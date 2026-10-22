// Vergleicht die Skalierungsverfahren objektiv.
//
// Test 1 (Rundreise): verkleinern und wieder vergrößern, dann MSE/PSNR gegen das
//   Original. Je kleiner der Fehler, desto mehr Bildinhalt überlebt die Skalierung
//   und desto weniger Aliasing entsteht. Das ist das übliche Maß für Resampler.
// Test 2 (Aliasing): 1-Pixel-Schachbrett halbieren. Ein korrekter Tiefpass macht
//   daraus eine gleichmäßige Fläche (Varianz ~0); ein schlechter Filter lässt das
//   Muster als Rauschen stehen (Varianz hoch).
import fs from 'node:fs';
import { resizeImage, resizeInto, innerSize } from './src/core/resample.js';

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

// --- Test 3: Seitenverhältnis (Verzerrung) ---
console.log('\n--- Seitenverhältnis: Skalierungsfaktor x/y muss gleich sein ---');
const aspectFaelle = [
    { sw: 1200, sh: 900, dw: 640, dh: 256, text: '4:3    -> 640x256' },
    { sw: 1920, sh: 1080, dw: 640, dh: 480, text: '16:9   -> 640x480' },
    { sw: 876, sh: 882, dw: 320, dh: 256, text: 'fast 1:1 -> 320x256' },
    { sw: 800, sh: 600, dw: 800, dh: 600, text: '4:3    -> 800x600' },
    { sw: 640, sh: 480, dw: 640, dh: 256, text: '4:3    -> 640x256' }
];
for (const f of aspectFaelle) {
    for (const mode of ['fit', 'fill']) {
        const { w: iw, h: ih } = innerSize(f.sw, f.sh, f.dw, f.dh, mode);
        const sx = iw / f.sw, sy = ih / f.sh;
        const abw = Math.abs(sx - sy) / Math.max(sx, sy) * 100;
        const passt = mode === 'fit' ? (iw <= f.dw && ih <= f.dh) : (iw >= f.dw && ih >= f.dh);
        const ok = abw < 1 && passt;
        if (!ok) fehler++;
        console.log(`  ${f.text} ${mode.padEnd(4)}: innen ${String(iw).padStart(4)}x${String(ih).padStart(3)} | Faktor x ${sx.toFixed(4)} y ${sy.toFixed(4)} | Abweichung ${abw.toFixed(2)}% ${ok ? 'OK' : 'FEHL'}`);
    }
}

// --- Test 4: Kreis muss ein Kreis bleiben (geometrischer Beweis) ---
console.log('\n--- Kreis 300x300 -> 640x256 ---');
const S = 300;
const kreis = new Uint8ClampedArray(S * S * 4);
for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        const d = Math.hypot(x - 149.5, y - 149.5);
        const v = d <= 100 ? 255 : 0;
        kreis[o] = kreis[o + 1] = kreis[o + 2] = v; kreis[o + 3] = 255;
    }
}
for (const mode of ['fit', 'fill']) {
    const r = resizeInto(kreis, S, S, 640, 256, 'lanczos', mode);
    // Begrenzungsrahmen des hellen Bereichs
    let x0 = 640, x1 = -1, y0 = 256, y1 = -1;
    for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 640; x++) {
            if (r.pixels[(y * 640 + x) * 4] > 128) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

    // Kreis-Durchmesser 200 im Quellbild. 'fit' skaliert mit min(), 'fill' mit
    // max(); bei 'fill' wird die Höhe auf den Rahmen beschnitten.
    const sK = mode === 'fill' ? Math.max(640 / S, 256 / S) : Math.min(640 / S, 256 / S);
    const erwarteteBreite = Math.round(200 * sK);
    const erwarteteHoehe = Math.min(256, Math.round(200 * sK));
    // Entscheidend gegen Verzerrung: bei 'fit' muss der Kreis quadratisch bleiben
    const quadratisch = Math.abs(bw - bh) <= 2;
    const ok = Math.abs(bw - erwarteteBreite) <= 2 && Math.abs(bh - erwarteteHoehe) <= 2
        && (mode === 'fill' || quadratisch);
    if (!ok) fehler++;
    console.log(`  ${mode.padEnd(4)}: Kreis-Bbox ${bw}x${bh} | erwartet ${erwarteteBreite}x${erwarteteHoehe}${mode === 'fit' ? ' und quadratisch' : ''} ${ok ? 'OK' : 'FEHL'}`);
}
{
    // Ränder: einfarbig weißes Quellbild macht Briefmarken-Ränder eindeutig sichtbar
    const weiss = new Uint8ClampedArray(S * S * 4).fill(255);
    const rFit = resizeInto(weiss, S, S, 640, 256, 'lanczos', 'fit');
    let randSchwarz = true;
    for (let y = 0; y < 256; y++) { const o = (y * 640) * 4; if (rFit.pixels[o] !== 0) randSchwarz = false; }
    const rFill = resizeInto(weiss, S, S, 640, 256, 'lanczos', 'fill');
    let fillOhneSchwarz = true;
    for (let i = 0; i < rFill.pixels.length; i += 4) if (rFill.pixels[i] !== 255) fillOhneSchwarz = false;

    if (!randSchwarz || !fillOhneSchwarz) fehler++;
    console.log(`  fit : linke Randspalte schwarz ${randSchwarz ? 'OK' : 'FEHL'} | fill: rahmenfüllend ohne Ränder ${fillOhneSchwarz ? 'OK' : 'FEHL'}`);
    console.log(`  Puffergrößen: fit ${rFit.pixels.length} , fill ${rFill.pixels.length} (erwartet je ${640 * 256 * 4})`);
    if (rFit.pixels.length !== 640 * 256 * 4 || rFill.pixels.length !== 640 * 256 * 4) fehler++;
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
