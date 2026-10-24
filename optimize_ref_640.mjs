// Optimiert die Paletten des 640x256-Satzes — ausgehend von den Paletten des
// 320x256-Satzes — und schreibt die neuen .ham-Dateien.
//
// Aufruf: node optimize_ref_640.mjs [intensity] [modus]
//   intensity: sehr_schnell | normal | langsam (Standard: normal)
//   modus:     03|04|05|06|08 (optional, sonst alle)
import fs from 'node:fs';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';
import { runHybridOptimization, runManualRefinement } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';
import { resizeImage } from './src/core/resample.js';

// Stubs, die der Optimierer für den Browser erwartet
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch { /* schon gesetzt */ }

const OUT = 'testbilder/ref640';
const PAL_SRC = 'testbilder/ref';
const SRC_RAW = 'testbilder/ref640/_src.raw.tmp';
const W = 640, H = 256, TOTAL = W * H;
const STEP = { r: 4, g: 4, b: 4 }, OFFSET = 0, METRIC = 'yuv_weight';
const ALLE = ['03', '04', '05', '06', '08'];

const intensity = process.argv[2] || 'normal';
const nurModus = process.argv[3];

function readHam(path) {
    const raw = new Uint8Array(fs.readFileSync(path));
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const le = raw[5] === 0;
    const w = dv.getUint16(6, le), h = dv.getUint16(8, le);
    const fLen = raw[10];
    let p = 11;
    const format = new TextDecoder().decode(raw.slice(p, p + fLen)); p += fLen;
    const step = { r: raw[p++], g: raw[p++], b: raw[p++] };
    const offset = raw[p++];
    const palette = raw.slice(p, p + 768); p += 768;
    return { width: w, height: h, format, step, offset, palette, payload: raw.slice(p) };
}

function writeHam(format, palette, payload) {
    const nameBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + nameBytes.length + 4 + 768 + payload.length);
    const dv = new DataView(buf.buffer);
    buf.set([72, 65, 77, 33], 0);
    dv.setUint8(4, 4); dv.setUint8(5, 0);
    dv.setUint16(6, W, true); dv.setUint16(8, H, true);
    dv.setUint8(10, nameBytes.length);
    let p = 11;
    buf.set(nameBytes, p); p += nameBytes.length;
    dv.setUint8(p++, STEP.r); dv.setUint8(p++, STEP.g); dv.setUint8(p++, STEP.b); dv.setUint8(p++, OFFSET);
    buf.set(palette, p); p += 768;
    buf.set(payload, p);
    return buf;
}

// --- Eingabebild (identisch zum erzeugten Satz) ---
const src = new Uint8ClampedArray(1120 * 1120 * 4);
{
    const raw = fs.readFileSync(SRC_RAW);
    for (let i = 0, j = 0; i < 1120 * 1120; i++, j += 3) {
        src[i * 4] = raw[j]; src[i * 4 + 1] = raw[j + 1]; src[i * 4 + 2] = raw[j + 2]; src[i * 4 + 3] = 255;
    }
}
const scaled = { pixels: resizeImage(src, 1120, 1120, W, H, 'lanczos') };
const rgba = scaled.pixels;
// Gegenprobe: muss byte-identisch zum gespeicherten Eingabebild sein
{
    const gespeichert = fs.readFileSync(`${OUT}/input_640x256.rgb`);
    let diff = 0;
    for (let i = 0; i < TOTAL; i++) {
        if (gespeichert[i * 3] !== rgba[i * 4] || gespeichert[i * 3 + 1] !== rgba[i * 4 + 1] || gespeichert[i * 3 + 2] !== rgba[i * 4 + 2]) diff++;
    }
    if (diff) throw new Error(`Eingabebild weicht ab (${diff} Pixel) — Abbruch`);
    console.log('Eingabebild stimmt mit input_640x256.rgb überein');
}

const ergebnis = [];
const modi = nurModus ? [nurModus] : ALLE;

for (const m of modi) {
    const alt = readHam(`${OUT}/ham${m}.ham`);
    const format = alt.format;
    const startPalette = readHam(`${PAL_SRC}/ham${m}.ham`).palette;   // Palette vom letzten Mal

    const appState = {
        originalImageData: { width: W, height: H, data: rgba },
        decodedImageData: null, currentImgW: W, currentImgH: H,
        currentFormat: format, globalPaletteRAM: startPalette.slice(), latestCommandArray: null
    };
    const optRegion = { x: 0, y: 0, width: W, height: H };

    async function triggerEncode() {
        const enc = await encodePaletted(rgba, W, H, format, STEP, appState.globalPaletteRAM, OFFSET, 'greedy', METRIC, null, 0, 0, 15.0);
        appState.latestCommandArray = enc.commands;
        appState.decodedImageData = { width: W, height: H, data: decodePaletted(enc.commands, W, H, STEP, appState.globalPaletteRAM, OFFSET) };
    }

    await triggerEncode();
    const mseVorher = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, METRIC, optRegion);

    const t0 = Date.now();
    const log = await runManualRefinement(appState, optRegion, STEP, METRIC, OFFSET, new Set(),
        () => {}, triggerEncode, () => {}, 'usage');
    const dauer = Date.now() - t0;

    await triggerEncode();
    const mseNachher = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, METRIC, optRegion);

    const payload = packPaletted(appState.latestCommandArray, format);
    const ham = writeHam(format, appState.globalPaletteRAM, payload);
    fs.writeFileSync(`${OUT}/ham${m}.ham`, ham);

    // Raster aus der geschriebenen Datei
    const back = readHam(`${OUT}/ham${m}.ham`);
    const dec = decodePaletted(unpackPaletted(back.payload, format, TOTAL), W, H, STEP, back.palette, OFFSET);
    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = dec[i * 4]; rgb[i * 3 + 1] = dec[i * 4 + 1]; rgb[i * 3 + 2] = dec[i * 4 + 2]; }
    fs.writeFileSync(`${OUT}/ham${m}_decoded.rgb`, rgb);

    const verb = ((1 - mseNachher / mseVorher) * 100);
    console.log(`${format} (${intensity}): MSE ${mseVorher.toFixed(2)} -> ${mseNachher.toFixed(2)} (${verb.toFixed(1)}% besser) | ${(dauer / 1000).toFixed(1)} s | ${log.length} Log-Zeilen`);
    ergebnis.push({ m, format, mseVorher, mseNachher, dauer });
}

fs.writeFileSync(`${OUT}/_optimize_result.json`, JSON.stringify({ intensity, ergebnis }, null, 2));
console.log('\n_optimize_result.json geschrieben');
