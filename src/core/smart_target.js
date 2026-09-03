// src/core/smart_target.js
//
// Erzeugt ein "Smart Target": eine modifizierte Kopie des Originalbildes, die
// der HAM-Codec ohne Artefakte und Kettenrisse (Clipping) codieren kann.
//
// Verarbeitung im Frequenzraum über die Le Gall 5/3 Wavelet-Transformation
// (JPEG 2000). Der Prozess ist vollständig von der Paletten-Optimierung
// entkoppelt — es wird nur encode/decode als Diagnose benutzt.
//
// Phasen:
//   1. Fehler-Detektion im Wavelet-Raum (Scanner):
//      Encode/Decode → Fehlerbild E = O − D → 5/3-HL-Koeffizienten
//      (= lokale horizontale Hochfrequenz "Mitte − (Links+Rechts)/2").
//      Massive Peaks markieren die X/Y-Koordinaten gescheiterter Kanten.
//   2. Bidirektionales Edge-Snapping:
//      Option A (Vorziehen):  Pixel X übernimmt den Wert von X+1.
//      Option B (Verzögern):  Pixel X übernimmt den Wert von X−1.
//   3. High-Performance Batch-Testing:
//      Alle Peaks (räumlich > PEAK_MIN_SPACING entfernt) werden gleichzeitig
//      getestet: ein Testbild für alle A-Verschiebungen, eines für alle B.
//      Bewertet wird ausschließlich lokal über die 5/3-Formel an der
//      Peak-Koordinate — als SELBST-Fehler |modifiziertes Bild − decode|
//      (nicht Abweichung vom Original, die ist durch die Modifikation
//      gewollt). (Da der HAM-Akkumulator in dieser Codebasis über die
//      Zeilengrenzen hinweg weiterläuft, wird statt "Micro-Encoding" das
//      komplette Bild re-encodiert — korrekt, aber nur 2 Zusatz-Durchläufe.)
//      Schutz: Pixel, die von BEIDEN Nachbarn deutlich abweichen (1-Pixel-
//      Details wie dünne Linien), werden nicht gesnappt, sondern gedämpft.
//   4. Wavelet-Dämpfung (Fallback, ZWEI Ebenen):
//      Harte Kanten, die weder A noch B behebt, werden lokal per 5/3-Lifting
//      gedämpft. Die Ebene richtet sich nach der Fehler-Struktur:
//        Level 1 (HL1, Rest 1/2): isolierte 1-Pixel-Spikes — Fein-Tuning.
//        Level 2 (HL2, Rest 1/4): Fehler auf Rasterpositionen des Formats
//      (z. B. HAM03 im 6343-Kern), die keinen Anker-Slot erreichen, sowie
//      räumlich korrelierte Raster-Glieder (x±4k, vertikale Nachbarn).
//      Level 2 wird auf die GESAMTE korrelierte Struktur ausgeweitet, damit
//      das Bild exakt in den Rhythmus des Format-Rasters gezwungen wird.
//
// Öffentlicher Einstiegspunkt: generateSmartTarget(...)

import { encodePaletted, decodePaletted } from './module_paletted.js';
import { clamp } from '../codecs/utils.js';
import { HAM_CONFIGS } from '../codecs/configs.js';

// ---------------------------------------------------------------------------
// Tuning-Parameter
// ---------------------------------------------------------------------------
const PEAK_MIN_MAG = 20;              // absolute Untergrenze für HL-Peaks
const PEAK_SIGMA = 1.5;               // Peaks oberhalb mean + SIGMA * stddev
const PEAK_MIN_SPACING = 4;           // Mindestabstand (px) zwischen Peaks
const MAX_PEAKS = 8000;               // Obergrenze gegen pathologische Fälle
const ACCEPT_IMPROVE_RATIO = 0.85;    // Kandidat muss lokalen Fehler < 85% senken
const ACCEPT_MIN_ABS_GAIN = 0.5;      // ... und mindestens so viel absolut gewinnen
const CLEAN_WIN_ABS = 90;             // Selbst-Fehler unter dem ein Snap als "sauber" gilt
const MIN_1PX_DIST = 24;              // 1-Pixel-Detail: Abstand zu BEIDEN Nachbarn darüber → kein Snap

