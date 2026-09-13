// src/core/smart_target.js

import { encodePaletted, decodePaletted } from './module_paletted.js';
import { clamp } from '../codecs/utils.js';
import { HAM_CONFIGS } from '../codecs/configs.js';

// ---------------------------------------------------------------------------
// Tuning-Parameter
// ---------------------------------------------------------------------------
const PEAK_MIN_SPACING = 4;
const MAX_PEAKS = 8000;
const ACCEPT_IMPROVE_RATIO = 0.85;
const ACCEPT_MIN_ABS_GAIN = 0.5;
const CLEAN_WIN_ABS = 90;
const MIN_1PX_DIST_SQ = 576; // 24^2 für euklidische Distanz

const LEVEL1_REST = 0.5;
const LEVEL2_REST = 0.25;
const RASTER_LINK_RATIO = 0.35;
const RASTER_HALF_SPAN = 2;

// Luma-Gewichte zur psycho-visuellen Anpassung
const LUMA_W = [0.299, 0.587, 0.114];

// ---------------------------------------------------------------------------
// 5/3-Helfer (lokal, horizontal)
// ---------------------------------------------------------------------------

function hlDetailAtPixels(orig, dec, width, x, y) {
    if (x < 1 || x >= width - 1) return 0;
    const i = y * width + x;
    const l = i - 1, r = i + 1;
    let mag = 0;
    for (let c = 0; c < 3; c++) {
        const e0 = orig[i * 4 + c] - dec[i * 4 + c];
        const el = orig[l * 4 + c] - dec[l * 4 + c];
        const er = orig[r * 4 + c] - dec[r * 4 + c];
        // Integer-Lifting für exakte Reversibilität
        const h = e0 - ((el + er) >> 1);
        mag += Math.abs(h) * LUMA_W[c];
    }
    return mag;
}

// Berechnet das komplette HL-Band einmal in ein Float32Array. detectPeaks,
// localWindowError (Quellbild) und findRasterLinks greifen danach nur noch
// lesend zu, statt hlDetailAtPixels pro Pixel erneut auszuführen.
function computeHlMap(orig, dec, width, height) {
    const map = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const i = row + x;
            const l = i - 1, r = i + 1;
            let mag = 0;
            for (let c = 0; c < 3; c++) {
                const e0 = orig[i * 4 + c] - dec[i * 4 + c];
                const el = orig[l * 4 + c] - dec[l * 4 + c];
                const er = orig[r * 4 + c] - dec[r * 4 + c];
                const h = e0 - ((el + er) >> 1);
                mag += Math.abs(h) * LUMA_W[c];
            }
            map[i] = mag;
        }
    }
    return map;
}

function localWindowError(orig, dec, width, x, y) {
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 1 || xx >= width - 1) continue;
        sum += hlDetailAtPixels(orig, dec, width, xx, y);
    }
    return sum;
}

function localWindowErrorFromMap(hlMap, width, x, y) {
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 1 || xx >= width - 1) continue;
        sum += hlMap[y * width + xx];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Phase 1: Peak-Detektion im HL-Band (Zero-Allocation)
// ---------------------------------------------------------------------------

// Peaks über der (manuellen) Schwelle. Schwelle 0 = KEINE Modifikation.
// Die HL-Statistik wird zusätzlich zurückgegeben, damit das UI eine sinnvolle
// Schwelle vorschlagen kann.
function detectPeaks(hlMap, width, height, peakThreshold = 0) {
    let sum = 0, sumSq = 0, count = 0;
    
    // Pass 1: Statistische Basis ermitteln (liest nur aus dem HL-Band)
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const m = hlMap[row + x];
            sum += m;
            sumSq += m * m;
            count++;
        }
    }
    const mean = count > 0 ? sum / count : 0;
    const std = count > 0 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0;

    // Schwelle 0 (oder keine Pixel) → keine Modifikation
    if (peakThreshold <= 0 || count === 0) {
        return { peaks: [], threshold: 0, mean, std };
    }

    const threshold = peakThreshold;

    // Pass 2: Kandidaten isolieren
    const candidates = [];
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const m = hlMap[row + x];
            if (m < threshold) continue;
            
            // Lokale Maxima Prüfung
            if (m < hlMap[row + (x - 1)]) continue;
            if (m < hlMap[row + (x + 1)]) continue;
            
            candidates.push({ x, y, mag: m });
        }
    }

    candidates.sort((a, b) => b.mag - a.mag);

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
    return { peaks, threshold, mean, std };
}

