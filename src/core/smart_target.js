// src/core/smart_target.js

import { encodePaletted, decodePaletted } from './module_paletted.js';
import { clamp } from '../codecs/utils.js';
import { HAM_CONFIGS } from '../codecs/configs.js';

// ---------------------------------------------------------------------------
// Tuning-Parameter
// ---------------------------------------------------------------------------
const PEAK_MIN_MAG = 20;
const PEAK_SIGMA = 1.5;
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
// Phase 1: Peak-Detektion im HL-Band (Zero-Allocation)
// ---------------------------------------------------------------------------

function detectPeaks(orig, dec, width, height) {
    let sum = 0, sumSq = 0, count = 0;
    
    // Pass 1: Statistische Basis ermitteln (On-the-fly)
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width - 1; x++) {
            const m = hlDetailAtPixels(orig, dec, width, x, y);
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

    // Pass 2: Kandidaten isolieren
    const candidates = [];
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width - 1; x++) {
            const m = hlDetailAtPixels(orig, dec, width, x, y);
            if (m < threshold) continue;
            
            // Lokale Maxima Prüfung
            const ml = hlDetailAtPixels(orig, dec, width, x - 1, y);
            if (m < ml) continue;
            const mr = hlDetailAtPixels(orig, dec, width, x + 1, y);
            if (m < mr) continue;
            
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
    return { peaks, threshold };
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

export async function generateSmartTarget({
    sourceData, width, height, step, metric, format, paletteRAM, offset, strategy, onProgress
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

        const w0 = localWindowError(sourceData, dec, width, p.x, p.y);
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
        const links = findRasterLinks(sourceData, dec, width, height, p.x, p.y, threshold);
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
    report('Smart Target fertig', 4, 4);

    return { target, log };
}