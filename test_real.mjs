// Prüft die Palettenoptimierung an einem ECHTEN Bild (JPEG -> BGRA-Rohdaten).
// Aufruf: node test_real.mjs <size> <intensity|full>
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { runHybridOptimization } from './src/core/palette_optimizer.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 };
const metric = 'yuv_weight';
const offset = 0;

function loadBgra(path) {
    const raw = fs.readFileSync(path);
    const isFull = path.includes('full');
    const W = isFull ? 876 : parseInt(path.match(/real-(\d+)/)[1], 10);
    const H = isFull ? 882 : W;
    const stride = raw.length / H;          // Zeilenlänge in Bytes
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        const row = y * stride;
        for (let x = 0; x < W; x++) {
            const s = row + x * 4, d = (y * W + x) * 4;
            rgba[d] = raw[s + 2]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s]; rgba[d + 3] = 255; // BGRA -> RGBA
        }
    }
    return { W, H, rgba };
}

async function measure(size, intensity) {
    const file = size === 'full' ? 'testbilder/real-full.bgra' : `testbilder/real-${size}.bgra`;
    const { W, H, rgba } = loadBgra(file);
    const appState = {
        originalImageData: { width: W, height: H, data: rgba },
        decodedImageData: null, currentImgW: W, currentImgH: H,
        currentFormat: FORMAT, globalPaletteRAM: new Uint8Array(768), latestCommandArray: null
    };
    const optRegion = { x: 0, y: 0, width: W, height: H };
    const lockedSlots = new Set();

    async function triggerEncode() {
        const enc = await encodePaletted(rgba, W, H, FORMAT, step, appState.globalPaletteRAM, offset, 'greedy', metric, null, 0, 0, 15.0);
        appState.latestCommandArray = enc.commands;
        const dec = decodePaletted(enc.commands, W, H, step, appState.globalPaletteRAM, offset);
        appState.decodedImageData = { width: W, height: H, data: dec };
    }

    // Ausgangszustand: leere Palette
    const t0 = Date.now();
    await triggerEncode();
    const emptyMs = Date.now() - t0;
    const mseEmpty = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
    let a0 = 0, d0 = 0, t0c = 0;
    for (const c of appState.latestCommandArray) { if (c.isAnchor) a0++; else { d0++; if (c.isTurbo) t0c++; } }
    console.log(`\n### ${W}x${H} | Ausgang (leere Palette): MSE ${mseEmpty.toFixed(2)} | ${emptyMs} ms | Anker ${a0} (${(100*a0/(W*H)).toFixed(1)}%), Delta ${d0}, Turbo ${t0c}`);

    if (intensity === 'full') {
        // Nur: Qualität der optimierten Palette auf VOLLER Auflösung zeigen
        const pal = new Uint8Array(fs.readFileSync('testbilder/real-256-palette.bin'));
        appState.globalPaletteRAM.set(pal);
        const t1 = Date.now();
        await triggerEncode();
        const ms = Date.now() - t1;
        const mse = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);
        let a = 0, d = 0, tu = 0;
        for (const c of appState.latestCommandArray) { if (c.isAnchor) a++; else { d++; if (c.isTurbo) tu++; } }
        console.log(`### ${W}x${H} | mit optimierter 256er-Palette: MSE ${mse.toFixed(2)} (${((1 - mse / mseEmpty) * 100).toFixed(1)}% besser) | ${ms} ms | Anker ${a} (${(100*a/(W*H)).toFixed(1)}%), Delta ${d}, Turbo ${tu}`);
        return;
    }

    const t2 = Date.now();
    const log = await runHybridOptimization(appState, optRegion, step, metric, offset, lockedSlots, () => {}, triggerEncode, () => {}, intensity);
    const dur = Date.now() - t2;
    const mseEnd = computeAvgYuvScore(rgba, appState.decodedImageData.data, W, H, metric, optRegion);

    let anchors = 0, deltas = 0, turbo = 0;
    const usage = new Array(32).fill(0);
    for (const c of appState.latestCommandArray) {
        if (c.isAnchor) { anchors++; if (c.anchorIdx < 32) usage[c.anchorIdx]++; }
        else { deltas++; if (c.isTurbo) turbo++; }
    }
    const used = usage.filter((n, i) => i >= 1 && n > 0).length;

    console.log(`### "${intensity}": MSE ${mseEmpty.toFixed(2)} → ${mseEnd.toFixed(2)} (${((1 - mseEnd/mseEmpty)*100).toFixed(1)}% besser) | ${dur} ms`);
    console.log(`###   Anker ${anchors} (${(100*anchors/(W*H)).toFixed(1)}%), Delta ${deltas}, Turbo ${turbo} | Slots genutzt ${used}/31`);
    console.log(`###   Nutzung: ${usage.map((n, i) => i > 0 && n > 0 ? `S${i}:${n}` : null).filter(Boolean).join(' ')}`);
    const stages = [...String(log.join('\n')).matchAll(/Nach ([^:<]+): <b>MSE ([0-9.]+)<\/b>([^|]*)\| ([^<]*)</g)]
        .map(m => ({ stage: m[1].trim(), mse: m[2], diff: m[3].replace(/<[^>]*>/g, '').trim(), time: m[4].trim() }));
    for (const s of stages) console.log(`      ${s.stage.padEnd(44)} MSE ${s.mse.padStart(8)} ${s.diff.padEnd(14)} ${s.time}`);
    if (typeof size === 'number') fs.writeFileSync(`testbilder/real-${size}-palette.bin`, appState.globalPaletteRAM);
}

const sizeArg = process.argv[2];
const size = sizeArg === 'full' ? 'full' : parseInt(sizeArg, 10);
await measure(size, process.argv[3] || 'sehr_schnell');
