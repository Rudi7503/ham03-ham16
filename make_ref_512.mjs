// Erzeugt den 640x512-Referenzsatz für den Interlace-Test.
//
// Unterschied zum 640x256-Satz:
//   • Zielgröße 640x512, x/y wieder unabhängig skaliert (Faktoren 0,5714 / 0,4571)
//   • JEDE Zeile beginnt mit einem Anker (forceRowAnchors) — damit kann die
//     Hardware jede Zeile einzeln anspringen, ohne den Farbzustand der
//     Vorderzeile zu kennen. Voraussetzung für Zeilensprung (Interlace) ohne Puffer.
//   • Paletten aus dem 640x256-Satz übernommen (dort bereits nachoptimiert)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resizeImage } from './src/core/resample.js';
import { encodePaletted, packPaletted, unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const SRC_RAW = 'testbilder/ref640/_src.raw.tmp';
const OUT = 'testbilder/ref512';
const PAL_SRC = 'testbilder/ref640';
const SRC_W = 1120, SRC_H = 1120;
const W = 640, H = 512, TOTAL = W * H;
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
    return { width: w, height: h, format, step, offset, palette, payload: raw.slice(p) };
}

function writeHam(format, palette, payload) {
    const nameBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + nameBytes.length + 4 + 768 + payload.length);
    const dv = new DataView(buf.buffer);
    buf.set([72, 65, 77, 33], 0);
    dv.setUint8(4, 4); dv.setUint8(5, 0);
    dv.setUint16(6, W, true); dv.setUint16(8, H, true);
    dv.setUint8(10, nameBytes.length);
    let p = 11;
    buf.set(nameBytes, p); p += nameBytes.length;
    dv.setUint8(p++, STEP.r); dv.setUint8(p++, STEP.g); dv.setUint8(p++, STEP.b); dv.setUint8(p++, OFFSET);
    buf.set(palette, p); p += 768;
    buf.set(payload, p);
    return buf;
}

fs.mkdirSync(OUT, { recursive: true });

// --- Quelle skalieren (x/y getrennt) ---
const raw = fs.readFileSync(SRC_RAW);
const src = new Uint8ClampedArray(SRC_W * SRC_H * 4);
for (let i = 0, j = 0; i < SRC_W * SRC_H; i++, j += 3) {
    src[i * 4] = raw[j]; src[i * 4 + 1] = raw[j + 1]; src[i * 4 + 2] = raw[j + 2]; src[i * 4 + 3] = 255;
}
const pixels = resizeImage(src, SRC_W, SRC_H, W, H, 'lanczos');
const inputRgb = new Uint8Array(TOTAL * 3);
for (let i = 0; i < TOTAL; i++) { inputRgb[i * 3] = pixels[i * 4]; inputRgb[i * 3 + 1] = pixels[i * 4 + 1]; inputRgb[i * 3 + 2] = pixels[i * 4 + 2]; }
fs.writeFileSync(`${OUT}/input_640x512.rgb`, inputRgb);
console.log(`${SRC_W}x${SRC_H} -> ${W}x${H}, x/y getrennt (${(W / SRC_W).toFixed(4)} / ${(H / SRC_H).toFixed(4)}), Zeilenanker aktiv`);

const zeilen = [];
for (const m of MODES) {
    const quelle = readHam(`${PAL_SRC}/ham${m}.ham`);
    const format = quelle.format;

    const { commands } = await encodePaletted(pixels, W, H, format, STEP, quelle.palette.slice(), OFFSET,
        'greedy', 'yuv_weight', null, 0, 0, 15.0, 6, true);
    const payload = packPaletted(commands, format);

    let ohneAnker = 0;
    for (let y = 0; y < H; y++) if (!commands[y * W].isAnchor) ohneAnker++;
    if (ohneAnker !== 0) throw new Error(`${format}: ${ohneAnker} Zeilen ohne Anker`);

    const ham = writeHam(format, quelle.palette, payload);
    fs.writeFileSync(`${OUT}/ham${m}.ham`, ham);

    const back = readHam(`${OUT}/ham${m}.ham`);
    const dec = decodePaletted(unpackPaletted(back.payload, format, TOTAL), W, H, STEP, back.palette, OFFSET);
    const rgb = new Uint8Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) { rgb[i * 3] = dec[i * 4]; rgb[i * 3 + 1] = dec[i * 4 + 1]; rgb[i * 3 + 2] = dec[i * 4 + 2]; }
    fs.writeFileSync(`${OUT}/ham${m}_decoded.rgb`, rgb);

    const again = packPaletted((await encodePaletted(pixels, W, H, format, STEP, quelle.palette.slice(), OFFSET,
        'greedy', 'yuv_weight', null, 0, 0, 15.0, 6, true)).commands, format);
    let repro = 0;
    for (let i = 0; i < again.length; i++) if (again[i] !== payload[i]) repro++;

    zeilen.push({ m, format, ham, palette: quelle.palette, rgb, payload, repro, ohneAnker });
    console.log(`${format}: ${ham.length} B | Nutzlast ${payload.length} | Zeilen mit Anker ${H - ohneAnker}/${H} | Reproduktion ${repro}`);
}

