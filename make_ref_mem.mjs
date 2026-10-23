// Erzeugt Testbench-Dateien aus den fünf Referenz-.ham-Dateien.
//
// Format (Vorgabe von Tobys KI):
//   <mode>_payload.mem   32-Bit-Wort je Zeile, 8 Hexziffern, OHNE @Adresse.
//                        Das erste Byte der Datei steht in Bits 31:24
//                        (also Big-Endian, wie im Container).
//   <mode>_expected.mem  24-Bit RRGGBB je Zeile, 6 Hexziffern, ein Pixel je Zeile.
//                        Reihenfolge: y = 0 zuerst, innerhalb der Zeile x = 0 zuerst.
//   <mode>_palette.mem   256 Zeilen RRGGBB (Palettenplatz 0 zuerst).
//
// Zusaetzlich INDEX.md mit Kopfdaten, Zeilenzahlen und Pruefsummen.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const REF_DIR = 'testbilder/ref';
const OUT_DIR = `${REF_DIR}/mem`;
const MODES = ['03', '04', '05', '06', '08'];

fs.mkdirSync(OUT_DIR, { recursive: true });

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');
const hex6 = (v) => v.toString(16).toUpperCase().padStart(6, '0');

function parseHam(path) {
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
    return { raw, width: w, height: h, format, step, offset, palette, payload: raw.slice(p), headerBytes: p };
}

const zeilen = [];

for (const m of MODES) {
    const h = parseHam(`${REF_DIR}/ham${m}.ham`);
    const total = h.width * h.height;

    // --- Nutzlast als 32-Bit-Woerter ---
    const words = [];
    for (let i = 0; i < h.payload.length; i += 4) {
        const w = ((h.payload[i] << 24) | (h.payload[i + 1] << 16) | (h.payload[i + 2] << 8) | h.payload[i + 3]) >>> 0;
        words.push(hex8(w));
    }
    const payloadText = words.join('\n') + '\n';
    const payloadName = `ham${m}_payload.mem`;
    fs.writeFileSync(`${OUT_DIR}/${payloadName}`, payloadText);

    // --- Sollpixel aus dem Referenzdecoder ---
    const rgba = decodePaletted(unpackPaletted(h.payload, h.format, total), h.width, h.height, h.step, h.palette, h.offset);
    const pix = [];
    for (let i = 0; i < total; i++) {
        pix.push(hex6((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]));
    }
    const expectedText = pix.join('\n') + '\n';
    const expectedName = `ham${m}_expected.mem`;
    fs.writeFileSync(`${OUT_DIR}/${expectedName}`, expectedText);

    // --- Palette ---
    const pal = [];
    for (let i = 0; i < 256; i++) {
        pal.push(hex6((h.palette[i * 3] << 16) | (h.palette[i * 3 + 1] << 8) | h.palette[i * 3 + 2]));
    }
    const paletteText = pal.join('\n') + '\n';
    const paletteName = `ham${m}_palette.mem`;
    fs.writeFileSync(`${OUT_DIR}/${paletteName}`, paletteText);

    zeilen.push({
        mode: h.format, datei: `ham${m}.ham`, dateiSha256: sha(h.raw), dateiBytes: h.raw.length,
        breite: h.width, hoehe: h.height, step: h.step, offset: h.offset,
        nutzlastBytes: h.payload.length, woerter: words.length,
        pixel: total,
        payload: { name: payloadName, bytes: Buffer.byteLength(payloadText), sha256: sha(payloadText) },
        expected: { name: expectedName, bytes: Buffer.byteLength(expectedText), sha256: sha(expectedText) },
        palette: { name: paletteName, bytes: Buffer.byteLength(paletteText), sha256: sha(paletteText) },
        paletteSha256: sha(h.palette),
        ersteWoerter: words.slice(0, 4),
        letzteWoerter: words.slice(-2),
        erstePixel: pix.slice(0, 4),
        letztesPixel: pix[pix.length - 1]
    });

    console.log(`${h.format}: ${payloadName} (${words.length} Woerter) | ${expectedName} (${total} Pixel) | ${paletteName} (256)`);
}

