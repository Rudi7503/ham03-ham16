// src/core/palette_optimizer.js
//
// ===========================================================================
// HAM-PALETTE OPTIMIZER (PARALLEL VECTOR SHIFT 8-31 & DESCENDING ANCHOR LOOP)
// ===========================================================================

import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp } from '../codecs/utils.js';
import { computeDetailedAnalysis, computeAvgYuvScore, getImageHistogram } from './analysis.js';
import { encodePaletted, decodePaletted } from './module_paletted.js';

const VECTOR_SCALES = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];
const REPOP_HISTOGRAM_CANDIDATES = 8; 

const LUMA_W_R = 0.299;
const LUMA_W_G = 0.587;
const LUMA_W_B = 0.114;

const MIN_PREFILL_DIST_SQ = 576;     
const CLUSTER_RADIUS_SQ = 144;       
const MIN_DISTINCT_DIST_SQ = 576;    

let workerFallbackWarned = false;

// ---------------------------------------------------------------------------
// Helfer & Statistiken
// ---------------------------------------------------------------------------

function colorDistanceSq(a, b) {
    const dR = a.r - b.r;
    const dG = a.g - b.g;
    const dB = a.b - b.b;
    return (dR * dR * LUMA_W_R) + (dG * dG * LUMA_W_G) + (dB * dB * LUMA_W_B);
}

function colorInPalette(paletteRAM, r, g, b, thresholdSq = 12) {
    for (let slot = 0; slot < 256; slot++) {
        const dR = r - paletteRAM[slot * 3];
        const dG = g - paletteRAM[slot * 3 + 1];
        const dB = b - paletteRAM[slot * 3 + 2];
        if ((dR * dR * LUMA_W_R) + (dG * dG * LUMA_W_G) + (dB * dB * LUMA_W_B) <= thresholdSq) {
            return true;
        }
    }
    return false;
}

function isDistinctFromAll(color, existing, minDistSq) {
    return existing.every(c => colorDistanceSq(color, c) >= minDistSq);
}

function colorDistinctFromPalette(paletteRAM, color, minDistSq) {
    for (let slot = 0; slot < 256; slot++) {
        const r = paletteRAM[slot * 3];
        const g = paletteRAM[slot * 3 + 1];
        const b = paletteRAM[slot * 3 + 2];
        if (slot !== 0 && r === 0 && g === 0 && b === 0) continue;
        if (colorDistanceSq(color, { r, g, b }) < minDistSq) return false;
    }
    return true;
}

function computeErrorHistogramSummary(appState, metric, optRegion) {
    const orig = appState.originalImageData.data;
    const dec = appState.decodedImageData.data;
    const imgW = appState.currentImgW;
    const totalPixels = imgW * appState.currentImgH;
    const useRegion = optRegion && optRegion.width > 0 && optRegion.height > 0;

    const buckets = { "0-4": 0, "5-16": 0, "17-36": 0, "37-64": 0, ">64": 0 };
    let count = 0;

    for (let i = 0; i < totalPixels; i++) {
        const x = i % imgW;
        const y = Math.floor(i / imgW);
        if (useRegion && (x < optRegion.x || x >= optRegion.x + optRegion.width || y < optRegion.y || y >= optRegion.y + optRegion.height)) {
            continue;
        }
        const idx = i * 4;
        const dR = orig[idx] - dec[idx];
        const dG = orig[idx + 1] - dec[idx + 1];
        const dB = orig[idx + 2] - dec[idx + 2];
        const errSq = (dR * dR * LUMA_W_R) + (dG * dG * LUMA_W_G) + (dB * dB * LUMA_W_B);

        if (errSq <= 4) buckets["0-4"]++;
        else if (errSq <= 16) buckets["5-16"]++;
        else if (errSq <= 36) buckets["17-36"]++;
        else if (errSq <= 64) buckets["37-64"]++;
        else buckets[">64"]++;
        count++;
    }

    if (count === 0) return "";

    return Object.entries(buckets)
        .map(([k, v]) => `[${k}]: ${((v / count) * 100).toFixed(1)}%`)
        .join(" | ");
}

// ---------------------------------------------------------------------------
// Fehlergetriebene Kandidaten: Farben, deren Ersetzen am meisten Fehler
// entfernt. Gewicht = MSE × Pixelanzahl des Fehler-Clusters — dadurch landen
// die Problemzonen (z. B. helle Glanzlichter) VOR den großen ruhigen Flächen
// im Paletten-Pool, anders als beim reinen Histogramm (Pixelanzahl).
// ---------------------------------------------------------------------------
function getErrorDrivenCandidates(stats, paletteRAM, maxCandidates) {
    const all = [];
    const add = (list) => { if (list) for (const e of list) all.push(e); };
    add(stats.global.top10);
    for (const b in stats.global.byBitDepth) add(stats.global.byBitDepth[b]);

    all.sort((a, b) => (b.mse * b.count) - (a.mse * a.count));

    const out = [];
    for (const e of all) {
        const cand = { r: e.r1, g: e.g1, b: e.b1 };
        if (colorInPalette(paletteRAM, cand.r, cand.g, cand.b, 12)) continue;
        if (!isDistinctFromAll(cand, out, MIN_DISTINCT_DIST_SQ)) continue;
        out.push(cand);
        if (out.length >= maxCandidates) break;
    }
    return out;
}

// Box-Filter-Downscale für die Proxy-Optimierung (RGBA).
function downscaleRgba(src, srcW, srcH, dstW, dstH) {
    const dst = new Uint8ClampedArray(dstW * dstH * 4);
    const xRatio = srcW / dstW, yRatio = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
        const sy0 = Math.floor(y * yRatio);
        const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
        for (let x = 0; x < dstW; x++) {
            const sx0 = Math.floor(x * xRatio);
            const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                let o = (sy * srcW + sx0) * 4;
                for (let sx = sx0; sx < sx1; sx++, o += 4) { r += src[o]; g += src[o + 1]; b += src[o + 2]; n++; }
            }
            const d = (y * dstW + x) * 4;
            dst[d] = r / n; dst[d + 1] = g / n; dst[d + 2] = b / n; dst[d + 3] = 255;
        }
    }
    return dst;
}

function resolveBankLayout(format, config) {
    const formatsInUse = config?.isMixed ? [...new Set(config.sequence)] : [format];
    const capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a, b) => a - b);
    const maxSlots = config?.slotsPerBank || capacities[capacities.length - 1] || 8;
    return { formatsInUse, maxSlots };
}

function getSlotBitDepths(i, formatsInUse) {
    const depths = new Set();
    for (const f of formatsInUse) {
        const cfg = HAM_CONFIGS[f];
        if (cfg && cfg.bits) depths.add(String(cfg.bits));
    }
    return depths;
}

function createBattleArgs(appState, step, metric, currentOffset, optRegion, onWorkerFallback) {
    return {
        // appState wird mitgeführt, damit Helfer das AKTUELLE Decodiert-Bild
        // lesen können (appState.decodedImageData wird bei jedem Encode ersetzt;
        // ein Snapshot hier wäre sofort veraltet).
        appState,
        origData: appState.originalImageData.data,
        imgW: appState.currentImgW,
        imgH: appState.currentImgH,
        format: appState.currentFormat,
        step, metric, currentOffset,
        paletteRAM: appState.globalPaletteRAM,
        optRegion, onWorkerFallback
    };
}

function measureCurrentMse(appState, metric, optRegion) {
    return computeAvgYuvScore(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, metric, optRegion
    );
}

function getSlotUsageSummary(commands, maxSlots) {
    const usage = new Array(maxSlots).fill(0);
    if (!commands || !Array.isArray(commands)) return usage;
    for (const cmd of commands) {
        if (!cmd || !cmd.isAnchor || cmd.anchorIdx === undefined) continue;
        if (cmd.anchorIdx >= 0 && cmd.anchorIdx < maxSlots) {
            usage[cmd.anchorIdx]++;
        }
    }
    return usage;
}

function computeSlotErrorVectors(appState, maxSlots, optRegion) {
    const commands = appState.latestCommandArray;
    const vectors = Array.from({ length: maxSlots }, () => ({ dR: 0, dG: 0, dB: 0, count: 0 }));
    if (!commands || !Array.isArray(commands) || commands.length === 0) return vectors;

    const orig = appState.originalImageData.data;
    const dec = appState.decodedImageData.data;
    const imgW = appState.currentImgW;
    const totalPixels = imgW * appState.currentImgH;
    const useRegion = optRegion && optRegion.width > 0 && optRegion.height > 0;

    let activeSlot = -1;
    let x = 0, y = 0;

    for (let i = 0; i < totalPixels; i++) {
        const cmd = commands[i];
        if (cmd && cmd.isAnchor && (HAM_CONFIGS[cmd.format]?.slotsPerBank > 0)) {
            activeSlot = cmd.anchorIdx;
        }

        const currentX = x;
        const currentY = y;
        if (++x === imgW) { x = 0; y++; }

        if (activeSlot < 0 || activeSlot >= maxSlots) continue;

        if (useRegion && (currentX < optRegion.x || currentX >= optRegion.x + optRegion.width ||
                          currentY < optRegion.y || currentY >= optRegion.y + optRegion.height)) {
            continue;
        }

        const idx = i * 4;
        const v = vectors[activeSlot];
        v.dR += orig[idx] - dec[idx];
        v.dG += orig[idx + 1] - dec[idx + 1];
        v.dB += orig[idx + 2] - dec[idx + 2];
        v.count++;
    }

    for (const v of vectors) {
        if (v.count > 0) {
            v.dR /= v.count;
            v.dG /= v.count;
            v.dB /= v.count;
        }
    }
    return vectors;
}

