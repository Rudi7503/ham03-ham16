// Vergleichsmessung nach den Änderungen (#1 Proxy, #2 fehlergewichteter Prefill).
// Aufruf: node test_palcheck.mjs <real128|real256|realfull|synth>
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runHybridOptimization, runOptimizationWithProxy } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';
import { testImagePixels } from './src/testimages.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 };
const metric = 'yuv_weight';
const offset = 0;

function loadReal(size) {
    const file = size === 'full' ? 'testbilder/real-full.bgra' : `testbilder/real-${size}.bgra`;
    const raw = fs.readFileSync(file);
    const W = size === 'full' ? 876 : size;
    const H = size === 'full' ? 882 : size;
    const stride = raw.length / H;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = y * stride + x * 4, d = (y * W + x) * 4;
        rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
    }
    return { W, H, rgba };
}

async function runCase(label, ref, W, H, rgba, intensity, viaProxy) {
    const appState = {
        originalImageData: { width: W, height: H, data: rgba },
        decodedImageData: null, currentImgW: W, currentImgH: H,
        currentFormat: FORMAT, globalPaletteRAM: new Uint8Array(768), latestCommandArray: null
    };
    const optRegion = { x: 0, y: 0, width: W, height: H };
    // Wichtig: IMMER den aktuellen appState encodieren (wie der echte Builder) —
    // nur so funktioniert die Proxy-Phase, in der appState auf das Vorschaubild zeigt.
    async function triggerEncode() {
        const src = appState.modifiedImageData || appState.originalImageData;
        const w = appState.currentImgW, h = appState.currentImgH;
        const enc = await encodePaletted(src.data, w, h, FORMAT, step, appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
        appState.latestCommandArray = enc.commands;
        appState.decodedImageData = { width: w, height: h, data: decodePaletted(enc.commands, w, h, step, appState.globalPaletteRAM, offset) };
    }
    await triggerEncode();
    const mseStart = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);

    const t0 = Date.now();
    const log = viaProxy
        ? await runOptimizationWithProxy(appState, optRegion, step, metric, offset, new Set(), () => {}, triggerEncode, () => {}, intensity, true)
        : await runHybridOptimization(appState, optRegion, step, metric, offset, new Set(), () => {}, triggerEncode, () => {}, intensity);
    const dur = Date.now() - t0;

    const mseEnd = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
    let anchors = 0, deltas = 0, turbo = 0;
    for (const c of appState.latestCommandArray) { if (c.isAnchor) anchors++; else { deltas++; if (c.isTurbo) turbo++; } }
    const improved = mseStart > 0 ? (100 * (1 - mseEnd / mseStart)).toFixed(1) : '0';
    const refTxt = ref != null ? `  (vorher: MSE ${ref})` : '';
    console.log(`${label.padEnd(34)} MSE ${mseStart.toFixed(1).padStart(7)} → ${mseEnd.toFixed(2).padStart(7)} (${improved.padStart(5)}%)  ${dur.toString().padStart(6)} ms  Anker ${(100*anchors/(W*H)).toFixed(0).padStart(2)}% Turbo ${turbo}${refTxt}`);
    return mseEnd;
}

const mode = process.argv[2] || 'real128';
if (mode === 'real128') {
    const { W, H, rgba } = loadReal(128);
    await runCase('real 128 sehr_schnell', 62.51, W, H, rgba, 'sehr_schnell', false);
} else if (mode === 'real256') {
    const { W, H, rgba } = loadReal(256);
    await runCase('real 256 sehr_schnell', 35.72, W, H, rgba, 'sehr_schnell', false);
} else if (mode === 'realfull') {
    const { W, H, rgba } = loadReal('full');
    await runCase('real 876x882 PROXY sehr_schnell', 33.62, W, H, rgba, 'sehr_schnell', true);
} else if (mode === 'synth') {
    for (const style of ['sweet', 'pixelstyle']) {
        const W = 64, H = 64;
        const rgba = testImagePixels(style, W);
        const ref = style === 'sweet' ? 9.62 : null;
        await runCase(`${style} 64 sehr_schnell`, ref, W, H, rgba, 'sehr_schnell', false);
    }
}
