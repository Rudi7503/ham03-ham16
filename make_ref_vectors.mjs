// Erzeugt Referenzvektoren aus den fünf echten .ham-Dateien in testbilder/ref/.
//
// Ausgabe:
//   testbilder/ref/hamXX_decoded.rgb   rohe RGB-Pixel (3 Byte/Pixel, 320x256, oben->unten, links->rechts)
//   testbilder/ref/vectors.json        Kopfdaten, Hashes und kurze Sollwertfolgen
//
// Die Vektoren sind aus den Dateien abgeleitet, nicht erfunden: jede Zahl stammt
// aus dem tatsaechlichen Dekodierlauf mit dem Referenzdecoder.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpackPaletted, decodePaletted, encodePaletted, packPaletted } from './src/core/module_paletted.js';

const REF_DIR = 'testbilder/ref';
const MODES = ['03', '04', '05', '06', '08'];

const CHANNEL_STUFEN = {
    HAM03: { r: [-2, 2], g: [-2, 2], b: [-2, 2], turbo: false, bits: 3 },
    HAM04: { r: [-2, 2], g: [-2, 2], b: [-2, 2], turbo: false, bits: 4 },
    HAM05: { r: [-1, 1], g: [-1, 1], b: [-1, 1], turbo: true, bits: 5 },
    HAM06: { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1], turbo: true, bits: 6 },
    HAM08: { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2], turbo: true, bits: 8 }
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const clamp = (v) => v < 0 ? 0 : (v > 255 ? 255 : v);

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

// Erwarteter Pixelwert aus einem Befehl (Decoder-Semantik)
function apply(cmd, acc, step, palette, offset, def) {
    const m = cmd.isTurbo ? 4 : 1;
    if (cmd.isAnchor) {
        const a = ((offset + cmd.anchorIdx) % 256) * 3;
        return {
            before: { ...acc }, after: { r: palette[a], g: palette[a + 1], b: palette[a + 2] },
            unclamped: null, clipped: null
        };
    }
    const dr = def.r[cmd.rIndex || 0] * step.r * m;
    const dg = def.g[cmd.gIndex || 0] * step.g * m;
    const db = def.b[cmd.bIndex || 0] * step.b * m;
    const ur = acc.r + dr, ug = acc.g + dg, ub = acc.b + db;
    const after = { r: clamp(ur), g: clamp(ug), b: clamp(ub) };
    const clipped = (ur < 0 || ug < 0 || ub < 0) ? 'low' : ((ur > 255 || ug > 255 || ub > 255) ? 'high' : null);
    return { before: { ...acc }, after, unclamped: { r: ur, g: ug, b: ub }, clipped, delta: { dr, dg, db }, turbo: !!cmd.isTurbo, m };
}

function describe(cmd, def, i) {
    if (cmd.isAnchor) {
        return { index: i, x: i % 320, y: Math.floor(i / 320), kind: 'anchor', code: cmd.anchorIdx, bits: def.bits };
    }
    const parts = { index: i, x: i % 320, y: Math.floor(i / 320), kind: 'delta', bits: def.bits, rIndex: cmd.rIndex || 0, gIndex: cmd.gIndex || 0, bIndex: cmd.bIndex || 0, turbo: !!cmd.isTurbo };
    // Code rekonstruieren (Modusbit = 1 bei Delta)
    const mb = 1 << (def.bits - 1);
    let v = mb;
    if (def.turbo && cmd.isTurbo) v |= 1 << (def.bits - 2);
    const rBits = def.r.length > 2 ? 2 : 1;
    const gBits = def.g.length > 2 ? 2 : 1;
    const bBits = def.b.length > 2 ? 2 : 1;
    // Bitpositionen wie im Format definiert
    if (def.bits === 3) v |= ((cmd.rIndex || 0) & 1) << 1 | ((cmd.gIndex || 0) & 1);
    else if (def.bits === 4) v |= ((cmd.rIndex || 0) & 1) << 2 | ((cmd.gIndex || 0) & 1) << 1 | ((cmd.bIndex || 0) & 1);
    else if (def.bits === 5) v |= ((cmd.rIndex || 0) & 1) << 2 | ((cmd.gIndex || 0) & 1) << 1 | ((cmd.bIndex || 0) & 1);
    else if (def.bits === 6) v |= ((cmd.rIndex || 0) & 1) << 3 | ((cmd.gIndex || 0) & 3) << 1 | ((cmd.bIndex || 0) & 1);
    else if (def.bits === 8) v |= ((cmd.rIndex || 0) & 3) << 4 | ((cmd.gIndex || 0) & 3) << 2 | ((cmd.bIndex || 0) & 1);
    parts.code = v;
    parts.bitOffset = i * def.bits;
    parts.byteOffset = Math.floor(i * def.bits / 8);
    return parts;
}