// ---------------------------------------------------------------------------
// Raster-Info
// ---------------------------------------------------------------------------

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
        if (!sub || !sub.slotsPerBank) weak.add(i);
    }
    return { period, weak };
}

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
// Phase 4: Wavelet-Dämpfung (Referenz-gesichert)
// ---------------------------------------------------------------------------

function dampHlAt(target, reference, width, x, y, rest) {
    if (x < 1 || x >= width - 1) return;
    const i = y * width + x;
    const l = i - 1, r = i + 1;
    for (let c = 0; c < 3; c++) {
        const el = reference[l * 4 + c];
        const er = reference[r * 4 + c];
        const e0 = reference[i * 4 + c];
        
        // Exaktes Integer-Lifting über Referenzbild
        const h = e0 - ((el + er) >> 1);
        target[i * 4 + c] = clamp(Math.round(e0 - h * (1 - rest)), 0, 255);
    }
}

function findRasterLinks(hlMap, width, height, x, y, threshold) {
    const out = [];
    const minMag = threshold * RASTER_LINK_RATIO;
    const consider = (xx, yy) => {
        if (xx < 1 || xx >= width - 1 || yy < 0 || yy >= height) return;
        if (hlMap[yy * width + xx] > minMag) out.push({ x: xx, y: yy });
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

// ---------------------------------------------------------------------------
// Kontrast-Snap: Pixel nahe Schwarz/Weiß auf die exakten Extremwerte ziehen.
// Kriterium ist der einstellbare RGB-Abstand als Summe der Kanaldifferenzen:
//   Schwarz: r + g + b                          < blackThreshold
//   Weiß:    (255-r) + (255-g) + (255-b)        < whiteThreshold
// Beispiel: blackThreshold = 20 → alle Pixel mit r+g+b < 20 werden zu (0,0,0).
// 0 = Funktion deaktiviert. Alpha bleibt unverändert.
// ---------------------------------------------------------------------------
function snapExtremes(target, blackThreshold, whiteThreshold) {
    let blacks = 0, whites = 0;
    if (blackThreshold <= 0 && whiteThreshold <= 0) return { blacks, whites };

    for (let i = 0; i < target.length; i += 4) {
        const r = target[i], g = target[i + 1], b = target[i + 2];
        if (blackThreshold > 0 && (r + g + b) < blackThreshold) {
            target[i] = 0; target[i + 1] = 0; target[i + 2] = 0;
            blacks++;
        } else if (whiteThreshold > 0 && ((255 - r) + (255 - g) + (255 - b)) < whiteThreshold) {
            target[i] = 255; target[i + 1] = 255; target[i + 2] = 255;
            whites++;
        }
    }
    return { blacks, whites };
}

// ---------------------------------------------------------------------------
// Fehlerbild = |Original - Decodiert| JE KANAL (klassisches Differenzbild):
//   R = |dR|, G = |dG|, B = |dB|  →  Farbsäume dort, wo der Codec daneben liegt.
// Zusätzlich werden Statistiken und (bei Schwelle > 0) die Anzahl der Pixel
// zurückgegeben, die Smart Target bearbeiten würde (HL-Magnitude ≥ Schwelle).
// Wird beim Codieren erzeugt.
// ---------------------------------------------------------------------------
export function buildErrorMap(sourceData, decData, width, height, threshold = 0) {
    const out = new Uint8ClampedArray(width * height * 4);
    let max = 0, sum = 0, sumSq = 0, count = 0;

    for (let i = 0; i < sourceData.length; i += 4) {
        const dr = Math.abs(sourceData[i] - decData[i]);
        const dg = Math.abs(sourceData[i + 1] - decData[i + 1]);
        const db = Math.abs(sourceData[i + 2] - decData[i + 2]);
        out[i] = dr; out[i + 1] = dg; out[i + 2] = db; out[i + 3] = 255;

        const m = dr + dg + db;
        if (m > max) max = m;
        sum += m; sumSq += m * m; count++;
    }
    const mean = count > 0 ? sum / count : 0;
    const std = count > 0 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0;

    // Info für die Modifikations-Schwelle (Smart Target arbeitet auf der HL-Magnitude)
    const hlMap = computeHlMap(sourceData, decData, width, height);
    let hSum = 0, hSumSq = 0, overCount = 0;
    for (let i = 0; i < hlMap.length; i++) {
        const m = hlMap[i];
        hSum += m; hSumSq += m * m;
        if (threshold > 0 && m >= threshold) overCount++;
    }
    const hlMean = hlMap.length > 0 ? hSum / hlMap.length : 0;
    const hlStd = hlMap.length > 0 ? Math.sqrt(Math.max(0, hSumSq / hlMap.length - hlMean * hlMean)) : 0;

    return {
        errorMap: out,
        max, mean, std,
        overCount,
        thresholdSuggestion: Math.max(1, Math.round(hlMean + 2 * hlStd))
    };
}

// ---------------------------------------------------------------------------
// Snap vom Original auf das modifizierte Bild übertragen: Das Kriterium wird
// am ORIGINAL-Pixel ausgewertet, geschrieben wird exakt 0 bzw. 255 in das
// modifizierte Bild. So bleiben nahe Schwarz/Weiß liegende Bereiche des
// Originals auch nach der Smart-Target-Reparatur exakt (Slot-0-Anker / Weiß).
// ---------------------------------------------------------------------------
export function applySnapFromOriginal(originalData, modifiedData, blackThreshold, whiteThreshold) {
    let blacks = 0, whites = 0;
    if (blackThreshold <= 0 && whiteThreshold <= 0) return { blacks, whites };
    const n = Math.min(originalData.length, modifiedData.length);
    for (let i = 0; i < n; i += 4) {
        const r = originalData[i], g = originalData[i + 1], b = originalData[i + 2];
        if (blackThreshold > 0 && (r + g + b) < blackThreshold) {
            modifiedData[i] = 0; modifiedData[i + 1] = 0; modifiedData[i + 2] = 0;
            blacks++;
        } else if (whiteThreshold > 0 && ((255 - r) + (255 - g) + (255 - b)) < whiteThreshold) {
            modifiedData[i] = 255; modifiedData[i + 1] = 255; modifiedData[i + 2] = 255;
            whites++;
        }
    }
    return { blacks, whites };
}

// ---------------------------------------------------------------------------
// Lokaler Wavelet-Filter: dämpft die HL-Details in einer 3×3-Region um (cx,cy)
// im ZIEL-Bild (z. B. dem modifizierten Bild). Gearbeitet wird auf einem
// Snapshot als Referenz, damit exaktes Integer-Lifting ohne Kaskade entsteht.
// Liefert die Anzahl geänderter Pixel und den geänderten Pixelbereich zurück.
// ---------------------------------------------------------------------------
export function applyLocalWaveletDamping(data, width, height, cx, cy, rest = LEVEL1_REST) {
    const reference = new Uint8ClampedArray(data);
    const y0 = Math.max(0, cy - 1), y1 = Math.min(height - 1, cy + 1);
    const x0 = Math.max(1, cx - 1), x1 = Math.min(width - 2, cx + 1);

    let changed = 0;
    let firstPx = -1, lastPx = -1;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const o = (y * width + x) * 4;
            const b0 = data[o], b1 = data[o + 1], b2 = data[o + 2];
            dampHlAt(data, reference, width, x, y, rest);
            if (data[o] !== b0 || data[o + 1] !== b1 || data[o + 2] !== b2) {
                const px = y * width + x;
                changed++;
                if (firstPx === -1 || px < firstPx) firstPx = px;
                if (px > lastPx) lastPx = px;
            }
        }
    }
    return { changed, firstPx, lastPx, x0, x1, y0, y1 };
}

