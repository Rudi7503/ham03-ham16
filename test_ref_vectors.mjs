// Prüft die Referenzvektoren in testbilder/ref/ gegen die .ham-Dateien:
// Kopfdaten, Hashes der Rasterdaten, gespeicherte Rohdaten und die Sollwerte
// der Vektoren. Ändert sich der Decoder, schlägt das hier fehl.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const DIR = 'testbilder/ref';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

const vect = JSON.parse(fs.readFileSync(`${DIR}/vectors.json`, 'utf8'));

for (const [format, d] of Object.entries(vect.modi)) {
    const raw = new Uint8Array(fs.readFileSync(`${DIR}/${d.datei}`));
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const le = raw[5] === 0;
    const w = dv.getUint16(6, le), h = dv.getUint16(8, le);
    const fLen = raw[10];
    let p = 11;
    const fmt = new TextDecoder().decode(raw.slice(p, p + fLen)); p += fLen;
    const step = { r: raw[p++], g: raw[p++], b: raw[p++] };
    const offset = raw[p++];
    const palette = raw.slice(p, p + 768); p += 768;
    const payload = raw.slice(p);

    check(`${format} Kopfdaten`,
        raw[4] === 4 && fmt === format && w === d.kopf.breite && h === d.kopf.hoehe
        && step.r === d.kopf.step.r && step.g === d.kopf.step.g && step.b === d.kopf.step.b
        && offset === d.kopf.offset && payload.length === d.kopf.nutzlastBytes,
        `${raw[4]}/${fmt}/${w}x${h}/${step.r},${step.g},${step.b}/${offset}/${payload.length}`);

    check(`${format} Datei-Hash`, sha(raw) === d.dateiSha256);

    const total = w * h;
    const rgba = decodePaletted(unpackPaletted(payload, fmt, total), w, h, step, palette, offset);
    const rgb = new Uint8Array(total * 3);
    for (let i = 0; i < total; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }

    check(`${format} dekodiertes Raster (Hash)`, sha(rgb) === d.raster.sha256,
        `${sha(rgb).slice(0, 16)} != ${d.raster.sha256.slice(0, 16)}`);

    const gespeichert = new Uint8Array(fs.readFileSync(`${DIR}/${d.raster.datei}`));
    check(`${format} Rohdatei ${d.raster.datei}`, gespeichert.length === rgb.length && Buffer.compare(gespeichert, rgb) === 0);

    // Sollwerte der Vektoren gegen den Dekodierlauf prüfen
    let vOk = true, vDetail = '';
    for (const [name, liste] of Object.entries(d.vektoren)) {
        if (!liste) continue;
        for (const e of liste) {
            const i = e.index;
            if (rgba[i * 4] !== e.rgb.r || rgba[i * 4 + 1] !== e.rgb.g || rgba[i * 4 + 2] !== e.rgb.b) {
                vOk = false;
                vDetail += ` ${name}[${i}]: (${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]}) statt (${e.rgb.r},${e.rgb.g},${e.rgb.b});`;
            }
        }
    }
    check(`${format} Sollwerte aller Vektoren`, vOk, vDetail);

    // Zeilenübergang muss im Vektor enthalten sein (Kernpunkt: kein Reset pro Zeile)
    const zeile = d.vektoren.zeilenwechsel.map(e => e.index);
    check(`${format} Zeilenübergang im Vektor (319 -> 320)`, zeile.includes(319) && zeile.includes(320));
}

console.log(fehler === 0 ? '\nREFERENZVEKTOREN STIMMEN MIT DEN .ham-DATEIEN UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
