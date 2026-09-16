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
        const totalPixels = battleArgs.imgW * battleArgs.imgH;
        const stats = computeDetailedAnalysis(
            battleArgs.origData, battleArgs.origData, 
            battleArgs.imgW, battleArgs.imgH, 0, totalPixels,
            battleArgs.step, battleArgs.metric, null, battleArgs.optRegion
        );

        const topErrors = stats.global.top10 || [];
        const reactCandidates = topErrors.slice(0, 4).map(e => ({ r: e.r1, g: e.g1, b: e.b1 }));

        if (reactCandidates.length > 0) {
            updateOptProgress(`Slot ${slotIdx} hat 0 Nutzungen — Versuche Reaktivierung mit Fehlerfarben...`);
            const baseline = await runWorkerBattle([startColor], battleArgs, absSlot);
            const best = await runWorkerBattleAll(reactCandidates, battleArgs, absSlot);

            if (best[0] && best[0].score < baseline.score) {
                writeSlotColor(paletteRAM, absSlot, best[0].candidate);
                updateOptProgress(`🔥 Slot ${slotIdx} reaktiviert mit Fehlerfarbe! [MSE: ${best[0].score.toFixed(2)}]`);
                renderUIPalette();
                await new Promise(r => requestAnimationFrame(r));
                await triggerEncodeFn();
                await new Promise(r => requestAnimationFrame(r));
                return { candidate: best[0].candidate, score: best[0].score, didImprove: true };
            }
        }
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
        anyImproved = false;
        const slotVectors = computeSlotErrorVectors(appState, maxSlots, battleArgs.optRegion);

        for (let slotIdx = maxSlot; slotIdx >= minSlot; slotIdx--) {
            const absSlot = (currentOffset + slotIdx) % 256;
            if (lockedSlots.has(absSlot)) continue;

            updateOptProgress(`${label} (Pass ${loopPass}): Slot ${slotIdx}...`);
            const slotVector = slotVectors[slotIdx];
            const usageCount = getSlotUsageSummary(appState.latestCommandArray, maxSlots)[slotIdx] || 0;

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

export async function runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette, intensity = 'langsam') {
    const globalStart = performance.now();
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
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

    let prefillIdx = 0;
    for (let i = 8; i < maxSlots; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;
        if (prefillIdx < hist.length) {
            writeSlotColor(appState.globalPaletteRAM, absSlot, hist[prefillIdx]);
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
        const totalDurationSec = ((performance.now() - globalStart) / 1000).toFixed(2);
        const endMse = measureCurrentMse(appState, metric, optRegion);
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">⚡ Sehr schnelle Optimierung beendet [End-MSE: ${endMse.toFixed(2)} | Gesamtdauer: ${totalDurationSec}s]</div>`);
        return changeLog;
    }

    // SCHRITT 4: 50/50 USAGE-PARTITIONING (TOP 50% VEKTOR | BOTTOM 50% BATTLE)
    stageStart = performance.now();
    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- SCHRITT 4: Nutzungs-Partitionierung (Top 50% Vektor | Bottom 50% Battle) ---</div>`);

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

    // B. Kandidaten-Battle Bottom 50%
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
    pushMseStand("Schritt 4b (Bottom 50% Candidate Battle)", stageStart);

    if (intensity === 'normal') {
        const totalDurationSec = ((performance.now() - globalStart) / 1000).toFixed(2);
        const endMse = measureCurrentMse(appState, metric, optRegion);
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">✅ Normale Kaskaden-Optimierung beendet [End-MSE: ${endMse.toFixed(2)} | Gesamtdauer: ${totalDurationSec}s]</div>`);
        return changeLog;
    }

    // =======================================================================
    // SCHRITT 5: TIEFEN-OPTIMIERUNG (SIMULTAN-SHIFT 31..8 & 3x ANKER 7→1)
    // =======================================================================
    stageStart = performance.now();
    changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- SCHRITT 5: Tiefen-Optimierung (Simultan-Pool 31→8 & 3x Anker 7→1) ---</div>`);

    // Pre-Step 5 Auto-Injection für tote/wenig genutzte Slots (< 5 Nutzungen)
    const preStep5Usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    for (let i = 1; i < maxSlots; i++) {
        const absSlot = (currentOffset + i) % 256;
        if (!lockedSlots.has(absSlot) && preStep5Usage[i] < 5) {
            const stats = computeDetailedAnalysis(
                appState.originalImageData.data, appState.decodedImageData.data,
                appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion
            );
            const topErr = stats.global.top10[0];
            if (topErr) {
                writeSlotColor(appState.globalPaletteRAM, absSlot, { r: topErr.r1, g: topErr.g1, b: topErr.b1 });
                changeLog.push(`💉 Auto-Injection vor Schritt 5: Slot ${i} mit HAM-Fehler belegt.`);
            }
        }
    }
    await triggerEncodeFn();

    let passSlow = 1;
    const MAX_SLOW_PASSES = 3;
    let lastPassMse = measureCurrentMse(appState, metric, optRegion);

    while (passSlow <= MAX_SLOW_PASSES) {
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

    return changeLog;
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