// src/core/palette_optimizer.js
//
// Optimiert die Farbpalette (globalPaletteRAM) für HAM-Formate. Ablauf:
//   0.  Pre-Fill: Befüllt freie Slots vorab mit Histogramm-Farben.
//   0.5 Zero-Usage Eradication: Überschreibt ungenutzte Slots sofort 
//       mit den Top-Fehlern des letzten Encodes, bis alle Slots genutzt werden.
//   1.  Kandidaten-"Battle": Farbkandidaten werden parallel in Web Workern
//       getestet, der beste Kandidat gewinnt (runWorkerBattle).
//   2.  Vektor-Analyse + Liniensuche pro Slot (refineSlotColorVector):
//       Der mittlere Fehler-Vektor (ΔR,ΔG,ΔB) aller vom Slot abhängigen Pixel
//       spannt einen Fächer auf, der in Workern getestet wird.
//
// Öffentliche Einstiegspunkte:
//   - runManualRefinement  : manuelles Nachjustieren aller Slots einer Bank
//   - runHybridOptimization: Auto-Füllen mit einstellbarer Intensität ('fast', 'normal', 'max')

import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp } from '../codecs/utils.js';
import { computeDetailedAnalysis, computeAvgYuvScore, getImageHistogram } from './analysis.js';
import { encodePaletted, decodePaletted } from './module_paletted.js';

const VECTOR_SCALES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];

const REPOP_MAX_PASSES = 10;
const REPOP_POLISH_PASSES = 2;        
const REPOP_BOTTOM_RATIO = 0.10;      
const REPOP_HISTOGRAM_CANDIDATES = 8; 
const FINAL_POLISH_MAX_PASSES = 3;    
const MAX_ALTERNATING_CYCLES = 4;

// Luma-Gewichtungen für psycho-visuell korrekte Farbabstände
const LUMA_W_R = 0.299;
const LUMA_W_G = 0.587;
const LUMA_W_B = 0.114;

// Cluster-Abstände (Quadrierte Luma-Distanzen)
const MIN_PREFILL_DIST_SQ = 576;     // ca. 24 pro Kanal für Histogramm-Pre-Fill
const CLUSTER_RADIUS_SQ = 144;       // ca. 12 pro Kanal für Battle-Kandidaten
const MIN_DISTINCT_DIST_SQ = 576;    // ca. 24 pro Kanal für reguläre Direkt-Belegungen

let workerFallbackWarned = false;

// ---------------------------------------------------------------------------
// Gemeinsame Helfer & Farb-Distanz
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

function resolveBankLayout(format, config) {
    const formatsInUse = config?.isMixed ? [...new Set(config.sequence)] : [format];
    const capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a, b) => a - b);
    return { formatsInUse, maxSlots: capacities[capacities.length - 1] };
}