// Phase 4 — zwei Dämpfungs-Ebenen:
const LEVEL1_REST = 0.5;   // HL₁ Fein-Tuning: 1-Pixel-Spikes → Amplitude halbieren
const LEVEL2_REST = 0.25;  // HL₂ Struktur: 4-Pixel-Rasterperioden → Amplitude vierteln
const RASTER_LINK_RATIO = 0.35; // Magnitude-Schwelle korrelierter Raster-Glieder (rel. zur Peak-Schwelle)
const RASTER_HALF_SPAN = 2;     // Raster-Ausdehnung ± RASTER_HALF_SPAN·4 Pixel vom Peak

// ---------------------------------------------------------------------------
// 5/3-Helfer (lokal, horizontal)
// ---------------------------------------------------------------------------

/**
 * Lokaler HL-Detail-Koeffizient (5/3-Highpass) des Fehlerbildes E = orig − dec
 * an (x,y):  d = E(x) − (E(x−1) + E(x+1)) / 2
 * Liefert die kombinierte Magnitude über R/G/B. Randspalten haben keinen
 * Detail-Koeffizienten und liefern 0.
 */
function hlDetailAtPixels(orig, dec, width, x, y) {
    if (x < 1 || x >= width - 1) return 0;
    const i = y * width + x;
    const l = i - 1, r = i + 1;
    let mag = 0;
    for (let c = 0; c < 3; c++) {
        const e0 = orig[i * 4 + c] - dec[i * 4 + c];
        const el = orig[l * 4 + c] - dec[l * 4 + c];
        const er = orig[r * 4 + c] - dec[r * 4 + c];
        mag += Math.abs(e0 - (el + er) / 2);
    }
    return mag;
}

/** Summe der HL-Details in einem ±1-Fenster um (x,y) — robuste lokale Bewertung. */
function localWindowError(orig, dec, width, x, y) {
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 1 || xx >= width - 1) continue;
        sum += hlDetailAtPixels(orig, dec, width, xx, y);
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Phase 1: Peak-Detektion im HL-Band
// ---------------------------------------------------------------------------

/**
 * Findet massive HL-Peaks des Fehlerbildes. Rückgabe: [{x, y, mag}],
 * nach Magnitude absteigend sortiert, mit Mindestabstand PEAK_MIN_SPACING.
 * Liefert zusätzlich die verwendete Magnitude-Schwelle für Folgephasen.
 */
function detectPeaks(orig, dec, width, height) {
    const n = width * height;
    const mags = new Float32Array(n);

    let sum = 0, sumSq = 0, count = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const m = hlDetailAtPixels(orig, dec, width, x, y);
            mags[i] = m;
            sum += m;
            sumSq += m * m;
            count++;
        }
    }
    if (count === 0) return { peaks: [], threshold: PEAK_MIN_MAG };

    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const std = Math.sqrt(variance);
    const threshold = Math.max(PEAK_MIN_MAG, mean + PEAK_SIGMA * std);

    // Kandidaten: über Schwelle UND lokales Maximum entlang x.
    const candidates = [];
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const m = mags[i];
            if (m < threshold) continue;
            if (m < mags[i - 1] || m < mags[i + 1]) continue;
            candidates.push({ x, y, mag: m });
        }
    }

    candidates.sort((a, b) => b.mag - a.mag);

    // Räumlich entkoppelte Peaks auswählen (gleiche Zeile: > PEAK_MIN_SPACING px).
    const peaks = [];
    for (const c of candidates) {
        let tooClose = false;
        for (const p of peaks) {
            if (p.y === c.y && Math.abs(p.x - c.x) <= PEAK_MIN_SPACING) {
                tooClose = true;
                break;
            }
        }
        if (!tooClose) peaks.push(c);
        if (peaks.length >= MAX_PEAKS) break;
    }
    return { peaks, threshold };
}

// ---------------------------------------------------------------------------
// Raster-Info des Formates (für Level-2-Klassifikation)
// ---------------------------------------------------------------------------