function writeSlotColor(paletteRAM, absSlot, color) {
    paletteRAM[absSlot * 3] = color.r;
    paletteRAM[absSlot * 3 + 1] = color.g;
    paletteRAM[absSlot * 3 + 2] = color.b;
}

function getClusteredCandidates(pool, paletteRAM, maxCores, distinctDistSq = MIN_DISTINCT_DIST_SQ) {
    const clusters = []; 

    for (const err of pool) {
        const r = err.r1, g = err.g1, b = err.b1;
        if (colorInPalette(paletteRAM, r, g, b, 12)) continue;

        let nearest = -1, nearestDistSq = Infinity;
        for (let c = 0; c < clusters.length; c++) {
            const meanColor = { 
                r: clusters[c].rSum / clusters[c].n, 
                g: clusters[c].gSum / clusters[c].n, 
                b: clusters[c].bSum / clusters[c].n 
            };
            const dSq = colorDistanceSq({ r, g, b }, meanColor);
            if (dSq < nearestDistSq) { nearestDistSq = dSq; nearest = c; }
        }

        if (nearest >= 0 && nearestDistSq <= CLUSTER_RADIUS_SQ) {
            clusters[nearest].rSum += r;
            clusters[nearest].gSum += g;
            clusters[nearest].bSum += b;
            clusters[nearest].n++;
        } else if (clusters.length < maxCores) {
            clusters.push({ rSum: r, gSum: g, bSum: b, n: 1 });
        }
    }

    const candidates = clusters
        .map(c => ({
            r: Math.round(c.rSum / c.n),
            g: Math.round(c.gSum / c.n),
            b: Math.round(c.bSum / c.n)
        }))
        .filter(cand => colorDistinctFromPalette(paletteRAM, cand, distinctDistSq));

    const FILL_OFFSETS = [-32, -16, -8, 8, 16, 32];
    const OFF = FILL_OFFSETS.length;
    let fillGuard = 0, poolCursor = 0;
    while (candidates.length < maxCores && fillGuard < OFF * OFF * OFF) {
        const base = pool.length > 0 ? pool[poolCursor % pool.length] : { r1: 128, g1: 128, b1: 128 };
        poolCursor++;
        const oR = FILL_OFFSETS[fillGuard % OFF];
        const oG = FILL_OFFSETS[Math.floor(fillGuard / OFF) % OFF];
        const oB = FILL_OFFSETS[Math.floor(fillGuard / (OFF * OFF)) % OFF];
        fillGuard++;
        const cand = {
            r: Math.round(clamp(base.r1 + oR, 0, 255)),
            g: Math.round(clamp(base.g1 + oG, 0, 255)),
            b: Math.round(clamp(base.b1 + oB, 0, 255))
        };
        if (isDistinctFromAll(cand, candidates, distinctDistSq) &&
            colorDistinctFromPalette(paletteRAM, cand, distinctDistSq)) candidates.push(cand);
    }
    
    while (candidates.length < maxCores) {
        const base = pool.length > 0 ? pool[candidates.length % pool.length] : { r1: 128, g1: 128, b1: 128 };
        const k = candidates.length;
        candidates.push({
            r: Math.round(clamp(base.r1 + FILL_OFFSETS[k % OFF], 0, 255)),
            g: Math.round(clamp(base.g1 + FILL_OFFSETS[(k + 1) % OFF], 0, 255)),
            b: Math.round(clamp(base.b1 + FILL_OFFSETS[(k + 2) % OFF], 0, 255))
        });
    }

    return candidates;
}

async function computeCandidateScoreInThread(candidate, args, absSlot) {
    const { origData, imgW, imgH, format, step, metric, currentOffset, paletteRAM, optRegion } = args;
    const localPalette = new Uint8Array(paletteRAM);
    writeSlotColor(localPalette, absSlot, candidate);
    const encodeRes = await encodePaletted(origData, imgW, imgH, format, step, localPalette, currentOffset, "greedy", metric, null, 0, 0, 15.0);
    const decodedPixels = decodePaletted(encodeRes.commands, imgW, imgH, step, localPalette, currentOffset);
    return computeAvgYuvScore(origData, decodedPixels, imgW, imgH, metric, optRegion);
}

const POOL_CAP = Math.max(2, Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 16));
const workerPool = [];
let workerUnavailable = false;

function createPoolWorker() {
    const entry = { worker: new Worker(new URL('./optimizer_worker.js', import.meta.url), { type: 'module' }), busy: true };
    workerPool.push(entry);
    return entry;
}

async function acquirePoolWorker() {
    for (;;) {
        const idle = workerPool.find(w => !w.busy);
        if (idle) { idle.busy = true; return idle; }
        if (!workerUnavailable && workerPool.length < POOL_CAP) {
            try { return createPoolWorker(); }
            catch (err) { workerUnavailable = true; return null; }
        }
        if (workerUnavailable) return null;
        await new Promise(r => setTimeout(r, 1));
    }
}

async function scoreCandidateViaPool(candidate, args, absSlot, onWorkerFallback) {
    const warnFallback = () => {
        if (!workerFallbackWarned) {
            workerFallbackWarned = true;
            const msg = "⚠️ Worker-Battle nicht verfügbar — In-Thread-Bewertung aktiv.";
            if (typeof onWorkerFallback === 'function') onWorkerFallback(msg);
            else console.warn(msg);
        }
    };

    const entry = await acquirePoolWorker();
    if (!entry) {
        warnFallback();
        try {
            const score = await computeCandidateScoreInThread(candidate, args, absSlot);
            return { candidate, score };
        } catch (err) {
            return { candidate, score: Infinity };
        }
    }

    const { worker } = entry;
    return new Promise((resolve) => {
        let settled = false;
        let fallbackRunning = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            entry.busy = false;
            resolve(result);
        };
        const fallback = async () => {
            if (settled || fallbackRunning) return;
            fallbackRunning = true;
            warnFallback();
            try {
                const score = await computeCandidateScoreInThread(candidate, args, absSlot);
                finish({ candidate, score });
            } catch (err) {
                finish({ candidate, score: Infinity });
            }
        };

        worker.onmessage = (e) => {
            if (e.data && e.data.score === Infinity) { fallback(); return; }
            finish(e.data);
        };
        worker.onerror = () => fallback();
        worker.onmessageerror = () => fallback();

        worker.postMessage({
            candidate,
            origData: args.origData,
            imgW: args.imgW,
            imgH: args.imgH,
            format: args.format,
            step: args.step,
            metric: args.metric,
            offset: args.currentOffset,
            basePaletteRAM: args.paletteRAM,
            slotToFill: absSlot,
            optRegion: args.optRegion
        });
    });
}

async function runWorkerBattleAll(candidates, args, absSlot) {
    const concurrency = Math.max(1, Math.min(POOL_CAP, candidates.length));
    const results = new Array(candidates.length);
    let next = 0;

    const workerLoop = async () => {
        for (;;) {
            const i = next++;
            if (i >= candidates.length) return;
            results[i] = await scoreCandidateViaPool(candidates[i], args, absSlot, args.onWorkerFallback);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, workerLoop));
    results.sort((a, b) => a.score - b.score);
    return results;
}

async function runWorkerBattle(candidates, args, absSlot) {
    return (await runWorkerBattleAll(candidates, args, absSlot))[0];
}

// ---------------------------------------------------------------------------
// SIMULTANE PARALLELE VEKTOR-OPTIMIERUNG (SLOTS 8–31 IN EINEM RUTSCH)
// ---------------------------------------------------------------------------

async function refineAllPoolSlotsParallel(minSlot, maxSlot, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, metric, optRegion, changeLog) {
    const lastMse = measureCurrentMse(appState, metric, optRegion);
    const vectors = computeSlotErrorVectors(appState, maxSlots, optRegion);
    const backupRAM = new Uint8Array(appState.globalPaletteRAM);

    const scalesToTest = [1.0, 0.5, 0.25];
    let bestMse = lastMse;
    let bestRAM = null;
    let bestScale = 0;

    for (const scale of scalesToTest) {
        appState.globalPaletteRAM.set(backupRAM);
        let shiftedCount = 0;

        for (let i = minSlot; i <= maxSlot; i++) {
            const absSlot = (currentOffset + i) % 256;
            if (lockedSlots.has(absSlot)) continue;

            const v = vectors[i];
            if (v && v.count > 0 && (Math.abs(v.dR) + Math.abs(v.dG) + Math.abs(v.dB) > 0.3)) {
                appState.globalPaletteRAM[absSlot * 3]     = clamp(Math.round(backupRAM[absSlot * 3]     + v.dR * scale), 0, 255);
                appState.globalPaletteRAM[absSlot * 3 + 1] = clamp(Math.round(backupRAM[absSlot * 3 + 1] + v.dG * scale), 0, 255);
                appState.globalPaletteRAM[absSlot * 3 + 2] = clamp(Math.round(backupRAM[absSlot * 3 + 2] + v.dB * scale), 0, 255);
                shiftedCount++;
            }
        }

        if (shiftedCount === 0) continue;

        await triggerEncodeFn();
        const newMse = measureCurrentMse(appState, metric, optRegion);

        if (newMse < bestMse - 0.005) {
            bestMse = newMse;
            bestRAM = new Uint8Array(appState.globalPaletteRAM);
            bestScale = scale;
        }
    }

    if (bestRAM) {
        appState.globalPaletteRAM.set(bestRAM);
        await triggerEncodeFn();
        const diff = lastMse - bestMse;
        changeLog.push(`⚡ Simultan-Vektor-Shift (Slots ${minSlot}–${maxSlot}, ×${(bestScale*100).toFixed(0)}%): [MSE: ${bestMse.toFixed(2)} (−${diff.toFixed(2)})]`);
        return true;
    } else {
        appState.globalPaletteRAM.set(backupRAM);
        await triggerEncodeFn();
        return false;
    }
}

