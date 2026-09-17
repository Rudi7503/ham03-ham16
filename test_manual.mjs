// Prüft das manuelle Nachoptimieren über den Proxy am echten 876x882-Foto.
// Aufruf: node test_manual.mjs [true|false]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runManualRefinementWithProxy, getCandidateScoreCount } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, metric = 'yuv_weight', offset = 0;
const W = 876, H = 882;

function loadBgra(path, w, h) {
    const raw = fs.readFileSync(path);
    const stride = raw.length / h;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const row = y * stride;
        for (let x = 0; x < w; x++) {
            const s = row + x * 4, d = (y * w + x) * 4;
            rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
        }
    }
    return rgba;
}

const rgba = loadBgra('testbilder/real-full.bgra', W, H);
const useProxy = process.argv[2] === undefined ? true : process.argv[2] === 'true';

const appState = {
    originalImageData: { width: W, height: H, data: rgba },
    modifiedImageData: null, decodedImageData: null, errorViewData: null,
    latestCommandArray: null, latestPackedData: null, commandSource: null,
    currentImgW: W, currentImgH: H, currentFormat: FORMAT, globalPaletteRAM: new Uint8Array(768)
};
const optRegion = { x: 0, y: 0, width: W, height: H };

let encodeCount = 0;
let lastEncodeMs = 0;
async function triggerEncode() {
    const w = appState.currentImgW, h = appState.currentImgH;
    const t = Date.now();
    const enc = await encodePaletted(appState.originalImageData.data, w, h, FORMAT, step,
        appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
    lastEncodeMs = Date.now() - t;
    encodeCount++;
    appState.latestCommandArray = enc.commands;
    appState.decodedImageData = { width: w, height: h, data: decodePaletted(enc.commands, w, h, step, appState.globalPaletteRAM, offset) };
}

// Startpalette: die gespeicherte, proxy-optimierte 256er-Palette
const pal = new Uint8Array(fs.readFileSync('testbilder/real-256-palette.bin'));
appState.globalPaletteRAM.set(pal);
await triggerEncode();
const fullEncodeMs = lastEncodeMs;
const mseBefore = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
console.log(`### ${W}x${H}: Ausgangs-MSE ${mseBefore.toFixed(2)} | Vollbild-Encode ${fullEncodeMs} ms`);
console.log(`### Nachoptimierung: Proxy=${useProxy}`);

encodeCount = 0;
const scoresBefore = getCandidateScoreCount();
const t0 = Date.now();
const log = await runManualRefinementWithProxy(appState, optRegion, step, metric, offset, new Set(),
    () => {}, triggerEncode, () => {}, useProxy);
const dur = (Date.now() - t0) / 1000;
const candidateScores = getCandidateScoreCount() - scoresBefore;

const restored = appState.currentImgW === W && appState.currentImgH === H;
const mseAfter = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
const improved = log.filter(l => String(l).includes('✨')).length;
const abortedNote = log.some(l => String(l).includes('abgebrochen'));

console.log(`\n### Ergebnis: MSE ${mseBefore.toFixed(2)} → ${mseAfter.toFixed(2)} (${(mseBefore - mseAfter).toFixed(2)} besser) | ${dur.toFixed(1)} s`);
console.log(`###   Verbesserte Slots: ${improved} | Basis-Encodes: ${encodeCount} | Kandidaten-Bewertungen: ${candidateScores}`);
console.log(`###   Bildgröße wiederhergestellt: ${restored ? 'ja' : 'NEIN — FEHLER!'} (${appState.currentImgW}x${appState.currentImgH})`);
console.log(`###   Abbruch-Hinweis: ${abortedNote ? 'ja' : 'nein'}`);
if (Array.isArray(log) && log.length) console.log(`###   Kopfzeile: ${String(log[0]).replace(/<[^>]*>/g, '')}`);
// Hochrechnung aufs Vollbild: JEDE Kandidaten-Bewertung ist ein voller Encode.
const totalEncodes = encodeCount + candidateScores;
console.log(`###   Arbeit gesamt: ${totalEncodes} Bild-Encodes (${encodeCount} Basis + ${candidateScores} Kandidaten)`);
console.log(`###   Aufs Vollbild hochgerechnet: ca. ${(totalEncodes * fullEncodeMs / 1000).toFixed(0)} s (${totalEncodes} x ${fullEncodeMs} ms)`);
process.exit(restored ? 0 : 1);