function getSlotBitDepths(i, formatsInUse) {
    const depths = new Set();
    for (const f of formatsInUse) {
        const cfg = HAM_CONFIGS[f];
        if (cfg && cfg.bits >= 4 && cfg.slotsPerBank && i < cfg.slotsPerBank) {
            depths.add(String(cfg.bits));
        }
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

function measureCurrentMse(appState, step, metric, config, optRegion) {
    const totalPixels = appState.currentImgW * appState.currentImgH;
    return computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels,
        step, metric, config, optRegion
    ).global.avgYuv;
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

// ---------------------------------------------------------------------------
// Kandidatenauswahl & Worker-Battle
// ---------------------------------------------------------------------------

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

async function runWorkerBattleAll(candidates, args, absSlot) {
    const { origData, imgW, imgH, format, step, metric, currentOffset, paletteRAM, optRegion, onWorkerFallback } = args;

    const promises = candidates.map(cand => new Promise((resolve) => {
        const worker = new Worker(new URL('./optimizer_worker.js', import.meta.url), { type: 'module' });
        let settled = false;
        let fallbackRunning = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            worker.terminate();
            resolve(result);
        };

        const fallback = async () => {
            if (settled || fallbackRunning) return;
            fallbackRunning = true;
            if (!workerFallbackWarned) {
                workerFallbackWarned = true;
                const msg = "⚠️ Worker-Battle nicht verfügbar — In-Thread-Bewertung aktiv.";
                if (typeof onWorkerFallback === 'function') onWorkerFallback(msg);
                else console.warn(msg);
            }
            try {
                const score = await computeCandidateScoreInThread(cand, args, absSlot);
                finish({ candidate: cand, score });
            } catch (err) {
                finish({ candidate: cand, score: Infinity });
            }
        };

        worker.onmessage = (e) => {
            if (e.data && e.data.score === Infinity) { fallback(); return; }
            finish(e.data);
        };
        worker.onerror = () => fallback();
        worker.onmessageerror = () => fallback();

        worker.postMessage({
            candidate: cand,
            origData, imgW, imgH, format, step, metric,
            offset: currentOffset,
            basePaletteRAM: paletteRAM,
            slotToFill: absSlot,
            optRegion
        });
    }));

    const results = await Promise.all(promises);
    results.sort((a, b) => a.score - b.score);
    return results;
}

async function runWorkerBattle(candidates, args, absSlot) {
    return (await runWorkerBattleAll(candidates, args, absSlot))[0];
}

// ---------------------------------------------------------------------------
// Slot-Feinabstimmung (Vektor-Liniensuche)
// ---------------------------------------------------------------------------

async function refineSlotColorVector(startColor, absSlot, slotIdx, vector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette) {
    const { paletteRAM } = battleArgs;
    const baseline = await runWorkerBattle([startColor], battleArgs, absSlot);

    const candidates = VECTOR_SCALES.map(scale => ({
        r: clamp(Math.round(startColor.r + vector.dR * scale), 0, 255),
        g: clamp(Math.round(startColor.g + vector.dG * scale), 0, 255),
        b: clamp(Math.round(startColor.b + vector.dB * scale), 0, 255),
        scale
    }));

    const best = await runWorkerBattle(candidates, battleArgs, absSlot);

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
// Slot-Reihenfolge
// ---------------------------------------------------------------------------

function generateHierarchicalSlotOrder(maxSlots) {
    if (maxSlots < 31) {
        const order = [];
        for (let i = maxSlots - 1; i >= 1; i--) order.push(i);
        return order;
    }

    const ham04Slots = [1, 2, 3, 4, 5, 6, 7];
    const ham06Blocks = [
        [8, 9, 10, 11], [12, 13, 14, 15], [16, 17, 18, 19],
        [20, 21, 22, 23], [24, 25, 26, 27], [28, 29, 30, 31]
    ];

    const order = [];
    ham06Blocks.forEach((block, i) => {
        order.push(...block);
        if (i < ham04Slots.length) order.push(ham04Slots[i]);
    });
    order.push(...ham04Slots.slice(ham06Blocks.length));
    return order;
}

// ---------------------------------------------------------------------------
// Force-Fill "Zero-Usage Eradication"
// ---------------------------------------------------------------------------

async function forceFillUnusedSlots(appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, phaseName) {
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const MAX_PASSES = 5;
    let anyChange = false;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
        const unusedSlots = [];
        for (let i = 1; i < maxSlots; i++) {
            if (!lockedSlots.has((currentOffset + i) % 256) && usage[i] === 0) {
                unusedSlots.push(i);
            }
        }

        if (unusedSlots.length === 0) break;

        updateOptProgress(`${phaseName}: Fülle ${unusedSlots.length} ungenutzte Slots mit Fehlerfarben (Pass ${pass + 1})...`);

        const stats = computeDetailedAnalysis(
            appState.originalImageData.data, appState.decodedImageData.data,
            appState.currentImgW, appState.currentImgH, 0, totalPixels,
            step, metric, config, optRegion
        );

        const candidates = getClusteredCandidates(stats.global.top10, appState.globalPaletteRAM, unusedSlots.length * 2, CLUSTER_RADIUS_SQ);

        let placed = 0;
        for (const i of unusedSlots) {
            if (placed >= candidates.length) break;
            const absSlot = (currentOffset + i) % 256;
            writeSlotColor(appState.globalPaletteRAM, absSlot, candidates[placed]);
            placed++;
        }

        if (placed === 0) {
            changeLog.push(`${phaseName}: Keine weiteren Fehlerfarben gefunden.`);
            break;
        }

        changeLog.push(`💉 ${phaseName}: ${placed} ungenutzte Slots direkt mit Kanten-Fehlern überschrieben.`);
        anyChange = true;

        renderUIPalette();
        await new Promise(r => requestAnimationFrame(r));
        await triggerEncodeFn();
        await new Promise(r => requestAnimationFrame(r));
    }
    return anyChange;
}

// ---------------------------------------------------------------------------
// Öffentliche Einstiegspunkte
// ---------------------------------------------------------------------------

async function runVectorRefinementPass(passNum, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    const order = [];
    for (let i = 1; i < maxSlots; i++) order.push(i);
    order.sort((a, b) => usage[b] - usage[a]);

    const imgW = appState.currentImgW;
    const imgH = appState.currentImgH;
    const { metric } = battleArgs;
    let currentMse = computeAvgYuvScore(
        appState.originalImageData.data, appState.decodedImageData.data,
        imgW, imgH, metric, optRegion
    );

    let anyChange = false;
    for (const i of order) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        updateOptProgress(`Durchlauf ${passNum}: Vektor-Liniensuche für Slot ${i}... (MSE: ${currentMse.toFixed(2)})`);

        const slotVector = computeSlotErrorVectors(appState, maxSlots, optRegion)[i];
        if (slotVector.count === 0) continue;

        const startColor = {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2]
        };

        const result = await refineSlotColorVector(startColor, absSlot, i, slotVector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
        if (result.didImprove) {
            anyChange = true;
            currentMse = computeAvgYuvScore(
                appState.originalImageData.data, appState.decodedImageData.data,
                imgW, imgH, metric, optRegion
            );
            const winScale = result.candidate.scale != null ? ` ×${(result.candidate.scale * 100).toFixed(0)}%` : "";
            changeLog.push(`✨ Slot ${i} (Durchlauf ${passNum}): RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b})${winScale} [Neuer MSE: ${result.score.toFixed(2)}]`);
        }
    }
    return anyChange;
}