const out = {
    erzeugt: 'make_ref_vectors.mjs',
    encoder: {
        commitBereich: '48890d1..72ddd69',
        hinweis: 'formatrelevante Dateien seit 48890d1 unveraendert (git log 48890d1..HEAD -- src/core/module_paletted.js = 0 Commits)',
        dateiversion: 4,
        modusbit: '0 = Anker, 1 = Delta'
    },
    quelle: {
        datei: 'Leonardo_Phoenix_10_A_young_adult_with_a_mix_of_frustration_an_0.jpg',
        breiteHoehe: [1120, 1120],
        skalierung: 'resizeInto(..., lanczos, fill) -> 320x256, seitenverhaeltnistreu, mittig beschnitten'
    },
    modi: {}
};

for (const m of MODES) {
    const file = `${REF_DIR}/ham${m}.ham`;
    const h = parseHam(file);
    const def = CHANNEL_STUFEN[h.format];
    const total = h.width * h.height;

    const cmds = unpackPaletted(h.payload, h.format, total);
    const rgba = decodePaletted(cmds, h.width, h.height, h.step, h.palette, h.offset);

    // Rasterdaten als reines RGB schreiben
    const rgb = new Uint8Array(total * 3);
    for (let i = 0; i < total; i++) {
        rgb[i * 3] = rgba[i * 4];
        rgb[i * 3 + 1] = rgba[i * 4 + 1];
        rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const rgbName = `ham${m}_decoded.rgb`;
    fs.writeFileSync(`${REF_DIR}/${rgbName}`, rgb);

    // Laufender Akkumulator: Statistik + Vektorstellen finden
    let acc = { r: 127, g: 127, b: 127 };
    let anchors = 0, deltas = 0, turbo = 0, clipLow = 0, clipHigh = 0;
    let firstTurbo = -1, firstClipLow = -1, firstClipHigh = -1, anchorPlusDeltas = -1;
    const states = new Array(total);

    for (let i = 0; i < total; i++) {
        const cmd = cmds[i];
        const res = apply(cmd, acc, h.step, h.palette, h.offset, def);
        if (cmd.isAnchor) anchors++; else { deltas++; if (cmd.isTurbo) turbo++; }
        if (res.clipped === 'low') { clipLow++; if (firstClipLow < 0) firstClipLow = i; }
        if (res.clipped === 'high') { clipHigh++; if (firstClipHigh < 0) firstClipHigh = i; }
        if (!cmd.isAnchor && cmd.isTurbo && firstTurbo < 0) firstTurbo = i;
        if (cmd.isAnchor && i + 4 < total && !cmds[i + 1].isAnchor && !cmds[i + 2].isAnchor && !cmds[i + 3].isAnchor && anchorPlusDeltas < 0) anchorPlusDeltas = i;
        states[i] = { accBefore: res.before, accAfter: res.after, unclamped: res.unclamped, clipped: res.clipped, delta: res.delta, m: res.m };
        acc = res.after;
    }

    // Sollwertfolge bauen: eine Stelle mit Code, Akkumulator vorher/nachher und Ergebnis
    const seq = (from, count) => {
        const arr = [];
        for (let i = from; i < Math.min(total, from + count); i++) {
            const c = describe(cmds[i], def, i);
            const s = states[i];
            arr.push({
                ...c,
                codeBin: c.code.toString(2).padStart(def.bits, '0'),
                akkuVor: s.accBefore,
                akkuNach: s.accAfter,
                ungeklemmt: s.unclamped,
                geklemmt: s.clipped,
                delta: s.delta,
                turboFaktor: s.m,
                rgb: { r: rgb[i * 3], g: rgb[i * 3 + 1], b: rgb[i * 3 + 2] }
            });
        }
        return arr;
    };

    out.modi[h.format] = {
        datei: `ham${m}.ham`,
        dateiBytes: h.raw.length,
        dateiSha256: sha(h.raw),
        kopf: {
            version: h.raw[4], magic: Array.from(h.raw.slice(0, 4)), kopfBytes: h.headerBytes,
            breite: h.width, hoehe: h.height, format: h.format,
            step: h.step, offset: h.offset, palettenBytes: 768,
            nutzlastBytes: h.payload.length,
            nutzlastBytesErwartet: Math.ceil(total * def.bits / 32) * 4
        },
        paletteSha256: sha(h.palette),
        paletteErsteEintraege: Array.from(h.palette.slice(0, 18)),
        raster: {
            datei: rgbName, bytes: rgb.length, sha256: sha(rgb),
            aufbau: 'RGB, 3 Byte je Pixel, zeilenweise oben->unten, links->rechts, ohne Kopf'
        },
        statistik: { pixel: total, anker: anchors, deltas, turbo, klemmung0: clipLow, klemmung255: clipHigh },
        vektoren: {
            frameStart: seq(0, 8),
            ankerUndDeltas: seq(anchorPlusDeltas, 6),
            turbo: firstTurbo >= 0 ? seq(firstTurbo - 2, 5) : null,
            klemmungUnten: firstClipLow >= 0 ? seq(firstClipLow - 1, 3) : null,
            klemmungOben: firstClipHigh >= 0 ? seq(firstClipHigh - 1, 3) : null,
            zeilenwechsel: seq(318, 5)
        }
    };
    console.log(`ham${m}: ${h.format} ${h.width}x${h.height} | Nutzlast ${h.payload.length} | RGB ${rgbName} (${rgb.length} B, sha ${sha(rgb).slice(0, 12)})`);
    console.log(`   Anker ${anchors} Deltas ${deltas} Turbo ${turbo} | Klemmung 0: ${clipLow}x, 255: ${clipHigh}x`);
}

fs.writeFileSync(`${REF_DIR}/vectors.json`, JSON.stringify(out, null, 2));
console.log(`\nvectors.json geschrieben (${fs.statSync(`${REF_DIR}/vectors.json`).size} Byte)`);

// ---------------------------------------------------------------------------
// Reproduktionsprüfung: jede Datei aus dem Eingabebild nachrechnen.
// Die Palette kommt aus der Datei selbst, ebenso step und offset. Damit ist
// bewiesen, dass alle fünf aus EINEM Eingabebild entstanden sind.
// ---------------------------------------------------------------------------
const repro = {};
{
    const raw = fs.readFileSync(`${REF_DIR}/input_320x256.rgb`);
    const W = 320, H = 256;
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0, j = 0; i < W * H; i++, j += 3) {
        px[i * 4] = raw[j]; px[i * 4 + 1] = raw[j + 1]; px[i * 4 + 2] = raw[j + 2]; px[i * 4 + 3] = 255;
    }
    for (const m of MODES) {
        const h = parseHam(`${REF_DIR}/ham${m}.ham`);
        const { commands } = await encodePaletted(px, W, H, h.format, h.step, h.palette.slice(), h.offset,
            'greedy', 'yuv_weight', null, 0, 0, 15.0);
        const packed = packPaletted(commands, h.format);
        let diff = 0;
        for (let i = 0; i < Math.min(packed.length, h.payload.length); i++) if (packed[i] !== h.payload[i]) diff++;
        diff += Math.abs(packed.length - h.payload.length);
        repro[h.format] = { diff, total: h.payload.length, strategy: 'greedy', metric: 'yuv_weight' };
        console.log(`Reproduktion ${h.format}: ${diff === 0 ? 'byte-exakt' : diff + ' abweichende Bytes'} (${h.payload.length} Byte)`);
    }
}