export async function generateSmartTarget({
    sourceData, width, height, step, metric, format, paletteRAM, offset, strategy, onProgress,
    snapBlack = 0, snapWhite = 0, peakThreshold = 0
}) {
    const log = [];
    const report = (p, c, t) => { if (onProgress) onProgress(p, c, t); };

    report('Phase 1/4: Scanner (Encode/Decode + HL-Peaks)', 0, 4);
    const dec = await encodeDecode(sourceData, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);

    // HL-Band einmal berechnen und für Peaks, Edge-Snapping und Raster-Links teilen.
    const hlMap = computeHlMap(sourceData, dec, width, height);
    const { peaks, threshold, mean, std } = detectPeaks(hlMap, width, height, peakThreshold);
    log.push(`HL-Statistik: Mittelwert ${mean.toFixed(1)}, σ ${std.toFixed(1)} (Vorschlag Schwelle: ${Math.max(1, Math.round(mean + 2 * std))})`);

    // Schwelle 0 = keine Modifikation: nur Original (+ optionaler Snap) übernehmen.
    if (peakThreshold <= 0) {
        const target = new Uint8ClampedArray(sourceData);
        const snap = snapExtremes(target, snapBlack, snapWhite);
        if (snap.blacks || snap.whites) log.push(`Kontrast-Snap: ${snap.blacks} px → Schwarz(0,0,0), ${snap.whites} px → Weiß(255,255,255)`);
        log.push('Schwelle 0 → keine Modifikation');
        report('Schwelle 0 — keine Modifikation', 4, 4);
        return { target, log };
    }

    log.push(`Scanner: ${peaks.length} HL-Peaks über Schwelle ${threshold}`);
    report(`Phase 1/4: ${peaks.length} HL-Peaks gefunden`, 1, 4);

    if (peaks.length === 0) {
        const target = new Uint8ClampedArray(sourceData);
        const snap = snapExtremes(target, snapBlack, snapWhite);
        if (snap.blacks || snap.whites) log.push(`Kontrast-Snap: ${snap.blacks} px → Schwarz(0,0,0), ${snap.whites} px → Weiß(255,255,255)`);
        log.push('Keine Artefakte über der Schwelle');
        report('Keine Artefakte über der Schwelle', 4, 4);
        return { target, log };
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
        const oi = p.y * width + p.x;
        const ox = oi * 4;
        let dL = 0, dR = 0;
        
        // Euklidische Distanz (quadriert) für präziseren 1-Pixel-Schutz
        if (p.x > 0 && p.x < width - 1) {
            for (let c = 0; c < 3; c++) {
                const diffL = sourceData[ox + c] - sourceData[ox - 4 + c];
                const diffR = sourceData[ox + c] - sourceData[ox + 4 + c];
                dL += diffL * diffL;
                dR += diffR * diffR;
            }
        }
        if (dL > MIN_1PX_DIST_SQ && dR > MIN_1PX_DIST_SQ) { remaining.push(p); continue; }

        const w0 = localWindowErrorFromMap(hlMap, width, p.x, p.y);
        const wA = localWindowError(testA, decA, width, p.x, p.y);
        const wB = localWindowError(testB, decB, width, p.x, p.y);

        const isCleanFix = (wCand) =>
            wCand < w0 * ACCEPT_IMPROVE_RATIO && 
            (w0 - wCand) > ACCEPT_MIN_ABS_GAIN &&
            wCand < CLEAN_WIN_ABS;
            
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

    report('Phase 4/4: Wavelet-Dämpfung (2 Ebenen)', 3, 4);
    const raster = getRasterInfo(format);
    const level2Pos = new Set(); 

    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const phase = raster ? ((p.x % raster.period) + raster.period) % raster.period : -1;
        const onWeakSlot = raster ? raster.weak.has(phase) : false;
        const links = findRasterLinks(hlMap, width, height, p.x, p.y, threshold);
        if (onWeakSlot || links.length > 0) {
            level2Pos.add(p.y * width + p.x);
            for (const l of links) level2Pos.add(l.y * width + l.x);
        }
    }

    let spikeCount = 0, structPixel = 0;
    const damped = new Set();
    
    // Referenzbild für Wavelet-Dämpfung, um Kaskadeneffekte zu vermeiden
    const reference = new Uint8ClampedArray(target);
    
    const damp = (x, y, rest) => {
        const key = y * width + x;
        if (damped.has(key)) return;
        damped.add(key);
        dampHlAt(target, reference, width, x, y, rest);
    };

    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const key = p.y * width + p.x;
        if (level2Pos.has(key)) structPixel++;
        else spikeCount++;
        damp(p.x, p.y, level2Pos.has(key) ? LEVEL2_REST : LEVEL1_REST);
    }
    for (const key of level2Pos) {
        if (damped.has(key)) continue;
        structPixel++;
        damp(key % width, (key / width) | 0, LEVEL2_REST);
    }
    log.push(`Wavelet-Dämpfung: ${spikeCount} Spikes auf ${Math.round(LEVEL1_REST * 100)}%, ${structPixel} Raster-Struktur-Pixel auf ${Math.round(LEVEL2_REST * 100)}% (gesamt ${damped.size} px modifiziert)`);

    // Kontrast-Snap zuletzt: nahe Schwarz/Weiß liegende Pixel exakt auf 0 bzw. 255
    const snap = snapExtremes(target, snapBlack, snapWhite);
    if (snap.blacks || snap.whites) {
        log.push(`Kontrast-Snap: ${snap.blacks} px → Schwarz(0,0,0), ${snap.whites} px → Weiß(255,255,255) [Schwellen S/W: ${snapBlack}/${snapWhite}]`);
    }
    report('Smart Target fertig', 4, 4);

    return { target, log };
}