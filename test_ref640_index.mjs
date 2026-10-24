// Prüft testbilder/ref640/INDEX.md gegen die Dateien: jede dort genannte
// Prüfsumme und Bytezahl muss zum tatsächlichen Dateiinhalt passen.
// Genau dieser Abgleich hat gefehlt, als nach der Paletten-Nachoptimierung die
// Hashes im Index veraltet waren.
import fs from 'node:fs';
import crypto from 'node:crypto';

const DIR = 'testbilder/ref640';
const MODES = ['03', '04', '05', '06', '08'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

const idx = fs.readFileSync(`${DIR}/INDEX.md`, 'utf8');

function readHam(path) {
    const raw = new Uint8Array(fs.readFileSync(path));
    const fLen = raw[10];
    let p = 11 + fLen;
    const step = { r: raw[p++], g: raw[p++], b: raw[p++] };
    const offset = raw[p++];
    const palette = raw.slice(p, p + 768); p += 768;
    return { raw, palette, payload: raw.slice(p) };
}

for (const m of MODES) {
    const h = readHam(`${DIR}/ham${m}.ham`);
    const rgb = new Uint8Array(fs.readFileSync(`${DIR}/ham${m}_decoded.rgb`));

    check(`HAM${m} .ham-Prüfsumme im Index`, idx.includes(sha(h.raw)),
        `Index kennt ${sha(h.raw)} nicht`);
    check(`HAM${m} .ham-Bytezahl im Index`, new RegExp(`\\|\\s*${h.raw.length}\\s*\\|\\s*${h.payload.length}\\s*\\|`).test(idx),
        `${h.raw.length} B / ${h.payload.length} B Nutzlast nicht gefunden`);
    check(`HAM${m} Raster-Prüfsumme im Index`, idx.includes(sha(rgb)),
        `Index kennt ${sha(rgb)} nicht`);
    check(`HAM${m} Paletten-Prüfsumme im Index`, idx.includes(sha(h.palette)),
        `Index kennt ${sha(h.palette)} nicht`);
}

// Eingabebild
const inputRgb = fs.readFileSync(`${DIR}/input_640x256.rgb`);
check('Eingabebild-Prüfsumme im Index', idx.includes(sha(inputRgb)), `Index kennt ${sha(inputRgb)} nicht`);
check('Eingabebild-Bytezahl im Index', idx.includes(String(inputRgb.length)));

// mem/INDEX.md gegen die mem-Dateien
const memIdx = fs.readFileSync(`${DIR}/mem/INDEX.md`, 'utf8');
for (const m of MODES) {
    for (const kind of ['payload', 'expected', 'palette']) {
        const b = fs.readFileSync(`${DIR}/mem/ham${m}_${kind}.mem`);
        check(`ham${m}_${kind}.mem im mem/INDEX.md`, memIdx.includes(sha(b)), 'Prüfsumme fehlt oder veraltet');
    }
}

console.log(fehler === 0 ? '\nINDEX UND DATEIEN STIMMEN UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
