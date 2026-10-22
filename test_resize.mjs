// Vergleicht die Skalierungsverfahren objektiv.
//
// Test 1 (Rundreise): verkleinern und wieder vergrößern, dann MSE/PSNR gegen das
//   Original. Je kleiner der Fehler, desto mehr Bildinhalt überlebt die Skalierung
//   und desto weniger Aliasing entsteht. Das ist das übliche Maß für Resampler.
// Test 2 (Aliasing): 1-Pixel-Schachbrett halbieren. Ein korrekter Tiefpass macht
//   daraus eine gleichmäßige Fläche (Varianz ~0); ein schlechter Filter lässt das
//   Muster als Rauschen stehen (Varianz hoch).
import fs from 'node:fs';
import { resizeImage } from './src/core/resample.js';

function loadBgra(path) {
    const raw = fs.readFileSync(path);
    const W = parseInt(path.match(/real-(\d+)/)[1], 10);
    const H = W;
    const stride = raw.length / H;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        const row = y * stride;
        for (let x = 0; x < W; x++) {
            const s = row + x * 4, d = (y * W + x) * 4;
            rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
        }
    }
    return { W, H, rgba };
}

function mseRGB(a, b) {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
        const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
        sum += (dr * dr + dg * dg + db * db) / 3;
        n++;
    }
    return sum / n;
}
const psnr = (m) => m <= 0 ? Infinity : 10 * Math.log10(255 * 255 / m);

const METHODEN = ['box', 'lanczos', 'wavelet'];
const { W, H, rgba } = loadBgra('testbilder/real-256.bgra');
console.log(`Bild ${W}x${H} (testbilder/real-256.bgra)\n`);

let fehler = 0;
const faelle = [
    { ziel: [128, 128], text: '256→128 (Halbierung)' },
    { ziel: [192, 192], text: '256→192 (1.33x runter)' },
    { ziel: [64, 64], text: '256→64  (Viertelung)' },
    { ziel: [320, 320], text: '256→320 (1.25x hoch)' }
];

const ergebnis = {};
for (const f of faelle) {
    console.log(`--- ${f.text} ---`);
    const [dw, dh] = f.ziel;
    const zeile = {};
    for (const m of METHODEN) {
        const t0 = Date.now();
        const klein = resizeImage(rgba, W, H, dw, dh, m);
        const zurueck = resizeImage(klein, dw, dh, W, H, m);
        const ms = Date.now() - t0;
        const e = mseRGB(rgba, zurueck);
        zeile[m] = e;
        console.log(`  ${m.padEnd(8)} MSE ${e.toFixed(3).padStart(8)} | PSNR ${psnr(e).toFixed(2).padStart(6)} dB | ${ms} ms`);
    }
    // Rundreise separat (nur Verkleinern) ist der eigentliche Qualitätsmaßstab
    ergebnis[f.text] = zeile;
    const best = Object.entries(zeile).sort((a, b) => a[1] - b[1])[0];
    console.log(`  → bester: ${best[0]}\n`);
}

// --- Test 2: Aliasing am Schachbrett ---
console.log('--- Aliasing: 1-Pixel-Schachbrett 256→128 ---');
const schach = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = ((x + y) & 1) ? 255 : 0;
        schach[o] = schach[o + 1] = schach[o + 2] = v; schach[o + 3] = 255;
    }
}
for (const m of METHODEN) {
    const klein = resizeImage(schach, W, H, W / 2, H / 2, m);
    // Varianz im mittleren Bereich (ohne Rand)
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 8; y < H / 2 - 8; y++) {
        for (let x = 8; x < W / 2 - 8; x++) {
            const v = klein[(y * (W / 2) + x) * 4];
            sum += v; sum2 += v * v; n++;
        }
    }
    const mean = sum / n;
    const varianz = sum2 / n - mean * mean;
    const ok = Math.abs(mean - 127.5) < 4 && varianz < 4;
    if (!ok) fehler++;
    console.log(`  ${m.padEnd(8)} Mittel ${mean.toFixed(1).padStart(6)} (ideal 127.5) | Varianz ${varianz.toFixed(2).padStart(7)} (ideal 0) ${ok ? 'OK' : 'FEHL'}`);
}

// --- Bestes Verfahren über alle Fälle ---
const sieger = METHODEN.map(m => ({
    m,
    summe: Object.values(ergebnis).reduce((a, z) => a + z[m], 0)
})).sort((a, b) => a.summe - b.summe);
console.log('\nSumme der Rundreise-Fehler über alle Fälle:');
for (const s of sieger) console.log(`  ${s.m.padEnd(8)} ${s.summe.toFixed(2)}`);
console.log(`\nBESTES VERFAHREN: ${sieger[0].m}`);

// --- Integration: skalieren und das Ergebnis direkt codieren ---
console.log('\n--- Integration: 256x256 -> 320x256 skalieren, dann codieren ---');
const { encodePaletted, decodePaletted, packPaletted } = await import('./src/core/module_paletted.js');
const palette = new Uint8Array(fs.readFileSync('testbilder/palettes/real-256-langsam.bin'));
const skaliert = resizeImage(rgba, W, H, 320, 256, 'lanczos');
if (skaliert.length !== 320 * 256 * 4) { console.log('  FEHL: Puffergroesse'); fehler++; }
for (const fmt of ['HAM_32BIT_63436343', 'HAM06']) {
    const { commands } = await encodePaletted(skaliert, 320, 256, fmt, { r: 4, g: 4, b: 4 }, palette.slice(), 0, 'greedy', 'yuv_weight');
    const dec = decodePaletted(commands, 320, 256, { r: 4, g: 4, b: 4 }, palette, 0);
    console.log(`  ${fmt.padEnd(22)} MSE ${mseRGB(skaliert, dec).toFixed(2).padStart(6)} | ${packPaletted(commands, fmt).length} Byte`);
}

process.exit(fehler === 0 ? 0 : 1);
