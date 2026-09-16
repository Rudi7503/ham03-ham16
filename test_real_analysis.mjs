// Detailanalyse auf VOLLER Auflösung: Fehler nach Helligkeitsbereichen,
// Anteil fehlerfreier Pixel, Slot-Nutzung — mit leerer vs. optimierter Palette.
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 };
const metric = 'yuv_weight';
const offset = 0;

const raw = fs.readFileSync('testbilder/real-full.bgra');
const W = 876, H = 882;
const stride = raw.length / H;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = y * stride + x * 4, d = (y * W + x) * 4;
    rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
}

// Wie viele verschiedene Farben hat das Bild?
const distinct = new Set();
for (let i = 0; i < W * H; i++) { const o = i * 4; distinct.add((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]); }
console.log(`Bild: ${W}x${H} (${W * H} Pixel), verschiedene Farben: ${distinct.size}`);

const buckets = [[0, 15], [16, 47], [48, 95], [96, 159], [160, 255]];
function analyze(label, palette) {
    const pal = new Uint8Array(768);
    if (palette) pal.set(palette);
    const enc = null;
    return (async () => {
        const e = await encodePaletted(rgba, W, H, FORMAT, step, pal, offset, 'greedy', metric, null, 0, 0, 15.0);
        const dec = decodePaletted(e.commands, W, H, step, pal, offset);
        const mse = computeAvgYuvScore(rgba, dec, W, H, metric, null);

        let anchors = 0, deltas = 0, turbo = 0, usage0 = 0;
        const usage = new Array(32).fill(0);
        for (const c of e.commands) {
            if (c.isAnchor) { anchors++; if (c.anchorIdx === 0) usage0++; if (c.anchorIdx < 32) usage[c.anchorIdx]++; }
            else { deltas++; if (c.isTurbo) turbo++; }
        }

        const stat = buckets.map(() => ({ n: 0, err: 0, exact: 0 }));
        for (let i = 0; i < W * H; i++) {
            const o = i * 4;
            const lum = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
            const bi = buckets.findIndex(([a, b]) => lum >= a && lum <= b);
            const dR = rgba[o] - dec[o], dG = rgba[o + 1] - dec[o + 1], dB = rgba[o + 2] - dec[o + 2];
            const err = (dR * dR * 0.299) + (dG * dG * 0.587) + (dB * dB * 0.114);
            const s = stat[bi < 0 ? stat.length - 1 : bi];
            s.n++; s.err += err;
            if (dR === 0 && dG === 0 && dB === 0) s.exact++;
        }

        console.log(`\n=== ${label} ===`);
        console.log(`MSE gesamt: ${mse.toFixed(2)} | Anker ${anchors} (${(100*anchors/(W*H)).toFixed(1)}%), Delta ${deltas}, Turbo ${turbo} | Anker auf Slot 0 (Schwarz): ${usage0}`);
        console.log(`Slots genutzt: ${usage.filter((n, i) => i >= 1 && n > 0).length}/31`);
        console.log('Helligkeit      Anteil    Mittlerer Fehler   exakt identisch');
        for (let b = 0; b < buckets.length; b++) {
            const s = stat[b];
            if (!s.n) continue;
            const share = (100 * s.n / (W * H)).toFixed(1);
            console.log(`  ${String(buckets[b][0]).padStart(3)}–${String(buckets[b][1]).padStart(3)}:   ${share.padStart(5)}%   ${(s.err / s.n).toFixed(2).padStart(10)}        ${(100 * s.exact / s.n).toFixed(1).padStart(5)}%`);
        }
    })();
}

await analyze('LEERE Palette', null);
for (const size of [128, 256]) {
    const f = `testbilder/real-${size}-palette.bin`;
    if (fs.existsSync(f)) await analyze(`OPTIMIERTE Palette (Proxy ${size}x${size})`, fs.readFileSync(f));
    else console.log(`\n(${f} fehlt)`);
}
