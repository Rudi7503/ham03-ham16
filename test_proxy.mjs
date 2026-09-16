// Prüft die PROXY-Optimierung (Auto-Budget) am echten 876x882-Foto.
// Aufruf: node test_proxy.mjs [intensity] [useProxy]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runOptimizationWithProxy } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 };
const metric = 'yuv_weight';
const offset = 0;

function loadBgra(path, W, H) {
    const raw = fs.readFileSync(path);
    const stride = raw.length / H;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        const row = y * stride;
        for (let x = 0; x < W; x++) {
            const s = row + x * 4, d = (y * W + x) * 4;
            rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255;
        }
    }
    return rgba;
}

const W = 876, H = 882;
const rgba = loadBgra('testbilder/real-full.bgra', W, H);
const intensity = process.argv[2] || 'sehr_schnell';
const useProxy = process.argv[3] === undefined ? true : process.argv[3] === 'true';
const repeats = Math.max(1, parseInt(process.argv[4] || '1', 10));

const appState = {
    originalImageData: { width: W, height: H, data: rgba },
    modifiedImageData: null,
    decodedImageData: null,
    errorViewData: null,
    latestCommandArray: null,
    latestPackedData: null,
    commandSource: null,
    currentImgW: W, currentImgH: H,
    currentFormat: FORMAT,
    globalPaletteRAM: new Uint8Array(768)
};
const optRegion = { x: 0, y: 0, width: W, height: H };
const lockedSlots = new Set();

// Live-Fortschritt nur auszugsweise zeigen (sonst eine Zeile pro Slot)
let progressSeen = 0;
const progressSamples = [];
const onProgress = (msg) => {
    progressSeen++;
    if (msg.includes('noch ca.') && progressSamples.length < 4) progressSamples.push(msg);
};

async function triggerEncode() {
    // WICHTIG: immer die AKTUELLEN appState-Maße benutzen — die Proxy-Optimierung
    // tauscht Bilddaten und currentImgW/H temporär gegen das Vorschaubild aus.
    // (Ein fester W/H hier würde bei jedem Schritt das Vollbild encodieren.)
    const w = appState.currentImgW, h = appState.currentImgH;
    const src = appState.originalImageData.data;
    const enc = await encodePaletted(src, w, h, FORMAT, step,
        appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
    appState.latestCommandArray = enc.commands;
    const dec = decodePaletted(enc.commands, w, h, step, appState.globalPaletteRAM, offset);
    appState.decodedImageData = { width: w, height: h, data: dec };
}

// Startzustand: leere Palette
await triggerEncode();
const mseEmpty = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
console.log(`### ${W}x${H} (${W * H} px) | Ausgang (leere Palette): MSE ${mseEmpty.toFixed(2)}`);

for (let run = 1; run <= repeats; run++) {
    console.log(`\n===== Durchlauf ${run}/${repeats} (${intensity}, Proxy=${useProxy}) =====`);
    progressSeen = 0;
    progressSamples.length = 0;
    appState.globalPaletteRAM.fill(0);

    const t0 = Date.now();
    const log = await runOptimizationWithProxy(
        appState, optRegion, step, metric, offset, lockedSlots,
        onProgress,
        triggerEncode,
        () => {},
        intensity,
        useProxy
    );
    const dur = (Date.now() - t0) / 1000;

    // Zustand muss vollständig wiederhergestellt sein
    const restored = appState.currentImgW === W && appState.currentImgH === H;
    const mseNow = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);

    let anchors = 0, deltas = 0, turbo = 0;
    for (const c of appState.latestCommandArray) {
        if (c.isAnchor) anchors++; else { deltas++; if (c.isTurbo) turbo++; }
    }

    console.log(`### Ergebnis: MSE ${mseEmpty.toFixed(2)} → ${mseNow.toFixed(2)} (${((1 - mseNow / mseEmpty) * 100).toFixed(1)}% besser) | ${dur.toFixed(1)} s`);
    console.log(`###   Anker ${anchors} (${(100 * anchors / (W * H)).toFixed(1)}%), Delta ${deltas}, Turbo ${turbo}`);
    console.log(`###   Bildgröße wiederhergestellt: ${restored ? 'ja' : 'NEIN — FEHLER!'} (${appState.currentImgW}x${appState.currentImgH})`);
    console.log(`###   Log-Einträge: ${Array.isArray(log) ? log.length : 'kein Array'}`);
    if (Array.isArray(log) && log.length > 0) {
        console.log(`###   Schätzung: ${String(log[1] || log[0]).replace(/<[^>]*>/g, '')}`);
    }
    console.log(`###   Fortschrittsmeldungen: ${progressSeen}, davon mit Restdauer: ${progressSamples.length ? 'ja' : 'NEIN'}`);
    if (progressSamples.length) console.log(`###     z.B.: ${progressSamples[progressSamples.length - 1]}`);
    if (!restored) process.exit(1);
}
process.exit(0);

