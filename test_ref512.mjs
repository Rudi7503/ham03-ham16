// Prüft den 640x512-Referenzsatz: Zeilenanker, Kopfdaten, Prüfsummen und die
// Übereinstimmung von INDEX.md mit den Dateien.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const DIR = 'testbilder/ref512';
const MODES = ['03', '04', '05', '06', '08'];
const W = 640, H = 512;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

const idx = fs.readFileSync(`${DIR}/INDEX.md`, 'utf8');

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

for (const m of MODES) {
    const h = readHam(`${DIR}/ham${m}.ham`);
    check(`HAM${m} Kopfdaten 640x512`, h.width === W && h.height === H && h.format === `HAM${m}`,
        `${h.width}x${h.height} ${h.format}`);

    const cmds = unpackPaletted(h.payload, h.format, W * H);
    let ohneAnker = 0, ersterOhne = -1;
    for (let y = 0; y < H; y++) {
        if (!cmds[y * W].isAnchor) { ohneAnker++; if (ersterOhne < 0) ersterOhne = y; }
    }
    check(`HAM${m} alle ${H} Zeilen beginnen mit Anker`, ohneAnker === 0,
        `${ohneAnker} Zeilen ohne Anker, erste bei y=${ersterOhne}`);

    check(`HAM${m} Prüfsumme .ham im Index`, idx.includes(sha(h.raw)));
    const rgb = new Uint8Array(fs.readFileSync(`${DIR}/ham${m}_decoded.rgb`));
    check(`HAM${m} Prüfsumme Raster im Index`, idx.includes(sha(rgb)));

    const dec = decodePaletted(cmds, W, H, h.step, h.palette, h.offset);
    let diff = 0;
    for (let i = 0; i < W * H; i++) {
        if (dec[i * 4] !== rgb[i * 3] || dec[i * 4 + 1] !== rgb[i * 3 + 1] || dec[i * 4 + 2] !== rgb[i * 3 + 2]) diff++;
    }
    check(`HAM${m} Rasterdatei == Dekodierlauf`, diff === 0, `${diff} Pixel abweichend`);
    check(`HAM${m} Paletten-Prüfsumme im Index`, idx.includes(sha(h.palette)));
}

const inputRgb = fs.readFileSync(`${DIR}/input_640x512.rgb`);
check('Eingabebild 640x512', inputRgb.length === W * H * 3, `${inputRgb.length} Byte`);
check('Eingabebild-Prüfsumme im Index', idx.includes(sha(inputRgb)));

console.log(fehler === 0 ? '\n640x512-SATZ VOLLSTAENDIG, ALLE ZEILEN VERANKERT' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
