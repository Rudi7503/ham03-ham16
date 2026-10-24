// Erzeugt den 640x256-Referenzsatz aus dem Quellbild — mit den Paletten aus dem
// 320x256-Satz (Vorgabe von Rudi: "verwende die paletten vom letzten mal").
//
// Pipeline identisch zum 320x256-Satz: resizeInto(..., lanczos, fill), dann
// encodePaletted(greedy, yuv_weight), step 4/4/4, offset 0.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resizeInto } from './src/core/resample.js';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const SRC_RAW = 'testbilder/ref640/_src.raw';
const OUT = 'testbilder/ref640';
const PAL_SRC = 'testbilder/ref';           // dort liegen die 320x256-Dateien mit den Paletten
const SRC_W = 1120, SRC_H = 1120;
const W = 640, H = 256, TOTAL = W * H;
const STEP = { r: 4, g: 4, b: 4 }, OFFSET = 0;
const MODES = ['03', '04', '05', '06', '08'];

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

function writeHam({ format, palette, payload }) {
    const nameBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + nameBytes.length + 4 + 768 + payload.length);
    const dv = new DataView(buf.buffer);
    buf.set([72, 65, 77, 33], 0);          // "HAM!"
    dv.setUint8(4, 4);                      // Version 4
    dv.setUint8(5, 0);                      // Little-Endian fuer die Kopffelder
    dv.setUint16(6, W, true);
    dv.setUint16(8, H, true);
    dv.setUint8(10, nameBytes.length);
    let p = 11;
    buf.set(nameBytes, p); p += nameBytes.length;
    dv.setUint8(p++, STEP.r); dv.setUint8(p++, STEP.g); dv.setUint8(p++, STEP.b); dv.setUint8(p++, OFFSET);
    buf.set(palette, p); p += 768;
    buf.set(payload, p);
    return buf;
}

// --- Quelle skalieren ---
const raw = fs.readFileSync(SRC_RAW);
const src = new Uint8ClampedArray(SRC_W * SRC_H * 4);
for (let i = 0, j = 0; i < SRC_W * SRC_H; i++, j += 3) {
    src[i * 4] = raw[j]; src[i * 4 + 1] = raw[j + 1]; src[i * 4 + 2] = raw[j + 2]; src[i * 4 + 3] = 255;
}
const scaled = resizeInto(src, SRC_W, SRC_H, W, H, 'lanczos', 'fill');
fs.writeFileSync(`${OUT}/input_640x256.rgb`, (() => {
    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = scaled.pixels[i * 4]; rgb[i * 3 + 1] = scaled.pixels[i * 4 + 1]; rgb[i * 3 + 2] = scaled.pixels[i * 4 + 2]; }
    return rgb;
})());
console.log(`Eingabe: 1120x1120 -> ${W}x${H} (inneres Bild ${scaled.innerW}x${scaled.innerH}, Offset ${scaled.offsetX},${scaled.offsetY})`);

const zeilen = [];
for (const m of MODES) {
    const pal320 = readHam(`${PAL_SRC}/ham${m}.ham`);
    const format = pal320.format;

    const { commands } = await encodePaletted(scaled.pixels, W, H, format, STEP, pal320.palette.slice(), OFFSET,
        'greedy', 'yuv_weight', null, 0, 0, 15.0);
    const payload = packPaletted(commands, format);

    const ham = writeHam({ format, palette: pal320.palette, payload });
    fs.writeFileSync(`${OUT}/ham${m}.ham`, ham);

    // Gegenprobe: aus der geschriebenen Datei zurueckdekodieren und mit dem
    // Encode-Ergebnis vergleichen
    const back = readHam(`${OUT}/ham${m}.ham`);
    const decFromFile = decodePaletted(unpackPaletted(back.payload, format, TOTAL), W, H, STEP, back.palette, OFFSET);
    const decDirect = decodePaletted(commands, W, H, STEP, pal320.palette, OFFSET);
    let rtDiff = 0;
    for (let i = 0; i < decFromFile.length; i++) if (decFromFile[i] !== decDirect[i]) rtDiff++;

    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = decDirect[i * 4]; rgb[i * 3 + 1] = decDirect[i * 4 + 1]; rgb[i * 3 + 2] = decDirect[i * 4 + 2]; }
    fs.writeFileSync(`${OUT}/ham${m}_decoded.rgb`, rgb);

    // Reproduktion: nochmal encoden, Nutzlast vergleichen
    const again = packPaletted((await encodePaletted(scaled.pixels, W, H, format, STEP, pal320.palette.slice(), OFFSET,
        'greedy', 'yuv_weight', null, 0, 0, 15.0)).commands, format);
    let reproDiff = 0;
    for (let i = 0; i < again.length; i++) if (again[i] !== payload[i]) reproDiff++;

    zeilen.push({
        mode: format, datei: `ham${m}.ham`, bytes: ham.length, sha256: sha(ham),
        nutzlast: payload.length, woerter: payload.length / 4,
        raster: { name: `ham${m}_decoded.rgb`, sha256: sha(rgb) },
        paletteSha256: sha(pal320.palette),
        rtDiff, reproDiff
    });
    console.log(`${format}: ${ham.length} B | Nutzlast ${payload.length} | Round-Trip-Abweichungen ${rtDiff} | Reproduktion ${reproDiff}`);
}

