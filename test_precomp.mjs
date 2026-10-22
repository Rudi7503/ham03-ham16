// Gegenvorschlag zum Smart-Target-Ansatz: statt das Ziel zu GLÄTTEN (was es vom
// Original entfernt), das Ziel VORWÄRTSKOMPENSIEREN — also in die Richtung
// verschieben, in der der Codec danebenlag:
//
//   D = decode(encode(O))            // Fehler des Codecs
//   T = clamp(O + alpha * (O - D))   // Ziel so verschieben, dass D näher an O landet
//
// Der Codec folgt dem Ziel, also sollte decode(T) näher an O liegen als D.
// Getestet wird gegen das ORIGINAL. Zusätzlich eine Variante mit Totzone:
// nur Pixel mit großem Fehler werden kompensiert (begrenzt Kollateralschaden).
//
// Aufruf: node test_precomp.mjs <size|full> <palette>
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;
const strategy = 'greedy';

const sizeArg = process.argv[2] || '128';
const paletteName = process.argv[3] || `real-${sizeArg}-langsam`;
const isFull = sizeArg === 'full';
const W = isFull ? 876 : parseInt(sizeArg, 10), H = W;

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
const paletteRAM = new Uint8Array(fs.readFileSync(`testbilder/palettes/${paletteName}.bin`));
const region = { x: 0, y: 0, width: W, height: H };
const score = (a, b) => computeAvgYuvScore(a, b, W, H, metric, region);

async function encDec(data) {
    const enc = await encodePaletted(data, W, H, FORMAT, step, paletteRAM, offset, strategy, metric, null, 0, 0, 15.0);
    return decodePaletted(enc.commands, W, H, step, paletteRAM, offset);
}

const D = await encDec(original);
const mseBase = score(original, D);
console.log(`### ${W}x${H} | Palette ${paletteName} | Referenz MSE(Original, Decode) = ${mseBase.toFixed(2)}`);

// Fehlerrichtung einmal berechnen
const err = new Float32Array(W * H * 3);
for (let i = 0, j = 0; i < original.length; i += 4, j += 3) {
    err[j] = original[i] - D[i];
    err[j + 1] = original[i + 1] - D[i + 1];
    err[j + 2] = original[i + 2] - D[i + 2];
}

function buildTarget(alpha, deadzone) {
    const T = new Uint8ClampedArray(original.length);
    let touched = 0;
    for (let i = 0, j = 0; i < original.length; i += 4, j += 3) {
        const e0 = err[j], e1 = err[j + 1], e2 = err[j + 2];
        const mag = Math.max(Math.abs(e0), Math.abs(e1), Math.abs(e2));
        const a = mag >= deadzone ? alpha : 0;
        T[i] = original[i] + a * e0;
        T[i + 1] = original[i + 1] + a * e1;
        T[i + 2] = original[i + 2] + a * e2;
        T[i + 3] = original[i + 3];
        if (a !== 0 && (T[i] !== original[i] || T[i + 1] !== original[i + 1] || T[i + 2] !== original[i + 2])) touched++;
    }
    return { T, touched };
}

const alphas = [0.25, 0.5, 0.75, 1.0];
const deadzones = [0, 32, 64];
for (const dz of deadzones) {
    for (const alpha of alphas) {
        const { T, touched } = buildTarget(alpha, dz);
        const Dt = await encDec(T);
        const mse = score(original, Dt);
        const gain = mseBase - mse;
        const pct = (gain / mseBase) * 100;
        console.log(`### alpha ${alpha.toFixed(2)} | Totzone ${String(dz).padStart(2)} | ${String(touched).padStart(6)} px geändert | MSE(Original,Decode) ${mse.toFixed(2)} | ${gain >= 0 ? 'BESSER' : 'schlechter'} ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    }
}
process.exit(0);
