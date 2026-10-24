// Vergleicht drei Wege zu einem 640x256-Bild:
//   R  Direkt   : Original -> resizeInto(lanczos, fill)          (aktueller Satz)
//   A  Wavelet  : alle Koeffizienten auf 320x256, HF = 0
//                 -> 320x256 erzeugen, dann auf 640x256 hochskalieren
//   B  Interleave: gerade Spalten aus A (320er Raster), ungerade aus R
//                 ("320x256 nehmen und mit Werten aus dem Original auffuellen")
//
// Gemessen wird: Abweichung zu R, Detailgehalt (mittlerer Gradient) und das
// Ergebnis nach HAM06-Encoding mit der Palette aus dem 320er Satz.
import fs from 'node:fs';
import { resizeInto, resizeImage } from './src/core/resample.js';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

const OUT = 'testbilder/ref640';
const W = 640, H = 256, TOTAL = W * H;
const STEP = { r: 4, g: 4, b: 4 }, OFFSET = 0, METRIC = 'yuv_weight';

// --- Quelle ---
const raw = fs.readFileSync(`${OUT}/_src.raw.tmp`);
const src = new Uint8ClampedArray(1120 * 1120 * 4);
for (let i = 0, j = 0; i < 1120 * 1120; i++, j += 3) {
    src[i * 4] = raw[j]; src[i * 4 + 1] = raw[j + 1]; src[i * 4 + 2] = raw[j + 2]; src[i * 4 + 3] = 255;
}

// --- R: direkt ---
const R = resizeInto(src, 1120, 1120, W, H, 'lanczos', 'fill').pixels;

// --- A: 320x256 erzeugen, dann 2x hochskalieren ---
const klein = resizeInto(src, 1120, 1120, 320, 256, 'lanczos', 'fill');
const A = resizeImage(klein.pixels, 320, 256, W, H, 'lanczos');

// --- B: gerade Spalten aus A, ungerade aus R ---
const B = new Uint8ClampedArray(TOTAL * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const q = (x % 2 === 0) ? A : R;
        B[o] = q[o]; B[o + 1] = q[o + 1]; B[o + 2] = q[o + 2]; B[o + 3] = 255;
    }
}

const luma = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
function rmse(a, b) {
    let s = 0, n = 0;
    for (let i = 0; i < TOTAL * 4; i += 4) {
        const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
        s += (dr * dr + dg * dg + db * db) / 3; n++;
    }
    return Math.sqrt(s / n);
}
// Mittlerer horizontaler Gradient (Detailgehalt), Rand ausgelassen
function gradX(p) {
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) {
        const i = (y * W + x) * 4, j = i - 4;
        s += Math.abs(luma(p, i) - luma(p, j)); n++;
    }
    return s / n;
}
// Wechsel zwischen benachbarten Spalten als Comb-Indikator:
// mittlerer Gradient nur an geraden vs. ungeraden Grenzen
function gradParitaet(p) {
    let gEven = 0, nEven = 0, gOdd = 0, nOdd = 0;
    for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) {
        const i = (y * W + x) * 4, j = i - 4;
        const d = Math.abs(luma(p, i) - luma(p, j));
        if (x % 2 === 0) { gEven += d; nEven++; } else { gOdd += d; nOdd++; }
    }
    return { gEven: gEven / nEven, gOdd: gOdd / nOdd };
}

console.log('Variante | RMSE zu R | Gradient | Gradient gerade/ungerade Grenzen');
for (const [name, p] of [['R direkt', R], ['A wavelet', A], ['B interleave', B]]) {
    const g = gradParitaet(p);
    console.log(`${name.padEnd(12)} | ${rmse(p, R).toFixed(2).padStart(8)} | ${gradX(p).toFixed(3)} | ${g.gEven.toFixed(3)} / ${g.gOdd.toFixed(3)}`);
}

// --- HAM06 mit der Palette aus dem 320er Satz ---
function readPalette(path) {
    const b = new Uint8Array(fs.readFileSync(path));
    const fLen = b[10];
    return b.slice(11 + fLen + 4, 11 + fLen + 4 + 768);
}
const palette = readPalette('testbilder/ref/ham06.ham');

console.log('\nHAM06-Encoding (Palette aus dem 320er Satz):');
for (const [name, p] of [['R direkt', R], ['A wavelet', A], ['B interleave', B]]) {
    const { commands } = await encodePaletted(p, W, H, 'HAM06', STEP, palette.slice(), OFFSET, 'greedy', METRIC, null, 0, 0, 15.0);
    const dec = decodePaletted(commands, W, H, STEP, palette, OFFSET);
    const mse = computeAvgYuvScore(p, dec, W, H, METRIC, null);
    const g = gradParitaet(dec);
    console.log(`  ${name.padEnd(12)} | MSE gegen eigene Vorlage ${mse.toFixed(2).padStart(6)} | nachher Gradient ${gradX(dec).toFixed(3)} | gerade/ungerade ${g.gEven.toFixed(3)} / ${g.gOdd.toFixed(3)}`);
    // RGB-Rohdaten fuer die Vorschau
    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = dec[i * 4]; rgb[i * 3 + 1] = dec[i * 4 + 1]; rgb[i * 3 + 2] = dec[i * 4 + 2]; }
    fs.writeFileSync(`${OUT}/_variant_${name.split(' ')[0]}_ham06.rgb`, rgb);
}

// Rohdaten der Vorlagen fuer die Vorschau
for (const [name, p] of [['R', R], ['A', A], ['B', B]]) {
    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = p[i * 4]; rgb[i * 3 + 1] = p[i * 4 + 1]; rgb[i * 3 + 2] = p[i * 4 + 2]; }
    fs.writeFileSync(`${OUT}/_variant_${name}.rgb`, rgb);
}
console.log('\nRohdaten der Varianten geschrieben');