// --- Index ---
const inputRgb = fs.readFileSync(`${OUT}/input_640x256.rgb`);
let md = `# Referenzsatz 640×256

Erzeugt mit \`make_ref_640.mjs\`. Geprüft mit \`test_ref_640.mjs\`.

## Herkunft

- **Encoder:** Code ab Commit \`48890d1\` (unverändert bis HEAD).
- **Quellbild:** dieselbe 1120×1120-JPEG wie beim 320×256-Satz
  (sha256 \`3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f\`).
- **Skalierung:** \`resizeInto(..., lanczos, fill)\` → inneres Bild ${scaled.innerW}×${scaled.innerH},
  Ausschnitt bei Offset (${scaled.offsetX}, ${scaled.offsetY}) → **${W}×${H}**.
  Das Zielformat ist 2,5:1; aus einem quadratischen Bild bleibt deshalb nur der
  mittlere Ausschnitt. \`input_640x256.rgb\` ist das tatsächliche Encoder-Eingabebild
  (${inputRgb.length} Byte, sha256 \`${sha(inputRgb)}\`).
- **Paletten:** unverändert aus dem 320×256-Satz übernommen (\`../ham0X.ham\`), also
  **nicht** auf 640×256 optimiert — so vorgegeben, um die Auflösung isoliert zu
  vergleichen.
- **Schrittweite** 4/4/4 · **Offset** 0 · Strategie \`greedy\` · Metrik \`yuv_weight\`

## Dateien

| Modus | \`.ham\` | Bytes | Nutzlast | Wörter | \`.rgb\` (RGB, 3 Byte/Pixel, oben→unten) |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.mode} | \`${z.datei}\` | ${z.bytes} | ${z.nutzlast} | ${z.woerter} | \`${z.raster.name}\` |`).join('\n')}

## Prüfsummen

| Modus | sha256 \`.ham\` | sha256 Raster | sha256 Palette | Round-Trip | Reproduktion |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.mode} | \`${z.sha256}\` | \`${z.raster.sha256}\` | \`${z.paletteSha256}\` | ${z.rtDiff === 0 ? 'identisch' : z.rtDiff + ' Abw.'} | ${z.reproDiff === 0 ? 'byte-exakt' : z.reproDiff + ' Abw.'} |`).join('\n')}

## Testbench-Dateien

In \`mem/\`: \`hamXX_payload.mem\` (32-Bit-Wörter, 8 Hexziffern, Byte0 in Bits 31:24),
\`hamXX_expected.mem\` (24 Bit RRGGBB je Pixel, y=0 zuerst), \`hamXX_palette.mem\`
(256 Zeilen RRGGBB). Erzeugt mit \`make_ref_mem.mjs testbilder/ref640\`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest ist nicht erfolgt.
`;
fs.writeFileSync(`${OUT}/INDEX.md`, md);
console.log(`\nINDEX.md geschrieben (${Buffer.byteLength(md)} Byte)`);