/**
 * Leitet aus der Sequenz eines Misch-Formates den sich wiederholenden Kern ab
 * (z. B. 63436343 → Kern "6343", Periode 4) und markiert dessen Positionen,
 * die KEINEN Anker-Slot referenzieren können (reine Delta-Formate, HAM01/02/03).
 * Fehler, die auf diesen Raster-Positionen liegen, kollidieren mit dem
 * Codec-Rhythmus und werden in Phase 4 mit Level 2 (stärker) gedämpft.
 * Rückgabe: { period, weak:Set } oder null für Nicht-Misch-Formate.
 */
function getRasterInfo(format) {
    const cfg = HAM_CONFIGS[format];
    if (!cfg || !cfg.isMixed || !Array.isArray(cfg.sequence) || cfg.sequence.length === 0) return null;
    const seq = cfg.sequence;

    let period = seq.length;
    for (let p = 1; p < seq.length; p++) {
        if (seq.length % p !== 0) continue;
        let ok = true;
        for (let i = 0; i < seq.length; i++) {
            if (seq[i] !== seq[i % p]) { ok = false; break; }
        }
        if (ok) { period = p; break; }
    }

    const weak = new Set();
    for (let i = 0; i < period; i++) {
        const sub = HAM_CONFIGS[seq[i]];
        if (!sub || !sub.slotsPerBank) weak.add(i); // ohne Anker-Slots
    }
    return { period, weak };
}

// ---------------------------------------------------------------------------
// Phase 2/3: Edge-Snapping
// ---------------------------------------------------------------------------

/**
 * Erzeugt ein Testbild, in dem für JEDEN Peak gleichzeitig die Verschiebung
 * `dir` angewendet wird (A: +1 vorziehen, B: −1 verzögern).
 */
