// src/core/palette_optimizer.js
//
// Optimiert die Farbpalette (globalPaletteRAM) für HAM-Formate. Ablauf:
//   1. Kandidaten-"Battle": mehrere Farbkandidaten werden parallel in Web Workern
//      getestet, der beste Kandidat gewinnt (runWorkerBattle).
//   2. Vektor-Analyse + parallele Liniensuche pro Slot (refineSlotColorVector):
//      Statt sequenziellem Hill-Climbing wird der mittlere Fehler-Vektor (ΔR,ΔG,ΔB)
//      aller vom Slot abhängigen Pixel berechnet und ein Fächer skalierter
//      Test-Vektoren gleichzeitig in Workern getestet.
//
// Öffentliche Einstiegspunkte:
//   - runManualRefinement  : manuelles Nachjustieren aller Slots einer Bank
//   - runHybridOptimization: Auto-Füllen (Battle + optionaler Feinpass)

import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp } from '../codecs/utils.js';
import { computeDetailedAnalysis, computeAvgYuvScore, getImageHistogram } from './analysis.js';
import { encodePaletted, decodePaletted } from './module_paletted.js';

// Skalierungsfaktoren der parallelen Liniensuche (Prozentsätze des Fehler-Vektors).
const VECTOR_SCALES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];

// Durchlauf 1+ (Slot-Nachbesiedlung): Slots mit 0x Nutzung und die am wenigsten
// genutzten Slots werden erneut gebattelt, bis kein Slot mehr ungenutzt ist
// (maximal REPOP_MAX_PASSES Durchläufe). Danach poliert REPOP_POLISH_PASSES
// weitere Durchläufe die unteren 10 % (auch ohne 0x-Slots).
const REPOP_MAX_PASSES = 10;
const REPOP_POLISH_PASSES = 2;        // Schlusslicht-Politur nach der Besiedlung
const REPOP_BOTTOM_RATIO = 0.10;      // Anteil der am wenigsten genutzten Slots
const REPOP_HISTOGRAM_CANDIDATES = 8; // Top-Histogramm-Farben als Zusatzkandidaten
const FINAL_POLISH_MAX_PASSES = 3;    // Feinschliff-Pässe bis Konvergenz

// Maximale Anzahl (Feinschliff → Vektor) Wechsel-Zyklen nach Durchlauf 3.
// Die Schleife endet normalerweise früher, sobald ein kompletter Zyklus auf
// beiden Fronten (Battle & Vektor) keine Verbesserung mehr findet.
const MAX_ALTERNATING_CYCLES = 4;

// Clustering der Fehler-Kandidaten (Durchlauf 1) und Mindestabstand für
// "deutlich unterschiedliche" Farben bei der Direkt-Belegung freier Slots.
const CLUSTER_RADIUS = 24;
const MIN_DISTINCT_DIST = 48;

// Wird gesetzt, sobald der erste Worker-Battle in den In-Thread-Fallback
// wechselt — verhindert eine Flut identischer Warnungen.
let workerFallbackWarned = false;

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

/**
 * Ermittelt, welche Bit-Tiefen (Sub-Formate) einen Slot als Anker referenzieren
 * dürfen. Ein Sub-Format kann die Slots 0..slotsPerBank-1 nutzen.
 * HAM01/02/03 sind reine Delta-Formate ohne Anker-Bit (bits < 4) und
 * referenzieren daher keinen Slot.
 */
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