// ---------------------------------------------------------------------------
// Single-Slot Vektor-Feinabstimmung
// ---------------------------------------------------------------------------

async function refineSlotColorVector(startColor, absSlot, slotIdx, vector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette) {
    const { paletteRAM } = battleArgs;

    if (!vector || vector.count === 0) {
        // Toter Slot (kein Pixel nutzt ihn) → nichts tun.
        // Hier stand früher eine "Reaktivierung": sie holte ihre Kandidaten aus
        // computeDetailedAnalysis(origData, origData). Weil Original gegen
        // Original überall Fehler 0 ergibt, ist dessen top10 LEER — der Zweig
        // wurde also nie ausgeführt (nachgeprüft: top10.length === 0). Der
        // damalige Messwert 35.82 (sehr_schnell, 128², echtes Bild) war somit
        // schlicht "tote Slots bleiben unverändert".
        // Echte Reaktivierung ist messbar SCHLECHTER: mit häufigen
        // Originalfarben 36.81, mit echten Fehlerfarben 38.39. Tote Slots werden
        // bereits von replaceWeakestSlots und der Schritt-5-Injektion behandelt.
        return { candidate: startColor, score: Infinity, didImprove: false };
    }

    const vectorMag = Math.abs(vector.dR) + Math.abs(vector.dG) + Math.abs(vector.dB);
    if (vectorMag < 0.3) {
        return { candidate: startColor, score: Infinity, didImprove: false };
    }

    const baseline = await runWorkerBattle([startColor], battleArgs, absSlot);

    const rawCandidates = VECTOR_SCALES.map(scale => ({
        r: clamp(Math.round(startColor.r + vector.dR * scale), 0, 255),
        g: clamp(Math.round(startColor.g + vector.dG * scale), 0, 255),
        b: clamp(Math.round(startColor.b + vector.dB * scale), 0, 255),
        scale
    }));

    const signR = Math.sign(vector.dR);
    const signG = Math.sign(vector.dG);
    const signB = Math.sign(vector.dB);
    for (const step of [1, 2, 3]) {
        rawCandidates.push({
            r: clamp(startColor.r + signR * step, 0, 255),
            g: clamp(startColor.g + signG * step, 0, 255),
            b: clamp(startColor.b + signB * step, 0, 255),
            scale: step * 0.05
        });
    }

    const uniqueCandidates = [];
    const seen = new Set([`${startColor.r},${startColor.g},${startColor.b}`]);

    for (const cand of rawCandidates) {
        const key = `${cand.r},${cand.g},${cand.b}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueCandidates.push(cand);
        }
    }

    if (uniqueCandidates.length < POOL_CAP) {
        const altVariations = [
            { r: signR * 2, g: -signG * 2, b: signB * 2 },
            { r: -signR * 2, g: signG * 2, b: -signB * 2 },
            { r: signR * 3, g: 0, b: 0 },
            { r: 0, g: signG * 3, b: 0 },
            { r: 0, g: 0, b: signB * 3 }
        ];

        for (const alt of altVariations) {
            if (uniqueCandidates.length >= POOL_CAP) break;
            const cand = {
                r: clamp(startColor.r + alt.r, 0, 255),
                g: clamp(startColor.g + alt.g, 0, 255),
                b: clamp(startColor.b + alt.b, 0, 255),
                scale: 0.99
            };
            const key = `${cand.r},${cand.g},${cand.b}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCandidates.push(cand);
            }
        }
    }

    if (uniqueCandidates.length === 0) {
        return { candidate: startColor, score: baseline.score, didImprove: false };
    }

    const best = await runWorkerBattle(uniqueCandidates, battleArgs, absSlot);

    if (best.score >= baseline.score) {
        return { candidate: startColor, score: baseline.score, didImprove: false };
    }

    paletteRAM[absSlot * 3] = best.candidate.r;
    paletteRAM[absSlot * 3 + 1] = best.candidate.g;
    paletteRAM[absSlot * 3 + 2] = best.candidate.b;

    const winScale = best.candidate.scale != null ? `${(best.candidate.scale * 100).toFixed(0)}%` : "?";
    updateOptProgress(
        `Slot ${slotIdx} (Vektor ${vector.dR.toFixed(1)},${vector.dG.toFixed(1)},${vector.dB.toFixed(1)} ×${winScale}) | MSE: ${best.score.toFixed(2)}`
    );
    renderUIPalette();
    await new Promise(r => requestAnimationFrame(r));
    await triggerEncodeFn();
    await new Promise(r => requestAnimationFrame(r));

    return { candidate: best.candidate, score: best.score, didImprove: true };
}

// ---------------------------------------------------------------------------
// Helper: Absteigender Vektor-Liniensuch-Pass (von maxSlot runter zu minSlot)
// ---------------------------------------------------------------------------

async function runVectorLoopDescending(maxSlot, minSlot, maxPasses, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette, changeLog, label) {
    let loopPass = 1;
    let anyImproved = true;

    while (anyImproved && loopPass <= maxPasses) {
        if (consumeAbort()) { changeLog.push(`⏹️ Abgebrochen (${label}).`); return; }
        anyImproved = false;
        const slotVectors = computeSlotErrorVectors(appState, maxSlots, battleArgs.optRegion);
        const usageNow = getSlotUsageSummary(appState.latestCommandArray, maxSlots); // 1x pro Pass statt pro Slot

        for (let slotIdx = maxSlot; slotIdx >= minSlot; slotIdx--) {
            const absSlot = (currentOffset + slotIdx) % 256;
            if (lockedSlots.has(absSlot)) continue;

            updateOptProgress(`${label} (Pass ${loopPass}): Slot ${slotIdx}...`);
            const slotVector = slotVectors[slotIdx];
            const usageCount = usageNow[slotIdx] || 0;

            const startColor = {
                r: appState.globalPaletteRAM[absSlot * 3],
                g: appState.globalPaletteRAM[absSlot * 3 + 1],
                b: appState.globalPaletteRAM[absSlot * 3 + 2]
            };

            const result = await refineSlotColorVector(startColor, absSlot, slotIdx, slotVector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
            if (result.didImprove) {
                anyImproved = true;
                changeLog.push(`🔥 Slot ${slotIdx} (${label} Pass ${loopPass}): RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b}) [Nutzung: ${usageCount}x | MSE: ${result.score.toFixed(2)}]`);
            }
        }
        loopPass++;
    }
}

// ---------------------------------------------------------------------------
// Zero-Usage Eradication
// ---------------------------------------------------------------------------

async function forceFillUnusedSlots(appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, phaseName, skipSlots = []) {
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const MAX_PASSES = 5;
    let anyChange = false;
    const skipSet = new Set(skipSlots);

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
        const unusedSlots = [];
        for (let i = 1; i < maxSlots; i++) {
            if (skipSet.has(i)) continue;
            if (!lockedSlots.has((currentOffset + i) % 256) && usage[i] === 0) {
                unusedSlots.push(i);
            }
        }

        if (unusedSlots.length === 0) break;

        updateOptProgress(`${phaseName}: Fülle ${unusedSlots.length} ungenutzte Slots (Pass ${pass + 1})...`);

        const stats = computeDetailedAnalysis(
            appState.originalImageData.data, appState.decodedImageData.data,
            appState.currentImgW, appState.currentImgH, 0, totalPixels,
            step, metric, config, optRegion
        );

        const clusters = [];
        const addList = (list) => { if(list) for (const e of list) clusters.push(e); };
        addList(stats.global.top10);
        for (const b in stats.global.byBitDepth) addList(stats.global.byBitDepth[b]);
        clusters.sort((a, b) => b.mse - a.mse);

        let placed = 0;
        for (const i of unusedSlots) {
            const absSlot = (currentOffset + i) % 256;
            let chosen = null;
            for (const e of clusters) {
                if (colorInPalette(appState.globalPaletteRAM, e.r1, e.g1, e.b1, 12)) continue; 
                chosen = { r: e.r1, g: e.g1, b: e.b1 };
                break;
            }
            if (!chosen) continue;
            writeSlotColor(appState.globalPaletteRAM, absSlot, chosen);
            placed++;
        }

        if (placed === 0) {
            changeLog.push(`${phaseName}: Keine weiteren Fehlerfarben gefunden.`);
            break;
        }

        changeLog.push(`💉 ${phaseName}: ${placed} ungenutzte Slots direkt mit Fehlerfarben befüllt.`);
        anyChange = true;

        renderUIPalette();
        await new Promise(r => requestAnimationFrame(r));
        await triggerEncodeFn();
        await new Promise(r => requestAnimationFrame(r));
    }
    return anyChange;
}

// ---------------------------------------------------------------------------
// Safe Slot-Sortierung
// ---------------------------------------------------------------------------

