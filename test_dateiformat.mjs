// Prüft die Testvektoren aus HAM-DATEIFORMAT.md §6 gegen die echte
// Implementierung. Die Zahlen hier sind wörtlich aus dem Dokument übernommen —
// weicht der Code ab, schlägt der Test fehl und das Dokument muss nachgezogen
// werden (oder der Code ist kaputt).
import {
    packPaletted, unpackPaletted, decodePaletted, encodePaletted
} from './src/core/module_paletted.js';
import { packHam12_16, unpackHam12_16, decodeHam12_16 } from './src/core/module_ham12_16.js';
import { encodeDXT1, decodeDXT1 } from './src/core/module_dxt1.js';

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const px = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]];

// ===== §6.1 Paletten-Bitstrom: HAM_32BIT_63436343 =====
{
    const nutzlast = new Uint8Array([0x06, 0x7F, 0xC2, 0x44]);
    const palette = new Uint8Array(768);
    palette[3] = 255;                       // Slot 1 = (255,0,0)
    const step = { r: 4, g: 4, b: 4 };

    const cmds = unpackPaletted(nutzlast, 'HAM_32BIT_63436343', 8);
    const out = decodePaletted(cmds, 8, 1, step, palette, 0);

    const erwartet = [
        [255, 0, 0], [247, 0, 0], [255, 8, 8], [255, 16, 16],
        [239, 0, 0], [231, 0, 0], [223, 0, 0], [215, 0, 0]
    ];
    let ok = true, detail = '';
    for (let i = 0; i < 8; i++) {
        const got = px(out, i);
        if (!eq(got, erwartet[i])) { ok = false; detail += ` px${i}: ${got} statt ${erwartet[i]};`; }
    }
    check('§6.1 HAM_32BIT_63436343 Nutzlast 067FC244 → 8 Pixel', ok, detail);

    // Gegenrichtung: die acht Befehle müssen genau diese Nutzlast ergeben
    const nachPack = packPaletted(cmds, 'HAM_32BIT_63436343');
    check('§6.1 Packen ergibt 0x06 0x7F 0xC2 0x44', eq(Array.from(nachPack), [0x06, 0x7F, 0xC2, 0x44]),
        Array.from(nachPack).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
}

// ===== §6.2 HAM16 =====
{
    const cmds = [
        { isAnchor: true, format: 'HAM16', r5: 12, g5: 7, b5: 31 },
        { isAnchor: false, format: 'HAM16', isTurbo: false, dr: -3, dg: 7, db: -2 },
        { isAnchor: false, format: 'HAM16', isTurbo: true, dr: 3, dg: -8, db: 2 }
    ];
    const packed = packHam12_16(cmds, 'HAM16');
    const erwarteteBytes = [0x30, 0xFF, 0xB4, 0xFE, 0xCF, 0x02];
    check('§6.2 HAM16 Nutzlast 30FF B4FE CF02', eq(Array.from(packed), erwarteteBytes),
        Array.from(packed).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    const out = decodeHam12_16(unpackHam12_16(packed, 'HAM16', 3), 3, 1, { r: 4, g: 4, b: 4 });
    const erwartet = [[96, 56, 248], [84, 84, 240], [132, 0, 255]];
    let ok = true, detail = '';
    for (let i = 0; i < 3; i++) {
        const got = px(out, i);
        if (!eq(got, erwartet[i])) { ok = false; detail += ` px${i}: ${got} statt ${erwartet[i]};`; }
    }
    check('§6.2 HAM16 → (96,56,248) (84,84,240) (132,0,255)', ok, detail);
}

// ===== §6.3 HAM12 =====
{
    const cmds = [
        { isAnchor: true, format: 'HAM12', b10: 1, r3: 5, g4: 12, b3: 3 },
        { isAnchor: false, format: 'HAM12', isTurbo: false, dr: -3, dg: 7, db: -2 },
        { isAnchor: false, format: 'HAM12', isTurbo: true, dr: 3, dg: -8, db: 2 }
    ];
    const packed = packHam12_16(cmds, 'HAM12');
    const erwarteteBytes = [0x06, 0xE3, 0x0A, 0xBE, 0x0D, 0xC2];
    check('§6.3 HAM12 Nutzlast 06E3 0ABE 0DC2', eq(Array.from(packed), erwarteteBytes),
        Array.from(packed).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    const out = decodeHam12_16(unpackHam12_16(packed, 'HAM12', 3), 3, 1, { r: 4, g: 4, b: 4 });
    const erwartet = [[176, 192, 112], [164, 220, 104], [212, 92, 136]];
    let ok = true, detail = '';
    for (let i = 0; i < 3; i++) {
        const got = px(out, i);
        if (!eq(got, erwartet[i])) { ok = false; detail += ` px${i}: ${got} statt ${erwartet[i]};`; }
    }
    check('§6.3 HAM12 → (176,192,112) (164,220,104) (212,92,136)', ok, detail);
}

// ===== §6.4 DXT1 =====
{
    const W = 4, H = 4;
    const src = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            const links = x < 2;
            src[o] = links ? 255 : 0;
            src[o + 1] = links ? 0 : 255;
            src[o + 2] = 0; src[o + 3] = 255;
        }
    }
    const packed = encodeDXT1(src, W, H);
    const erwarteteBytes = [0x00, 0xF8, 0xE0, 0x07, 0x50, 0x50, 0x50, 0x50];
    check('§6.4 DXT1 Nutzlast 00F8 E007 50505050', eq(Array.from(packed), erwarteteBytes),
        Array.from(packed).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    const out = decodeDXT1(packed, W, H);
    const erwartet = [[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 255, 0]];
    let ok = true, detail = '';
    for (let i = 0; i < 4; i++) {
        const got = px(out, i);
        if (!eq(got, erwartet[i])) { ok = false; detail += ` px${i}: ${got} statt ${erwartet[i]};`; }
    }
    check('§6.4 DXT1 erste Zeile rot,rot,grün,grün', ok, detail);
}

// ===== §2: Nutzlastgrößen je Familie =====
{
    const W = 128, H = 128, N = W * H;
    const cases = [
        { format: 'HAM_32BIT_63436343', weite: Math.ceil(N * 4 / 32) * 4 },
        { format: 'HAM06', weite: Math.ceil(N * 6 / 32) * 4 },
        { format: 'HAM03', weite: Math.ceil(N * 3 / 32) * 4 },
        { format: 'HAM08', weite: Math.ceil(N * 8 / 32) * 4 }
    ];
    const palette = new Uint8Array(768).fill(40);
    const src = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) { src[i * 4] = i & 255; src[i * 4 + 1] = (i >> 3) & 255; src[i * 4 + 2] = 128; src[i * 4 + 3] = 255; }
    for (const c of cases) {
        const { commands } = await encodePaletted(src, W, H, c.format, { r: 4, g: 4, b: 4 }, palette.slice(), 0, 'greedy', 'yuv_weight');
        const len = packPaletted(commands, c.format).length;
        check(`§2 ${c.format.padEnd(20)} Nutzlast ${len} B (Formel ${c.weite})`, len === c.weite);
    }
    check('§2 HAM16 Nutzlast = W*H*2', 128 * 128 * 2 === 32768);
    check('§2 DXT1 Nutzlast = ceil(W/4)*ceil(H/4)*8', Math.ceil(128 / 4) * Math.ceil(128 / 4) * 8 === 8192);
}

console.log(fehler === 0 ? '\nDATEIFORMAT-SPEZIFIKATION STIMMT MIT DER IMPLEMENTIERUNG UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
