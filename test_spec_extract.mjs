// Extrahiert den Referenz-Decoder DIREKT aus HAM06-SPEZIFIKATION.md (§6) und
// prüft ihn. Damit kann der abgedruckte Code nicht unbemerkt von der
// Implementierung abweichen — getestet wird die Doku, nicht eine Kopie davon.

import { readFileSync } from 'node:fs';
import { encodePaletted, decodePaletted, packPaletted } from './src/core/module_paletted.js';

const md = readFileSync(new URL('./HAM06-SPEZIFIKATION.md', import.meta.url), 'utf8');

// Alle ```js-Blöcke einsammeln und den mit decodeHam nehmen
const blocks = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1]);
const code = blocks.find(b => b.includes('function decodeHam'));
if (!code) {
    console.log('FEHL: kein js-Block mit decodeHam in der Spezifikation gefunden');
    process.exit(1);
}
console.log(`OK   Code-Block aus der Doku extrahiert (${code.split('\n').length} Zeilen, ${blocks.length} js-Blöcke in der Datei)`);

// Der Block hat keine Imports; als Funktionskörper auswerten und decodeHam herausholen
let decodeHam;
try {
    decodeHam = new Function(code + '\n; return decodeHam;')();
    console.log('OK   Code-Block kompiliert ohne Fehler');
} catch (e) {
    console.log('FEHL: Code-Block der Doku kompiliert nicht: ' + e.message);
    process.exit(1);
}

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

function buildContainer({ W, H, format, step, offset, palette, packed }) {
    const fmtBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + fmtBytes.length + 4 + 768 + packed.length);
    const dv = new DataView(buf.buffer);
    buf.set([72, 65, 77, 33], 0);
    dv.setUint8(4, 4);          // Version 4: Modusbit 0 = Anker
    dv.setUint8(5, 0);
    dv.setUint16(6, W, true);
    dv.setUint16(8, H, true);
    dv.setUint8(10, fmtBytes.length);
    let p = 11;
    buf.set(fmtBytes, p); p += fmtBytes.length;
    dv.setUint8(p++, step.r); dv.setUint8(p++, step.g); dv.setUint8(p++, step.b); dv.setUint8(p++, offset);
    buf.set(palette, p); p += 768;
    buf.set(packed, p);
    return buf;
}

const wrap = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// --- Testvektor aus §7 ---
{
    const palette = new Uint8Array(768);
    palette[3] = 255;
    const bytes = buildContainer({
        W: 8, H: 1, format: 'HAM_32BIT_63436343',
        step: { r: 4, g: 4, b: 4 }, offset: 0, palette,
        packed: new Uint8Array([0x06, 0x7F, 0xC2, 0x44])
    });
    const out = decodeHam(wrap(bytes));
    const erwartet = [
        [255, 0, 0], [247, 0, 0], [255, 8, 8], [255, 16, 16],
        [239, 0, 0], [231, 0, 0], [223, 0, 0], [215, 0, 0]
    ];
    let ok = true, detail = '';
    for (let i = 0; i < 8; i++) {
        const o = i * 4;
        const got = [out.rgba[o], out.rgba[o + 1], out.rgba[o + 2]];
        if (got.join() !== erwartet[i].join()) { ok = false; detail += ` px${i}: ${got} statt ${erwartet[i]}`; }
    }
    check('§7 Testvektor 0x067FC244 (Code aus der Doku)', ok, detail);
}

// --- Echter Round-Trip gegen decodePaletted ---
{
    const W = 96, H = 64, TOTAL = W * H;
    const px = new Uint8ClampedArray(TOTAL * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            px[i] = (x * 3 + y * 5) % 256;
            px[i + 1] = ((x & 1) ? 250 : 5);
            px[i + 2] = ((x * 7 + y * 11) % 256);
            px[i + 3] = 255;
        }
    }
    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = (i * 43 + 11) % 256;
    palette[0] = palette[1] = palette[2] = 0;
    const step = { r: 4, g: 4, b: 4 };

    for (const format of ['HAM_32BIT_63436343', 'HAM_32BIT_655655', 'HAM_32BIT_8888', 'HAM_32BIT_53535353']) {
        for (const strategie of ['greedy', 'delta_only', 'anchor_only']) {
            const { commands } = await encodePaletted(px, W, H, format, step, palette.slice(), 0, strategie, 'yuv_weight');
            const packed = packPaletted(commands, format);
            const mine = decodeHam(wrap(buildContainer({ W, H, format, step, offset: 0, palette, packed })));
            const ref = decodePaletted(commands, W, H, step, palette, 0);
            let diff = 0;
            for (let i = 0; i < ref.length; i++) if (ref[i] !== mine.rgba[i]) diff++;
            check(`${format.padEnd(22)} ${strategie.padEnd(11)} Doku-Decoder == decodePaletted`, diff === 0, `${diff} Abweichungen`);
        }
    }
}

console.log(fehler === 0 ? '\nDOKU-DECODER LAEUFT UND STIMMT MIT DER IMPLEMENTIERUNG UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