const idx = `# Referenzsatz 640×512 (Interlace) — mit Zeilenankern

Erzeugt mit \`make_ref_512.mjs\`. Geprüft mit \`test_ref512.mjs\` und
\`test_ref_mem.mjs testbilder/ref512\`.

## Herkunft

- **Encoder:** Code ab \`48890d1\`, erweitert um \`forceRowAnchors\` (am Zeilenanfang
  ist nur ein Anker erlaubt).
- **Quellbild:** dieselbe 1120×1120-JPEG wie bei den früheren Sätzen.
- **Skalierung:** \`resizeImage\` (Lanczos), x/y **unabhängig**: x = 0,5714, y = 0,4571.
  Kein Beschnitt, keine Ränder, anisotrop. Eingabe: \`input_640x512.rgb\`
  (${inputRgb.length} Byte, sha256 \`${sha(inputRgb)}\`).
- **Zeilenanker:** jede der ${H} Zeilen beginnt mit einem Anker. Damit ist jede Zeile
  unabhängig dekodierbar — Voraussetzung für Zeilensprung im Betrieb (Interlace)
  ohne Bildpuffer.
- **Paletten:** aus dem 640×256-Satz übernommen (\`../ref640/ham0X.ham\`), dort bereits
  nachoptimiert; für 640×512 nicht erneut optimiert.
- **Schrittweite** 4/4/4 · **Offset** 0 · Strategie \`greedy\` · Metrik \`yuv_weight\`

## Kosten der Zeilenanker (gemessen, 640×512)

| Modus | MSE ohne Ankerzwang | mit Zeilenankern | Delta |
|---|---|---|---|
| HAM03 | 35,82 | 43,94 | **+22,7 %** |
| HAM04 | 15,36 | 15,46 | +0,6 % |
| HAM05 | 5,56 | 5,58 | +0,4 % |
| HAM06 | 3,54 | 3,54 | +0,08 % |
| HAM08 | 1,41 | 1,41 | +0,04 % |

Die Dateigröße ändert sich nicht (feste Bitrate). HAM03 verliert deutlich, weil nur
vier Palettenplätze zur Verfügung stehen und die Zeile mit ±8 pro Schritt lange
braucht, um vom erzwungenen Anker zur eigentlichen Farbe zurückzukommen.

## Dateien

| Modus | \`.ham\` | Bytes | Nutzlast | Wörter | Zeilen mit Anker |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`ham${z.m}.ham\` | ${z.ham.length} | ${z.payload.length} | ${z.payload.length / 4} | ${H - z.ohneAnker}/${H} |`).join('\n')}

## Prüfsummen

| Modus | sha256 \`.ham\` | sha256 Raster | sha256 Palette | Reproduktion |
|---|---|---|---|---|
${zeilen.map(z => `| ${z.format} | \`${sha(z.ham)}\` | \`${sha(z.rgb)}\` | \`${sha(z.palette)}\` | ${z.repro === 0 ? 'byte-exakt' : z.repro + ' Abw.'} |`).join('\n')}

## Testbench-Dateien

In \`mem/\`: Nutzlast als 32-Bit-Wörter (8 Hexziffern, Byte0 in Bits 31:24),
Sollpixel als 24 Bit RRGGBB je Pixel (zeilenweise von oben links),
Palette als 256 Zeilen RRGGBB. Erzeugt mit \`make_ref_mem.mjs testbilder/ref512\`.

## Stand

Reine Software-Referenz. FPGA-Build und Hardwaretest stehen aus.
`;

fs.writeFileSync(`${OUT}/INDEX.md`, idx);
console.log(`\nINDEX.md geschrieben (${Buffer.byteLength(idx)} Byte)`);