async function safeSortPaletteRange(minSlot, maxSlot, appState, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette) {
    const tStart = performance.now();
    const startMse = measureCurrentMse(appState, metric, optRegion);
    const usage = getSlotUsageSummary(appState.latestCommandArray, appState.globalPaletteRAM.length / 3);

    const movableSlots = [];
    for (let i = minSlot; i <= maxSlot; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (!lockedSlots.has(absSlot)) {
            movableSlots.push(i);
        }
    }

    if (movableSlots.length <= 1) return startMse;

    const colorData = movableSlots.map(i => {
        const absSlot = (currentOffset + i) % 256;
        return {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2],
            useCount: usage[i]
        };
    });

    colorData.sort((a, b) => b.useCount - a.useCount);
    const backupRAM = new Uint8Array(appState.globalPaletteRAM);

    for (let idx = 0; idx < movableSlots.length; idx++) {
        const targetI = movableSlots[idx]; 
        const absSlot = (currentOffset + targetI) % 256;
        const srcColor = colorData[idx];

        appState.globalPaletteRAM[absSlot * 3] = srcColor.r;
        appState.globalPaletteRAM[absSlot * 3 + 1] = srcColor.g;
        appState.globalPaletteRAM[absSlot * 3 + 2] = srcColor.b;
    }

    await triggerEncodeFn();
    const newMse = measureCurrentMse(appState, metric, optRegion);
    const durationMs = Math.round(performance.now() - tStart);

    if (newMse <= startMse + 0.01) {
        const diff = startMse - newMse;
        const diffTxt = diff > 0.005 ? ` (−${diff.toFixed(2)})` : "";
        changeLog.push(`🔄 <span style="color:#28a745;">Safe-Sorting für Slots ${minSlot}–${maxSlot} erfolgreich.</span> [MSE: ${newMse.toFixed(2)}${diffTxt}] ⏱️ ${durationMs}ms`);
        renderUIPalette();
        return newMse;
    } else {
        appState.globalPaletteRAM.set(backupRAM);
        await triggerEncodeFn();
        changeLog.push(`🔄 <span style="color:#6c757d;">Sortierung Slots ${minSlot}–${maxSlot} verworfen.</span> ⏱️ ${durationMs}ms`);
        return startMse;
    }
}

async function safeSortPalette(appState, maxSlots, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette) {
    return await safeSortPaletteRange(1, maxSlots - 1, appState, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette);
}

// ---------------------------------------------------------------------------
// Haupt-Pipeline (runHybridOptimization)
// ---------------------------------------------------------------------------

