// Phasen-Aufschlüsselung des Fehlers für das Format 63436343
// (Sequenz [HAM06, HAM03, HAM04, HAM03], also x%4: 0=HAM06/32 Slots, 1=HAM03/4, 2=HAM04/8, 3=HAM03/4).
//
// Prüft die Grundannahme des Modifizierens: liegt der Fehler überwiegend auf den
// schwach bestückten Phasen (HAM03/HAM04), und zwar dort, wo harte Kanten sind?
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { getMetricDistFunc } from './src/codecs/utils.js';

const FORMAT = 'HAM_32BIT_63436343';
const SEQ = ['HAM06', 'HAM03', 'HAM04', 'HAM03'];
const SLOTS = [32, 4, 8, 4];
const step = { r: 4, g: 4, b: 4 }, offset = 0, strategy = 'greedy', metric = 'yuv_weight';
const dist = getMetricDistFunc(metric);

const sizeArg = process.argv[2] || '256';
const paletteName = process.argv[3] || `real-${sizeArg}-langsam`;
const isFull = sizeArg === 'full';
const W = isFull ? 876 : parseInt(sizeArg, 10);
const H = isFull ? 882 : W;

const raw = fs.readFileSync(isFull ? 'testbilder/real-full.bgra' : `testbilder/real-${W}.bgra`);
const stride = raw.length / H;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    const row = y * stride;
    for (let x = 0; x < W; x++) {
        const s = row + x * 4, d = (y * W + x) * 4;
        rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
    }
}
const pal = new Uint8Array(fs.readFileSync(`testbilder/palettes/${paletteName}.bin`));
const enc = await encodePaletted(rgba, W, H, FORMAT, step, pal, offset, strategy, metric, null, 0, 0, 15.0);
const dec = decodePaletted(enc.commands, W, H, step, pal, offset);

const P = SEQ.length;
const errSum = new Array(P).fill(0), errCnt = new Array(P).fill(0);
const edgeSum = new Array(P).fill(0), edgeCnt = new Array(P).fill(0);
const edgeErrSum = new Array(P).fill(0);
let totalEdgePx = 0, totalEdgeErr = 0, totalErr = 0, totalPx = 0;

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const e = dist(rgba[i], rgba[i + 1], rgba[i + 2], dec[i], dec[i + 1], dec[i + 2]);
        const p = x % P;
        errSum[p] += e; errCnt[p]++;
        totalErr += e; totalPx++;

        // Horizontale Kante im ORIGINAL (Stärke der Nachbarschaftsdifferenz)
        if (x > 0) {
            const l = i - 4;
            const g = (Math.abs(rgba[i] - rgba[l]) + Math.abs(rgba[i + 1] - rgba[l + 1]) + Math.abs(rgba[i + 2] - rgba[l + 2])) / 3;
            edgeSum[p] += g; edgeCnt[p]++;
            if (g > 24) { edgeErrSum[p] += e; totalEdgePx++; totalEdgeErr += e; }
        }
    }
}

console.log(`### ${W}x${H} | Palette ${paletteName} | Sequenz ${SEQ.join(',')} (Periode ${P})`);
console.log(`### Gesamt: MSE ${(totalErr / totalPx).toFixed(2)} | Pixel mit harter Kante (Gradient > 24): ${totalEdgePx} (${(100 * totalEdgePx / totalPx).toFixed(2)}%)`);
console.log(`###   davon Fehleranteil: ${(100 * totalEdgeErr / totalErr).toFixed(1)}% des Gesamtfehlers`);
console.log(`### Phase | Format | Slots | MSE    | mittl. Gradient | MSE auf harten Kanten`);
for (let p = 0; p < P; p++) {
    console.log(`###   ${p}   | ${SEQ[p]}  | ${String(SLOTS[p]).padStart(5)} | ${(errSum[p] / errCnt[p]).toFixed(2).padStart(6)} | ${(edgeSum[p] / edgeCnt[p]).toFixed(2).padStart(15)} | ${(edgeErrSum[p] / Math.max(1, errCnt[p])).toFixed(2)}`);
}
// Anteil am Gesamtfehler je Phase
console.log(`### Anteil am Gesamtfehler je Phase:`);
for (let p = 0; p < P; p++) {
    console.log(`###   Phase ${p} (${SEQ[p]}, ${SLOTS[p]} Slots): ${(100 * errSum[p] / totalErr).toFixed(1)}% des Fehlers bei ${(100 * errCnt[p] / totalPx).toFixed(1)}% der Pixel`);
}
process.exit(0);
