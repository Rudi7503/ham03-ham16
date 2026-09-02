// src/core/palette_optimizer.js
//
// Optimiert die Farbpalette (globalPaletteRAM) für HAM-Formate. Ablauf:
//   1. Kandidaten-"Battle": mehrere Farbkandidaten werden parallel in Web Workern
//      getestet, der beste Kandidat gewinnt (runWorkerBattle).
//   2. Hill-Climbing-Feinabstimmung pro Slot (refineSlotColor).
//
// Öffentliche Einstiegspunkte:
//   - runManualRefinement  : manuelles Nachjustieren aller Slots einer Bank
//   - runHybridOptimization: Auto-Füllen (Battle + optionaler Feinpass)

import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp } from '../codecs/utils.js';
import { computeDetailedAnalysis } from './analysis.js';

// ---------------------------------------------------------------------------
// Gemeinsame Helfer
// ---------------------------------------------------------------------------

/**
 * Ermittelt die aktiven Formate und die maximale Slot-Anzahl der Bank.
 * Berücksichtigt gemischte Formate über config.sequence.
 */
function resolveBankLayout(format, config) {
    const formatsInUse = config?.isMixed ? [...new Set(config.sequence)] : [format];
    const capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a, b) => a - b);
    return { formatsInUse, maxSlots: capacities[capacities.length - 1] };
}

/** Bündelt die wiederkehrenden Argumente für die Worker-Battles. */
function createBattleArgs(appState, step, metric, currentOffset, optRegion) {
    return {
        origData: appState.originalImageData.data,
        imgW: appState.currentImgW,
        imgH: appState.currentImgH,
        format: appState.currentFormat,
        step,
        metric,
        currentOffset,
        paletteRAM: appState.globalPaletteRAM,
        optRegion
    };
}

/** Aktueller MSE des decodierten Bildes gegenüber dem Original. */
function measureCurrentMse(appState, step, metric, config, optRegion) {
    const totalPixels = appState.currentImgW * appState.currentImgH;
    return computeDetailedAnalysis(
        appState.originalImageData.data,
        appState.decodedImageData.data,
        appState.currentImgW,
        appState.currentImgH,
        0,
        totalPixels,
        step,
        metric,
        config,
        optRegion
    ).global.avgYuv;
}

/** Zählt, wie oft jeder bank-lokale Slot als Anker verwendet wurde. */
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

// ---------------------------------------------------------------------------
// Kandidatenauswahl & Worker-Battle
// ---------------------------------------------------------------------------

function getCandidatesFromPool(pool, paletteRAM, maxCores, threshold = 8) {
    const candidates = [];
    const seen = new Set();

    for (const err of pool) {
        const key = `${err.r1},${err.g1},${err.b1}`;
        if (seen.has(key)) continue;

        let exists = false;
        for (let slot = 0; slot < 256; slot++) {
            if (Math.abs(err.r1 - paletteRAM[slot * 3]) + Math.abs(err.g1 - paletteRAM[slot * 3 + 1]) + Math.abs(err.b1 - paletteRAM[slot * 3 + 2]) <= threshold) {
                exists = true;
                break;
            }
        }

        if (!exists) {
            candidates.push({ r: err.r1, g: err.g1, b: err.b1 });
            seen.add(key);
            if (candidates.length >= maxCores) break;
        }
    }

    while (candidates.length < maxCores) {
        const base = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : { r1: 128, g1: 128, b1: 128 };
        const mutR = clamp(base.r1 + (Math.random() * 64 - 32), 0, 255);
        const mutG = clamp(base.g1 + (Math.random() * 64 - 32), 0, 255);
        const mutB = clamp(base.b1 + (Math.random() * 64 - 32), 0, 255);
        candidates.push({ r: Math.round(mutR), g: Math.round(mutG), b: Math.round(mutB) });
    }

    return candidates;
}

/**
 * Testet mehrere Farbkandidaten parallel in Workern und liefert den besten zurück.
 * `absSlot` ist der absolute Palette-Slot, in den der Kandidat eingesetzt wird.
 */
