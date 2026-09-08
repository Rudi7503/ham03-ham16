// Erzeugt zwei 256x256 PNG-Testbilder für die 4-bit/pixel HAM-Modi.
// Läuft ohne Abhängigkeiten: node make_test_images.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const W = 256, H = 256;
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

// ---------- Minimaler PNG-Encoder (RGB, 8 bit, ohne Filter) ----------
const crcTable = new Int32Array(256).fill(0).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c;
});
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, pixelFn) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // Bittiefe
    ihdr[9] = 2;   // Farbtyp: Truecolor RGB
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) {
        const row = y * (1 + width * 3);
        raw[row] = 0; // Filter: None
        for (let x = 0; x < width; x++) {
            const [r, g, b] = pixelFn(x, y);
            const o = row + 1 + x * 3;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// ---------- Bild 1: "Sweet Spot" (Stärken ausreizen) ----------
const TWO_PI = Math.PI * 2;
const bars = [
    [0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 255, 0],
    [0, 255, 128], [0, 128, 255], [128, 0, 255], [255, 0, 128], [128, 128, 128], [32, 32, 32]
];
function sweetPx(x, y) {
    if (y < 64) {
        // Horizontaler Grauverlauf 0..255 (Delta-freundlich)
        const v = Math.round((x / (W - 1)) * 255);
        return [v, v, v];
    }
    if (y < 128) {
        // Sanfter Farbkreis (alle drei Kanäle gleiten langsam)
        const p = x / (W - 1);
        return [
            clamp(127.5 + 127.5 * Math.cos(TWO_PI * p)),
            clamp(127.5 + 127.5 * Math.cos(TWO_PI * p + TWO_PI / 3)),
            clamp(127.5 + 127.5 * Math.cos(TWO_PI * p + TWO_PI * 2 / 3))
        ];
    }
    if (y < 192) {
        // Diagonaler Zweikanal-Verlauf (verändert sich mit x UND y)
        const f = (x + y) / (W + H - 2);
        return [clamp(255 * (1 - f)), clamp(60 + 135 * f), clamp(255 * f)];
    }
    // Farbbalken (Breite 16 = 2 Wörter): testet Anker + Slots der Bank
    const c = bars[Math.floor(x / 16) % bars.length];
    return c;
}

// ---------- Bild 2: "Stress" (maximale Belastung) ----------
function stressPx(x, y) {
    if (y < 128) {
        // Perfekt unkorrelierter RGB-Farbrausch (Worst Case pro Pixel)
        return [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
    }
    if (y < 192) {
        // 2-px Schwarz/Weiß-Schachbrett (harte Kanten im Rastermaß)
        const on = ((Math.floor(x / 2) + Math.floor(y / 2)) & 1) === 0;
        return on ? [255, 255, 255] : [0, 0, 0];
    }
    // 1-px diagonales Schachbrett aus zwei satten Komplementärfarben
    const on = ((x & 1) === (y & 1));
    return on ? [255, 255, 0] : [0, 0, 255];
}

// ---------- Erzeugen, schreiben und verifizieren ----------
function writeAndVerify(name, pixelFn) {
    const png = encodePng(W, H, pixelFn);
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, png);

    // Selbsttest: Signatur, IHDR-Maße und IDAT-Dekomprimierung prüfen
    const sigOk = png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    let idatStart = 33 + 13, idatLen = png.readUInt32BE(29);
    // IDAT-Chunk beginnt bei 8(Signatur)+25(IHDR+Header); hier robust über Chunks suchen:
    let pos = 8;
    let rawLen = -1;
    while (pos < png.length) {
        const len = png.readUInt32BE(pos);
        const type = png.toString('ascii', pos + 4, pos + 8);
        if (type === 'IDAT') {
            const inflated = zlib.inflateSync(png.subarray(pos + 8, pos + 8 + len));
            rawLen = inflated.length;
        }
        pos += 12 + len;
    }
    const expect = H * (1 + W * 3);
    console.log(`${name}: ${w}x${h}, ${(png.length / 1024).toFixed(1)} KB, Signatur=${sigOk}, IDAT ok=${rawLen === expect}${sigOk && rawLen === expect ? ' ✅' : ' ❌'}`);
    if (!sigOk || w !== W || h !== H || rawLen !== expect) throw new Error(`PNG-Verifikation fehlgeschlagen für ${name}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
writeAndVerify('ham4bpp-sweet.png', sweetPx);
writeAndVerify('ham4bpp-stress.png', stressPx);
console.log(`Abgelegt in: ${OUT_DIR}`);