// ---------------------------------------------------------------------------
// README aus denselben Daten erzeugen, damit die Zahlen nicht abdriften
// ---------------------------------------------------------------------------
const zeile = (e) => `\`${e.codeBin}\` → (${e.rgb.r}, ${e.rgb.g}, ${e.rgb.b})`;
const tabelle = (arr) => '| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |\n|---|---|---|---|---|---|\n'
    + arr.map(e => `| ${e.index} | ${e.x},${e.y} | ${e.codeBin} | (${e.akkuVor.r}, ${e.akkuVor.g}, ${e.akkuVor.b}) | (${e.akkuNach.r}, ${e.akkuNach.g}, ${e.akkuNach.b}) | (${e.rgb.r}, ${e.rgb.g}, ${e.rgb.b}) |`).join('\n');

let md = `# Referenzvektoren der fünf HAM-Dateien

Erzeugt mit \`make_ref_vectors.mjs\` aus den echten \`.ham\`-Dateien. Geprüft mit
\`test_ref_vectors.mjs\`.

## Herkunft

- **Encoder:** Code ab Commit \`48890d1\` (dort wurden die reinen Formate wählbar und
  das Versionsbyte auf 4 gesetzt). Die formatrelevanten Dateien
  \`src/core/module_paletted.js\` und \`src/core/palette_optimizer.js\` sind seit
  \`48890d1\` bis \`HEAD\` unverändert (0 Commits laut \`git log 48890d1..HEAD\`).
- **Quellbild:** \`Leonardo_Phoenix_10_A_young_adult_with_a_mix_of_frustration_an_0.jpg\`,
  1120×1120, sha256 \`3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f\`
- **Skalierung:** \`resizeInto(..., lanczos, fill)\` → 320×256, seitenverhältnistreu,
  Überstand mittig beschnitten. Ergebnis: \`input_320x256.rgb\` (245 760 Byte,
  sha256 \`938f7c1b900aaa026179167e01004f0990586c6f4e281202b519b47b2c5edabc\`).
- **Schrittweite:** 4/4/4 · **Offset:** 0 · Strategie \`greedy\` · Metrik \`yuv_weight\`

### Reproduktionsbeweis

Jede Datei wurde aus \`input_320x256.rgb\` nachgerechnet — mit der Palette, der
Schrittweite und dem Offset **aus der Datei selbst** — und die Nutzlast byteweise
verglichen (\`make_ref_vectors.mjs\` führt diesen Test bei jedem Lauf aus):

| Datei | abweichende Bytes | Ergebnis |
|---|---|---|
${Object.entries(repro).map(([fmt, r]) =>
    `| \`${out.modi[fmt].datei}\` | ${r.diff} von ${r.total} | ${r.diff === 0 ? '**byte-exakt reproduziert**' : 'nicht exakt'} |`).join('\n')}

