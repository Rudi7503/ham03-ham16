// End-to-End-Prüfung der REINEN HAM-Modi (HAM03…HAM08): echte Encode-Kette,
// Packen/Entpacken, Bildfehler und Smart Target. Ergänzt test_modebit.mjs, das
// nur die Bit-Ebene auf einem synthetischen Bild prüft.
import fs from 'node:fs';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './src/core/module_paletted.js';
import { generateSmartTarget, getRasterInfo } from './src/core/smart_target.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const step = { r: 4, g: 4, b: 4 };
const metric = 'yuv_weight';

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

const { W, H, rgba } = loadBgra('testbilder/real-128.bgra');

// Feste Palette: die versionierte Referenz (identische Ausgangslage für alle Formate)
const palette = new Uint8Array(fs.readFileSync('testbilder/palettes/real-128-langsam.bin'));

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

console.log(`Bild ${W}x${H}, Palette testbilder/palettes/real-128-langsam.bin\n`);

for (const format of ['HAM03', 'HAM04', 'HAM05', 'HAM06', 'HAM08']) {
    const cfg = { isMixed: false };
    // 1) Encode
    const { commands } = await encodePaletted(rgba, W, H, format, step, palette.slice(), 0, 'greedy', metric);
    const decoded = decodePaletted(commands, W, H, step, palette, 0);
    const mse = computeAvgYuvScore(rgba, decoded, W, H, metric, null);

    let anchors = 0, turbo = 0;
    for (const c of commands) { if (c.isAnchor) anchors++; else if (c.isTurbo) turbo++; }

    // 2) Packen / Entpacken / erneut dekodieren
    const packed = packPaletted(commands, format);
    const back = unpackPaletted(packed, format, W * H);
    const decoded2 = decodePaletted(back, W, H, step, palette, 0);
    let diff = 0;
    for (let i = 0; i < decoded.length; i++) if (decoded[i] !== decoded2[i]) diff++;

    const bits = { HAM03: 3, HAM04: 4, HAM05: 5, HAM06: 6, HAM08: 8 }[format];
    const erwarteteBytes = Math.ceil(W * H * bits / 32) * 4;

    // 3) Smart Target auf einem reinen Format (kein Mischraster!)
    let stOk = true, stDetail = '';
    if (getRasterInfo(format) !== null) { stOk = false; stDetail = 'getRasterInfo liefert fuer ein reines Format ein Raster'; }
    try {
        const st = await generateSmartTarget({
            sourceData: rgba, width: W, height: H, step, metric,
            format, paletteRAM: palette, offset: 0, strategy: 'greedy',
            peakThreshold: 8, anchorTol: 24
        });
        if (!st || !st.target) { stOk = false; stDetail = 'kein target'; }
        else if (st.target.length !== rgba.length) { stOk = false; stDetail = 'falsche Puffergroesse'; }
    } catch (e) {
        stOk = false; stDetail = 'Ausnahme: ' + e.message;
    }

    check(`${format}  MSE ${mse.toFixed(2)} | ${packed.length} B (erwartet ${erwarteteBytes}) | Anker ${anchors} Turbo ${turbo}`,
        packed.length === erwarteteBytes && diff === 0 && Number.isFinite(mse));
    check(`${format}  Round-Trip Packen→Entpacken→Dekodieren identisch`, diff === 0, diff ? `${diff} Abweichungen` : '');
    check(`${format}  Smart Target ohne Mischraster`, stOk, stDetail);
}

console.log(fehler === 0 ? '\nREINE FORMATE LAUFEN DURCH DIE GANZE KETTE' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
