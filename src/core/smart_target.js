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
// Kernel-Breite der Wavelet-Dämpfung in Pixeln (±span). 1 = nur die direkten
// Nachbarn.
//
// ACHTUNG, gemessen (876x882, Schwelle 8, Anker 24) — breiter und stärker hilft
// NICHT, es macht die Zieltreue schlechter:
//   span 1 / rest 0.25 → 19.99 | span 1 / rest 0 → 19.90
//   span 3 / rest 0.25 → 20.70 | span 3 / rest 0 → 20.84
// Grund siehe QUANTIZE_DAMP: die Dämpfung erzeugt Mischfarben, die nicht in der
// Palette stehen. Mehr Dämpfung heißt nur mehr unrepräsentierbare Farben. Wer
// die Wirkung erhöhen will, dreht an der Palettentreue, nicht an der Stärke.
const DAMP_SPAN = 1;

// Gedämpfte Werte auf eine Palettenfarbe ziehen, die die Phase dieses Pixels
// auch anspringen kann. Das ist der eigentliche Hebel (gleiche Bedingungen):
//   aus:  Zieltreue 19.99, Mittel 25.7 je geändertem Pixel
//   an:   Zieltreue 16.32, Mittel 39.9
// Also 18% bessere Zieltreue bei praktisch gleicher Pixelzahl (38852 → 39047).
// Beleg für die Ursache: 38192 von 38195 gedämpften Pixeln lagen VORHER
// außerhalb der Palette — der Encoder konnte die geglätteten Werte gar nicht
// treffen. Deshalb brachte stärkeres Glätten nichts: es erzeugte nur noch mehr
// solcher Farben.
// Preis: der einzelne Pixel wird weiter verschoben (Mittel 26 → 40), weil eine
// schwache Phase nur ihre 4 Plätze anspringen kann. Dafür steht dort eine
// glatte, exakt reproduzierte Farbe statt eines verwaschenen Zwischentons.
const QUANTIZE_DAMP = true;
// Mindest-HL-Magnitude eines Nachbarn (als Anteil der Schwelle), damit er als
// Teil DERSELBEN hochfrequenten Struktur gilt. Hieß vorher RASTER_LINK_RATIO.
const STRUCTURE_MAG_RATIO = 0.35;
const RASTER_HALF_SPAN = 2;