export async function runManualRefinement(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const { maxSlots } = resolveBankLayout(appState.currentFormat, config);

    const startMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const changeLog = [`<div style="color:#ffc107; font-weight:bold;">Manuelles Nachoptimieren (Start-MSE: ${startMse.toFixed(2)})</div>`];
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion, (msg) => changeLog.push(`<div style="color:#ffc107;">${msg}</div>`));

    updateOptProgress(`Starte manuelle Nachoptimierung (Vektor-Analyse)...`);

    for (let i = maxSlots - 1; i >= 1; i--) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        const slotVector = computeSlotErrorVectors(appState, maxSlots, optRegion)[i];
        if (slotVector.count === 0) continue;

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

    const endMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const endUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    const usageStr = endUsage.map((cnt, idx) => idx > 0 ? `S${idx}:${cnt}x` : "").filter(Boolean).join(", ");

    changeLog.push(`<div style="color:#aaa; font-size:10px;">Nutzung (nach Optimierung): ${usageStr}</div>`);
    changeLog.push(`<div style="color:#28a745; font-weight:bold;">Beendet: Vorher ${startMse.toFixed(2)} ➔ Nachher ${endMse.toFixed(2)}</div>`);

    return changeLog;
}

async function battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSlots, usage, phaseLabel, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const maxCores = navigator.hardwareConcurrency || 4;

    const stats = computeDetailedAnalysis(
        appState.originalImageData.data, appState.decodedImageData.data,
        appState.currentImgW, appState.currentImgH, 0, totalPixels,
        battleArgs.step, battleArgs.metric, config, optRegion
    );
    const histogramCandidates = getImageHistogram(
        appState.originalImageData, appState.currentImgW, appState.currentImgH,
        battleArgs.step, REPOP_HISTOGRAM_CANDIDATES,
        appState.globalPaletteRAM, currentOffset, optRegion
    );

    let anyChange = false;
    for (const i of [...targetSlots].sort((a, b) => usage[a] - usage[b])) {
        const absSlot = (currentOffset + i) % 256;
        const bitDepths = getSlotBitDepths(i, formatsInUse);

        const poolForBitDepth = [];
        for (const d of bitDepths) {
            if (stats.global.byBitDepth[d]) poolForBitDepth.push(...stats.global.byBitDepth[d]);
        }
        poolForBitDepth.sort((a, b) => b.mse - a.mse);

        const candidates = getClusteredCandidates(
            poolForBitDepth.length > 0 ? poolForBitDepth : stats.global.top10,
            appState.globalPaletteRAM, maxCores
        );

        for (const hc of histogramCandidates) {
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
        updateOptProgress(`${phaseLabel}: Battle für Slot ${i} (${usage[i]}x genutzt, MSE: ${baseline.score.toFixed(2)})...`);
        
        const results = await runWorkerBattleAll(candidates, battleArgs, absSlot);
        const winner = results[0];

        if (winner.score >= baseline.score) {
            changeLog.push(`Slot ${i} (${phaseLabel}, ${usage[i]}x): keine Verbesserung — Farbe bleibt.`);
            continue;
        }

        writeSlotColor(appState.globalPaletteRAM, absSlot, winner.candidate);
        const labelName = i <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
        changeLog.push(`✨ Slot ${i} (${phaseLabel}, ${labelName}, ${usage[i]}x): RGB(${winner.candidate.r}, ${winner.candidate.g}, ${winner.candidate.b}) [MSE: ${winner.score.toFixed(2)}]`);
        anyChange = true;

        renderUIPalette();
        await new Promise(r => requestAnimationFrame(r));
        await triggerEncodeFn();
        await new Promise(r => requestAnimationFrame(r));
        usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    }
    return anyChange;
}

