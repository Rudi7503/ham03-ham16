// Prüft den in HAM06-SPEZIFIKATION.md §6 abgedruckten Referenz-Decoder gegen die
// echte Implementierung. Der Decoder hier ist absichtlich eine 1:1-Abschrift aus
// der Doku (inkl. FORMATS-Tabelle) — weicht er ab, ist die Doku falsch.
//
// Test 1: der handgerechnete Testvektor aus §7
// Test 2: Round-Trip auf einem synthetischen Bild gegen decodePaletted

import { encodePaletted, decodePaletted, packPaletted } from './src/core/module_paletted.js';

// ===== BEGINN Abschrift aus der Spezifikation =====
const BITS = { HAM01: 1, HAM02: 2, HAM03: 3, HAM04: 4, HAM05: 5, HAM06: 6, HAM08: 8 };
const SLOTS = { HAM01: 0, HAM02: 0, HAM03: 4, HAM04: 8, HAM05: 16, HAM06: 32, HAM08: 128 };
const CH = {
    HAM01: { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    HAM02: { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    HAM03: { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    HAM04: { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    HAM05: { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    HAM06: { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    HAM08: { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] }
};
const FORMATS = {
    HAM_32BIT_44444444: ['HAM04', 'HAM04', 'HAM04', 'HAM04', 'HAM04', 'HAM04', 'HAM04', 'HAM04'],
    HAM_32BIT_53535353: ['HAM05', 'HAM03', 'HAM05', 'HAM03', 'HAM05', 'HAM03', 'HAM05', 'HAM03'],
    HAM_32BIT_63436343: ['HAM06', 'HAM03', 'HAM04', 'HAM03', 'HAM06', 'HAM03', 'HAM04', 'HAM03'],
    HAM_32BIT_6446444: ['HAM06', 'HAM04', 'HAM04', 'HAM06', 'HAM04', 'HAM04', 'HAM04'],
    HAM_32BIT_5454545: ['HAM05', 'HAM04', 'HAM05', 'HAM04', 'HAM05', 'HAM04', 'HAM05'],
    HAM_32BIT_6454544: ['HAM06', 'HAM04', 'HAM05', 'HAM04', 'HAM05', 'HAM04', 'HAM04'],
    HAM_32BIT_655655: ['HAM06', 'HAM05', 'HAM05', 'HAM06', 'HAM05', 'HAM05'],
    HAM_32BIT_844844: ['HAM08', 'HAM04', 'HAM04', 'HAM08', 'HAM04', 'HAM04'],
    HAM_32BIT_846554: ['HAM08', 'HAM04', 'HAM06', 'HAM05', 'HAM05', 'HAM04'],
    HAM_32BIT_646565: ['HAM06', 'HAM04', 'HAM06', 'HAM05', 'HAM06', 'HAM05'],
    HAM_32BIT_86666: ['HAM08', 'HAM06', 'HAM06', 'HAM06', 'HAM06'],
    HAM_32BIT_85865: ['HAM08', 'HAM05', 'HAM08', 'HAM06', 'HAM05'],
    HAM_32BIT_8888: ['HAM08', 'HAM08', 'HAM08', 'HAM08']
};

const clamp = (v) => v < 0 ? 0 : (v > 255 ? 255 : v);

// Modusbit 0 = Anker, 1 = Delta
function parseCode(v, fmt) {
    const slots = SLOTS[fmt];
    if (slots > 0) {
        const anchorBit = slots;
        if ((v & anchorBit) === 0) return { anchor: true, idx: v & (slots - 1) };
    }
    switch (fmt) {
        case 'HAM01': return { anchor: false, turbo: false, r: v & 1, g: v & 1, b: v & 1 };
        case 'HAM02': { const rb = (v >> 1) & 1; return { anchor: false, turbo: false, r: rb, g: v & 1, b: rb }; }
        case 'HAM03': { const rb = (v >> 1) & 1; return { anchor: false, turbo: false, r: rb, g: v & 1, b: rb }; }
        case 'HAM04': return { anchor: false, turbo: false, r: (v >> 2) & 1, g: (v >> 1) & 1, b: v & 1 };
        case 'HAM05': return { anchor: false, turbo: !!((v >> 3) & 1), r: (v >> 2) & 1, g: (v >> 1) & 1, b: v & 1 };
        case 'HAM06': return { anchor: false, turbo: !!((v >> 4) & 1), r: (v >> 3) & 1, g: (v >> 1) & 3, b: v & 1 };
        case 'HAM08': return { anchor: false, turbo: !!((v >> 6) & 1), r: (v >> 4) & 3, g: (v >> 2) & 3, b: v & 3 };
    }
    return { anchor: true, idx: 0 };
}

function decodeHam(bytes) {
    const u8 = new Uint8Array(bytes);
    const dv = new DataView(bytes);
    if (!(u8[0] === 72 && u8[1] === 65 && u8[2] === 77 && u8[3] === 33)) throw new Error('kein HAM!-Magic');
    if (u8[4] !== 4) throw new Error('unbekannte Version ' + u8[4]);
    const le = u8[5] === 0;
    const W = dv.getUint16(6, le), H = dv.getUint16(8, le);
    const fLen = u8[10];
    let p = 11;
    const format = new TextDecoder().decode(u8.slice(p, p + fLen)); p += fLen;
    const step = { r: u8[p++], g: u8[p++], b: u8[p++] };
    const offset = u8[p++];
    const palette = u8.slice(p, p + 768); p += 768;
    const packed = u8.slice(p);

    const seq = FORMATS[format];
    const ppw = seq.length;
    const out = new Uint8ClampedArray(W * H * 4);

    let r = 127, g = 127, b = 127;
    let px = 0, wi = 0;
    const total = W * H;
    while (px < total) {
        const w32 = ((packed[wi] << 24) | (packed[wi + 1] << 16) | (packed[wi + 2] << 8) | packed[wi + 3]) >>> 0;
        wi += 4;
        let shift = 32;
        for (let j = 0; j < ppw && px < total; j++, px++) {
            const fmt = seq[j];
            const bits = BITS[fmt];
            shift -= bits;
            const v = (w32 >>> shift) & ((1 << bits) - 1);
            const cmd = parseCode(v, fmt);
            if (cmd.anchor) {
                const a = ((offset + cmd.idx) % 256) * 3;
                r = palette[a]; g = palette[a + 1]; b = palette[a + 2];
            } else {
                const m = cmd.turbo ? 4 : 1;
                r = clamp(r + CH[fmt].r[cmd.r] * step.r * m);
                g = clamp(g + CH[fmt].g[cmd.g] * step.g * m);
                b = clamp(b + CH[fmt].b[cmd.b] * step.b * m);
            }
            const o = px * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
    }
    return { width: W, height: H, format, step, offset, palette, rgba: out };
}
// ===== ENDE Abschrift =====

function buildContainer({ W, H, format, step, offset, palette, packed }) {
    const fmtBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + fmtBytes.length + 4 + 768 + packed.length);
    const dv = new DataView(buf.buffer);
    buf.set([72, 65, 77, 33], 0);
    dv.setUint8(4, 4);
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

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

// ---------- Test 1: Testvektor aus §7 ----------
{
    const palette = new Uint8Array(768);
    palette[3] = 255;  // Slot 1 = (255,0,0)
    const bytes = buildContainer({
        W: 8, H: 1, format: 'HAM_32BIT_63436343',
        step: { r: 4, g: 4, b: 4 }, offset: 0, palette,
        packed: new Uint8Array([0x06, 0x7F, 0xC2, 0x44])
    });
    const out = decodeHam(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const erwartet = [
        [255, 0, 0], [247, 0, 0], [255, 8, 8], [255, 16, 16],
        [239, 0, 0], [231, 0, 0], [223, 0, 0], [215, 0, 0]
    ];
    let ok = true, detail = '';
    for (let i = 0; i < 8; i++) {
        const o = i * 4;
        const got = [out.rgba[o], out.rgba[o + 1], out.rgba[o + 2]];
        if (got[0] !== erwartet[i][0] || got[1] !== erwartet[i][1] || got[2] !== erwartet[i][2]) {
            ok = false;
            detail += ` px${i}: ${got} statt ${erwartet[i]}`;
        }
    }
    check('§7 Testvektor (0x067FC244) liefert die vorhergesagten 8 Pixel', ok, detail);
}

// ---------- Test 2: Round-Trip gegen die echte Implementierung ----------
{
    const W = 128, H = 96, TOTAL = W * H;
    const px = new Uint8ClampedArray(TOTAL * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            px[i] = (x * 2 + y) % 256;
            px[i + 1] = ((x & 3) === 0) ? 255 : (y * 3) % 256;
            px[i + 2] = ((x + y) & 1) ? 240 : 15;
            px[i + 3] = 255;
        }
    }
    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = (i * 61 + 7) % 256;
    palette[0] = palette[1] = palette[2] = 0;
    const step = { r: 4, g: 4, b: 4 };

    for (const format of Object.keys(FORMATS)) {
        const { commands } = await encodePaletted(px, W, H, format, step, palette.slice(), 0, 'greedy', 'yuv_weight');
        const packed = packPaletted(commands, format);
        const container = buildContainer({ W, H, format, step, offset: 0, palette, packed });
        const mine = decodeHam(container.buffer.slice(container.byteOffset, container.byteOffset + container.byteLength));
        const ref = decodePaletted(commands, W, H, step, palette, 0);

        let diff = 0, first = -1;
        for (let i = 0; i < ref.length; i++) {
            if (ref[i] !== mine.rgba[i]) { diff++; if (first < 0) first = i; }
        }
        check(`${format.padEnd(22)} Spezifikations-Decoder == decodePaletted`, diff === 0,
            diff ? `${diff} Abweichungen, erste bei Byte ${first}` : '');
    }
}

console.log(fehler === 0 ? '\nSPEZIFIKATION STIMMT MIT DER IMPLEMENTIERUNG UEBEREIN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