// Fehlerbeitrag je Slot: Summe der (luma-gewichteten) Fehler aller Pixel, die
// aktuell von diesem Slot als Anker abhängen. Zeigt, welcher Slot am wenigsten
// zur Bildqualität beiträgt — der lohnt sich am ehesten zu ersetzen.
function computeSlotErrorContribution(appState, maxSlots, optRegion) {
    const commands = appState.latestCommandArray;
    const orig = appState.originalImageData.data;
    const dec = appState.decodedImageData.data;
    const imgW = appState.currentImgW;
    const totalPixels = imgW * appState.currentImgH;
    const out = Array.from({ length: maxSlots }, () => ({ err: 0, count: 0 }));
    if (!commands || commands.length === 0) return out;

    const useRegion = optRegion && optRegion.width > 0 && optRegion.height > 0;
    let activeSlot = -1, x = 0, y = 0;

    for (let i = 0; i < totalPixels; i++) {
        const cmd = commands[i];
        if (cmd && cmd.isAnchor && (HAM_CONFIGS[cmd.format]?.slotsPerBank > 0)) activeSlot = cmd.anchorIdx;
        const cx = x, cy = y;
        if (++x === imgW) { x = 0; y++; }
        if (activeSlot < 0 || activeSlot >= maxSlots) continue;
        if (useRegion && (cx < optRegion.x || cx >= optRegion.x + optRegion.width || cy < optRegion.y || cy >= optRegion.y + optRegion.height)) continue;

        const o = i * 4;
        const dR = orig[o] - dec[o], dG = orig[o + 1] - dec[o + 1], dB = orig[o + 2] - dec[o + 2];
        out[activeSlot].err += (dR * dR * LUMA_W_R) + (dG * dG * LUMA_W_G) + (dB * dB * LUMA_W_B);
        out[activeSlot].count++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// SCHWÄCHSTER-SLOT-ERSATZ
//
// Billiger Ersatz für den Kandidaten-Battle: Die Slots mit dem geringsten
// Fehlerbeitrag werden durch die stärksten Fehlerfarben ersetzt (statt pro Slot
// maxCores Kandidaten komplett zu encodieren). Nach jeder Runde wird geprüft,
// ob es besser wurde — sonst Rücksetzen (wie safeSortPalette).
// ---------------------------------------------------------------------------
async function replaceWeakestSlots(appState, maxSlots, currentOffset, lockedSlots, step, metric, optRegion,
                                   triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog,
                                   rounds = 3, perRound = 3) {
    const totalPixels = appState.currentImgW * appState.currentImgH;
    let improvedAny = false;

    for (let round = 1; round <= rounds; round++) {
        if (consumeAbort()) { changeLog.push('⏹️ Abgebrochen (Schwächster-Slot-Ersatz).'); break; }
        const startMse = measureCurrentMse(appState, metric, optRegion);
        const backup = new Uint8Array(appState.globalPaletteRAM);

        const contrib = computeSlotErrorContribution(appState, maxSlots, optRegion);
        const order = [];
        for (let i = 1; i < maxSlots; i++) {
            const absSlot = (currentOffset + i) % 256;
            if (lockedSlots.has(absSlot)) continue;
            order.push({ slot: i, err: contrib[i].err, count: contrib[i].count });
        }
        order.sort((a, b) => a.err - b.err);          // geringster Beitrag zuerst

        const stats = computeDetailedAnalysis(
            appState.originalImageData.data, appState.decodedImageData.data,
            appState.currentImgW, appState.currentImgH, 0, totalPixels,
            step, metric, HAM_CONFIGS[appState.currentFormat], optRegion
        );
        const cands = getErrorDrivenCandidates(stats, appState.globalPaletteRAM, perRound + 4);
        if (cands.length === 0) {
            changeLog.push(`♻️ Schwächster-Slot-Ersatz Runde ${round}: keine neuen Fehlerfarben mehr.`);
            break;
        }

        let placed = 0;
        for (let k = 0; k < perRound && k < order.length && k < cands.length; k++) {
            writeSlotColor(appState.globalPaletteRAM, (currentOffset + order[k].slot) % 256, cands[k]);
            placed++;
        }
        if (placed === 0) break;

        renderUIPalette();
        updateOptProgress(`Schwächster-Slot-Ersatz Runde ${round}: ${placed} Slots ersetzt...`, 0, 1);
        await triggerEncodeFn();
        const newMse = measureCurrentMse(appState, metric, optRegion);

        if (newMse < startMse - 0.005) {
            improvedAny = true;
            const list = order.slice(0, placed).map(t => `S${t.slot}(${t.count}px)`).join(', ');
            changeLog.push(`♻️ <span style="color:#28a745;">Schwächster-Slot-Ersatz Runde ${round}: ${placed} schwache Slots ersetzt [${list}] → MSE ${newMse.toFixed(2)} (−${(startMse - newMse).toFixed(2)})</span>`);
        } else {
            appState.globalPaletteRAM.set(backup);
            await triggerEncodeFn();
            changeLog.push(`♻️ Schwächster-Slot-Ersatz Runde ${round}: verworfen (kein Gewinn).`);
            break;
        }
    }
    return improvedAny;
}

// ---------------------------------------------------------------------------
// ABBRUCH (#4 Auto-Budget): Die UI kann eine laufende Optimierung abbrechen.
// Das Flag wird an Stufen-/Schleifengrenzen geprüft und dabei zurückgesetzt.
// ---------------------------------------------------------------------------
let abortRequested = false;

export function requestOptimizationAbort() { abortRequested = true; }

function consumeAbort() {
    if (!abortRequested) return false;
    abortRequested = false;
    return true;
}

// Dauer-Schätzung.
//
// Erste Wahl: der zuletzt gelaufene Durchlauf DESSELBEN Verfahrens, hochgerechnet
// auf die aktuelle Pixelzahl (Encode-Zeit ist ~linear in der Pixelzahl). Das ist
// belastbar, weil es Maschine, Worker-Anzahl und Bildgröße schon enthält.
//
// Sonst ein grober Faktor auf EINEN Encode. Der Faktor ist bewusst getrennt für
// In-Thread-Betrieb (kein Worker verfügbar: pro Kandidat fallen Encode + Decode +
// Bewertung an, ~4-8x teurer als ein reiner Encode) und für echte Worker.
// Gemessen an einem echten 876x882-Foto:
//   Browser: Proxy-Encode 912 ms, "langsam" 184.6 s → Faktor 202; "normal"
//            (= Stufen 1-4 + 4a + 4c) 107.3 s → 118; "sehr_schnell" ~99.
//   Node/In-Thread (128²): 90 / 307 / 558.
const FALLBACK_FACTOR = {
    threaded: { sehr_schnell: 90, normal: 310, langsam: 560 },
    workers: { sehr_schnell: 100, normal: 120, langsam: 200 }
};

export function estimateOptimizationMs(singleEncodeMs, intensity, pixels) {
    const prev = lastRunStats;
    if (prev && prev.intensity === intensity && prev.encodeCount >= 3 && prev.pixels > 0) {
        const scale = pixels ? pixels / prev.pixels : 1;
        return { ms: Math.round(prev.totalMs * scale), exact: true };
    }
    const tbl = (typeof Worker === 'undefined') ? FALLBACK_FACTOR.threaded : FALLBACK_FACTOR.workers;
    const factor = tbl[intensity] || tbl.langsam;
    return { ms: Math.round(singleEncodeMs * factor), exact: false };
}

// Bilanz des letzten Laufs: Anzahl Encodes, Dauer und Pixelzahl. Damit stützt
// sich die Schätzung auf das GEMESSENE Tempo statt auf fest verdrahtete
// Faktoren — die hängen stark von Maschine und Worker-Anzahl ab (im Browser mit
// echten Workern war "langsam" 2,2x schneller als der Node-Faktor sagte).
let lastRunStats = null;

// Die Proxy-Optimierung umfasst mehr als die Pipeline (Vorab-Encode + Anwenden
// auf das Vollbild). Diese Randzeiten werden nachgetragen, damit die Schätzung
// des nächsten Laufs die GESAMTE Operation abdeckt — sonst fehlten z. B. auf
// einem 876x882-Bild rund 8 s.
export function setLastRunTotal(totalMs) {
    if (lastRunStats && totalMs > 0) lastRunStats.totalMs = totalMs;
}

// Live-Restdauer über STUFEN-ANTEILE statt über Encode-Zahlen.
//
// Die absolute Anzahl Encodes ist umgebungsabhängig (maxCores bestimmt die
// Kandidatenzahl im Battle: Node/4 → 83, Browser/16 → ~200), die relativen
// Stufen-Anteile dagegen nicht. Gemessen an einem echten 876x882-Foto,
// Node-In-Thread vs. Browser bei "langsam":
//   Stufe 2: 7.1% vs 7.7% | Stufe 4: 6.7% vs 5.9%
//   4a:     29.4% vs 23.4% | 4c:    14.1% vs 18.5% | Schritt 5: 40.3% vs 38.2%
// Die Gewichte sind die Mittelwerte daraus; sie werden in der Reihenfolge der
// pushMseStand()-Aufrufe abgearbeitet.
const STAGE_WEIGHTS = {
    sehr_schnell: [0.06, 0.45, 0.02, 0.42, 0.05],
    normal: [0.03, 0.13, 0.00, 0.11, 0.45, 0.28],
    langsam: [0.02, 0.07, 0.00, 0.06, 0.26, 0.03, 0.16, 0.39]
};

export async function runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette, intensity = 'langsam') {
    const globalStart = performance.now();
    // Jeden Encode mitzählen: die Laufzeit der Pipeline ist (Anzahl Encodes) ×
    // (Zeit pro Encode). Die Anzahl hängt nur vom Verfahren ab, die Zeit pro
    // Encode von Maschine/Bildgröße — daher ist der Zähler die verlässliche
    // Bezugsgröße für eine Dauer-Schätzung.
    let encodeCount = 0;
    const rawTriggerEncode = triggerEncodeFn;
    const countedEncode = async () => { encodeCount++; return await rawTriggerEncode(); };
    triggerEncodeFn = countedEncode;

    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;

    // Live-Restdauer: aus dem BEOBACHTETEN Tempo und dem Anteil der bereits
    // erledigten Stufen. Das ist ehrlicher als ein a-priori-Faktor, weil pro
    // Kandidat Encode, Decode und Bewertung zusammenkommen und je nach Maschine
    // und Worker-Anzahl stark variieren.
    //
    // Wichtig: die Hochrechnung wird nur an STUFENGRENZEN neu berechnet und
    // dazwischen konstant gehalten. Sonst wird die Restzeit mitten in einer
    // langen Stufe immer weiter aufgebläht (die verstrichene Zeit wächst, der
    // fertige Stufenanteil nicht) — gemessen ergab das "4 min" statt 88 s.
    const stageWeights = STAGE_WEIGHTS[intensity] || STAGE_WEIGHTS.langsam;
    let stagesDone = 0;
    let projectedTotalMs = null;
    // Ein früherer Lauf desselben Verfahrens ist die beste Grundlage.
    if (lastRunStats && lastRunStats.intensity === intensity && lastRunStats.pixels > 0) {
        projectedTotalMs = lastRunStats.totalMs * (totalPixels / lastRunStats.pixels);
    }
    const fmtDur = (ms) => ms >= 90000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
    const rawUpdateOptProgress = updateOptProgress;
    updateOptProgress = (msg, cur, total) => {
        let suffix = '';
        if (projectedTotalMs) {
            const elapsed = performance.now() - globalStart;
            const remain = Math.max(0, projectedTotalMs - elapsed);
            suffix = ` ⏳ noch ca. ${fmtDur(remain)} (Stufe ${stagesDone}/${stageWeights.length})`;
        }
        return rawUpdateOptProgress(msg + suffix, cur, total);
    };
    const { formatsInUse, maxSlots } = resolveBankLayout(appState.currentFormat, config);
    const maxCores = navigator.hardwareConcurrency || 4;
    const changeLog = [];
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion, (msg) => changeLog.push(`<div style="color:#ffc107;">${msg}</div>`));

    let mseStand = measureCurrentMse(appState, metric, optRegion);

    const pushMseStand = (phaseLabel, startTime) => {
        const durationMs = Math.round(performance.now() - startTime);
        const durationTxt = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${durationMs}ms`;
        const mse = measureCurrentMse(appState, metric, optRegion);
        const diff = mseStand - mse;
        const diffTxt = Math.abs(diff) < 0.005 ? "" : (diff > 0 ? ` (−${diff.toFixed(2)})` : ` (+${(-diff).toFixed(2)})`);
        const histStr = computeErrorHistogramSummary(appState, metric, optRegion);

        changeLog.push(
            `<div style="color:#17a2b8; font-size:11px; margin-top:2px; background:rgba(23,162,184,0.08); padding:3px 6px; border-radius:3px;">` +
            `📊 Nach ${phaseLabel}: <b>MSE ${mse.toFixed(2)}</b>${diffTxt} | ⏱️ ${durationTxt}<br/>` +
            `<span style="color:#aaa;">📉 Fehler-Histogramm: ${histStr}</span>` +
            `</div>`
        );
        mseStand = mse;
        // Stufengrenze: Hochrechnung neu berechnen (nur wenn kein früherer Lauf
        // desselben Verfahrens als Grundlage vorliegt).
        stagesDone++;
        if (!lastRunStats || lastRunStats.intensity !== intensity) {
            const doneWeight = stageWeights.slice(0, stagesDone).reduce((a, b) => a + b, 0);
            if (doneWeight >= 0.03) {
                projectedTotalMs = (performance.now() - globalStart) / doneWeight;
            }
        }
    };

    // Ein evtl. noch gesetztes Abbruch-Flag aus einem früheren Lauf verwerfen,
    // sonst bricht die nächste Optimierung sofort ab.
    abortRequested = false;
    let aborted = false;
    // Prüft das Abbruch-Flag an einer Stufengrenze und beendet die Pipeline
    // wirklich (ein "break" in einer Schleife ließ früher alle Folgestufen
    // trotzdem noch komplett durchlaufen).
    const abortNow = () => {
        if (!consumeAbort()) return false;
        aborted = true;
        changeLog.push('<div style="color:#dc3545; font-weight:bold; margin-top:8px;">⏹️ Optimierung abgebrochen — bisherige Palette bleibt erhalten.</div>');
        return true;
    };

    // Gemeinsamer Ausstieg aller Zweige: protokolliert die Encode-Bilanz, aus der
    // sich die Dauer-Schätzung ableitet (Anzahl Encodes × Zeit pro Encode).
    const finish = () => {
        const totalMs = performance.now() - globalStart;
        // Ein abgebrochener Lauf taugt nicht als Zeitgrundlage für den nächsten.
        if (!aborted) {
            lastRunStats = { intensity, encodeCount, totalMs, pixels: totalPixels };
        }
        console.log(`[Palette] ${intensity}: ${encodeCount} Encodes, ${stagesDone}/${stageWeights.length} Stufen in ${(totalMs / 1000).toFixed(2)}s${aborted ? ' (abgebrochen)' : ''}`);
        return changeLog;
    };

    // =======================================================================
    // STUFE 1: GLOBALER BASIS-POOL (SLOTS 8–31) + SIMULTAN-VEKTOR-SHIFT
    // =======================================================================
    let stageStart = performance.now();
    changeLog.push(`<div style="color:#6f42c1; font-weight:bold; margin-top:5px;">--- STUFE 1: Globaler Basis-Pool (Slots 8–${maxSlots-1}) ---</div>`);
    updateOptProgress(`Befülle globalen Basis-Pool (Slots 8–${maxSlots-1})...`);

    const hist = getImageHistogram(
        appState.originalImageData, appState.currentImgW, appState.currentImgH,
        step, 1000, appState.globalPaletteRAM, currentOffset, optRegion
    );

    // Fehlergetriebene Kandidaten: die Farben, deren Fehler am meisten wehtut
    // (MSE × Anzahl). Ohne sie füllt der reine Histogramm-Prefill den Pool mit
    // den großen ruhigen Flächen und die Problemzonen (helle Glanzlichter,
    // Kanten) bekommen zu wenige Slots.
    const statsPrefill = computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion
    );
    const errCands = getErrorDrivenCandidates(statsPrefill, appState.globalPaletteRAM, maxSlots);

    // Mischung: 1 fehlergetriebene Farbe auf 2 Histogrammfarben (fehlergetriebene
    // zuerst, weil die niedrigen Pool-Slots von allen Phasen erreichbar sind).
    // 1:1 hatte sich bei 256x256 als leicht nachteilig erwiesen (verdrängt gut
    // gewählte Histogrammfarben), bei 128x128 aber stark geholfen.
    const ERROR_PREFILL_EVERY = 3;
    const poolCandidates = [];
    {
        let ei = 0, hi = 0, k = 0;
        while (hi < hist.length || ei < errCands.length) {
            if (ei < errCands.length && (k % ERROR_PREFILL_EVERY) === 0) poolCandidates.push(errCands[ei++]);
            else if (hi < hist.length) poolCandidates.push(hist[hi++]);
            else poolCandidates.push(errCands[ei++]);
            k++;
        }
    }
    changeLog.push(`🧪 Prefill-Mix: ${errCands.length} fehlergetriebene + ${hist.length} Histogramm-Farben (1:${ERROR_PREFILL_EVERY - 1})`);

    let prefillIdx = 0;
    for (let i = 8; i < maxSlots; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;
        if (prefillIdx < poolCandidates.length) {
            writeSlotColor(appState.globalPaletteRAM, absSlot, poolCandidates[prefillIdx]);
            prefillIdx++;
        }
    }

    renderUIPalette();
    await triggerEncodeFn();

    await forceFillUnusedSlots(
        appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config,
        triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog,
        "Zero-Usage Base-Pool (Slots 8..max)", [1, 2, 3, 4, 5, 6, 7]
    );

    // SIMULTANER VEKTOR-SHIFT FÜR ALLE POOL-SLOTS (8..31) IN EINEM SCHRITT
    changeLog.push(`<div style="color:#6f42c1; font-size:12px; font-weight:bold; margin-top:4px;">⚡ Simultaner Vektor-Shift Basis-Pool (Slots 8–${maxSlots-1})</div>`);
    await refineAllPoolSlotsParallel(8, maxSlots - 1, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, metric, optRegion, changeLog);
    pushMseStand("Stufe 1 (Basis-Pool Slots 8..max)", stageStart);

    // =======================================================================
    // STUFE 2: HAM04-KASKADE (SLOTS 4–7 BEFÜLLEN & 1x ABSTEIGEND OPTIMIEREN)
    // =======================================================================
    if (abortNow()) return finish();
    stageStart = performance.now();
    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- STUFE 2: HAM04-Kaskade (Slots 4–7) ---</div>`);
    updateOptProgress(`Optimiere HAM04-Zugriff (Slots 4–7)...`);

    const statsHam04 = computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion
    );

    let topHam04Errors = statsHam04.global.byBitDepth["4"] || statsHam04.global.top10 || [];
    const chosen47 = [];

    for (const err of topHam04Errors) {
        if (chosen47.length >= 4) break;
        const target = { r: err.r1, g: err.g1, b: err.b1 };
        
        let bestSlot = -1, minDist = Infinity;
        for (let h = 8; h < maxSlots; h++) {
            const absH = (currentOffset + h) % 256;
            const hColor = { r: appState.globalPaletteRAM[absH*3], g: appState.globalPaletteRAM[absH*3+1], b: appState.globalPaletteRAM[absH*3+2] };
            const dSq = colorDistanceSq(target, hColor);
            if (dSq < minDist && isDistinctFromAll(hColor, chosen47, 144)) {
                minDist = dSq; bestSlot = h;
            }
        }

        if (bestSlot !== -1 && minDist < 1024) {
            const absM = (currentOffset + bestSlot) % 256;
            chosen47.push({ r: appState.globalPaletteRAM[absM*3], g: appState.globalPaletteRAM[absM*3+1], b: appState.globalPaletteRAM[absM*3+2], promotedFrom: bestSlot });
        } else {
            chosen47.push(target);
        }
    }

    for (let i = 4; i <= 7; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;
        const c = chosen47[i - 4] || { r: 128, g: 128, b: 128 };
        writeSlotColor(appState.globalPaletteRAM, absSlot, c);
        const info = c.promotedFrom ? `(Befördert aus Slot ${c.promotedFrom})` : `(Neuer HAM04-Fehler)`;
        changeLog.push(`📌 Slot ${i} belegt: RGB(${c.r},${c.g},${c.b}) ${info}`);
    }

    renderUIPalette();
    await triggerEncodeFn();

    await safeSortPaletteRange(4, 7, appState, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette);

    // 1x Vektor-Feinabstimmung absteigend (Slots 7 -> 4)
    changeLog.push(`<div style="color:#17a2b8; font-size:12px; font-weight:bold; margin-top:4px;">🔹 Vektor-Feinabstimmung HAM04 (7→4)</div>`);
    await runVectorLoopDescending(7, 4, 1, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette, changeLog, "HAM04 (7->4)");
    pushMseStand("Stufe 2 (HAM04-Kaskade Slots 4–7)", stageStart);

    // STUFE 3: REFILL & RE-ERADICATION GESAMTER POOL
    if (abortNow()) return finish();
    stageStart = performance.now();
    await forceFillUnusedSlots(
        appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config,
        triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog,
        "Refill & Re-Eradication Pool", [1, 2, 3]
    );
    pushMseStand("Stufe 3 (Refill Pool)", stageStart);

    // =======================================================================
    // STUFE 4: HAM03-KASKADE (SLOTS 1–3 BEFÜLLEN & 1x ABSTEIGEND OPTIMIEREN)
    // =======================================================================
    if (abortNow()) return finish();
    stageStart = performance.now();
    changeLog.push(`<div style="color:#ffc107; font-weight:bold; margin-top:10px;">--- STUFE 4: HAM03-Kaskade (Slots 1–3) ---</div>`);
    updateOptProgress(`Optimiere HAM03-Hauptzugriff (Slots 1–3)...`);

    const statsHam03 = computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion
    );

    let topHam03Errors = statsHam03.global.byBitDepth["3"] || statsHam03.global.top10 || [];
    const chosen13 = [];

    for (const err of topHam03Errors) {
        if (chosen13.length >= 3) break;
        const target = { r: err.r1, g: err.g1, b: err.b1 };
        
        let bestSlot = -1, minDist = Infinity;
        for (let h = 4; h < maxSlots; h++) {
            const absH = (currentOffset + h) % 256;
            const hColor = { r: appState.globalPaletteRAM[absH*3], g: appState.globalPaletteRAM[absH*3+1], b: appState.globalPaletteRAM[absH*3+2] };
            const dSq = colorDistanceSq(target, hColor);
            if (dSq < minDist && isDistinctFromAll(hColor, chosen13, 144)) {
                minDist = dSq; bestSlot = h;
            }
        }

        if (bestSlot !== -1 && minDist < 1024) {
            const absM = (currentOffset + bestSlot) % 256;
            chosen13.push({ r: appState.globalPaletteRAM[absM*3], g: appState.globalPaletteRAM[absM*3+1], b: appState.globalPaletteRAM[absM*3+2], promotedFrom: bestSlot });
        } else {
            chosen13.push(target);
        }
    }

    for (let i = 1; i <= 3; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;
        const c = chosen13[i - 1] || { r: 128, g: 128, b: 128 };
        writeSlotColor(appState.globalPaletteRAM, absSlot, c);
        const info = c.promotedFrom ? `(Befördert aus Slot ${c.promotedFrom})` : `(Neuer HAM03-Fehler)`;
        changeLog.push(`📌 Slot ${i} belegt: RGB(${c.r},${c.g},${c.b}) ${info}`);
    }

    renderUIPalette();
    await triggerEncodeFn();

    await safeSortPaletteRange(1, 3, appState, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette);

    // 1x Vektor-Feinabstimmung absteigend (Slots 3 -> 1)
    changeLog.push(`<div style="color:#ffc107; font-size:12px; font-weight:bold; margin-top:4px;">🔸 Vektor-Feinabstimmung HAM03 (3→1)</div>`);
    await runVectorLoopDescending(3, 1, 1, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette, changeLog, "HAM03 (3->1)");
    pushMseStand("Stufe 4 (HAM03-Kaskade Slots 1–3)", stageStart);

    if (intensity === 'sehr_schnell') {
        // Billiger Abschluss: schwächste Slots gegen die stärksten Fehlerfarben
        // tauschen. Kostet nur wenige Encodes (bricht bei fehlendem Gewinn ab)
        // und ist der beste Qualitätsgewinn pro Millisekunde in dieser Stufe —
        // der teure Kandidaten-Battle lohnt sich hier nicht.
        stageStart = performance.now();
        changeLog.push(`<div style="color:#28a745; font-size:12px; font-weight:bold; margin-top:6px;">♻️ Schwächster-Slot-Ersatz (billiger Abschluss)</div>`);
        await replaceWeakestSlots(appState, maxSlots, currentOffset, lockedSlots, step, metric, optRegion,
            triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, 4, 3);
        pushMseStand("Abschluss (Schwächster-Slot-Ersatz)", stageStart);

        const totalDurationSec = ((performance.now() - globalStart) / 1000).toFixed(2);
        const endMse = measureCurrentMse(appState, metric, optRegion);
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">⚡ Sehr schnelle Optimierung beendet [End-MSE: ${endMse.toFixed(2)} | Gesamtdauer: ${totalDurationSec}s]</div>`);
        return finish();
    }

    // SCHRITT 4: 50/50 USAGE-PARTITIONING (TOP 50% VEKTOR | BOTTOM 50% BATTLE)
    stageStart = performance.now();
    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- SCHRITT 4: Nutzungs-Partitionierung (Top 50% Vektor | Bottom 50% Ersatz/Battle) ---</div>`);

    const usageSummary = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    const movableSlots = [];
    for (let i = 1; i < maxSlots; i++) {
        if (!lockedSlots.has((currentOffset + i) % 256)) {
            movableSlots.push({ slotIdx: i, useCount: usageSummary[i] });
        }
    }

    movableSlots.sort((a, b) => b.useCount - a.useCount);

    const half = Math.ceil(movableSlots.length / 2);
    const top50Slots = movableSlots.slice(0, half);
    const bottom50Slots = movableSlots.slice(half);

    changeLog.push(`📊 Aufteilung: ${top50Slots.length} Slots in Top 50% (Vektor-Suche), ${bottom50Slots.length} Slots in Bottom 50% (Kandidaten-Battle).`);

    // A. Vektor-Suche Top 50% (Absteigend nach Slot-Index sortiert)
    if (abortNow()) return finish();
    changeLog.push(`<div style="color:#28a745; font-size:12px; font-weight:bold; margin-top:6px;">🔹 Vektor-Liniensuche (Top 50% meistgenutzte Slots)</div>`);
    top50Slots.sort((a, b) => b.slotIdx - a.slotIdx);
    const currentVectors = computeSlotErrorVectors(appState, maxSlots, optRegion);

    for (const item of top50Slots) {
        const i = item.slotIdx;
        const absSlot = (currentOffset + i) % 256;
        const vector = currentVectors[i];
        
        const startColor = {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2]
        };

        updateOptProgress(`Top 50% Vektor-Suche: Slot ${i} (${item.useCount}x genutzt)...`);
        const result = await refineSlotColorVector(startColor, absSlot, i, vector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
        if (result.didImprove) {
            changeLog.push(`✨ Top-Slot ${i} (${item.useCount}x): RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b}) [MSE: ${result.score.toFixed(2)}]`);
        }
    }
    pushMseStand("Schritt 4a (Top 50% Vektor-Suche)", stageStart);

    // B. Schwächster-Slot-Ersatz (billig): Slots mit dem geringsten Fehlerbeitrag
    //    werden durch die stärksten Fehlerfarben ersetzt.
    //
    //    Messung am ECHTEN Bild 128², jeweils identischer Zustand nach 4a (MSE 31.42):
    //      • 4b allein (4 Runden x 3):           30.15  in   0.6 s
    //      • Kandidaten-Battle allein:           29.51  in  10.8 s
    //      • 4b, DANN Battle:                    29.70  (4b nimmt dem Battle die Kandidaten)
    //    Pro Sekunde ist 4b ~12x effizienter, aber der Battle erreicht die bessere
    //    Endqualität. Deshalb: 4b nur dort, wo der Battle nicht läuft.
    if (intensity === 'langsam') {
        if (abortNow()) return finish();
        stageStart = performance.now();
        changeLog.push(`<div style="color:#28a745; font-size:12px; font-weight:bold; margin-top:6px;">♻️ Schwächster-Slot-Ersatz (Slots mit kleinstem Fehlerbeitrag → Top-Fehlerfarben)</div>`);
        await replaceWeakestSlots(appState, maxSlots, currentOffset, lockedSlots, step, metric, optRegion,
            triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, 8, 4);
        pushMseStand("Schritt 4b (Schwächster-Slot-Ersatz)", stageStart);
    } else {
        changeLog.push(`<div style="color:#888; font-size:11px; margin-top:4px;">♻️ Schwächster-Slot-Ersatz übersprungen — hier übernimmt der Kandidaten-Battle.</div>`);
    }

    // C. Kandidaten-Battle Bottom 50% (bei "normal" und "langsam")
    if (abortNow()) return finish();
    stageStart = performance.now();
    changeLog.push(`<div style="color:#e83e8c; font-size:12px; font-weight:bold; margin-top:6px;">🔸 Kandidaten-Battle (Bottom 50% wenigstgenutzte Slots)</div>`);

    const statsBattle = computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels,
        step, metric, config, optRegion
    );
    const histCandidates = getImageHistogram(
        appState.originalImageData, appState.currentImgW, appState.currentImgH,
        step, REPOP_HISTOGRAM_CANDIDATES,
        appState.globalPaletteRAM, currentOffset, optRegion
    );

    for (const item of bottom50Slots) {
        if (consumeAbort()) { changeLog.push('⏹️ Abgebrochen (Kandidaten-Battle).'); break; }
        const i = item.slotIdx;
        const absSlot = (currentOffset + i) % 256;
        const bitDepths = getSlotBitDepths(i, formatsInUse);

        const poolForBitDepth = [];
        for (const d of bitDepths) {
            if (statsBattle.global.byBitDepth[d]) poolForBitDepth.push(...statsBattle.global.byBitDepth[d]);
        }
        poolForBitDepth.sort((a, b) => b.mse - a.mse);

        const candidates = getClusteredCandidates(
            poolForBitDepth.length > 0 ? poolForBitDepth : statsBattle.global.top10,
            appState.globalPaletteRAM, maxCores
        );

        for (const hc of histCandidates) {
            if (!colorInPalette(appState.globalPaletteRAM, hc.r, hc.g, hc.b, 12) &&
                isDistinctFromAll(hc, candidates, MIN_DISTINCT_DIST_SQ)) {
                candidates.push({ r: hc.r, g: hc.g, b: hc.b });
            }
        }

        const currentColor = {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2]
        };

        const baseline = await runWorkerBattle([currentColor], battleArgs, absSlot);
        updateOptProgress(`Bottom 50% Battle: Slot ${i} (${item.useCount}x genutzt, Baseline MSE: ${baseline.score.toFixed(2)})...`);
        
        const results = await runWorkerBattleAll(candidates, battleArgs, absSlot);
        const winner = results[0];

        if (winner.score < baseline.score) {
            writeSlotColor(appState.globalPaletteRAM, absSlot, winner.candidate);
            changeLog.push(`⚔️ Bottom-Slot ${i} (${item.useCount}x): RGB(${winner.candidate.r}, ${winner.candidate.g}, ${winner.candidate.b}) [MSE: ${winner.score.toFixed(2)}]`);
            renderUIPalette();
            await new Promise(r => requestAnimationFrame(r));
            await triggerEncodeFn();
            await new Promise(r => requestAnimationFrame(r));
        } else {
            changeLog.push(`🛡️ Bottom-Slot ${i} (${item.useCount}x): Farbe beibehalten.`);
        }
    }
    pushMseStand("Schritt 4c (Bottom 50% Candidate Battle)", stageStart);

    if (intensity === 'normal') {
        const totalDurationSec = ((performance.now() - globalStart) / 1000).toFixed(2);
        const endMse = measureCurrentMse(appState, metric, optRegion);
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">✅ Normale Kaskaden-Optimierung beendet [End-MSE: ${endMse.toFixed(2)} | Gesamtdauer: ${totalDurationSec}s]</div>`);
        return finish();
    }

    // =======================================================================
    // SCHRITT 5: TIEFEN-OPTIMIERUNG (SIMULTAN-SHIFT 31..8 & 3x ANKER 7→1)
    // =======================================================================
    if (abortNow()) return finish();
    stageStart = performance.now();
    changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- SCHRITT 5: Tiefen-Optimierung (Simultan-Pool 31→8 & 3x Anker 7→1) ---</div>`);

    // Pre-Step 5 Auto-Injection für tote/wenig genutzte Slots (< 5 Nutzungen)
    const preStep5Usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    const lowUseSlots = [];
    for (let i = 1; i < maxSlots; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (!lockedSlots.has(absSlot) && preStep5Usage[i] < 5) lowUseSlots.push({ i, absSlot });
    }
    if (lowUseSlots.length > 0) {
        // Die Analyse ist innerhalb dieser Schleife konstant (das Decodiert-Bild
        // ändert sich erst beim nächsten Encode) — daher EINMAL berechnen und
        // daraus UNTERSCHIEDLICHE Fehlerfarben ziehen. Vorher bekamen alle Slots
        // dieselbe Farbe top10[0], was den Pool mit Duplikaten gefüllt hat.
        const stats5 = computeDetailedAnalysis(
            appState.originalImageData.data, appState.decodedImageData.data,
            appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion
        );
        const injCands = getErrorDrivenCandidates(stats5, appState.globalPaletteRAM, lowUseSlots.length + 8);
        for (let k = 0; k < lowUseSlots.length; k++) {
            const cand = injCands[k];
            if (!cand) break;
            writeSlotColor(appState.globalPaletteRAM, lowUseSlots[k].absSlot, cand);
            changeLog.push(`💉 Auto-Injection vor Schritt 5: Slot ${lowUseSlots[k].i} mit Fehlerfarbe RGB(${cand.r}, ${cand.g}, ${cand.b}) belegt.`);
        }
    }
    await triggerEncodeFn();

    let passSlow = 1;
    const MAX_SLOW_PASSES = 3;
    let lastPassMse = measureCurrentMse(appState, metric, optRegion);

    while (passSlow <= MAX_SLOW_PASSES) {
        if (consumeAbort()) { changeLog.push('⏹️ Abgebrochen (Schritt 5).'); break; }
        // 1. SIMULTANER PARALLELER SHIFT FÜR ALLE POOL-SLOTS (31 DOWN TO 8)
        updateOptProgress(`Pass ${passSlow}: Simultaner Vektor-Shift für Basis-Slots 31→8...`);
        await refineAllPoolSlotsParallel(8, maxSlots - 1, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, metric, optRegion, changeLog);

        // 2. STRIKT ABSTEIGENDE VEKTOR-LINIENSUCHE FÜR ANKER-SLOTS (7 DOWN TO 1)
        changeLog.push(`<div style="color:#28a745; font-size:11px; margin-top:4px;">🔹 Pass ${passSlow}: Absteigende Anker-Optimierung (7→1)</div>`);
        await runVectorLoopDescending(7, 1, 1, appState, maxSlots, currentOffset, lockedSlots, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette, changeLog, `Pass ${passSlow} Anker (7->1)`);

        // 3. SAFE-SORTIERUNG NACH JEDEM DURCHLAUF
        const newMse = await safeSortPalette(appState, maxSlots, currentOffset, lockedSlots, metric, optRegion, triggerEncodeFn, changeLog, renderUIPalette);
        const passGain = lastPassMse - newMse;
        lastPassMse = newMse;

        // EARLY-EXIT CHECK
        if (passGain < 0.10 && passSlow > 1) {
            changeLog.push(`⏱️ <span style="color:#ffc107;">Schritt 5 Early-Exit: MSE-Gewinn (Δ${passGain.toFixed(2)}) unter Schwelle (0.10).</span>`);
            break;
        }

        passSlow++;
    }
    pushMseStand("Schritt 5 (Tiefen-Optimierung)", stageStart);

    // FINALE ZUSAMMENFASSUNG LOGGING
    const totalDurationSec = ((performance.now() - globalStart) / 1000).toFixed(2);
    const endMse = measureCurrentMse(appState, metric, optRegion);
    const endUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    const activeFormatName = config.isMixed ? `Gemischt (${formatsInUse.join(', ')})` : appState.currentFormat;
    const endUsageStr = endUsage.map((cnt, idx) => idx > 0 ? `S${idx}:${cnt}x` : "").filter(Boolean).join(" | ");

    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:8px;">Format: ${activeFormatName}</div>`);
    changeLog.push(`<div style="color:#ccc; font-size:10px; background:#111; padding:4px; border-radius:3px;">Nutzung: ${endUsageStr || "Keine Anker verwendet"}</div>`);
    changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:5px;">Ergebnis: End-MSE ${endMse.toFixed(2)} | Gesamtdauer: ${totalDurationSec}s</div>`);

    return finish();
}