function buildShiftedImage(source, width, peaks, dir) {
    const out = new Uint8ClampedArray(source);
    for (const p of peaks) {
        const fromX = p.x + dir;
        if (fromX < 0 || fromX >= width) continue;
        const toIdx = (p.y * width + p.x) * 4;
        const fromIdx = (p.y * width + fromX) * 4;
        out[toIdx] = source[fromIdx];
        out[toIdx + 1] = source[fromIdx + 1];
        out[toIdx + 2] = source[fromIdx + 2];
        out[toIdx + 3] = source[fromIdx + 3];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Phase 4: Wavelet-Dämpfung (lokal per 5/3-Lifting)
// ---------------------------------------------------------------------------

/**
 * Reduziert den lokalen HL-Koeffizienten an (x,y) exakt auf `rest`:
 *   h  = T(x) − (T(x−1) + T(x+1)) / 2      (5/3-Detail)
 *   T'(x) = T(x) − h·(1 − rest)            ⇒  h' = h·rest
 * Nachbarn bleiben unangetastet — der Wirkungsradius ist 1 Pixel.
 * Level 1 (rest 0.5): 1-Pixel-Spikes. Level 2 (rest 0.25): Raster-Strukturen.
 */
function dampHlAt(target, width, x, y, rest) {
    if (x < 1 || x >= width - 1) return;
    const i = y * width + x;
    const l = i - 1, r = i + 1;
    for (let c = 0; c < 3; c++) {
        const h = target[i * 4 + c] - (target[l * 4 + c] + target[r * 4 + c]) / 2;
        target[i * 4 + c] = clamp(Math.round(target[i * 4 + c] - h * (1 - rest)), 0, 255);
    }
}

/**
 * Findet die räumlich korrelierten Raster-Glieder eines Peaks (gleiche Zeile im
 * 4-Pixel-Takt: x±4, x±8; sowie die vertikalen Nachbarzeilen y±1 bei gleichem x,
 * für durchgehende vertikale Kanten). Nur Positionen mit signifikanter
 * Fehler-Magnitude (> RASTER_LINK_RATIO · threshold) zählen — so wird die
 * Level-2-Dämpfung auf die GESAMTE Raster-Struktur ausgeweitet, nicht nur auf
 * den einzelnen Peak.
 */
function findRasterLinks(orig, dec, width, height, x, y, threshold) {
    const out = [];
    const minMag = threshold * RASTER_LINK_RATIO;
    const consider = (xx, yy) => {
        if (xx < 1 || xx >= width - 1 || yy < 0 || yy >= height) return;
        if (hlDetailAtPixels(orig, dec, width, xx, yy) > minMag) out.push({ x: xx, y: yy });
    };
    for (let k = 1; k <= RASTER_HALF_SPAN; k++) {
        consider(x + 4 * k, y);
        consider(x - 4 * k, y);
    }
    consider(x, y - 1);
    consider(x, y + 1);
    return out;
}

// ---------------------------------------------------------------------------
// Haupt-Einstiegspunkt
// ---------------------------------------------------------------------------

async function encodeDecode(data, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress) {
    const encodeRes = await encodePaletted(
        data, width, height, format, step, paletteRAM, offset, strategy, metric,
        onProgress, 0, 0, 15.0
    );
    return decodePaletted(encodeRes.commands, width, height, step, paletteRAM, offset);
}

/**
 * Erzeugt das Smart Target.
 *
 * @param {Object}  opts
 * @param {Uint8ClampedArray} opts.sourceData  aktueller Quell-RGBA-Puffer
 * @param {number}  opts.width
 * @param {number}  opts.height
 * @param {Object}  opts.step       {r,g,b}
 * @param {string}  opts.metric
 * @param {string}  opts.format     aktuelles HAM-Format
 * @param {Uint8Array} opts.paletteRAM  (256*3)
 * @param {number}  opts.offset     Palette-Offset
 * @param {string}  opts.strategy
 * @param {Function} [opts.onProgress]  (phase, current, total)
 * @returns {Promise<{target: Uint8ClampedArray, log: string[]}>}
 */
export async function generateSmartTarget({
    sourceData,
    width,
    height,
    step,
    metric,
    format,
    paletteRAM,
    offset,
    strategy,
    onProgress
}) {
    const log = [];
    const report = (p, c, t) => { if (onProgress) onProgress(p, c, t); };

    report('Phase 1/4: Scanner (Encode/Decode + HL-Peaks)', 0, 4);
    const dec = await encodeDecode(sourceData, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);

    const { peaks, threshold } = detectPeaks(sourceData, dec, width, height);
    log.push(`Scanner: ${peaks.length} HL-Peaks gefunden`);
    report(`Phase 1/4: ${peaks.length} HL-Peaks gefunden`, 1, 4);

    if (peaks.length === 0) {
        report('Keine Artefakte — Smart Target = Original', 4, 4);
        return { target: new Uint8ClampedArray(sourceData), log };
    }

    report('Phase 2/4: Edge-Snapping (A/B-Batch-Test)', 1, 4);
    const testA = buildShiftedImage(sourceData, width, peaks, +1);
    const testB = buildShiftedImage(sourceData, width, peaks, -1);
    const decA = await encodeDecode(testA, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);
    const decB = await encodeDecode(testB, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);

    const target = new Uint8ClampedArray(sourceData);
    const remaining = [];
    let snapCount = 0;

    for (const p of peaks) {
        // 1-Pixel-Detail-Schutz: weicht das Pixel in der QUELLE deutlich von
        // BEIDEN Nachbarn ab (dünne Linie/Spitze), würde ein Snap (Pixel X
        // übernimmt X±1) es auslöschen. Solche Details gehen laut Spezifikation
        // an die Dämpfung (Phase 4) statt an das Edge-Snapping.
        const oi = p.y * width + p.x;
        const ox = oi * 4;
        let dL = 0, dR = 0;
        if (p.x > 0 && p.x < width - 1) {
            for (let c = 0; c < 3; c++) {
                dL += Math.abs(sourceData[ox + c] - sourceData[ox - 4 + c]);
                dR += Math.abs(sourceData[ox + c] - sourceData[ox + 4 + c]);
            }
        }
        if (dL > MIN_1PX_DIST && dR > MIN_1PX_DIST) { remaining.push(p); continue; }

        // Selbst-Fehler |Bild − decode(Bild)| im ±1-Fenster um den Peak.
        // Entscheidend ist NICHT die Abweichung vom Original (die ist durch die
        // Modifikation gewollt), sondern ob das MODIFIZIERTE Bild nach dem
        // Encode/Decode artefaktfrei ist — nur dann ist der Kettenriss wirklich
        // eliminiert (Kante liegt jetzt auf einem starken Slot/Anker). Ein
        // Vergleich mit dem unveränderten Original würde jeden Snap prinzipbedingt
        // ablehnen, weil das verschobene Pixel dort absichtlich nicht mehr stimmt.
        const w0 = localWindowError(sourceData, dec, width, p.x, p.y);
        const wA = localWindowError(testA, decA, width, p.x, p.y);
        const wB = localWindowError(testB, decB, width, p.x, p.y);

        const isCleanFix = (wCand) =>
            wCand < w0 * ACCEPT_IMPROVE_RATIO &&   // deutlich besser als der Artefakt
            (w0 - wCand) > ACCEPT_MIN_ABS_GAIN &&  // echter Gewinn
            wCand < CLEAN_WIN_ABS;                 // und lokal wirklich sauber
        const okA = isCleanFix(wA);
        const okB = isCleanFix(wB);

        let dir = 0;
        if (okA && okB) dir = wA <= wB ? +1 : -1;
        else if (okA) dir = +1;
        else if (okB) dir = -1;

        const fromX = p.x + dir;
        if (dir !== 0 && fromX >= 0 && fromX < width) {
            const toIdx = (p.y * width + p.x) * 4;
            const fromIdx = (p.y * width + fromX) * 4;
            target[toIdx] = sourceData[fromIdx];
            target[toIdx + 1] = sourceData[fromIdx + 1];
            target[toIdx + 2] = sourceData[fromIdx + 2];
            snapCount++;
        } else {
            remaining.push(p);
        }
    }
    log.push(`Edge-Snapping: ${snapCount} Kanten verschoben, ${remaining.length} verbleiben`);
    report(`Phase 3/4: ${snapCount} Kanten gesnappt`, 2, 4);

    // Phase 4 — Zwei-Ebenen-Dämpfung:
    //   Level 1 (HL₁, Rest 1/2): isolierte 1-Pixel-Spikes.
    //   Level 2 (HL₂, Rest 1/4): Fehler auf Rasterpositionen des Formats, die
    //     keinen Anker-Slot erreichen (z. B. HAM03 im 6343-Kern), sowie Fehler
    //     mit räumlich korrelierten Raster-Gliedern (x±4k, vertikale Nachbarn).
    //     Level 2 wird auf die GESAMTE korrelierte Struktur ausgeweitet, damit
    //     das Bild exakt in den Rhythmus des Format-Rasters gezwungen wird.
    report('Phase 4/4: Wavelet-Dämpfung (2 Ebenen)', 3, 4);
    const raster = getRasterInfo(format);
    const level2Pos = new Set(); // Pixel, die mit Level 2 (stärker) gedämpft werden

    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const phase = raster ? ((p.x % raster.period) + raster.period) % raster.period : -1;
        const onWeakSlot = raster ? raster.weak.has(phase) : false;
        const links = findRasterLinks(sourceData, dec, width, height, p.x, p.y, threshold);
        if (onWeakSlot || links.length > 0) {
            level2Pos.add(p.y * width + p.x);
            for (const l of links) level2Pos.add(l.y * width + l.x);
        }
    }

    let spikeCount = 0, structPixel = 0;
    const damped = new Set();
    const damp = (x, y, rest) => {
        const key = y * width + x;
        if (damped.has(key)) return;
        damped.add(key);
        dampHlAt(target, width, x, y, rest);
    };

    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const key = p.y * width + p.x;
        if (level2Pos.has(key)) structPixel++;
        else spikeCount++;
        damp(p.x, p.y, level2Pos.has(key) ? LEVEL2_REST : LEVEL1_REST);
    }
    for (const key of level2Pos) { // ausgeweitete Raster-Glieder
        if (damped.has(key)) continue;
        structPixel++;
        damp(key % width, (key / width) | 0, LEVEL2_REST);
    }
    log.push(`Wavelet-Dämpfung: ${spikeCount} Spikes auf ${Math.round(LEVEL1_REST * 100)}%, ${structPixel} Raster-Struktur-Pixel auf ${Math.round(LEVEL2_REST * 100)}% (gesamt ${damped.size} px modifiziert)`);
    report('Smart Target fertig', 4, 4);

    return { target, log };
}