/** Bündelt die wiederkehrenden Argumente für die Worker-Battles. */
function createBattleArgs(appState, step, metric, currentOffset, optRegion, onWorkerFallback) {
    return {
        origData: appState.originalImageData.data,
        imgW: appState.currentImgW,
        imgH: appState.currentImgH,
        format: appState.currentFormat,
        step,
        metric,
        currentOffset,
        paletteRAM: appState.globalPaletteRAM,
        optRegion,
        onWorkerFallback
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

/**
 * Schritt 1 (Vektor-Analyse): Ermittelt für jeden bank-lokalen Slot den mittleren
 * Fehler-Vektor (ΔR, ΔG, ΔB) aller Pixel, die von diesem Slot abhängen.
 * Ein Pixel hängt von dem Slot ab, dessen Anker die aktuelle Kette gestartet hat —
 * der Anker-Pixel selbst sowie alle nachfolgenden Delta-Schritte dieser Kette.
 * Rückgabe: Array (Index = bank-lokaler Slot) mit { dR, dG, dB, count }.
 */
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

    for (let i = 0; i < totalPixels; i++) {
        const cmd = commands[i];
        // Spiegelt decodePaletted: nur Sub-Formate mit echter Anker-Referenz
        // starten eine neue Kette (HAM01/02/03 sind reine Delta-Formate).
        if (cmd && cmd.isAnchor && (HAM_CONFIGS[cmd.format]?.slotsPerBank > 0)) {
            activeSlot = cmd.anchorIdx;
        }
        if (activeSlot < 0 || activeSlot >= maxSlots) continue;

        if (useRegion) {
            const x = i % imgW;
            const y = Math.floor(i / imgW);
            if (x < optRegion.x || x >= optRegion.x + optRegion.width ||
                y < optRegion.y || y >= optRegion.y + optRegion.height) continue;
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

/** Schreibt eine Kandidaten-Farbe in einen absoluten Palette-Slot. */
function writeSlotColor(paletteRAM, absSlot, color) {
    paletteRAM[absSlot * 3] = color.r;
    paletteRAM[absSlot * 3 + 1] = color.g;
    paletteRAM[absSlot * 3 + 2] = color.b;
}

function colorInPalette(paletteRAM, r, g, b, threshold = 6) {
    for (let slot = 0; slot < 256; slot++) {
        if (Math.abs(r - paletteRAM[slot * 3]) +
            Math.abs(g - paletteRAM[slot * 3 + 1]) +
            Math.abs(b - paletteRAM[slot * 3 + 2]) <= threshold) {
            return true;
        }
    }
    return false;
}

function colorDistance(a, b) {
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function isDistinctFromAll(color, existing, minDist) {
    return existing.every(c => colorDistance(color, c) >= minDist);
}

/**
 * Prüft, ob eine Farbe zu allen BELEGTEN Palette-Slots den Mindestabstand
 * einhält. Unbelegte Slots sind (0,0,0); nur Slot 0 ist die reservierte
 * Schwarz-Farbe und zählt deshalb als belegt.
 */
function colorDistinctFromPalette(paletteRAM, color, minDist) {
    for (let slot = 0; slot < 256; slot++) {
        const r = paletteRAM[slot * 3];
        const g = paletteRAM[slot * 3 + 1];
        const b = paletteRAM[slot * 3 + 2];
        if (slot !== 0 && r === 0 && g === 0 && b === 0) continue;
        if (colorDistance(color, { r, g, b }) < minDist) return false;
    }
    return true;
}

/**
 * Clustert die Fehler-Kandidaten: ähnliche Farben (z. B. mehrfaches Weiß)
 * werden zu ihrem Schwerpunkt ("Mitte") zusammengefasst, damit die begrenzten
 * Battle-Slots nicht mit nahezu identischen Farben verschwendet werden.
 * Verbleibende Slots werden mit deutlich anderen (mutierten) Farben gefüllt.
 */
function getClusteredCandidates(pool, paletteRAM, maxCores) {
    const clusters = []; // { rSum, gSum, bSum, n }

    for (const err of pool) {
        const r = err.r1, g = err.g1, b = err.b1;
        if (colorInPalette(paletteRAM, r, g, b)) continue;

        let nearest = -1, nearestDist = Infinity;
        for (let c = 0; c < clusters.length; c++) {
            const d = Math.abs(r - clusters[c].rSum / clusters[c].n) +
                      Math.abs(g - clusters[c].gSum / clusters[c].n) +
                      Math.abs(b - clusters[c].bSum / clusters[c].n);
            if (d < nearestDist) { nearestDist = d; nearest = c; }
        }

        if (nearest >= 0 && nearestDist <= CLUSTER_RADIUS) {
            clusters[nearest].rSum += r;
            clusters[nearest].gSum += g;
            clusters[nearest].bSum += b;
            clusters[nearest].n++;
        } else if (clusters.length < maxCores) {
            clusters.push({ rSum: r, gSum: g, bSum: b, n: 1 });
        }
    }

    // Schwerpunkte ERST NACH der Mittelung gegen die bereits belegte Palette
    // prüfen. Genau hier sind früher Weiß/Grau-Duplikate durchgerutscht: die
    // Einzel-Farben waren unauffällig, ihr Mittelwert lag aber trotzdem dicht
    // an einer schon vergebenen Farbe.
    const candidates = clusters
        .map(c => ({
            r: Math.round(c.rSum / c.n),
            g: Math.round(c.gSum / c.n),
            b: Math.round(c.bSum / c.n)
        }))
        .filter(cand => colorDistinctFromPalette(paletteRAM, cand, MIN_DISTINCT_DIST));

    // Verbleibende Battle-Slots DETERMINISTISCH auffüllen (kein Math.random):
    // ein festes Offset-Raster wird über den Fehler-Pool gelegt, damit
    // Durchlauf 1 reproduzierbar ist (gleiche Eingabe → gleiche Kandidaten).
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
        if (isDistinctFromAll(cand, candidates, MIN_DISTINCT_DIST) &&
            colorDistinctFromPalette(paletteRAM, cand, MIN_DISTINCT_DIST)) candidates.push(cand);
    }
    // Fallback, falls der Distinct-Filter zu streng ist: deterministisch auffüllen.
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

/**
 * Bewertet einen Kandidaten im Haupt-Thread (Fallback, wenn der Worker nicht
 * startet oder intern crasht). Repliziert exakt die Worker-Logik: Palette
 * kopieren → Kandidat einsetzen → encodieren → decodieren → MSE messen.
 */
async function computeCandidateScoreInThread(candidate, args, absSlot) {
    const { origData, imgW, imgH, format, step, metric, currentOffset, paletteRAM, optRegion } = args;
    const localPalette = new Uint8Array(paletteRAM);
    writeSlotColor(localPalette, absSlot, candidate);
    const encodeRes = await encodePaletted(origData, imgW, imgH, format, step, localPalette, currentOffset, "greedy", metric, null, 0, 0, 15.0);
    const decodedPixels = decodePaletted(encodeRes.commands, imgW, imgH, step, localPalette, currentOffset);
    // Schlanke Messung — identisch zum Worker und zu stats.global.avgYuv,
    // nur ohne die teure Voll-Analyse (siehe analysis.js).
    return computeAvgYuvScore(origData, decodedPixels, imgW, imgH, metric, optRegion);
}

/**
 * Testet mehrere Farbkandidaten parallel in Workern und liefert den besten zurück.
 * `absSlot` ist der absolute Palette-Slot, in den der Kandidat eingesetzt wird.
 * Fällt bei Worker-Ausfall auf eine In-Thread-Bewertung zurück.
 */
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

        // Fallback: ohne Worker bewerten, damit ein Battle nie lautlos auf
        // Infinity degradiert (Modul-Worker nicht unterstützt, CSP, falscher
        // Basis-Pfad oder interner Worker-Crash).
        const fallback = async () => {
            if (settled || fallbackRunning) return;
            fallbackRunning = true;
            if (!workerFallbackWarned) {
                workerFallbackWarned = true;
                const msg = "⚠️ Worker-Battle nicht verfügbar — In-Thread-Bewertung aktiv (korrekt, aber langsamer).";
                if (typeof onWorkerFallback === 'function') onWorkerFallback(msg);
                else console.warn(msg);
            }
            try {
                const score = await computeCandidateScoreInThread(cand, args, absSlot);
                finish({ candidate: cand, score });
            } catch (err) {
                // Auch der In-Thread-Pfad ist fehlgeschlagen — Battle darf nicht
                // hängen bleiben, also sichtbar mit Infinity auflösen.
                console.error("In-Thread-Battle Error:", err);
                finish({ candidate: cand, score: Infinity });
            }
        };

        worker.onmessage = (e) => {
            // Infinity ist das Fehlersignal des Workers (interner Crash) → Fallback.
            if (e.data && e.data.score === Infinity) { fallback(); return; }
            finish(e.data);
        };
        worker.onerror = () => fallback();
        worker.onmessageerror = () => fallback();

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
    return results;
}

async function runWorkerBattle(candidates, args, absSlot) {
    return (await runWorkerBattleAll(candidates, args, absSlot))[0];
}

// ---------------------------------------------------------------------------
// Slot-Feinabstimmung (Vektor-Liniensuche)
// ---------------------------------------------------------------------------

/**
 * Schritt 2 & 3: Spannt für einen Slot einen Fächer skalierter Test-Vektoren
 * auf (25%..175% des Fehler-Vektors) und testet alle Kandidaten parallel in
 * Workern (Promise.all). Der Kandidat mit dem niedrigsten MSE wird übernommen.
 */
async function refineSlotColorVector(startColor, absSlot, slotIdx, vector, triggerEncodeFn, updateOptProgress, battleArgs, renderUIPalette) {
    const { paletteRAM } = battleArgs;

    // Referenzmessung der aktuellen Slot-Farbe (verhindert Verschlechterung).
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

/**
 * Vektor-Feinoptimierung (identisch für Durchlauf 2 und 3): Slots werden nach
 * ihrer AKTUELLEN Nutzung (meistgenutzte zuerst) nachjustiert, der Fehler-Vektor
 * wird je Slot frisch aus dem letzten Encode/Decode-Stand berechnet.
 * Liefert true, wenn mindestens ein Slot verbessert wurde.
 */
async function runVectorRefinementPass(passNum, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
    const order = [];
    for (let i = 1; i < maxSlots; i++) order.push(i);
    order.sort((a, b) => usage[b] - usage[a]);

    const imgW = appState.currentImgW;
    const imgH = appState.currentImgH;
    const { metric } = battleArgs;
    // Einmal je Pass den aktuellen Gesamt-MSE schlank messen; nach jedem
    // erfolgreichen Slot wird er gegen den frisch decodierten Stand aktualisiert.
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

        // Schritt 1 (frisch je Slot): Fehler-Vektor auf Basis des aktuellen
        // Encode/Decode-Stands neu berechnen, damit vorherige Anpassungen einfließen.
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

/**
 * Battelt eine Menge von Slots gegen frische Kandidaten (Fehleranalyse-Pool
 * + ungenutzte Histogramm-Farben) und übernimmt jede neue Farbe NUR, wenn der
 * (greedy gemessene) MSE echt sinkt. Liefert true, wenn mindestens ein Slot
 * verbessert wurde. Nach jedem Treffer wird neu encodiert.
 */
async function battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSlots, usage, phaseLabel, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const maxCores = navigator.hardwareConcurrency || 4;

    // Fehleranalyse + Histogramm einmal pro Batch berechnen (Kandidaten-Pool).
    const stats = computeDetailedAnalysis(
        appState.originalImageData.data,
        appState.decodedImageData.data,
        appState.currentImgW,
        appState.currentImgH,
        0,
        totalPixels,
        battleArgs.step,
        battleArgs.metric,
        config,
        optRegion
    );
    const histogramCandidates = getImageHistogram(
        appState.originalImageData,
        appState.currentImgW,
        appState.currentImgH,
        battleArgs.step,
        REPOP_HISTOGRAM_CANDIDATES,
        appState.globalPaletteRAM,
        currentOffset,
        optRegion
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
            appState.globalPaletteRAM,
            maxCores
        );

        // Häufigste noch nicht verwendete Bildfarben als Zusatzkandidaten.
        for (const hc of histogramCandidates) {
            if (!colorInPalette(appState.globalPaletteRAM, hc.r, hc.g, hc.b) &&
                isDistinctFromAll(hc, candidates, MIN_DISTINCT_DIST)) {
                candidates.push({ r: hc.r, g: hc.g, b: hc.b });
            }
        }

        // Greedy-Baseline mit der aktuellen Slot-Farbe (gleiche Strategie wie
        // der Worker), damit der Vergleich Äpfel-mit-Äpfeln bleibt. Zugleich ist
        // baseline.score = aktueller Gesamt-MSE (Palette unverändert) und wird
        // deshalb in der Statuszeile angezeigt.
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
            changeLog.push(`Slot ${i} (${phaseLabel}, ${usage[i]}x): keine Verbesserung — Farbe bleibt (MSE: ${baseline.score.toFixed(2)}).`);
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

/**
 * Durchlauf 1+ (Slot-Nachbesiedlung + Schlusslicht-Politur): Nach dem Battle-
 * Durchlauf bleiben oft Slots mit 0x oder sehr geringer Nutzung übrig — die
 * Vektor-Liniensuche in Durchlauf 2/3 überspringt sie (kein Fehler-Vektor ⇒
 * keine Korrektur). Dieser Durchlauf battelt deshalb wiederholt die ungenutzten
 * Slots sowie die am wenigsten genutzten 10 % und übernimmt eine neue Farbe NUR,
 * wenn der (greedy gemessene) MSE sinkt. Zusätzlich werden die häufigsten, noch
 * nicht verwendeten Histogramm-Farben als Kandidaten eingespeist.
 *
 * Phase 1: Besiedlung — ungenutzte Slots + untere 10 %, bis kein 0x-Slot mehr
 *          existiert (max. REPOP_MAX_PASSES Durchläufe).
 * Phase 2: Politur  — untere 10 % noch REPOP_POLISH_PASSES Durchläufe batteln,
 *          um auch die letzten Schlusslichter (z. B. 20x-Slots) zu verbessern.
 */
async function runSlotRepopulationPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog) {
    const bottomCount = Math.max(1, Math.round((maxSlots - 1) * REPOP_BOTTOM_RATIO));

    // Nicht gesperrte Slots aufsteigend nach Nutzung (ungenutzte zuerst).
    const unlockedOrder = () => {
        const usage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);
        const order = [];
        for (let i = 1; i < maxSlots; i++) {
            if (!lockedSlots.has((currentOffset + i) % 256)) order.push(i);
        }
        order.sort((a, b) => usage[a] - usage[b]);
        return { usage, order };
    };

    // Phase 1: Besiedlung — ungenutzte Slots + untere 10 %, bis kein 0x-Slot
    // mehr existiert (max. REPOP_MAX_PASSES Durchläufe).
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
            changeLog.push(`Durchlauf 1+ (Pass ${pass}): keine Verbesserung möglich — Abbruch (MSE: ${currentMseForLog(appState, battleArgs, optRegion).toFixed(2)}).`);
            break;
        }
    }

    // Phase 2: Schlusslicht-Politur — untere 10 % auch ohne 0x-Slots noch
    // REPOP_POLISH_PASSES Durchläufe batteln (bringt den letzten Schliff).
    for (let pass = 1; pass <= REPOP_POLISH_PASSES; pass++) {
        const { usage, order } = unlockedOrder();
        const targetSet = new Set(order.slice(0, bottomCount));
        updateOptProgress(`Durchlauf 1+ (Politur ${pass}/${REPOP_POLISH_PASSES}): untere ${targetSet.size} Slots batteln...`);
        const anyChange = await battleSlotBatch(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, targetSet, usage, `1+ Politur ${pass}`, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        if (!anyChange) {
            changeLog.push(`Durchlauf 1+ (Politur ${pass}): keine Verbesserung — Abbruch (MSE: ${currentMseForLog(appState, battleArgs, optRegion).toFixed(2)}).`);
            break;
        }
    }
}

/**
 * Misst den aktuellen Gesamt-MSE aus dem letzten Encode/Decode-Stand (für
 * Log-Zeilen wie "keine Verbesserung — Abbruch"). Kostengünstig, da nur der
 * Pixelvergleich läuft — kein erneutes Encodieren nötig: Nach jeder erfolgreichen
 * Slot-Änderung wird in den aufrufenden Phasen sofort neu encodiert.
 */
function currentMseForLog(appState, battleArgs, optRegion) {
    const config = HAM_CONFIGS[appState.currentFormat];
    return measureCurrentMse(appState, battleArgs.step, battleArgs.metric, config, optRegion);
}

/**
 * Feinschliff (nach Durchlauf 3): Battelt JEDEN nicht gesperrten Slot gegen
 * frische Kandidaten und wiederholt das, bis kein Slot mehr verbessert wird
 * (max. FINAL_POLISH_MAX_PASSES Durchläufe). Die Vektor-Liniensuche bewegt
 * Farben nur entlang des Fehler-Vektors; der volle Battle-Pass kann Farben
 * außerhalb dieser Linie finden und holt so den letzten Schliff. Monoton
 * (nur bei sinkendem MSE). Liefert true, wenn mindestens ein Pass verbesserte.
 */
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
            changeLog.push(`Feinschliff (Pass ${pass}): keine Verbesserung — Konvergenz erreicht (MSE: ${currentMseForLog(appState, battleArgs, optRegion).toFixed(2)}).`);
            break;
        }
    }
    return anyPassChange;
}

