// Sind die Slots fertig optimiert?
//
// runManualRefinement wiederholt sich intern, bis ein Durchgang kaum noch etwas
// bringt (REFINE_MIN_GAIN). Dieses Skript ruft es mehrfach auf, um zu sehen, ob
// danach ÜBERHAUPT noch etwas geht — und zählt Rand-Treffer im Suchraster
// (×175% = Maximum von VECTOR_SCALES), weil die das Optimum abschneiden.
//
// Aufruf: node test_refine.mjs [size=128|full] [aufrufe=3] [useProxy=false] [start=sehr_schnell|normal|langsam]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runHybridOptimization, runManualRefinement, runManualRefinementWithProxy } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;

const sizeArg = process.argv[2] || '128';
const passes = Math.max(1, parseInt(process.argv[3] || '3', 10));
const useProxy = process.argv[4] === 'true';
const startIntensity = process.argv[5] || 'sehr_schnell';   // Startpalette: wie im echten Ablauf
const slotOrder = process.argv[6] || 'desc';                // desc | asc | usage
const isFull = sizeArg === 'full';
const W = isFull ? 876 : parseInt(sizeArg, 10);
const H = W;
const cacheFile = `testbilder/tmp-refine-start-${isFull ? 'full' : W}.bin`;

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
async function triggerEncode() {
    const w = appState.currentImgW, h = appState.currentImgH;
    const enc = await encodePaletted(appState.originalImageData.data, w, h, FORMAT, step,
        appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
    appState.latestCommandArray = enc.commands;
    appState.decodedImageData = { width: w, height: h, data: decodePaletted(enc.commands, w, h, step, appState.globalPaletteRAM, offset) };
}
const region = { x: 0, y: 0, width: W, height: H };
const mseFull = () => computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, region);
// Auf dem Vollbild messen (nach dem Proxy-Lauf wurde bereits neu encodiert)
const mseFullRes = async () => { if (appState.currentImgW !== W) await triggerEncode(); return mseFull(); };

// Startpalette: wie im echten Ablauf zuerst eine Optimierung — ODER die
// zwischengespeicherte Palette, damit ein A/B exakt von derselben Palette startet.
appState.globalPaletteRAM.fill(0);
await triggerEncode();
console.log(`### ${W}x${H} | Ausgang (leere Palette): MSE ${mseFull().toFixed(2)}`);
if (fs.existsSync(cacheFile)) {
    appState.globalPaletteRAM.set(new Uint8Array(fs.readFileSync(cacheFile)));
    await triggerEncode();
    console.log(`### Startpalette aus ${cacheFile} geladen: MSE ${(await mseFullRes()).toFixed(2)}`);
} else {
    await runHybridOptimization(appState, region, step, metric, offset, new Set(), () => {}, triggerEncode, () => {}, startIntensity);
    fs.writeFileSync(cacheFile, appState.globalPaletteRAM);
    console.log(`### Nach "${startIntensity}": MSE ${(await mseFullRes()).toFixed(2)}  (Startpalette in ${cacheFile} gespeichert)`);
}
console.log(`### Slot-Reihenfolge: ${slotOrder}`);

// Raster der gewählten Korrektur-Schritte mitschreiben, um Rand-Treffer zu sehen
for (let p = 1; p <= passes; p++) {
    const t0 = Date.now();
    const log = useProxy
        ? await runManualRefinementWithProxy(appState, region, step, metric, offset, new Set(), () => {}, triggerEncode, () => {}, true, slotOrder)
        : await runManualRefinement(appState, region, step, metric, offset, new Set(), () => {}, triggerEncode, () => {}, slotOrder);
    const dur = (Date.now() - t0) / 1000;
    const mse = await mseFullRes();

    const scales = [...log.join('\n').matchAll(/×(\d+)%/g)].map(m => parseInt(m[1], 10));
    const atMax = scales.filter(s => s >= 175).length;
    const maxScale = scales.length ? Math.max(...scales) : 0;
    const improved = log.filter(l => String(l).includes('✨')).length;

    // Interne Durchgänge der Konvergenzschleife ausgeben
    const passLines = log.map(l => String(l).replace(/<[^>]*>/g, '')).filter(l => l.includes('Durchgang') || l.includes('konvergiert'));
    for (const pl of passLines) console.log(`      ${pl.trim()}`);

    console.log(`### Aufruf ${p}: MSE ${mse.toFixed(2)} | ${dur.toFixed(1)} s | verbessert ${improved} Slots | Rand-Treffer (>=175%): ${atMax}/${scales.length} | groesster Schritt: ${maxScale}%`);
}
process.exit(0);
