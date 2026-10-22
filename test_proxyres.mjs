// Begrenzt die Proxy-Auflösung die Qualität? Läuft die Pipeline mehrfach mit
// unterschiedlich feinem Proxy und misst jeweils den MSE auf dem VOLLBILD.
// Bewusst am kleinen 128²-Bild: dort dauert ein Durchlauf Sekunden, und die
// Frage ist eine Prinzipienfrage (Verkleinerungsfaktor), keine Bildgrößenfrage.
//
// Aufruf: node test_proxyres.mjs [size=128] [intensity=sehr_schnell]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runOptimizationWithProxy } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;
const W = parseInt(process.argv[2] || '128', 10), H = W;
const intensity = process.argv[3] || 'sehr_schnell';

const raw = fs.readFileSync(`testbilder/real-${W}.bgra`);
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
const mseFull = () => computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, region);

await triggerEncode();
console.log(`### ${W}x${H} | Ausgang (leere Palette): MSE ${mseFull().toFixed(2)} | Verfahren: ${intensity}`);

// 1.0 entspricht "kein Proxy" (maxSide <= proxyMaxSide → Direktlauf).
// Relative Größen, damit der Lauf für jede Bildgröße sinnvoll ist.
// Optional: argv[4] = explizite Proxy-Kantenlängen als CSV (für Empfindlichkeitstests).
const explicit = (process.argv[4] || '').split(',').map(s => parseInt(s, 10)).filter(n => n > 0);
const fractions = explicit.length > 0 ? explicit.map(n => n / W) : [0.125, 0.25, 0.375, 0.5, 0.75, 1.0];
for (const frac of fractions) {
    const pms = Math.max(16, Math.round(W * frac));
    appState.globalPaletteRAM.fill(0);
    await triggerEncode();
    const proxySide = Math.min(pms, W);
    const t0 = Date.now();
    await runOptimizationWithProxy(appState, region, step, metric, offset, new Set(),
        () => {}, triggerEncode, () => {}, intensity, true, pms);
    const dur = (Date.now() - t0) / 1000;
    const restored = appState.currentImgW === W && appState.currentImgH === H;
    const ratio = (W * H) / (proxySide * proxySide);
    console.log(`### Proxy ${String(proxySide).padStart(3)}x${proxySide} (${ratio.toFixed(1).padStart(5)}x weniger Pixel) → Vollbild-MSE ${mseFull().toFixed(2)} | ${dur.toFixed(1)} s${restored ? '' : '  FEHLER: Groesse nicht wiederhergestellt'}`);
}
process.exit(0);
