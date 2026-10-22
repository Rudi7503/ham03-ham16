// Prüft die "keine Ankerfarbe"-Bedingung, BEVOR sie als Kriterium verdrahtet wird.
//
// Für jeden HL-Peak wird gemessen, wie weit die nächste Palettenfarbe entfernt
// ist, die die jeweilige Phase überhaupt erreichen kann:
//   - eigene Phase  → nur die ersten slots[phase] Einträge (HAM03 = 4, HAM04 = 8)
//   - starke Phase  → die ersten maxSlots Einträge (HAM06 = 32)
// Damit wird sichtbar, wie oft ein Peak ein Kapazitätsproblem ist (Farbe nur
// außerhalb der eigenen Phase erreichbar) und wie oft es GAR KEINE Ankerfarbe
// gibt (auch auf der starken Phase nicht) — nur dann ist Dämpfen die einzige
// Möglichkeit.
//
// Aufruf: node test_anchor.mjs [size|full] [palette] [threshold]
import fs from 'node:fs';
import { encodePaletted, decodePaletted } from './src/core/module_paletted.js';
import { computeHlMap, detectPeaks, getRasterInfo } from './src/core/smart_target.js';

const FORMAT = 'HAM_32BIT_63436343';
const step = { r: 4, g: 4, b: 4 }, offset = 0, strategy = 'greedy', metric = 'yuv_weight';
const sizeArg = process.argv[2] || 'full';
const paletteName = process.argv[3] || `real-${sizeArg}-langsam`;
const threshold = parseInt(process.argv[4] || '17', 10);
const isFull = sizeArg === 'full';
const W = isFull ? 876 : parseInt(sizeArg, 10);
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
const pal = new Uint8Array(fs.readFileSync(`testbilder/palettes/${paletteName}.bin`));
const enc = await encodePaletted(rgba, W, H, FORMAT, step, pal, offset, strategy, metric, null, 0, 0, 15.0);
const dec = decodePaletted(enc.commands, W, H, step, pal, offset);

const raster = getRasterInfo(FORMAT);
const hl = computeHlMap(rgba, dec, W, H);
const { peaks } = detectPeaks(hl, W, H, threshold);
console.log(`### ${W}x${H} | Palette ${paletteName} | Schwelle ${threshold} | ${peaks.length} Peaks`);
console.log(`### Raster: Periode ${raster.period}, Plaetze ${raster.slots.join('/')}, schwach {${[...raster.weak].join(',')}}`);

// Abstand zur nächsten erreichbaren Palettenfarbe, begrenzt auf die ersten n Slots
function nearestDist(r, g, b, nSlots) {
    let best = Infinity;
    for (let i = 0; i < nSlots; i++) {
        const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
}

const perPhase = new Array(raster.period).fill(0);
let sumOwnPhase = 0, sumStrong = 0;
const bucketsOwn = [0, 0, 0, 0, 0, 0];      // <=8, <=16, <=24, <=40, <=64, >64
const bucketsStrong = [0, 0, 0, 0, 0, 0];
const bucketOf = (d) => d <= 8 ? 0 : d <= 16 ? 1 : d <= 24 ? 2 : d <= 40 ? 3 : d <= 64 ? 4 : 5;

let lossByOwn = 0, lossByStrong = 0, sumAll = 0;

for (const p of peaks) {
    const phase = (p.y * W + p.x) % raster.period;
    perPhase[phase]++;
    const o = (p.y * W + p.x) * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const dOwn = nearestDist(r, g, b, raster.slots[phase]);
    const dStrong = nearestDist(r, g, b, raster.maxSlots);
    sumOwnPhase += dOwn; sumStrong += dStrong;
    bucketsOwn[bucketOf(dOwn)]++;
    bucketsStrong[bucketOf(dStrong)]++;
    // "Fehler, den die Phasengrenze verursacht": zusätzlicher Abstand durch die Slot-Begrenzung
    lossByOwn += Math.max(0, dOwn * dOwn - dStrong * dStrong);
    lossByStrong += dStrong * dStrong;
    sumAll++;
}

const pct = (n) => (100 * n / sumAll).toFixed(1) + '%';
console.log(`### Peaks je Phase: ${perPhase.map((n, i) => `P${i}(${raster.names[i]}/${raster.slots[i]}):${n}`).join(', ')}`);
console.log(`### Mittlerer Abstand zur nächsten erreichbaren Palettenfarbe:`);
console.log(`###   eigene Phase : ${(sumOwnPhase / sumAll).toFixed(2)}`);
console.log(`###   starke Phase : ${(sumStrong / sumAll).toFixed(2)}`);
console.log(`### Verteilung (Abstand)   <=8    <=16   <=24   <=40   <=64   >64`);
console.log(`###   eigene Phase      ${bucketsOwn.map(b => pct(b).padStart(6)).join(' ')}`);
console.log(`###   starke Phase      ${bucketsStrong.map(b => pct(b).padStart(6)).join(' ')}`);
console.log(`### Zusaetzlicher quadratischer Abstand durch die Slot-Grenze der eigenen Phase: ${(lossByOwn / Math.max(1, lossByStrong) * 100).toFixed(1)}% der des Abstands auf der starken Phase`);
process.exit(0);
