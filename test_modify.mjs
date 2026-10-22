// Bewertet das Bild-Modifizieren (Smart Target) an einem echten Bild.
//
// Entscheidende Messgröße ist der Fehler gegen das ORIGINAL: der Encoder
// verarbeitet das MODIFIZIERTE Bild, die Qualität beurteilt der Betrachter aber
// am Original. Also:
//   MSE_vorher = score(original, decode(original))
//   MSE_nachher = score(original, decode(modifiziert))
// Nur wenn MSE_nachher < MSE_vorher ist, hat die Modifikation genützt.
//
// Es wird IMMER eine feste Referenz-Palette aus testbilder/palettes/ benutzt,
// damit die Messung die Modifikation bewertet und nicht eine andere Palette.
//
// Aufruf:
//   node test_modify.mjs <size|full> <palette> [threshold] [snapBlack] [snapWhite]
// Beispiel:
//   node test_modify.mjs 128 real-128-langsam 0 0 0
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { generateSmartTarget, buildErrorMap } from './src/core/smart_target.js';
import { computeAvgYuvScore } from './src/core/analysis.js';
import { packPaletted } from './src/core/module_paletted.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;
const strategy = 'greedy';

const sizeArg = process.argv[2] || '128';
const paletteName = process.argv[3] || `real-${sizeArg}-langsam`;
const threshold = parseInt(process.argv[4] || '0', 10);
const snapBlack = parseInt(process.argv[5] || '0', 10);
const snapWhite = parseInt(process.argv[6] || '0', 10);
// Optionale Ankerfarben-Toleranz (Standard kommt aus smart_target.js)
const anchorTolArg = process.argv[7] ? parseInt(process.argv[7], 10) : undefined;
// Optionale Kernel-Breite der Wavelet-Dämpfung (1 = bisheriger 3-Tap-Filter)
const dampSpanArg = process.argv[8] ? parseInt(process.argv[8], 10) : undefined;
// Optionaler Rest-Detailanteil der starken Stufe (0 = alles weg, 0.25 = Standard)
const restArg = process.argv[9] !== undefined && process.argv[9] !== '' ? parseFloat(process.argv[9]) : undefined;
// Optional: gedämpfte Werte auf eine erreichbare Palettenfarbe ziehen
const quantizeArg = process.argv[10] === 'true';

const isFull = sizeArg === 'full';
// Achtung: das Testfoto ist 876x882, NICHT quadratisch.
const W = isFull ? 876 : parseInt(sizeArg, 10);
const H = isFull ? 882 : W;

const raw = fs.readFileSync(isFull ? 'testbilder/real-full.bgra' : `testbilder/real-${W}.bgra`);
const stride = raw.length / H;
const original = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    const row = y * stride;
    for (let x = 0; x < W; x++) {
        const s = row + x * 4, d = (y * W + x) * 4;
        original[d] = raw[s + 2]; original[d + 1] = raw[s + 1]; original[d + 2] = raw[s]; original[d + 3] = 255;
    }
}

const palFile = `testbilder/palettes/${paletteName}.bin`;
if (!fs.existsSync(palFile)) { console.error(`Palette fehlt: ${palFile} (mit make_palettes.mjs erzeugen)`); process.exit(2); }
const paletteRAM = new Uint8Array(fs.readFileSync(palFile));

const region = { x: 0, y: 0, width: W, height: H };
async function encDec(data) {
    const enc = await encodePaletted(data, W, H, FORMAT, step, paletteRAM, offset, strategy, metric, null, 0, 0, 15.0);
    const dec = decodePaletted(enc.commands, W, H, step, paletteRAM, offset);
    let anchors = 0, deltas = 0, turbo = 0;
    for (const c of enc.commands) { if (c.isAnchor) anchors++; else { deltas++; if (c.isTurbo) turbo++; } }
    // Gepackte Größe: hat die Modifikation wenigstens einen Nutzen beim Umfang?
    let bytes = 0;
    try { bytes = packPaletted(enc.commands, FORMAT).length; } catch (e) { bytes = -1; }
    return { dec, anchors, deltas, turbo, bytes, commands: enc.commands };
}

const score = (a, b) => computeAvgYuvScore(a, b, W, H, metric, region);
// Zweite, unabhängige Metrik: ungewichteter RGB-Fehler. Wenn beide Metriken
// dieselbe Richtung zeigen, ist das Ergebnis nicht von der Bewertungsfunktion
// abhängig (der Nutzer sieht im Fenster eine andere Zahl als meine).
const scoreRgb = (a, b) => computeAvgYuvScore(a, b, W, H, 'rgb', region);
const scoreAbs = (a, b) => computeAvgYuvScore(a, b, W, H, 'rgb_ABS', region);