async function runSlotRepopulationPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const bottomCount = Math.max(1, Math.round((maxSlots - 1) * REPOP_BOTTOM_RATIO));

    const unlockedOrder = () => {
        const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
        const order = [];
        for (let i = 1; i < maxSlots; i++) {
            if (!lockedSlots.has((currentOffset + i) % 256)) order.push(i);
        }
        order.sort((a, b) => usage[a] - usage[b]);
        return { usage, order };
    };

    for (let pass = 1; pass <= REPOP_MAX_PASSES; pass++) {
        const { usage, order } = unlockedOrder();
        const unusedCount = order.filter(i => usage[i] === 0).length;
        if (unusedCount === 0) {
            if (pass > 1) changeLog.push(`Durchlauf 1+ (Pass ${pass - 1}): alle Slots werden genutzt.`);
            break;
        }

        const targetSet = new Set(order.slice(0, unusedCount + bottomCount));
        updateOptProgress(`Durchlauf 1+ (Pass ${pass}/${REPOP_MAX_PASSES}): ${unusedCount} ungenutzte Slots, battle ${targetSet.size} Slots...`);
        const anyChange = await battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSet, usage, `1+, Pass ${pass}`, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        if (!anyChange) {
            changeLog.push(`Durchlauf 1+ (Pass ${pass}): keine Verbesserung möglich — Abbruch.`);
            break;
        }
    }

    for (let pass = 1; pass <= REPOP_POLISH_PASSES; pass++) {
        const { usage, order } = unlockedOrder();
        const targetSet = new Set(order.slice(0, bottomCount));
        updateOptProgress(`Durchlauf 1+ (Politur ${pass}/${REPOP_POLISH_PASSES}): untere ${targetSet.size} Slots batteln...`);
        const anyChange = await battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSet, usage, `1+ Politur ${pass}`, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        if (!anyChange) {
            changeLog.push(`Durchlauf 1+ (Politur ${pass}): keine Verbesserung — Abbruch.`);
            break;
        }
    }
}