// ---------------------------------------------------------------------------
// PROXY-OPTIMIERUNG
//
// Die Optimierung kostet pro Durchlauf einen kompletten Bild-Encode. Auf einem
// 876x882-Bild dauert das Minuten. Da die Palette (31 Farben) kaum von der
// Auflösung abhängt, wird sie auf einem Vorschaubild optimiert und danach auf
// das Original angewendet. Messung an einem echten 876x882-Foto:
//   volle Auflösung (extrapoliert) ~13 min  |  Proxy 256x256: 67 s
//   Ergebnis auf voller Auflösung: MSE 33.6 statt 427 (leere Palette).
// ---------------------------------------------------------------------------
const PROXY_MAX_SIDE = 320;
const PROXY_FORCE_ABOVE = 512;   // ab dieser Kantenlänge wird der Proxy erzwungen

export async function runOptimizationWithProxy(appState, optRegion, step, metric, currentOffset, lockedSlots,
                                               updateOptProgress, triggerEncodeFn, renderUIPalette,
                                               intensity = 'langsam', useProxy = true) {
    const W = appState.currentImgW, H = appState.currentImgH;
    const maxSide = Math.max(W, H);

    // Auto-Budget: sehr große Bilder werden IMMER über den Proxy optimiert —
    // eine Vollbild-Optimierung dauert dort viele Minuten.
    let forced = false;
    if (maxSide > PROXY_FORCE_ABOVE && !useProxy) { useProxy = true; forced = true; }

    // Klein genug (oder Proxy abgewählt) → direkt optimieren
    if (!useProxy || maxSide <= PROXY_MAX_SIDE) {
        return await runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots,
            updateOptProgress, triggerEncodeFn, renderUIPalette, intensity);
    }

    const scale = PROXY_MAX_SIDE / maxSide;
    const pw = Math.max(16, Math.round(W * scale));
    const ph = Math.max(16, Math.round(H * scale));
    const proxyOpStart = Date.now();

    // Zustand sichern (die Palette ist das Ergebnis und bleibt erhalten)
    const saved = {
        original: appState.originalImageData,
        modified: appState.modifiedImageData,
        decoded: appState.decodedImageData,
        error: appState.errorViewData,
        commands: appState.latestCommandArray,
        packed: appState.latestPackedData,
        commandSource: appState.commandSource,
        W, H
    };
    const toProxy = (img) => img
        ? { width: pw, height: ph, data: downscaleRgba(img.data, W, H, pw, ph) }
        : null;

    appState.originalImageData = toProxy(saved.original);
    appState.modifiedImageData = toProxy(saved.modified);
    appState.decodedImageData = null;
    appState.errorViewData = null;
    appState.latestCommandArray = null;
    appState.latestPackedData = null;
    appState.commandSource = null;
    appState.currentImgW = pw;
    appState.currentImgH = ph;

    const proxyRegion = (optRegion && optRegion.width > 0)
        ? {
            x: Math.max(0, Math.round(optRegion.x * scale)),
            y: Math.max(0, Math.round(optRegion.y * scale)),
            width: Math.max(1, Math.round(optRegion.width * scale)),
            height: Math.max(1, Math.round(optRegion.height * scale))
        }
        : null;

    const factor = (maxSide / PROXY_MAX_SIDE).toFixed(1);
    const autoTxt = forced ? ' — automatisch aktiviert (Bild > ' + PROXY_FORCE_ABOVE + ' px)' : '';
    updateOptProgress(`Proxy ${pw}x${ph} (${factor}x kleiner)${autoTxt}: Vorab-Encode...`, 0, 1);

    // Einmal mit der aktuellen Palette encodieren: die Pipeline braucht ein
    // Decodiert-Bild (Prefill-Analyse, Kaskaden), genau wie im normalen Ablauf.
    const tEnc0 = Date.now();
    await triggerEncodeFn();
    const proxyEncodeMs = Math.max(1, Date.now() - tEnc0);

    // Dauer-Schätzung: aus dem letzten Lauf desselben Verfahrens (belastbar) oder
    // grob aus einem Faktor auf einen Encode. Die Live-Anzeige während des Laufs
    // korrigiert sich danach selbst (siehe updateOptProgress-Wrapper).
    const { ms: est, exact: estExact } = estimateOptimizationMs(proxyEncodeMs, intensity, pw * ph);
    const estTxt = est >= 1000 ? `~${Math.round(est / 1000)} s` : `~${est} ms`;
    const estLabel = estExact ? 'geschätzte Dauer' : 'grobe Schätzung';
    console.log(`[Palette] Proxy ${pw}x${ph}: Encode ${proxyEncodeMs} ms → ${estLabel} ${estTxt} (${intensity})${autoTxt}`);
    updateOptProgress(`Proxy ${pw}x${ph} (${factor}x kleiner)${autoTxt}, ${estLabel} ${estTxt}...`, 0, 1);

    let log;
    try {
        log = await runHybridOptimization(appState, proxyRegion, step, metric, currentOffset, lockedSlots,
            updateOptProgress, triggerEncodeFn, renderUIPalette, intensity);
    } finally {
        // Originalzustand wiederherstellen; nur die Palette ist das Ergebnis
        appState.originalImageData = saved.original;
        appState.modifiedImageData = saved.modified;
        appState.decodedImageData = saved.decoded;
        appState.errorViewData = saved.error;
        appState.latestCommandArray = saved.commands;
        appState.latestPackedData = saved.packed;
        appState.commandSource = saved.commandSource;
        appState.currentImgW = saved.W;
        appState.currentImgH = saved.H;
    }

    updateOptProgress(`Palette wird auf ${W}x${H} angewendet...`, 0, 1);
    await triggerEncodeFn();
    renderUIPalette();
    // Gesamtdauer der Proxy-Operation nachtragen (Vorab-Encode + Anwenden).
    setLastRunTotal(Date.now() - proxyOpStart);

    if (Array.isArray(log)) {
        // Die Dauer-Schätzung nur in der Statuszeile zu zeigen bringt wenig —
        // die wird sofort von der ersten Stufe überschrieben. Daher auch hier.
        log.unshift(`<div style="color:#6f42c1;">⏱️ Proxy-Vorab-Encode ${proxyEncodeMs} ms → ${estLabel} ${estTxt} (${intensity})</div>`);
        log.unshift(`<div style="color:#6f42c1; font-weight:bold;">🖼️ Proxy-Optimierung: auf ${pw}x${ph} optimiert, dann auf ${W}x${H} angewendet${forced ? ' (Proxy erzwungen: Bild > ' + PROXY_FORCE_ABOVE + ' px)' : ''}.</div>`);
    }
    return log;
}