// Ab dieser Distanz (euklidisch in RGB) gilt eine Farbe als "nicht durch die
// Palette darstellbar", also als ohne Ankerfarbe. Gemessen am echten 876x882-Foto
// mit fester Palette, 8000 Peaks: auf der STARKEN Phase liegen 76,8% der Peaks
// innerhalb 24, auf der eigenen schwachen Phase nur 3,8% (Mittel 17,8 gegen 49,5).
// Nur wenn auch die stärkste Phase nichts in Reichweite hat, kann Verschieben
// nicht helfen — dann ist Dämpfen die einzige Möglichkeit.
const ANCHOR_TOL = 24;

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
// localWindowError (Quellbild) und collectStructureNeighbours greifen danach nur noch
// lesend zu, statt hlDetailAtPixels pro Pixel erneut auszuführen.
export function computeHlMap(orig, dec, width, height) {
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
export function detectPeaks(hlMap, width, height, peakThreshold = 0) {
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

// Nächste erreichbare Palettenfarbe für eine Phase (nicht nur der Abstand).
function nearestPaletteColor(paletteRAM, nSlots, r, g, b) {
    let best = null, bestD2 = Infinity;
    const n = Math.min(nSlots, Math.floor(paletteRAM.length / 3));
    for (let i = 0; i < n; i++) {
        const dr = paletteRAM[i * 3] - r, dg = paletteRAM[i * 3 + 1] - g, db = paletteRAM[i * 3 + 2] - b;
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = { r: paletteRAM[i * 3], g: paletteRAM[i * 3 + 1], b: paletteRAM[i * 3 + 2] };
            if (d2 === 0) break;
        }
    }
    return best;
}

// Nächste erreichbare Palettenfarbe für eine Phase: eine Phase kann nur die
// ersten `nSlots` Einträge der Palette anspringen (HAM03 = 4, HAM04 = 8,
// HAM06 = 32). Der Abstand sagt, welchen Farbfehler die Slot-Grenze erzwingt.
function nearestPaletteDist(paletteRAM, nSlots, r, g, b) {
    let best = Infinity;
    const n = Math.min(nSlots, Math.floor(paletteRAM.length / 3));
    for (let i = 0; i < n; i++) {
        const dr = paletteRAM[i * 3] - r, dg = paletteRAM[i * 3 + 1] - g, db = paletteRAM[i * 3 + 2] - b;
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < best) { best = d2; if (best === 0) break; }
    }
    return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// Raster-Info
// ---------------------------------------------------------------------------

// Phasen-Info des Mischrasters.
//
// "Schwach" heißt: diese Phase hat WENIGER ALS DIE HÄLFTE der Ankerplätze der
// stärksten Phase und kann eine harte Kante deshalb nicht zuverlässig exakt
// darstellen. Genau diese Phasen sind das Ziel der Modifikation (Kante auf die
// starke Phase schieben bzw. den Rest dort stärker dämpfen).
//
// Vorher wurde `!sub.slotsPerBank` geprüft — das ist nur bei HAM01/HAM02 wahr,
// und die kommen in KEINER Sequenz vor. Die Menge war damit für jedes reale
// Format leer und der Zweig lief nie.
//
// Die Hälfte-Regel trifft für die 32-Bit-Formate genau die Phasen, die keine
// harte Kante tragen können (HAM03 = 4, HAM04 = 8), lässt aber HAM05 (16) als
// Zielphase in Ruhe — bei 655655 (32/16/16) ist also nichts schwach, bei
// 63436343 (32/4/8/4) sind es die Phasen 1, 2 und 3, bei 53535353 (16/4) nur
// Phase 1. Ein gleichmäßiges Raster (44444444, 8888) hat korrekt keine schwache
// Phase — dort gibt es keine bessere, auf die man ausweichen könnte.
export function getRasterInfo(format) {
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

    const slots = [];
    for (let i = 0; i < period; i++) {
        const sub = HAM_CONFIGS[seq[i]];
        slots.push(sub && sub.slotsPerBank ? sub.slotsPerBank : 0);
    }
    const maxSlots = Math.max(...slots);

    const weak = new Set();
    for (let i = 0; i < period; i++) {
        if (slots[i] * 2 < maxSlots) weak.add(i);
    }
    return { period, weak, slots, maxSlots, names: seq.slice(0, period) };
}

// Nächste Position, die die Kante überhaupt tragen kann: kleinster Versatz je
// Richtung, der von dieser Phase auf eine STARKE (nicht-schwache) Phase führt.
// 0 = kein Versatz möglich oder nötig. Das ist der "next"-Teil des Rasters —
// bewusst NICHT "find irgendeinen Nachbarn", sondern "finde die nächste Position
// mit genug Ankerplätzen". Gegenstück zu collectStructureNeighbours, das die
// Nachbarn DERSELBEN Phase für die Dämpfung sammelt.
//
// Beispiel 63436343 (Periode 4, Plätze 32/4/8/4, schwach {1,2,3}, stark {0}):
//   Phase 1 → −1 (auf 0)      | Phase 2 → −2 oder +2 (auf 0)  ← mit ±1 NICHT erreichbar
//   Phase 3 → +1 (auf 0)      | Phase 0 → 0 (schon stark)
// Ohne diesen Schritt bleiben die Peaks auf Phase 2 (gemessen 21,8% aller Peaks)
// unerreichbar, weil ±1 von Phase 2 nur auf HAM03 führt — also auf eine noch
// schwächere Phase.
function nextStrongPhaseOffset(phase, raster) {
    if (!raster || raster.weak.size === 0 || !raster.weak.has(phase)) return { plus: 0, minus: 0 };
    const P = raster.period;
    let plus = 0, minus = 0;
    for (let d = 1; d <= P; d++) {
        if (!raster.weak.has((phase + d) % P)) { plus = d; break; }
    }
    for (let d = 1; d <= P; d++) {
        if (!raster.weak.has(((phase - d) % P + P) % P)) { minus = -d; break; }
    }
    return { plus, minus };
}

// Verschiebt jeden Peak um SEINEN Versatz (Feld `key` = 'dPlus'/'dMinus').
// Versatz 0 bedeutet: dieser Peak wird nicht verschoben.
function buildShiftedImage(source, width, peaks, key) {
    const out = new Uint8ClampedArray(source);
    for (const p of peaks) {
        const dir = p[key] || 0;
        if (dir === 0) continue;
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

function dampHlAt(target, reference, width, x, y, rest, span = 1) {
    if (x < 1 || x >= width - 1) return;
    const i = y * width + x;
    // Kernel-Breite: span = 1 ist der bisherige 3-Tap-Filter (nur linker und
    // rechter Nachbar). Größere Werte mitteln über ±span Pixel und erfassen
    // damit auch Wechsel, die dichter als 2 Pixel sind — genau der Fall
    // "Rot/Blau im Wechsel", den ein 3-Tap-Filter kaum berührt.
    const x0 = Math.max(0, x - span), x1 = Math.min(width - 1, x + span);
    for (let c = 0; c < 3; c++) {
        const e0 = reference[i * 4 + c];
        let low;
        if (span === 1) {
            // unverändert zum bisherigen Verhalten (exaktes Integer-Lifting)
            low = (reference[(i - 1) * 4 + c] + reference[(i + 1) * 4 + c]) >> 1;
        } else {
            let sum = 0, n = 0;
            for (let xx = x0; xx <= x1; xx++) {
                if (xx === x) continue;
                sum += reference[(y * width + xx) * 4 + c];
                n++;
            }
            if (n === 0) continue;
            low = Math.round(sum / n);
        }
        const h = e0 - low;
        target[i * 4 + c] = clamp(Math.round(e0 - h * (1 - rest)), 0, 255);
    }
}

// Sammelt die Nachbarn, die zur SELBEN hochfrequenten Struktur gehören wie der
// Peak — also Pixel, die selbst strukturiert sind (HL über STRUCTURE_MAG_RATIO
// der Schwelle), aber nicht stark genug, um eigene Peaks zu sein.
//
// Zwei Arten von Nachbarn:
//   • horizontal im Abstand der Raster-Periode (step): dieselbe Phase, also
//     dieselbe Ankerkapazität. Das ist die Struktur, die der Encoder entlang
//     der Zeile zusammenhängend behandeln muss.
//   • direkt darüber/darunter: eine waagerechte Kante erstreckt sich über
//     Zeilen, ein nur in einer Zeile gedämpfter Peak würde sie stehen lassen.
//     (Diese Nachbarn liegen übrigens nur dann auf derselben Phase, wenn die
//     Bildbreite ein Vielfaches der Periode ist — bei 876 und Periode 4 ja,
//     bei 876 und Periode 7 nicht.)
//
// Hieß vorher `findRasterLinks`. Der Name war doppelt irreführend: "Links" liest
// sich in dieser Datei als "links" = left (direkt daneben stehen dL/dR für
// distance-left/right), und die vertikalen Nachbarn sind eben nicht
// raster-phasengleich. Der Rückgabewert ist keine Verknüpfung, sondern eine
// Kandidatenmenge für die Dämpfung. Alternative Namen, falls gewünscht:
// `findRasterSiblings` oder `collectSamePhaseNeighbours`.
function collectStructureNeighbours(hlMap, width, height, x, y, threshold, step = 4) {
    const out = [];
    const minMag = threshold * STRUCTURE_MAG_RATIO;
    const consider = (xx, yy) => {
        if (xx < 1 || xx >= width - 1 || yy < 0 || yy >= height) return;
        if (hlMap[yy * width + xx] > minMag) out.push({ x: xx, y: yy });
    };
    for (let k = 1; k <= RASTER_HALF_SPAN; k++) {
        consider(x + step * k, y);
        consider(x - step * k, y);
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
    snapBlack = 0, snapWhite = 0, peakThreshold = 0, anchorTol = ANCHOR_TOL, dampSpan = DAMP_SPAN, level2Rest = LEVEL2_REST, quantizeDamp = QUANTIZE_DAMP
}) {
    const log = [];
    const report = (p, c, t) => { if (onProgress) onProgress(p, c, t); };

    report('Phase 1/4: Scanner (Encode/Decode + HL-Peaks)', 0, 4);
    const dec = await encodeDecode(sourceData, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);

    // HL-Band einmal berechnen und für Peaks, Edge-Snapping und Struktur-Nachbarn teilen.
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
    // Raster-Info schon hier: der Versatz je Peak richtet sich nach der Phase,
    // nicht mehr pauschal nach ±1. Peaks auf Phase 2 (HAM04) erreichen die starke
    // Phase erst mit 2 Pixeln Abstand.
    const raster = getRasterInfo(format);
    const tailIdx = (x, y) => ((y * width + x) % (raster ? raster.period : 1));

    let shiftable = 0, unreachable = 0, anchorless = 0, capacityLimited = 0;
    for (const p of peaks) {
        // Ankerfarben-Test: kann die Farbe dieses Pixels von irgendeiner Phase
        // dargestellt werden? Wenn nicht einmal die stärkste Phase etwas in
        // Reichweite hat, hilft Verschieben nicht — dann ist Dämpfen das Mittel.
        const o = (p.y * width + p.x) * 4;
        p.ownDist = 0;
        p.anchorless = false;
        if (raster) {
            const own = nearestPaletteDist(paletteRAM, raster.slots[tailIdx(p.x, p.y)], sourceData[o], sourceData[o + 1], sourceData[o + 2]);
            const strong = nearestPaletteDist(paletteRAM, raster.maxSlots, sourceData[o], sourceData[o + 1], sourceData[o + 2]);
            p.ownDist = own;
            p.anchorless = strong > anchorTol;
            if (p.anchorless) anchorless++;
            else if (own > anchorTol) capacityLimited++;
        }

        if (!raster) { p.dPlus = 0; p.dMinus = 0; continue; }
        const phase = tailIdx(p.x, p.y);
        const off = nextStrongPhaseOffset(phase, raster);
        // Ein Versatz, der über den Bildrand hinausführt, ist unbrauchbar.
        if (off.plus !== 0 && (p.x + off.plus < 0 || p.x + off.plus >= width)) off.plus = 0;
        if (off.minus !== 0 && (p.x + off.minus < 0 || p.x + off.minus >= width)) off.minus = 0;
        p.dPlus = off.plus; p.dMinus = off.minus;
        if (off.plus || off.minus) shiftable++;
        else if (raster.weak.has(phase)) unreachable++;
    }
    if (raster) {
        log.push(`Verschiebbar: ${shiftable} von ${peaks.length} Peaks (Ziel: nicht-schwache Phase); ` +
                 `nicht erreichbar: ${unreachable} (Phase schon stark oder kein Ziel vorhanden)`);
        log.push(`Ankerfarbe (Toleranz ${anchorTol}): ${anchorless} Peaks ohne jede erreichbare Farbe → nur Dämpfen; ` +
                 `${capacityLimited} durch die Slot-Grenze der eigenen Phase benachteiligt`);
    }

    const testA = buildShiftedImage(sourceData, width, peaks, 'dPlus');
    const testB = buildShiftedImage(sourceData, width, peaks, 'dMinus');
    const decA = await encodeDecode(testA, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);
    const decB = await encodeDecode(testB, width, height, format, step, paletteRAM, offset, strategy, metric, onProgress);

    const target = new Uint8ClampedArray(sourceData);
    const remaining = [];
    let snapCount = 0, snapDist1 = 0, snapDist2 = 0;

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
        // Ohne Ankerfarbe kann keine noch so gute Zielphase die Farbe darstellen
        // → nicht verschieben, sondern dämpfen (kommt unten in die starke Stufe).
        if (p.anchorless) { remaining.push(p); continue; }
        if (!p.dPlus && !p.dMinus) { remaining.push(p); continue; }

        const w0 = localWindowErrorFromMap(hlMap, width, p.x, p.y);
        const wA = p.dPlus ? localWindowError(testA, decA, width, p.x, p.y) : Infinity;
        const wB = p.dMinus ? localWindowError(testB, decB, width, p.x, p.y) : Infinity;

        const isCleanFix = (wCand) =>
            wCand < w0 * ACCEPT_IMPROVE_RATIO && 
            (w0 - wCand) > ACCEPT_MIN_ABS_GAIN &&
            wCand < CLEAN_WIN_ABS;
            
        const okA = isCleanFix(wA);
        const okB = isCleanFix(wB);

        // Der Versatz kann je Richtung unterschiedlich weit sein (Phase 2 → ±2).
        let dir = 0;
        if (okA && okB) dir = wA <= wB ? p.dPlus : p.dMinus;
        else if (okA) dir = p.dPlus;
        else if (okB) dir = p.dMinus;

        const fromX = p.x + dir;
        if (dir !== 0 && fromX >= 0 && fromX < width) {
            const toIdx = (p.y * width + p.x) * 4;
            const fromIdx = (p.y * width + fromX) * 4;
            target[toIdx] = sourceData[fromIdx];
            target[toIdx + 1] = sourceData[fromIdx + 1];
            target[toIdx + 2] = sourceData[fromIdx + 2];
            snapCount++;
            if (Math.abs(dir) === 1) snapDist1++; else snapDist2++;
        } else {
            remaining.push(p);
        }
    }
    log.push(`Edge-Snapping: ${snapCount} Kanten verschoben (Abstand 1: ${snapDist1}, Abstand ≥2: ${snapDist2}), ${remaining.length} verbleiben`);
    report(`Phase 3/4: ${snapCount} Kanten gesnappt`, 2, 4);

    report('Phase 4/4: Wavelet-Dämpfung (2 Ebenen)', 3, 4);
    // `raster` und `tailIdx` stammen aus Phase 2. Die Phase bestimmt sich aus dem
    // ABSOLUTEN Pixelindex (so macht es der Encoder: phaseFormatAt →
    // sequence[pxIndex % sequence.length]); `x % period` stimmt nur, wenn die
    // Bildbreite ein Vielfaches der Periode ist.
    const level2Pos = new Set();

    if (raster) {
        const wk = [...raster.weak].map(i => `${i}=${raster.names[i]}/${raster.slots[i]}`).join(', ');
        log.push(`Raster: Periode ${raster.period}, stärkste Phase ${raster.maxSlots} Plätze | schwach: ${wk || 'keine'}`);
    }

    let weakPeaks = 0, anchorlessPeaks = 0;
    const perPhase = raster ? new Array(raster.period).fill(0) : null;
    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const ph = raster ? tailIdx(p.x, p.y) : -1;
        if (perPhase && ph >= 0) perPhase[ph]++;
        const onWeakSlot = raster ? raster.weak.has(ph) : false;
        if (onWeakSlot) weakPeaks++;
        if (p.anchorless) anchorlessPeaks++;
        // Starke Dämpfung (25%) für Peaks ohne Ankerfarbe: dort hat der Encoder
        // keine Chance, den hochfrequenten Wechsel darzustellen — genau der Fall,
        // für den die Wavelet-Dämpfung gedacht ist.
        const forceStrong = !!p.anchorless;
        const neighbours = collectStructureNeighbours(hlMap, width, height, p.x, p.y, threshold, raster ? raster.period : 4);
        if (onWeakSlot || forceStrong || neighbours.length > 0) {
            level2Pos.add(p.y * width + p.x);
            for (const l of neighbours) level2Pos.add(l.y * width + l.x);
        }
    }
    log.push(`Peaks auf schwachen Phasen: ${weakPeaks} von ${remaining.length} → dort 25% Detail, Rest 50%`);
    log.push(`davon ohne Ankerfarbe: ${anchorlessPeaks} → ebenfalls 25% Detail`);
    if (perPhase) {
        const dist = perPhase.map((n, i) => `P${i}(${raster.names[i]}/${raster.slots[i]}):${n}`).join(', ');
        log.push(`Peak-Verteilung je Phase: ${dist}`);
    }

    let spikeCount = 0, structPixel = 0, quantized = 0;
    const damped = new Set();
    
    // Referenzbild für Wavelet-Dämpfung, um Kaskadeneffekte zu vermeiden
    const reference = new Uint8ClampedArray(target);
    
    const damp = (x, y, rest) => {
        const key = y * width + x;
        if (damped.has(key)) return;
        damped.add(key);
        dampHlAt(target, reference, width, x, y, rest, dampSpan);
        // Optional: den gedämpften Wert auf eine Palettenfarbe ziehen, die die
        // Phase DIESES Pixels auch anspringen kann. Die Dämpfung erzeugt sonst
        // Mischfarben, die in der Palette gar nicht vorkommen — der Encoder
        // kann sie nicht treffen, und die Zieltreue sinkt (gemessen).
        if (quantizeDamp) {
            const o = key * 4;
            const nSlots = raster ? raster.slots[tailIdx(x, y)] : Math.floor(paletteRAM.length / 3);
            const q = nearestPaletteColor(paletteRAM, nSlots, target[o], target[o + 1], target[o + 2]);
            if (q) {
                if (q.r !== target[o] || q.g !== target[o + 1] || q.b !== target[o + 2]) quantized++;
                target[o] = q.r; target[o + 1] = q.g; target[o + 2] = q.b;
            }
        }
    };

    for (const p of remaining) {
        if (p.x < 1 || p.x >= width - 1) continue;
        const key = p.y * width + p.x;
        if (level2Pos.has(key)) structPixel++;
        else spikeCount++;
        damp(p.x, p.y, level2Pos.has(key) ? level2Rest : LEVEL1_REST);
    }
    for (const key of level2Pos) {
        if (damped.has(key)) continue;
        structPixel++;
        damp(key % width, (key / width) | 0, level2Rest);
    }
    log.push(`Wavelet-Dämpfung: ${spikeCount} Spikes auf ${Math.round(LEVEL1_REST * 100)}%, ${structPixel} Raster-Struktur-Pixel auf ${Math.round(level2Rest * 100)}% (gesamt ${damped.size} px modifiziert), Kernel ±${dampSpan}${quantizeDamp ? `, davon ${quantized} auf Palettenfarbe gezogen` : ''}`);

    // Kontrast-Snap zuletzt: nahe Schwarz/Weiß liegende Pixel exakt auf 0 bzw. 255
    const snap = snapExtremes(target, snapBlack, snapWhite);
    if (snap.blacks || snap.whites) {
        log.push(`Kontrast-Snap: ${snap.blacks} px → Schwarz(0,0,0), ${snap.whites} px → Weiß(255,255,255) [Schwellen S/W: ${snapBlack}/${snapWhite}]`);
    }
    report('Smart Target fertig', 4, 4);

    return { target, log };
}