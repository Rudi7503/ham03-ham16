// Schreibt testbilder/ref640/INDEX.md vollständig aus den Dateien neu.
// Einzige Quelle für die Zahlen sind die Dateien selbst: Größen, Prüfsummen,
// Paletten-Hashes, Round-Trip und Reproduktion werden hier gemessen, nicht
// eingetragen. Nach jeder Änderung an den .ham-Dateien erneut ausführen.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const DIR = 'testbilder/ref640';
const PAL_SRC = 'testbilder/ref';
const W = 640, H = 256, TOTAL = W * H;
const STEP = { r: 4, g: 4, b: 4 }, OFFSET = 0, METRIC = 'yuv_weight';
const MODES = ['03', '04', '05', '06', '08'];

// Nachoptimierung: Ergebnisse des Laufs von optimize_ref_640.mjs (nicht aus den
// Dateien ableitbar, deshalb dokumentiert). HAM08 wurde nicht nachoptimiert.
const REFINE = {
    HAM03: { vorher: 32.67, nachher: 32.52 },
    HAM04: { vorher: 14.44, nachher: 14.40 },
    HAM05: { vorher: 5.13, nachher: 5.10 },
    HAM06: { vorher: 3.34, nachher: 3.29 },
    HAM08: null
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
    return { raw, width: w, height: h, format, step, offset, palette, payload: raw.slice(p) };
}

// Eingabebild
const inputRgb = fs.readFileSync(`${DIR}/input_640x256.rgb`);
const inputRgba = new Uint8ClampedArray(TOTAL * 4);
for (let i = 0, j = 0; i < TOTAL; i++, j += 3) {
    inputRgba[i * 4] = inputRgb[j]; inputRgba[i * 4 + 1] = inputRgb[j + 1]; inputRgba[i * 4 + 2] = inputRgb[j + 2]; inputRgba[i * 4 + 3] = 255;
}

const zeilen = [];
for (const m of MODES) {
    const h = readHam(`${DIR}/ham${m}.ham`);
    const rgb = new Uint8Array(fs.readFileSync(`${DIR}/ham${m}_decoded.rgb`));

    // Round-Trip: aus der geschriebenen Datei dekodieren und mit dem Encode-Ergebnis vergleichen
    const decFromFile = decodePaletted(unpackPaletted(h.payload, h.format, TOTAL), h.width, h.height, h.step, h.palette, h.offset);
    let rtDiff = 0;
    for (let i = 0; i < TOTAL; i++) {
        if (decFromFile[i * 4] !== rgb[i * 3] || decFromFile[i * 4 + 1] !== rgb[i * 3 + 1] || decFromFile[i * 4 + 2] !== rgb[i * 3 + 2]) rtDiff++;
    }

    // Reproduktion: aus dem Eingabebild mit der Palette AUS DER DATEI erneut encoden
    const { commands } = await encodePaletted(inputRgba, W, H, h.format, STEP, h.palette.slice(), OFFSET, 'greedy', METRIC, null, 0, 0, 15.0);
    const again = packPaletted(commands, h.format);
    let reproDiff = 0;
    for (let i = 0; i < Math.min(again.length, h.payload.length); i++) if (again[i] !== h.payload[i]) reproDiff++;
    reproDiff += Math.abs(again.length - h.payload.length);

    zeilen.push({ m, ...h, rgb, rtDiff, reproDiff });
}

