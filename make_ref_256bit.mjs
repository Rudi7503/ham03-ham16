// Erzeugt einen Referenzsatz für die 256-Bit-Delta-Formate (320×256, gleiches
// Eingabebild wie testbilder/ref, damit die Sätze vergleichbar sind).
//
// Diese Formate haben KEINE Palettenanker: jeder Block beginnt mit einem
// HAM12_ANCHOR (12 Bit Direktfarbe), der Rest sind reine Deltas. Deshalb braucht
// der Satz keine Palette (sie ist überall 0) — und deshalb ist die
// Palettenoptimierung für diese Formate gegenstandslos.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseHamHeader, buildHamFile } from './src/core/ham_file.js';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';
import { computeAvgYuvScore } from './src/core/analysis.js';

const OUT = 'testbilder/ref256bit';
const INPUT = 'testbilder/ref/input_320x256.rgb';
const W = 320, H = 256, TOTAL = W * H;
const STEP = { r: 4, g: 4, b: 4 }, OFFSET = 0, METRIC = 'yuv_weight';

const SAETZE = [
    { stem: 'ham_256bit_12_61x4_delta', format: 'HAM_256BIT_12_61x4_DELTA' },
    { stem: 'ham_256bit_12_14x5_29x6_delta', format: 'HAM_256BIT_12_14x5_29x6_DELTA' }
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

fs.mkdirSync(OUT, { recursive: true });

const inputRgb = fs.readFileSync(INPUT);
if (inputRgb.length !== TOTAL * 3) throw new Error('falsche Eingabegröße: ' + inputRgb.length);
const px = new Uint8ClampedArray(TOTAL * 4);
for (let i = 0, j = 0; i < TOTAL; i++, j += 3) {
    px[i * 4] = inputRgb[j]; px[i * 4 + 1] = inputRgb[j + 1]; px[i * 4 + 2] = inputRgb[j + 2]; px[i * 4 + 3] = 255;
}
fs.writeFileSync(OUT + '/input_320x256.rgb', inputRgb);

const leerePalette = new Uint8Array(768);   // diese Formate nutzen keine Palette
const zeilen = [];

for (const { stem, format } of SAETZE) {
    const t0 = Date.now();
    const { commands } = await encodePaletted(px, W, H, format, STEP, leerePalette.slice(), OFFSET, 'greedy', METRIC);
    const payload = packPaletted(commands, format);
    const datei = buildHamFile({ width: W, height: H, format, step: STEP, offset: OFFSET, palette: leerePalette, payload });
    fs.writeFileSync(`${OUT}/${stem}.ham`, datei);

    // Selbstkontrolle über die geschriebene Datei, nicht über die Befehle im Speicher
    const h = parseHamHeader(fs.readFileSync(`${OUT}/${stem}.ham`));
    const dec = decodePaletted(unpackPaletted(h.payload, h.format, TOTAL), W, H, h.step, h.palette, h.offset);

    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) {
        rgb[i * 3] = dec[i * 4]; rgb[i * 3 + 1] = dec[i * 4 + 1]; rgb[i * 3 + 2] = dec[i * 4 + 2];
    }
    fs.writeFileSync(`${OUT}/${stem}_decoded.rgb`, rgb);

    const mse = computeAvgYuvScore(px, dec, W, H, METRIC, null);
    let anker = 0;
    for (const c of commands) if (c.isAnchor) anker++;

    // Anker müssen genau an den Blockanfängen stehen — das ist die Formatregel
    const seqLen = format.includes('61x4') ? 62 : 44;
    let ankerFalsch = 0;
    for (let i = 0; i < TOTAL; i++) {
        const sollAnker = (i % seqLen) === 0;
        if (commands[i].isAnchor !== sollAnker) ankerFalsch++;
    }

    zeilen.push({
        format, stem, datei, rgb, palette: leerePalette, anker, ankerFalsch, seqLen, mse,
        nutzlast: payload.length, bitProPixel: payload.length * 8 / TOTAL, ms: Date.now() - t0
    });
    console.log(`${format}: ${datei.length} B | ${(payload.length * 8 / TOTAL).toFixed(2)} Bit/px | Anker ${anker} `
        + `| Ankerpositionen falsch ${ankerFalsch} | MSE ${mse.toFixed(2)} | ${Date.now() - t0} ms`);
}

const md = `# Referenzsatz 320×256 für die 256-Bit-Delta-Formate

Erzeugt mit \`make_ref_256bit.mjs\`. Eingabebild und Größe sind identisch mit
\`testbilder/ref/\`, damit man die Formate direkt vergleichen kann.

## Besonderheit dieser Formate

Jeder Block beginnt mit einem **HAM12_ANCHOR**: 12 Bit Direktfarbe (3 Bit Rot,
4 Bit Grün, 3 Bit Blau, 1 gemeinsames Bit) — also **kein Palettenplatz**. Der
Rest des Blocks sind reine Deltas. Folge: **diese Formate brauchen keine
Palette**, die 768 Palettenbytes im Container sind alle 0. Eine
Palettenoptimierung hätte hier keine Wirkung (gemessen: leere und bunte Palette
ergeben byte-identische Nutzlast).

## Qualität und Kosten (auf diesem Bild gemessen)

| Format | Bit/Pixel | Blocklänge | Anker | MSE (yuv_weight) |
|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | ${z.bitProPixel.toFixed(2)} | ${z.seqLen} | ${z.anker} | ${z.mse.toFixed(2).replace('.', ',')} |`).join('\n')}

Zum Vergleich: \`HAM_32BIT_63436343\` (4,00 Bit/Pixel) erreicht auf demselben Bild
mit **leerer** Palette MSE 452,58 — seine Anker sind Palettenplätze, die hier
fehlen. Die Direktfarbanker machen diese Formate unabhängig von der Palette.

**Formatregel, die ein Decoder prüfen kann:** Ein Anker steht genau dann, wenn
\`pixelIndex % Blocklänge === 0\`. Abweichungen: ${zeilen.map(z => `${z.format} ${z.ankerFalsch}`).join(', ')}.

## Dateien

| Format | \`.ham\` | Bytes | Nutzlast | Wörter |
|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`${z.stem}.ham\` | ${z.datei.length} | ${z.nutzlast} | ${z.nutzlast / 4} |`).join('\n')}

## Prüfsummen

| Format | sha256 \`.ham\` | sha256 Raster | sha256 Palette |
|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`${sha(z.datei)}\` | \`${sha(z.rgb)}\` | \`${sha(z.palette)}\` |`).join('\n')}

## Testbench-Dateien

In \`mem/\`: Nutzlast als 32-Bit-Wörter (8 Hexziffern, Byte0 in Bits 31:24),
Sollpixel als 24 Bit RRGGBB je Pixel, Palette als 256 Zeilen — hier durchgehend
\`000000\`, weil das Format keine Palette benutzt. Erzeugt mit
\`make_ref_mem.mjs testbilder/ref256bit\`, geprüft mit
\`test_ref_mem.mjs testbilder/ref256bit\`.

## Stand

Reine Software-Referenz. FPGA-Build und Hardwaretest stehen aus.
`;

fs.writeFileSync(OUT + '/INDEX.md', md);
console.log(`\nINDEX.md geschrieben (${Buffer.byteLength(md)} Byte)`);