// --- Index schreiben ---
let md = `# Testbench-Dateien (%h je Zeile, ohne @Adresse)

Erzeugt mit \`make_ref_mem.mjs\` aus den Referenzdateien in \`../\`. Geprüft mit
\`test_ref_mem.mjs\`.

## Formate

| Datei | Inhalt |
|---|---|
| \`hamXX_payload.mem\` | **32-Bit-Wort je Zeile**, 8 Hexziffern. Das **erste Byte der Datei steht in Bits 31:24** (Big-Endian wie im Container). Die Nutzlast ist bereits auf ein Vielfaches von 4 Byte aufgefüllt, die Nullwörter am Ende gehören zum Strom. |
| \`hamXX_expected.mem\` | **24-Bit RRGGBB je Zeile**, 6 Hexziffern, ein Pixel je Zeile. Reihenfolge: \`y = 0\` zuerst, innerhalb der Zeile \`x = 0\` zuerst (zeilenweise oben→unten, links→rechts). |
| \`hamXX_palette.mem\` | 256 Zeilen RRGGBB, Palettenplatz 0 zuerst. |

Hexziffern sind groß geschrieben; \`$readmemh\` akzeptiert beide Schreibweisen.
Für \`$readmemh\` ohne Adressangabe: \`$readmemh("ham06_payload.mem", mem);\` füllt
\`mem[0]\`, \`mem[1]\`, … in Dateireihenfolge.

## Zuordnung

| Modus | Nutzlast | Wörter | Sollpixel | Pixel | Breite×Höhe | step | offset |
|---|---|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.mode} | \`${z.payload.name}\` | ${z.woerter} | \`${z.expected.name}\` | ${z.pixel} | ${z.breite}×${z.hoehe} | ${z.step.r}/${z.step.g}/${z.step.b} | ${z.offset} |`).join('\n')}

## Prüfsummen

| Modus | Quelle \`.ham\` | sha256 \`.ham\` | sha256 Nutzlast \`.mem\` | sha256 Sollpixel \`.mem\` | sha256 Palette \`.mem\` |
|---|---|---|---|---|---|
${zeilen.map(z => `| ${z.mode} | \`${z.datei}\` (${z.dateiBytes} B) | \`${z.dateiSha256}\` | \`${z.payload.sha256}\` | \`${z.expected.sha256}\` | \`${z.palette.sha256}\` |`).join('\n')}

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
\`0x067FC244\` statt \`0x44C27F06\`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
${zeilen.map(z => `| ${z.mode} | ${z.ersteWoerter.map(w => '`' + w + '`').join(' ')} | ${z.letzteWoerter.map(w => '`' + w + '`').join(' ')} | ${z.erstePixel.map(p => '`' + p + '`').join(' ')} | \`${z.letztesPixel}\` |`).join('\n')}

## Bezug zum Container

- \`.ham\`-Kopf: 20 Byte (11 fest + 5 Zeichen Formatname + 3 Byte Schrittweite +
  1 Byte Offset), danach 768 Byte Palette, danach die Nutzlast.
- Die \`payload.mem\` ist **exakt** der Nutzlastbereich ab Byte 788, nur als
  32-Bit-Wörter gruppiert.
- Palettenbytes im Container sind RGB-Tripel; \`palette.mem\` gibt dieselben 256
  Einträge als RRGGBB aus. Das Auslesen der Palette aus dem Container ist damit
  gegenprüfbar.
- Formatregeln (Modusbit 0 = Anker, Kanalstufen, Turbo ×4, Sättigung, kein
  Zeilenreset) stehen in \`../README.md\` und \`../../HAM-DATEIFORMAT.md\`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest gegen diese Dateien ist
noch nicht erfolgt; die Dateien sind die Grundlage für den nächsten HDL-Abgleich.
`;
fs.writeFileSync(`${OUT_DIR}/INDEX.md`, md);
console.log(`\nINDEX.md geschrieben (${Buffer.byteLength(md)} Byte)`);