export async function runHybridOptimization(appState, optRegion, step, metric, currentOffset, lockedSlots, updateOptProgress, triggerEncodeFn, renderUIPalette, runRefinementPasses = true) {
    const config = HAM_CONFIGS[appState.currentFormat];
    const totalPixels = appState.currentImgW * appState.currentImgH;
    const { formatsInUse, maxSlots } = resolveBankLayout(appState.currentFormat, config);
    const maxCores = navigator.hardwareConcurrency || 4;
    const changeLog = [];
    const battleArgs = createBattleArgs(appState, step, metric, currentOffset, optRegion, (msg) => changeLog.push(`<div style="color:#ffc107;">${msg}</div>`));

    const startMse = measureCurrentMse(appState, step, metric, config, optRegion);
    const startUsage = getSlotUsageSummary(appState.latestCommandArray, maxSlots);

    // Laufender MSE-Zwischenstand: Nach JEDER Phase wird der aktuell gemessene
    // Gesamt-MSE samt Differenz zum letzten Stand ins Log geschrieben, damit der
    // Benutzer den Fortschritt über den ganzen Lauf hinweg verfolgen kann.
    let mseStand = startMse;
    const pushMseStand = (phaseLabel) => {
        const mse = measureCurrentMse(appState, step, metric, config, optRegion);
        const diff = mseStand - mse;
        const diffTxt = Math.abs(diff) < 0.005
            ? ""
            : (diff > 0 ? ` (−${diff.toFixed(2)})` : ` (+${(-diff).toFixed(2)})`);
        changeLog.push(`<div style="color:#17a2b8; font-size:11px; margin-top:2px;">📊 Nach ${phaseLabel}: MSE ${mse.toFixed(2)}${diffTxt}</div>`);
        mseStand = mse;
    };

    changeLog.push(`<div style="color:#4dabf7; font-weight:bold; margin-top:5px;">--- DURCHLAUF 1 (Battle + Clustering, Start-MSE: ${startMse.toFixed(2)}) ---</div>`);

    const slotOrder = generateHierarchicalSlotOrder(maxSlots);
    const filled = new Set(); // Im Durchlauf 1 bereits belegte Slots

    // DURCHLAUF 1: Battle mit geklusterten Kandidaten + Direkt-Belegung freier Slots
    for (let qi = 0; qi < slotOrder.length; qi++) {
        const i = slotOrder[qi];
        if (i >= maxSlots) continue;
        if (filled.has(i)) continue;
        const absSlot = (currentOffset + i) % 256;
        if (lockedSlots.has(absSlot)) continue;

        const bitDepths = getSlotBitDepths(i, formatsInUse);
        const usageCount = getSlotUsageSummary(appState.latestCommandArray, maxSlots)[i] || 0;

        // Fehleranalyse VOR der Statuszeile ausführen: Sie liefert den Kandidaten-Pool
        // UND den aktuellen Gesamt-MSE (letzter Stand nach dem vorigen Re-Encode).
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
        writeSlotColor(appState.globalPaletteRAM, absSlot, winner.candidate);
        filled.add(i);

        const labelName = i <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
        changeLog.push(`⚔️ Slot ${i} (${labelName}, ${usageCount}x genutzt): RGB(${winner.candidate.r}, ${winner.candidate.g}, ${winner.candidate.b}) [Battle MSE: ${winner.score.toFixed(2)}]`);

        // Direkt-Belegung: bis zu 2 weitere, deutlich unterschiedliche Farben
        // in freie Slots schieben (spart Battles). Die Runner-Werte aus dem
        // Sieger-Battle gelten NUR als Vorauswahl — gemessen wurden sie im
        // Sieger-Slot (absSlot). Jeder Runner wird deshalb in SEINEM Ziel-Slot
        // gegen die dort aktuelle Farbe neu gebattelt, damit Bewertung und
        // Schreibort übereinstimmen und die Übernahme monoton bleibt.
        const placedColors = [winner.candidate];
        let runnerCount = 0;
        for (let r = 1; r < results.length && runnerCount < 2; r++) {
            const runner = results[r];
            if (!Number.isFinite(runner.score)) continue;
            if (!isDistinctFromAll(runner.candidate, placedColors, MIN_DISTINCT_DIST)) continue;

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

            // Baseline & Kandidat im ZIEL-Slot messen (nicht im Sieger-Slot):
            const targetCurrent = {
                r: appState.globalPaletteRAM[targetAbs * 3],
                g: appState.globalPaletteRAM[targetAbs * 3 + 1],
                b: appState.globalPaletteRAM[targetAbs * 3 + 2]
            };
            const baseline = await runWorkerBattle([targetCurrent], battleArgs, targetAbs);
            const placed = await runWorkerBattle([runner.candidate], battleArgs, targetAbs);
            if (placed.score >= baseline.score) continue; // im Ziel-Slot keine echte Verbesserung

            writeSlotColor(appState.globalPaletteRAM, targetAbs, placed.candidate);
            filled.add(targetJ);
            placedColors.push(placed.candidate);
            runnerCount++;

            const targetLabel = targetJ <= 7 ? "HAM04 / Basis" : "HAM06 / Erweiterung";
            changeLog.push(`⚡ Slot ${targetJ} (${targetLabel}, direkt von Slot ${i}): RGB(${placed.candidate.r}, ${placed.candidate.g}, ${placed.candidate.b}) [MSE: ${placed.score.toFixed(2)}]`);
        }

        renderUIPalette();
        await new Promise(r => requestAnimationFrame(r));
        await triggerEncodeFn();
        await new Promise(r => requestAnimationFrame(r));
    }

    // DURCHLAUF 1+: Slot-Nachbesiedlung (ungenutzte Slots auffrischen, max. 10 Passes).
    // Läuft immer, damit Durchlauf 2/3 auf einer vollständig genutzten Palette aufsetzen.
    pushMseStand("Durchlauf 1 (Battle + Clustering)");
    changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- DURCHLAUF 1+ (Slot-Nachbesiedlung) ---</div>`);
    await runSlotRepopulationPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
    pushMseStand("Durchlauf 1+ (Slot-Nachbesiedlung)");

    // DURCHLAUF 2 & 3: Vektor-Feinoptimierung (frischer Vektor je Slot)
    if (runRefinementPasses) {
        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF 2 (Vektor-Feinoptimierung) ---</div>`);
        await runVectorRefinementPass(2, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        pushMseStand("Durchlauf 2 (Vektor-Feinoptimierung)");

        changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF 3 (Vektor-Feinoptimierung) ---</div>`);
        const d3Changed = await runVectorRefinementPass(3, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
        pushMseStand("Durchlauf 3 (Vektor-Feinoptimierung)");

        // Koordinaten-Deszenz: Ab hier wechseln sich volles Palette-Batteln
        // (Feinschliff) und Vektor-Liniensuche ab, bis ein kompletter Zyklus
        // auf BEIDEN Fronten keine Verbesserung mehr bringt. Jede Phase
        // verschiebt die Palette, wodurch die andere Phase neuen Spielraum
        // findet (Muster aus der Praxis: Feinschliff-Konvergenz → Vektor-
        // Verbesserung → erneut Feinschliff mit frischen Kandidaten).
        let cycle = 1;
        let lastVectorChanged = d3Changed;
        while (cycle <= MAX_ALTERNATING_CYCLES) {
            changeLog.push(`<div style="color:#17a2b8; font-weight:bold; margin-top:10px;">--- FEINSCHLIFF (volle Palette batteln${cycle > 1 ? `, Zyklus ${cycle}` : ''}) ---</div>`);
            const polishChanged = await runFinalPolishPass(appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, formatsInUse, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
            pushMseStand(`Feinschliff (Zyklus ${cycle})`);

            // Feinschliff und vorheriger Vektor-Durchlauf haben beide nichts
            // bewegt → die Palette ist unter beiden Operatoren stabil.
            if (!polishChanged && !lastVectorChanged) break;

            const passNum = 3 + cycle; // 4, 5, …
            changeLog.push(`<div style="color:#28a745; font-weight:bold; margin-top:10px;">--- DURCHLAUF ${passNum} (Vektor-Feinoptimierung) ---</div>`);
            lastVectorChanged = await runVectorRefinementPass(passNum, appState, maxSlots, currentOffset, lockedSlots, optRegion, battleArgs, triggerEncodeFn, updateOptProgress, renderUIPalette, changeLog);
            pushMseStand(`Durchlauf ${passNum} (Vektor-Feinoptimierung)`);

            // Beide Fronten dieses Zyklus' erschöpft → echte Konvergenz.
            if (!polishChanged && !lastVectorChanged) break;
            cycle++;
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