// --- Zustand vorher -------------------------------------------------------
const base = await encDec(original);
const mseBefore = score(original, base.dec);
const errInfo = buildErrorMap(original, base.dec, W, H, threshold);

console.log(`### Bild ${W}x${H} | Palette ${paletteName}`);
console.log(`### VORHER  MSE(Original, Decode) = ${mseBefore.toFixed(2)} | Anker ${base.anchors} (${(100 * base.anchors / (W * H)).toFixed(1)}%), Turbo ${base.turbo}`);
console.log(`### Fehlerbild: max ${errInfo.max}, Mittel ${errInfo.mean.toFixed(2)} | HL-Vorschlag Schwelle ${errInfo.thresholdSuggestion}`);
if (threshold > 0) console.log(`### Pixel mit HL >= ${threshold}: ${errInfo.overCount} (${(100 * errInfo.overCount / (W * H)).toFixed(2)}%)`);

// --- Modifikation ---------------------------------------------------------
const t0 = Date.now();
const { target, log } = await generateSmartTarget({
    sourceData: original, width: W, height: H, step, metric, format: FORMAT,
    paletteRAM, offset, strategy, snapBlack, snapWhite, peakThreshold: threshold,
    ...(anchorTolArg !== undefined ? { anchorTol: anchorTolArg } : {}),
    ...(dampSpanArg !== undefined ? { dampSpan: dampSpanArg } : {}),
    ...(restArg !== undefined ? { level2Rest: restArg } : {}),
    ...(quantizeArg ? { quantizeDamp: true } : {})
});
const genMs = Date.now() - t0;

let changed = 0, maxDelta = 0, sumAbsDelta = 0;
for (let i = 0; i < original.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(original[i + c] - target[i + c]));
    if (d > 0) { changed++; sumAbsDelta += d; if (d > maxDelta) maxDelta = d; }
}

// --- Zustand nachher ------------------------------------------------------
const mod = await encDec(target);
const mseAfter = score(original, mod.dec);        // DAS ist die Qualität
const mseTrack = score(target, mod.dec);          // wie gut der Codec dem Ziel folgt

const gain = mseBefore - mseAfter;
const pct = (gain / mseBefore) * 100;
console.log(`### Modifikation: ${changed} px geändert (${(100 * changed / (W * H)).toFixed(2)}%), max Kanal-Delta ${maxDelta}, Mittel ${changed ? (sumAbsDelta / changed).toFixed(2) : 0} | ${genMs} ms`);
console.log(`### NACHHER MSE(Original, Decode) = ${mseAfter.toFixed(2)} | Anker ${mod.anchors} (${(100 * mod.anchors / (W * H)).toFixed(1)}%), Turbo ${mod.turbo}`);
console.log(`### ${gain >= 0 ? 'VERBESSERUNG' : 'VERSCHLECHTERUNG'}: ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) | MSE(Ziel, Decode) = ${mseTrack.toFixed(2)}`);
// Kontrolle mit unabhängigen Metriken
const rgbB = scoreRgb(original, base.dec), rgbA = scoreRgb(original, mod.dec);
const absB = scoreAbs(original, base.dec), absA = scoreAbs(original, mod.dec);
const mark = (b, a) => a < b ? 'besser' : (a > b ? 'SCHLECHTER' : 'gleich');
console.log(`### Kontrolle  RGB-MSE      ${rgbB.toFixed(2)} → ${rgbA.toFixed(2)}  (${mark(rgbB, rgbA)})`);
console.log(`### Kontrolle  RGB-ABS-MSE  ${absB.toFixed(2)} → ${absA.toFixed(2)}  (${mark(absB, absA)})`);
const dBytes = base.bytes - mod.bytes;
const bytePct = base.bytes > 0 ? (dBytes / base.bytes) * 100 : 0;
console.log(`### Umfang     ${base.bytes} B → ${mod.bytes} B  (${dBytes >= 0 ? '-' : '+'}${Math.abs(bytePct).toFixed(1)}% ${dBytes >= 0 ? 'kleiner' : 'GROESSER'}) | Anker ${base.anchors}→${mod.anchors}, Turbo ${base.turbo}→${mod.turbo}`);
for (const l of log) console.log(`      ${l}`);
process.exit(0);