async function runFinalPolishPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    let anyPassChange = false;
    for (let pass = 1; pass <= FINAL_POLISH_MAX_PASSES; pass++) {
        const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
        const targetSet = new Set();
        for (let i = 1; i < maxSlots; i++) {
            if (!lockedSlots.has((currentOffset + i) % 256)) targetSet.add(i);
        }
        updateOptProgress(`Feinschliff (Pass ${pass}/${FINAL_POLISH_MAX_PASSES}): ${targetSet.size} Slots voll batteln...`);
        const anyChange = await battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSet, usage, `Feinschliff Pass ${pass}`, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        if (anyChange) anyPassChange = true;
        if (!anyChange) {
            changeLog.push(`Feinschliff (Pass ${pass}): keine Verbesserung — Konvergenz erreicht.`);
            break;
        }
    }
    return anyPassChange;
}

export async function runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette, intensity = 'langsam') {
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const { formatsInUse, maxSlots } = resolveBankLayout(appState.currentFormat, config);
    const maxCores = navigator.hardwareConcurrency || 4;
    const changeLog = [];
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion, (msg) => changeLog.push(`<div style="color:#ffc107;">${msg}</div>`));
    const slotOrder = generateHierarchicalSlotOrder(maxSlots);

    // -----------------------------------------------------------------------
    // STUFE 0: Pre-Fill (Histogramm-Clustering)[cite: 4]
    // -----------------------------------------------------------------------
    changeLog.push(`<div style="color:#6f42c1; font-weight:bold; margin-top:5px;">--- PRE-FILL (Histogramm-Clustering) ---</div>`);
    updateOptProgress(`Analysiere Bild-Histogramm für initialen Pre-Fill...`);

    const hist = getImageHistogram(
        appState.originalImageData, appState.currentImgW, appState.currentImgH,
        step, 1000, appState.globalPaletteRAM, currentOffset, optRegion
    );

    const prefillColors = [];
    for (const hc of hist) {
        let isDistinct = true;
        for (const pc of prefillColors) {
            if (colorDistanceSq(hc, pc) < MIN_PREFILL_DIST_SQ) {
                isDistinct = false;
                break;
            }
        }
        if (isDistinct) {
            prefillColors.push(hc);
            if (prefillColors.length >= maxSlots) break;
        }
    }

    let prefillIdx = 0, prefillCount = 0;
    for (const i of slotOrder) {
        if (i >= maxSlots) continue;
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;
        
        if (prefillIdx < prefillColors.length) {
            writeSlotColor(appState.globalPaletteRAM, absSlot, prefillColors[prefillIdx]);
            prefillIdx++;
            prefillCount++;
        }
    }

    changeLog.push(`Pre-Fill: ${prefillCount} Slots mit geclusterten Histogramm-Farben (Min-Distanz 24) belegt.`);
    renderUIPalette();
    await new Promise(r => requestAnimationFrame(r));
    
    updateOptProgress(`Erster Encode/Decode mit Pre-Fill Palette...`);
    await triggerEncodeFn();
    await new Promise(r => requestAnimationFrame(r));

    const startMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const startUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    let mseStand = startMse;
    const pushMseStand = (phaseLabel) => {
        const mse = measureCurrentMse(appState, step, metric, config, optRegion);
        const diff = mseStand - mse;
        const diffTxt = Math.abs(diff) < 0.005 ? "" : (diff > 0 ? ` (−${diff.toFixed(2)})` : ` (+${(-diff).toFixed(2)})`);
        changeLog.push(`<div style="color:#17a2b8; font-size:11px; margin-top:2px;">📊 Nach ${phaseLabel}: MSE ${mse.toFixed(2)}${diffTxt}</div>`);
        mseStand = mse;
    };

    // -----------------------------------------------------------------------
    // STUFE 0.5: Force-Fill / Zero-Usage Eradication[cite: 4]
    // -----------------------------------------------------------------------
    await forceFillUnusedSlots(appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, "Pre-Fill Korrektur");
    pushMseStand("Pre-Fill Korrektur");

    // Wenn 'sehr_schnell' gewählt ist, stoppen wir hier direkt nach Stufe 0.5.
    if (intensity === 'sehr_schnell') {
        changeLog.push(`<div style="color:#28a745; margin-top:5px; font-weight:bold;">Sehr schnelles Füllen (Stufe 0.5) abgeschlossen.</div>`);
    } else {
        // -----------------------------------------------------------------------
        // STUFE 1: Kandidaten-Battle (Durchlauf 1)[cite: 4]
        // -----------------------------------------------------------------------
        changeLog.push(`<div style="color:#4dabf7; font-weight:bold; margin-top:5px;">--- DURCHLAUF 1 (Kandidaten-Battle) ---</div>`);
        const filled = new Set(); 

        for (let qi = 0; qi < slotOrder.length; qi++) {
            const i = slotOrder[qi];
            if (i >= maxSlots) continue;
            if (filled.has(i)) continue;
            const absSlot = (currentOffset + i) % 256;
            if (lockedSlots.has(absSlot)) continue;

            const bitDepths = getSlotBitDepths(i, formatsInUse);
            const usageCount = getSlotUsageSummary(appState.latestCommandArray, maxSlots)[i] || 0;

            const stats = computeDetailedAnalysis(appState.originalImageData.data, appState.decodedImageData.data, appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion);
            updateOptProgress(`Durchlauf 1: Battle für Slot ${i} (${[...bitDepths].join('+')}-bit Ebene, MSE: ${stats.global.avgYuv.toFixed(2)})...`);

            const poolForBitDepth = [];
            for (const d of bitDepths) {
                if (stats.global.byBitDepth[d]) poolForBitDepth.push(...stats.global.byBitDepth[d]);
            }
            poolForBitDepth.sort((a, b) => b.mse - a.mse);

            const candidates = getClusteredCandidates(poolForBitDepth.length > 0 ? poolForBitDepth : stats.global.top10, appState.globalPaletteRAM, maxCores);
            const results = await runWorkerBattleAll(candidates, battleArgs, absSlot);

            const winner = results[0];
            let needsEncode = false;
            
            writeSlotColor(appState.globalPaletteRAM, absSlot, winner.candidate);
            filled.add(i);
            needsEncode = true;

            const labelName = i <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
            changeLog.push(`⚔️ Slot ${i} (${labelName}, ${usageCount}x genutzt): RGB(${winner.candidate.r}, ${winner.candidate.g}, ${winner.candidate.b}) [Battle MSE: ${winner.score.toFixed(2)}]`);

            const placedColors = [winner.candidate];
            let runnerCount = 0;
            for (let r = 1; r < results.length && runnerCount < 2; r++) {
                const runner = results[r];
                if (!Number.isFinite(runner.score)) continue;
                if (!isDistinctFromAll(runner.candidate, placedColors, MIN_DISTINCT_DIST_SQ)) continue;

                let targetJ = -1;
                for (let k = qi + 1; k < slotOrder.length; k++) {
                    const j = slotOrder[k];
                    if (j >= maxSlots) continue;
                    if (filled.has(j)) continue;
                    if (lockedSlots.has((currentOffset + j) % 256)) continue;
                    targetJ = j;
                    break;
                }
                if (targetJ === -1) break;

                const targetAbs = (currentOffset + targetJ) % 256;
                const targetCurrent = {
                    r: appState.globalPaletteRAM[targetAbs * 3],
                    g: appState.globalPaletteRAM[targetAbs * 3 + 1],
                    b: appState.globalPaletteRAM[targetAbs * 3 + 2]
                };
                const baseline = await runWorkerBattle([targetCurrent], battleArgs, targetAbs);
                const placed = await runWorkerBattle([runner.candidate], battleArgs, targetAbs);
                
                if (placed.score >= baseline.score) continue; 

                writeSlotColor(appState.globalPaletteRAM, targetAbs, placed.candidate);
                filled.add(targetJ);
                placedColors.push(placed.candidate);
                runnerCount++;
                needsEncode = true;

                const targetLabel = targetJ <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
                changeLog.push(`⚡ Slot ${targetJ} (${targetLabel}, direkt von Slot ${i}): RGB(${placed.candidate.r}, ${placed.candidate.g}, ${placed.candidate.b}) [MSE: ${placed.score.toFixed(2)}]`);
            }

            if (needsEncode) {
                renderUIPalette();
                await new Promise(r => requestAnimationFrame(r));
                await triggerEncodeFn();
                await new Promise(r => requestAnimationFrame(r));
            }
        }
        pushMseStand("Durchlauf 1 (Battle)");

        // Wenn 'normal' gewählt ist, stoppen wir hier nach Stufe 1 (Kandidaten-Battle).
        if (intensity === 'normal') {
            changeLog.push(`<div style="color:#28a745; margin-top:5px; font-weight:bold;">Normaler Modus (bis Stufe 1 - Kandidaten-Battle) abgeschlossen.</div>`);
        } else if (intensity === 'langsam') {
            // -----------------------------------------------------------------------
            // KOMPLETTES OPTIMUM SUCHEN (Volle Pipeline)[cite: 4]
            // -----------------------------------------------------------------------
            changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- DURCHLAUF 1+ (Slot-Nachbesiedlung) ---</div>`);
            await runSlotRepopulationPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
            pushMseStand("Durchlauf 1+ (Nachbesiedlung)");

            await forceFillUnusedSlots(appState, maxSlots, currentOffset, lockedSlots, optRegion, step, metric, config, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog, "Vor Runde 2 (Zero-Usage Garantie)");
            pushMseStand("Zero-Usage Eradication");

            changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF 2 (Vektor-Feinoptimierung) ---</div>`);
            await runVectorRefinementPass(2, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
            pushMseStand("Durchlauf 2 (Vektor-Feinoptimierung)");

            changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF 3 (Vektor-Feinoptimierung) ---</div>`);
            const d3Changed = await runVectorRefinementPass(3, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
            pushMseStand("Durchlauf 3 (Vektor-Feinoptimierung)");

            let cycle = 1;
            let lastVectorChanged = d3Changed;
            while (cycle <= MAX_ALTERNATING_CYCLES) {
                changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- FEINSCHLIFF (volle Palette batteln${cycle > 1 ? `, Zyklus ${cycle}` : ''}) ---</div>`);
                const polishChanged = await runFinalPolishPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
                pushMseStand(`Feinschliff (Zyklus ${cycle})`);

                if (!polishChanged && !lastVectorChanged) break;

                const passNum = 3 + cycle; 
                changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF ${passNum} (Vektor-Feinoptimierung) ---</div>`);
                lastVectorChanged = await runVectorRefinementPass(passNum, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
                pushMseStand(`Durchlauf ${passNum} (Vektor-Feinoptimierung)`);

                if (!polishChanged && !lastVectorChanged) break;
                cycle++;
            }
        }
    }

    const endMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const endUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    const activeFormatName = config.isMixed ? `Gemischt (${formatsInUse.join(', ')})` : appState.currentFormat;
    const startUsageStr = startUsage.map((cnt, idx) => idx > 0 ? `Slot ${idx}: ${cnt}x` : "").filter(Boolean).join(" | ");
    const endUsageStr = endUsage.map((cnt, idx) => idx > 0 ? `Slot ${idx}: ${cnt}x` : "").filter(Boolean).join(" | ");

    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:8px;">Format: ${activeFormatName}</div>`);
    changeLog.push(`<div style="color:#ccc; font-size:10px; background:#111; padding:4px; border-radius:3px;">Nutzung vor Start: ${startUsageStr || "Keine Anker verwendet"}</div>`);
    changeLog.push(`<div style="color:#ccc; font-size:10px; background:#111; padding:4px; border-radius:3px;">Nutzung nach Optimierung: ${endUsageStr || "Keine Anker verwendet"}</div>`);
    changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:5px;">Ergebnis: Vorher ${startMse.toFixed(2)} ➔ Nachher ${endMse.toFixed(2)}</div>`);

    return changeLog;
}