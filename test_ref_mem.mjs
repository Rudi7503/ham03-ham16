// Prüft die Testbench-Dateien in testbilder/ref/mem/ gegen die .ham-Dateien:
// Zeilenformat, Zeilenzahlen, Wort-/Pixel-/Palettenwerte.
import fs from 'node:fs';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const REF = 'testbilder/ref', MEM = `${REF}/mem`;
const MODES = ['03', '04', '05', '06', '08'];

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};
const zeilen = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(l => l.length > 0);

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
    return { width: w, height: h, format, step, offset, palette, payload: raw.slice(p) };
}

for (const m of MODES) {
    const h = parseHam(`${REF}/ham${m}.ham`);
    const total = h.width * h.height;

    // --- Nutzlast ---
    const pw = zeilen(`${MEM}/ham${m}_payload.mem`);
    const erwarteteWoerter = h.payload.length / 4;
    check(`ham${m} payload: ${pw.length} Wörter (erwartet ${erwarteteWoerter})`, pw.length === erwarteteWoerter);
    check(`ham${m} payload: 8 Hexziffern, keine @Adresse`, pw.every(z => /^[0-9A-Fa-f]{8}$/.test(z)),
        pw.find(z => !/^[0-9A-Fa-f]{8}$/.test(z)) || '');

    // Wörter zurück zu Bytes: Byte0 in Bits 31:24
    const bytes = new Uint8Array(h.payload.length);
    let wortOk = true;
    for (let i = 0; i < pw.length; i++) {
        const v = parseInt(pw[i], 16) >>> 0;
        bytes[i * 4] = (v >>> 24) & 255;
        bytes[i * 4 + 1] = (v >>> 16) & 255;
        bytes[i * 4 + 2] = (v >>> 8) & 255;
        bytes[i * 4 + 3] = v & 255;
        if (bytes[i * 4] !== h.payload[i * 4] || bytes[i * 4 + 1] !== h.payload[i * 4 + 1]
            || bytes[i * 4 + 2] !== h.payload[i * 4 + 2] || bytes[i * 4 + 3] !== h.payload[i * 4 + 3]) wortOk = false;
    }
    check(`ham${m} payload: Bytes byteweise identisch mit der Datei`, wortOk);

    // --- Sollpixel ---
    const pe = zeilen(`${MEM}/ham${m}_expected.mem`);
    check(`ham${m} expected: ${pe.length} Pixel (erwartet ${total})`, pe.length === total);
    check(`ham${m} expected: 6 Hexziffern`, pe.every(z => /^[0-9A-Fa-f]{6}$/.test(z)),
        pe.find(z => !/^[0-9A-Fa-f]{6}$/.test(z)) || '');

    const rgba = decodePaletted(unpackPaletted(h.payload, h.format, total), h.width, h.height, h.step, h.palette, h.offset);
    let pixOk = true, firstBad = '';
    for (let i = 0; i < total; i++) {
        const soll = ((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
        if (parseInt(pe[i], 16) !== soll) {
            pixOk = false;
            if (!firstBad) firstBad = `px ${i}: ${pe[i]} statt ${soll.toString(16).toUpperCase().padStart(6, '0')}`;
            break;
        }
    }
    check(`ham${m} expected: Werte == Referenzdecoder`, pixOk, firstBad);

    // --- Palette ---
    const pp = zeilen(`${MEM}/ham${m}_palette.mem`);
    check(`ham${m} palette: 256 Zeilen`, pp.length === 256);
    let palOk = true;
    for (let i = 0; i < 256; i++) {
        const soll = (h.palette[i * 3] << 16) | (h.palette[i * 3 + 1] << 8) | h.palette[i * 3 + 2];
        if (parseInt(pp[i], 16) !== soll) palOk = false;
    }
    check(`ham${m} palette: Werte == Container-Palette`, palOk);
}

// --- Index vorhanden und vollständig ---
const idx = fs.readFileSync(`${MEM}/INDEX.md`, 'utf8');
check('INDEX.md nennt alle fünf Modi', MODES.every(m => idx.includes(`ham${m}_payload.mem`)));
check('INDEX.md dokumentiert Byte0 in Bits 31:24', /Bits 31:24/.test(idx));
check('INDEX.md hält den Stand "kein FPGA-Build" fest', /FPGA-Build oder Hardwaretest/.test(idx));

console.log(fehler === 0 ? '\nTESTBENCH-DATEIEN STIMMEN MIT DEN .ham-DATEIEN UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
