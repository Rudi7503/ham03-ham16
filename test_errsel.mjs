// Prüft, WORAUF die Auswahl der zu bearbeitenden Pixel beruht:
//  (a) Fehlergröße  max(|orig-dec|) je Kanal   — "die großen Fehler"
//  (b) HL-Magnitude (Hochpass des Fehlers)     — das, was detectPeaks benutzt
// Vergleicht Anzahl und Fehleranteil beider Mengen bei gleicher Schwelle.
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, offset = 0, strategy = 'greedy', metric = 'yuv_weight';
const W = 876, H = 882;
const raw = fs.readFileSync('testbilder/real-full.bgra');
const stride = raw.length / H;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    const row = y * stride;
    for (let x = 0; x < W; x++) {
        const s = row + x * 4, d = (y * W + x) * 4;
        rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
    }
}
const pal = new Uint8Array(fs.readFileSync('testbilder/palettes/real-full-langsam.bin'));
const enc = await encodePaletted(rgba, W, H, FORMAT, step, pal, offset, strategy, metric, null, 0, 0, 15.0);
const dec = decodePaletted(enc.commands, W, H, step, pal, offset);

// HL-Band wie computeHlMap
const hl = new Float32Array(W * H);
const LUMA = [0.299, 0.587, 0.114];
for (let y = 0; y < H; y++) {
    for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, l = i - 1, r = i + 1;
        let mag = 0;
        for (let c = 0; c < 3; c++) {
            const e0 = rgba[i * 4 + c] - dec[i * 4 + c];
            const el = rgba[l * 4 + c] - dec[l * 4 + c];
            const er = rgba[r * 4 + c] - dec[r * 4 + c];
            mag += Math.abs(e0 - ((el + er) >> 1)) * LUMA[c];
        }
        hl[i] = mag;
    }
}

let sumAll = 0;
const mags = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
    const m = Math.max(Math.abs(rgba[i * 4] - dec[i * 4]), Math.abs(rgba[i * 4 + 1] - dec[i * 4 + 1]), Math.abs(rgba[i * 4 + 2] - dec[i * 4 + 2]));
    mags[i] = m;
    sumAll += m;
}

console.log(`### Vollbild ${W}x${H} | Gesamtfehler (Summe max-Kanal) ${sumAll}`);
console.log(`### Schwelle | Fehler>=T: px / Anteil   | HL>=T: px / Anteil     | Ueberschneidung`);
for (const T of [8, 17, 30, 50, 90]) {
    let cA = 0, sA = 0, cB = 0, sB = 0, both = 0;
    for (let i = 0; i < W * H; i++) {
        const a = mags[i] >= T, b = hl[i] >= T;
        if (a) { cA++; sA += mags[i]; }
        if (b) { cB++; sB += mags[i]; }
        if (a && b) both++;
    }
    const p = (n) => (100 * n / (W * H)).toFixed(2) + '%';
    const q = (s) => (100 * s / sumAll).toFixed(1) + '%';
    console.log(`### ${String(T).padStart(9)} | ${String(cA).padStart(7)} / ${q(sA).padStart(6)} | ${String(cB).padStart(7)} / ${q(sB).padStart(6)} | ${p(both)}`);
}
process.exit(0);
