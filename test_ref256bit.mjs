// Prüft den Referenzsatz der 256-Bit-Delta-Formate (testbilder/ref256bit):
// Kopf, Blockstruktur (Anker genau an den Blockanfängen), Dekodierung, Palette,
// Prüfsummen im Index und die Testbench-Dateien.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseHamHeader, expectedPayloadBytes } from './src/core/ham_file.js';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const DIR = 'testbilder/ref256bit';
const W = 320, H = 256, TOTAL = W * H;
// Dateiname -> Blocklänge (12 Bit Anker + n Deltas = 256 Bit)
const SAETZE = [
    { stem: 'ham_256bit_12_61x4_delta', format: 'HAM_256BIT_12_61x4_DELTA', block: 62 },
    { stem: 'ham_256bit_12_14x5_29x6_delta', format: 'HAM_256BIT_12_14x5_29x6_DELTA', block: 44 }
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

const idx = fs.readFileSync(`${DIR}/INDEX.md`, 'utf8');
const eingabe = fs.readFileSync(`${DIR}/input_320x256.rgb`);
check('Eingabebild 320x256 vorhanden', eingabe.length === TOTAL * 3, `${eingabe.length} Byte`);

for (const { stem, format, block } of SAETZE) {
    const roh = fs.readFileSync(`${DIR}/${stem}.ham`);
    const h = parseHamHeader(roh);
    check(`${format}: Größe 320x256`, h.width === W && h.height === H, `${h.width}x${h.height}`);
    check(`${format}: Formatname im Kopf`, h.format === format, h.format);
    // Bitrate: 256 Bit je Block, als fortlaufender Bitstrom gepackt
    check(`${format}: Nutzlast folgt der Bitrate (256 Bit je ${block} Pixel)`,
        h.payload.length === expectedPayloadBytes(format, TOTAL), `${h.payload.length} Byte`);

    const cmds = unpackPaletted(h.payload, h.format, TOTAL);
    let ankerFalsch = 0, ersterFalsch = -1;
    for (let i = 0; i < TOTAL; i++) {
        if (cmds[i].isAnchor !== ((i % block) === 0)) {
            ankerFalsch++;
            if (ersterFalsch < 0) ersterFalsch = i;
        }
    }
    check(`${format}: Anker genau an den Blockanfängen (${block} px)`, ankerFalsch === 0,
        `${ankerFalsch} Abweichungen, erste bei ${ersterFalsch}`);

    // Palettenfrei: alle 768 Bytes 0
    let palNull = true;
    for (let i = 0; i < 768; i++) if (h.palette[i] !== 0) { palNull = false; break; }
    check(`${format}: Palette unbenutzt (alle 0)`, palNull);

    const dec = decodePaletted(cmds, W, H, h.step, h.palette, h.offset);
    const rgb = fs.readFileSync(`${DIR}/${stem}_decoded.rgb`);
    let diff = 0;
    for (let i = 0; i < TOTAL; i++) {
        if (dec[i * 4] !== rgb[i * 3] || dec[i * 4 + 1] !== rgb[i * 3 + 1] || dec[i * 4 + 2] !== rgb[i * 3 + 2]) diff++;
    }
    check(`${format}: Rasterdatei == Decoderlauf`, diff === 0, `${diff} Pixel abweichend`);
    check(`${format}: Prüfsumme .ham im Index`, idx.includes(sha(roh)));
    check(`${format}: Prüfsumme Raster im Index`, idx.includes(sha(rgb)));

    // Testbench-Dateien
    const memPay = `${DIR}/mem/${stem}_payload.mem`;
    const memExp = `${DIR}/mem/${stem}_expected.mem`;
    const memPal = `${DIR}/mem/${stem}_palette.mem`;
    check(`${format}: mem-Dateien vorhanden`, fs.existsSync(memPay) && fs.existsSync(memExp) && fs.existsSync(memPal));
    if (fs.existsSync(memExp)) {
        const zeilen = fs.readFileSync(memExp, 'utf8').trim().split('\n');
        check(`${format}: expected.mem hat ${TOTAL} Pixel`, zeilen.length === TOTAL, `${zeilen.length}`);
        // Stichprobe: erster, mittlerer und letzter Pixel
        const proben = [0, Math.floor(TOTAL / 2), TOTAL - 1];
        const passen = proben.every(i => {
            const soll = ((dec[i * 4] << 16) | (dec[i * 4 + 1] << 8) | dec[i * 4 + 2]).toString(16).toUpperCase().padStart(6, '0');
            return zeilen[i].trim() === soll;
        });
        check(`${format}: expected.mem stimmt an Stichproben`, passen);
    }
}

console.log(fehler === 0 ? '\n256-BIT-SATZ VOLLSTAENDIG UND FORMATKONFORM' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