async function runWorkerBattle(candidates, args, absSlot) {
    const { origData, imgW, imgH, format, step, metric, currentOffset, paletteRAM, optRegion } = args;

    const promises = candidates.map(cand => new Promise((resolve) => {
        const worker = new Worker(new URL('./optimizer_worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
            resolve(e.data);
            worker.terminate();
        };
        worker.onerror = () => {
            resolve({ candidate: cand, score: Infinity });
            worker.terminate();
        };
        worker.postMessage({
            candidate: cand,
            origData,
            imgW,
            imgH,
            format,
            step,
            metric,
            offset: currentOffset,
            basePaletteRAM: paletteRAM,
            slotToFill: absSlot,
            optRegion
        });
    }));

    const results = await Promise.all(promises);
    results.sort((a, b) => a.score - b.score);
    return results[0];
}

// ---------------------------------------------------------------------------
// Slot-Feinabstimmung (Hill Climbing)
// ---------------------------------------------------------------------------

async function refineSlotColor(startColor, absSlot, slotIdx, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette) {
    const { paletteRAM } = battleArgs;

    const baselineMatch = await runWorkerBattle([startColor], battleArgs, absSlot);

    let currentScore = baselineMatch.score;
    let bestColor = baselineMatch.candidate;
    let delta = 4;
    let improved = false;

    while (delta >= 1) {
        const candidates = [
            { r: clamp(bestColor.r + delta, 0, 255), g: bestColor.g, b: bestColor.b },
            { r: clamp(bestColor.r - delta, 0, 255), g: bestColor.g, b: bestColor.b },
            { r: bestColor.r, g: clamp(bestColor.g + delta, 0, 255), b: bestColor.b },
            { r: bestColor.r, g: clamp(bestColor.g - delta, 0, 255), b: bestColor.b },
            { r: bestColor.r, g: bestColor.g, b: clamp(bestColor.b + delta, 0, 255) },
            { r: bestColor.r, g: bestColor.g, b: clamp(bestColor.b - delta, 0, 255) }
        ];

        const bestMatch = await runWorkerBattle(candidates, battleArgs, absSlot);

        if (bestMatch.score < currentScore) {
            currentScore = bestMatch.score;
            bestColor = bestMatch.candidate;
            improved = true;

            paletteRAM[absSlot * 3] = bestColor.r;
            paletteRAM[absSlot * 3 + 1] = bestColor.g;
            paletteRAM[absSlot * 3 + 2] = bestColor.b;

            updateOptProgress(`Slot ${slotIdx} (Hill Climb ±${delta}) | MSE: ${currentScore.toFixed(2)}`);
            renderUIPalette();
            await new Promise(r => requestAnimationFrame(r));
            await triggerEncodeFn();
            await new Promise(r => requestAnimationFrame(r));

            delta = Math.min(32, Math.ceil(delta * 1.5));
        } else {
            delta = Math.floor(delta / 2);
        }
    }
    return { candidate: bestColor, score: currentScore, didImprove: improved };
}

// ---------------------------------------------------------------------------
// Slot-Reihenfolge
// ---------------------------------------------------------------------------

/** Erzeugt die hierarchische Interleaving-Reihenfolge (HAM06-Blöcke gekoppelt an HAM04-Basis). */
function generateHierarchicalSlotOrder(maxSlots) {
    // Kleinere Bänke: Standard-Abfolge von oben nach unten.
    if (maxSlots < 31) {
        const order = [];
        for (let i = maxSlots - 1; i >= 1; i--) order.push(i);
        return order;
    }

    const ham04Slots = [1, 2, 3, 4, 5, 6, 7];
    const ham06Blocks = [
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [24, 25, 26, 27],
        [28, 29, 30, 31]
    ];

    // Pro HAM06-Block einen HAM04-Basis-Slot einstreuen, Rest hinten anhängen.
    const order = [];
    ham06Blocks.forEach((block, i) => {
        order.push(...block);
        if (i < ham04Slots.length) order.push(ham04Slots[i]);
    });
    order.push(...ham04Slots.slice(ham06Blocks.length));
    return order;
}

// ---------------------------------------------------------------------------
// Öffentliche Einstiegspunkte
// ---------------------------------------------------------------------------

export async function runManualRefinement(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const { maxSlots } = resolveBankLayout(appState.currentFormat, config);
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion);

    const startMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const initialUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    updateOptProgress(`Starte manuelle Nachoptimierung...`);
    const changeLog = [`<div style="color:#ffc107; font-weight:bold;">Manuelles Nachoptimieren (Start-MSE: ${startMse.toFixed(2)})</div>`];

    for (let i = maxSlots - 1; i >= 1; i--) {
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        const startColor = {
            r: appState.globalPaletteRAM[absSlot * 3],
            g: appState.globalPaletteRAM[absSlot * 3 + 1],
            b: appState.globalPaletteRAM[absSlot * 3 + 2]
        };

        const result = await refineSlotColor(startColor, absSlot, i, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
        if (result.didImprove) {
            changeLog.push(`✨ Slot ${i}: RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b}) [Neuer MSE: ${result.score.toFixed(2)}]`);
        }
    }

    const endMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const usageStr = initialUsage.map((cnt, idx) => idx > 0 ? `S${idx}:${cnt}x` : "").filter(Boolean).join(", ");

    changeLog.push(`<div style="color:#aaa; font-size:10px;">Nutzung (Stabil): ${usageStr}</div>`);
    changeLog.push(`<div style="color:#28a745; font-weight:bold;">Beendet: Vorher ${startMse.toFixed(2)} ➔ Nachher ${endMse.toFixed(2)}</div>`);

    return changeLog;
}

export async function runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette, runSecondPass = true) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const { formatsInUse, maxSlots } = resolveBankLayout(appState.currentFormat, config);
    const maxCores = navigator.hardwareConcurrency || 4;
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion);
    const changeLog = [];

    const startMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const initialUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    changeLog.push(`<div style="color:#4dabf7; font-weight:bold; margin-top:5px;">--- DURCHLAUF 1 (Hierarchisches Interleaving, Start-MSE: ${startMse.toFixed(2)}) ---</div>`);

    const slotOrder = generateHierarchicalSlotOrder(maxSlots);

    // DURCHLAUF 1: Reines Battle in hierarchischer Reihenfolge
    for (const i of slotOrder) {
        if (i >= maxSlots) continue;
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        const bitDepthKey = i <= 3 ? "3" : (i <= 7 ? "4" : String(Math.min(8, Math.ceil(Math.log2(i + 1)))));
        const usageCount = initialUsage[i] || 0;

        updateOptProgress(`Durchlauf 1: Battle für Slot ${i} (${bitDepthKey}-bit Ebene)...`);
        const stats = computeDetailedAnalysis(appState.originalImageData.data, appState.decodedImageData.data, appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion);

        const poolForBitDepth = stats.global.byBitDepth[bitDepthKey] || stats.global.top10;
        poolForBitDepth.sort((a, b) => b.mse - a.mse);

        const candidates = getCandidatesFromPool(poolForBitDepth.length > 0 ? poolForBitDepth : stats.global.top10, appState.globalPaletteRAM, maxCores, 6);
        const bestRaw = await runWorkerBattle(candidates, battleArgs, absSlot);

        appState.globalPaletteRAM[absSlot * 3] = bestRaw.candidate.r;
        appState.globalPaletteRAM[absSlot * 3 + 1] = bestRaw.candidate.g;
        appState.globalPaletteRAM[absSlot * 3 + 2] = bestRaw.candidate.b;

        renderUIPalette();
        await new Promise(r => requestAnimationFrame(r));
        await triggerEncodeFn();
        await new Promise(r => requestAnimationFrame(r));

        const labelName = i <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
        changeLog.push(`⚔️ Slot ${i} (${labelName}, ${usageCount}x genutzt): RGB(${bestRaw.candidate.r}, ${bestRaw.candidate.g}, ${bestRaw.candidate.b}) [Battle MSE: ${bestRaw.score.toFixed(2)}]`);
    }

    // DURCHLAUF 2: Optionales Fein-Tuning
    if (runSecondPass) {
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF 2 (Feinoptimierung) ---</div>`);

        for (let i = maxSlots - 1; i >= 1; i--) {
            const absSlot = (currentOffset + i) % 256;
            if (lockedSlots.has(absSlot)) continue;

            updateOptProgress(`Durchlauf 2: Nachjustieren von Slot ${i}...`);
            const startColor = {
                r: appState.globalPaletteRAM[absSlot * 3],
                g: appState.globalPaletteRAM[absSlot * 3 + 1],
                b: appState.globalPaletteRAM[absSlot * 3 + 2]
            };

            const result = await refineSlotColor(startColor, absSlot, i, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette);
            if (result.didImprove) {
                changeLog.push(`✨ Slot ${i} (Verbessert): RGB(${result.candidate.r}, ${result.candidate.g}, ${result.candidate.b}) [Neuer MSE: ${result.score.toFixed(2)}]`);
            }
        }
    }

    const endMse = measureCurrentMse(appState, step, metric, config, optRegion);

    const activeFormatName = config.isMixed ? `Gemischt (${formatsInUse.join(', ')})` : appState.currentFormat;
    const usageStr = initialUsage.map((cnt, idx) => idx > 0 ? `Slot ${idx}: ${cnt}x` : "").filter(Boolean).join(" | ");

    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:8px;">Format: ${activeFormatName}</div>`);
    changeLog.push(`<div style="color:#ccc; font-size:10px; background:#111; padding:4px; border-radius:3px;">Nutzung (Stabil vor Start): ${usageStr || "Keine Anker verwendet"}</div>`);
    changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:5px;">Ergebnis: Vorher ${startMse.toFixed(2)} ➔ Nachher ${endMse.toFixed(2)}</div>`);

    return changeLog;
}
