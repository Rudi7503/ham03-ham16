// Erzeugt die Referenz-Paletten für die Testbilder und legt sie unter
// testbilder/palettes/ ab. Diese Paletten sind die FESTE Grundlage für alle
// Vergleichsmessungen am Bild-Modifizieren: nur so ist eine Änderung der
// Modifikation vergleichbar und nicht eine Folge einer anderen Palette.
//
// Aufruf: node make_palettes.mjs [size|all] [intensity]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runHybridOptimization, runOptimizationWithProxy } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;
const OUTDIR = 'testbilder/palettes';
fs.mkdirSync(OUTDIR, { recursive: true });

const which = process.argv[2] || 'all';
const intensity = process.argv[3] || 'langsam';
const sizes = which === 'all' ? ['128', '256', 'full'] : [which];

for (const size of sizes) {
    const isFull = size === 'full';
    // Achtung: das Testfoto ist 876x882, NICHT quadratisch.
    const W = isFull ? 876 : parseInt(size, 10);
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
    const appState = {
        originalImageData: { width: W, height: H, data: rgba },
        modifiedImageData: null, decodedImageData: null, errorViewData: null,
        latestCommandArray: null, latestPackedData: null, commandSource: null,
        currentImgW: W, currentImgH: H, currentFormat: FORMAT, globalPaletteRAM: new Uint8Array(768)
    };
    const region = { x: 0, y: 0, width: W, height: H };
    async function triggerEncode() {
        const w = appState.currentImgW, h = appState.currentImgH;
        const enc = await encodePaletted(appState.originalImageData.data, w, h, FORMAT, step,
            appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
        appState.latestCommandArray = enc.commands;
        appState.decodedImageData = { width: w, height: h, data: decodePaletted(enc.commands, w, h, step, appState.globalPaletteRAM, offset) };
    }

    const t0 = Date.now();
    // Große Bilder über den Proxy (sonst dauert ein Lauf viele Minuten).
    if (isFull) {
        await runOptimizationWithProxy(appState, region, step, metric, offset, new Set(),
            () => {}, triggerEncode, () => {}, intensity, true);
    } else {
        appState.globalPaletteRAM.fill(0);
        await triggerEncode();
        await runHybridOptimization(appState, region, step, metric, offset, new Set(),
            () => {}, triggerEncode, () => {}, intensity);
    }
    const dur = (Date.now() - t0) / 1000;

    // Auf dem Vollbild nachmessen (nach dem Proxy-Lauf wurde bereits encodiert)
    if (appState.currentImgW !== W) await triggerEncode();
    const mse = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, region);

    const file = `${OUTDIR}/${isFull ? 'real-full' : 'real-' + W}-${intensity}.bin`;
    fs.writeFileSync(file, appState.globalPaletteRAM);
    console.log(`### ${W}x${H}: Palette "${intensity}" gespeichert in ${file} | Vollbild-MSE ${mse.toFixed(2)} | ${dur.toFixed(1)} s`);
}
process.exit(0);