let md = `# Referenzsatz 640×256

Erzeugt mit \`make_ref_640.mjs\`, Paletten nachoptimiert mit \`optimize_ref_640.mjs\`.
**Diese Datei wird von \`update_index_640.mjs\` aus den Dateien erzeugt** — alle
Größen und Prüfsummen sind gemessen, nicht eingetragen. \\
Geprüft mit \`test_ref640_index.mjs\` (Vergleich Index ↔ Dateien) und
\`test_ref_mem.mjs testbilder/ref640\` (Testbench-Dateien).

## Herkunft

- **Encoder:** Code ab Commit \`48890d1\` (unverändert bis HEAD).
- **Quellbild:** dieselbe 1120×1120-JPEG wie beim 320×256-Satz
  (sha256 \`3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f\`).
- **Skalierung:** \`resizeImage\` (Lanczos) mit **unabhängigen Faktoren je Achse**:
  x = 640/1120 = 0,5714, y = 256/1120 = 0,2286. Das ganze Bild wird auf 640×256
  abgebildet — **kein Beschnitt, keine Ränder**, dafür anisotrop. \\
  \`input_640x256.rgb\` = tatsächliches Encoder-Eingabebild (${inputRgb.length} Byte,
  sha256 \`${sha(inputRgb)}\`).
- **Paletten:** Startpunkt 320×256-Satz, dann \`runManualRefinement\` (Slot für Slot,
  ausgehend von der vorhandenen Palette, Reihenfolge \`usage\`) auf 640×256:

  | Modus | vorher | nachher | besser |
  |---|---|---|---|
${MODES.map(m => {
    const f = readHam(`${DIR}/ham${m}.ham`).format;
    const r = REFINE[f];
    return r
        ? `  | ${f} | ${r.vorher.toFixed(2).replace('.', ',')} | ${r.nachher.toFixed(2).replace('.', ',')} | ${((1 - r.nachher / r.vorher) * 100).toFixed(1).replace('.', ',')} % |`
        : `  | ${f} | — | — | nicht nachoptimiert, Palette aus dem 320er Satz |`;
}).join('\n')}

  Der Hybrid-Optimierer (\`runHybridOptimization\`) eignet sich dafür **nicht**: er
  führt die vorhandene Palette nicht als Kandidat mit und verschlechterte HAM06 im
  Test von 3,57 auf 5,24.
- **Schrittweite** 4/4/4 · **Offset** 0 · Strategie \`greedy\` · Metrik \`yuv_weight\`

## Dateien

| Modus | \`.ham\` | Bytes | Nutzlast | Wörter | \`.rgb\` (RGB, 3 Byte/Pixel, oben→unten) |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`ham${z.m}.ham\` | ${z.raw.length} | ${z.payload.length} | ${z.payload.length / 4} | \`ham${z.m}_decoded.rgb\` |`).join('\n')}

## Prüfsummen

| Modus | sha256 \`.ham\` | sha256 Raster | sha256 Palette | Round-Trip | Reproduktion |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`${sha(z.raw)}\` | \`${sha(z.rgb)}\` | \`${sha(z.palette)}\` | ${z.rtDiff === 0 ? 'identisch' : z.rtDiff + ' Abw.'} | ${z.reproDiff === 0 ? 'byte-exakt' : z.reproDiff + ' Abw.'} |`).join('\n')}

## Testbench-Dateien

In \`mem/\`: \`hamXX_payload.mem\` (32-Bit-Wörter, 8 Hexziffern, Byte0 in Bits 31:24),
\`hamXX_expected.mem\` (24 Bit RRGGBB je Pixel, y=0 zuerst), \`hamXX_palette.mem\`
(256 Zeilen RRGGBB). Erzeugt mit \`make_ref_mem.mjs testbilder/ref640\`, Prüfsummen in
\`mem/INDEX.md\`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest gegen diese Dateien ist
zum Zeitpunkt dieses Index noch nicht erfolgt.
`;

fs.writeFileSync(`${DIR}/INDEX.md`, md);
console.log(`INDEX.md geschrieben (${Buffer.byteLength(md)} Byte), ${zeilen.length} Modi`);
for (const z of zeilen) console.log(`  ${z.format}: .ham ${sha(z.raw).slice(0, 16)}… | Raster ${sha(z.rgb).slice(0, 16)}… | RT ${z.rtDiff} | Repro ${z.reproDiff}`);