export async function runManualRefinement(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette) {
    const tStart = performance.now();
    const config = HAM_CONFIGS[appState.currentFormat];
    const { maxSlots } = resolveBankLayout(appState.currentFormat, config);

    const startMse = measureCurrentMse(appState, metric, optRegion);
    const changeLog = [`<div style="color:#ffc107; font-weight:bold;">Manuelles Nachoptimieren (Start-MSE: ${startMse.toFixed(2)})</div>`];
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion, (msg) => changeLog.push(`<div style="color:#ffc107;">${msg}</div>`));

    updateOptProgress(`Starte manuelle Nachoptimierung (Vektor-Analyse)...`);
    const slotVectors = computeSlotErrorVectors(appState, maxSlots, optRegion);

    for (let i = maxSlots - 1; i >= 1; i--) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        const slotVector = slotVectors[i];

        const startColor = {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2]
        };

        const result = await refineSlotColorVector(startColor, absSlot, i, slotVector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
        if (result.didImprove) {
            const winScale = result.candidate.scale != null ? ` ×${(result.candidate.scale * 100).toFixed(0)}%` : "";
            changeLog.push(`✨ Slot ${i}: RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b})${winScale} [Neuer MSE: ${result.score.toFixed(2)}]`);
        }
    }

    const durationSec = ((performance.now() - tStart) / 1000).toFixed(2);
    const endMse = measureCurrentMse(appState, metric, optRegion);
    changeLog.push(`<div style="color:#28a745; font-size:11px;">⏱️ Dauer Manuelles Nachoptimieren: ${durationSec}s | End-MSE: ${endMse.toFixed(2)}</div>`);

    return changeLog;
}