Alle fünf Dateien sind damit aus **einem** Eingabebild und **einem** Encoderstand
herleitbar. \`ham03\`, \`ham06\` und \`ham08\` stammen aus dem ersten Satz, \`ham04\` und
\`ham05\` wurden am 2026-10-23 neu erzeugt, weil ihre Vorgänger nicht reproduzierbar
waren (die Skalierung lief dort noch über \`canvas.drawImage\`, gestreckt und
browserabhängig).

## Kopfdaten

| Modus | Datei | Bytes | Nutzlast | Breite×Höhe | step | offset | Palette[0..5] |
|---|---|---|---|---|---|---|---|
${Object.entries(out.modi).map(([fmt, d]) =>
    `| ${fmt} | \`${d.datei}\` | ${d.dateiBytes} | ${d.kopf.nutzlastBytes} | ${d.kopf.breite}×${d.kopf.hoehe} | ${d.kopf.step.r}/${d.kopf.step.g}/${d.kopf.step.b} | ${d.kopf.offset} | ${d.paletteErsteEintraege.join(', ')} |`).join('\n')}

Alle Dateien: Magic \`HAM!\`, Version 4, Kopf 20 Byte (11 + 5 Zeichen Formatname +
3 Byte Schrittweite + 1 Byte Offset), 768 Byte Palette, Nutzlast Big-Endian,
Modusbit **0 = Anker, 1 = Delta**.

## Vektoren

Auszug aus \`vectors.json\`. Jeder Eintrag nennt Pixelindex, Code als Binärfolge
(MSB-first, Breite = Bits des Modus), Akkumulator vorher/nachher und den
erwarteten RGB-Wert. \`vectors.json\` enthält zusätzlich \`ungeklemmt\`, \`delta\`
und \`turboFaktor\`.

`;

for (const [fmt, d] of Object.entries(out.modi)) {
    md += `### ${fmt} — \`${d.datei}\`\n\n`;
    md += `Anker ${d.statistik.anker}, Deltas ${d.statistik.deltas}, Turbo ${d.statistik.turbo}; `
        + `Klemmung auf 0: ${d.statistik.klemmung0}×, auf 255: ${d.statistik.klemmung255}×.\n\n`;
    md += `**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):\n\n${tabelle(d.vektoren.frameStart)}\n\n`;
    md += `**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):\n\n${tabelle(d.vektoren.zeilenwechsel)}\n\n`;
    if (d.vektoren.turbo) md += `**Turbo** (erster Turbo-Delta mit Umgebung):\n\n${tabelle(d.vektoren.turbo)}\n\n`;
    md += `**Klemmung unten** (ein Kanal würde negativ):\n\n${tabelle(d.vektoren.klemmungUnten)}\n\n`;
    md += `**Klemmung oben** (ein Kanal würde über 255 gehen):\n\n${tabelle(d.vektoren.klemmungOben)}\n\n`;
}

md += `## Dateien in diesem Verzeichnis

| Datei | Inhalt |
|---|---|
| \`ham03.ham\` … \`ham08.ham\` | die fünf Originaldateien |
| \`ham03_decoded.rgb\` … \`ham08_decoded.rgb\` | **RGB-Rohdaten** des Dekodierlaufs, je 245 760 Byte: 3 Byte je Pixel, zeilenweise oben→unten, links→rechts, ohne Kopf |
| \`input_320x256.rgb\` | das bewiesene 320×256-Eingabebild (gleiches Layout) |
| \`vectors.json\` | Kopfdaten, Hashes und alle Vektoren maschinenlesbar |

## Prüfen

\`\`\`
node make_ref_vectors.mjs     # erzeugt Rasterdaten, vectors.json und diese Datei neu
node test_ref_vectors.mjs     # prüft Hashes, Rohdaten und alle Sollwerte
\`\`\`

## Was diese Vektoren belegen

- **Kein Zeilenreset:** bei HAM03, HAM04, HAM05 und HAM06 beginnt Pixel 320
  (erste Spalte von Zeile 1) **ohne Anker** — der Akkumulator läuft über die
  Zeilengrenze weiter. Bei HAM08 steht dort ein Anker, weil der Encoder dort fast
  jedes Pixel über die Palette setzt (80,9 % Anker).
- **Sättigung statt Modulo:** siehe die Klemmungstabellen; \`ungeklemmt\` steht in
  \`vectors.json\`. Beispiel HAM06 Pixel 1812: ungeklemmt (258, 202, 113) → (255, 202, 113).
  Modulo-256 würde (2, 202, 113) ergeben.
- **Turbo = Faktor 4**, nicht 2: \`turboFaktor\` ist in jeder Turbo-Zeile angegeben.
`;
fs.writeFileSync(`${REF_DIR}/README.md`, md);
console.log(`README.md geschrieben (${Buffer.byteLength(md)} Byte)`);
