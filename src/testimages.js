// src/testimages.js
//
// Prozedurale Testbild-Generierung für die 4-bit/pixel HAM-Modi.
// Pure Kernfunktion (testImagePixels) ohne DOM — kann auch unter Node getestet
// werden; generateTestImage erzeugt daraus ein ImageData für die Canvas-API.

export const TEST_IMAGE_SIZES = [16, 32, 64, 128, 256, 512];

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const clampF = (v) => Math.max(0, Math.min(255, v));

function setPx(pix, size, x, y, r, g, b) {
    const o = (y * size + x) * 4;
    pix[o] = r; pix[o + 1] = g; pix[o + 2] = b; pix[o + 3] = 255;
}

// ---------------------------------------------------------------------------
// Stil: Stress — Rauschen, Schachbrett, 1-px-Muster (Worst Case)
// ---------------------------------------------------------------------------
function fillStress(pix, size) {
    const yNoiseEnd = Math.floor(size * 0.5);
    const yCheckEnd = Math.floor(size * 0.75);
    const cell = Math.max(1, Math.round(size / 128)); // Schachbrett skaliert mit
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (y < yNoiseEnd) {
                setPx(pix, size, x, y,
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256),
                    Math.floor(Math.random() * 256));
            } else if (y < yCheckEnd) {
                const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
                setPx(pix, size, x, y, on ? 255 : 0, on ? 255 : 0, on ? 255 : 0);
            } else {
                const on = ((x & 1) === (y & 1));
                setPx(pix, size, x, y, on ? 255 : 255, on ? 255 : 0, on ? 0 : 255);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stil: Sweet — glatte Verläufe + Farbbalken (Stärken ausreizen)
// ---------------------------------------------------------------------------
const SWEET_BARS = [
    [0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0], [128, 255, 0],
    [0, 255, 128], [0, 128, 255], [128, 0, 255], [255, 0, 128], [128, 128, 128], [32, 32, 32]
];
const TWO_PI = Math.PI * 2;

function fillSweet(pix, size) {
    const band1 = Math.floor(size * 0.25);
    const band2 = Math.floor(size * 0.5);
    const band3 = Math.floor(size * 0.75);
    const bw = Math.max(1, Math.round(size / 16)); // Balkenbreite (ein Wort bzw. 2 Wörter)
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (y < band1) {
                const v = clamp((x / (size - 1)) * 255);
                setPx(pix, size, x, y, v, v, v);
            } else if (y < band2) {
                const p = x / (size - 1);
                setPx(pix, size, x, y,
                    clamp(127.5 + 127.5 * Math.cos(TWO_PI * p)),
                    clamp(127.5 + 127.5 * Math.cos(TWO_PI * p + TWO_PI / 3)),
                    clamp(127.5 + 127.5 * Math.cos(TWO_PI * p + TWO_PI * 2 / 3)));
            } else if (y < band3) {
                const f = (x + y) / (size * 2 - 2);
                setPx(pix, size, x, y,
                    clamp(255 * (1 - f)),
                    clamp(60 + 135 * f),
                    clamp(255 * f));
            } else {
                const c = SWEET_BARS[Math.floor(x / bw) % SWEET_BARS.length];
                setPx(pix, size, x, y, c[0], c[1], c[2]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stil: Real — prozeduraler, glatter "Foto"-Look (Himmel, Sonne, Wiese/Wasser)
// ---------------------------------------------------------------------------
function fillReal(pix, size) {
    const sx = Math.floor(size * 0.72);
    const sy = Math.floor(size * 0.22);
    const sunR = Math.max(4, size * 0.13);
    const skyTop = [92, 148, 235], skyHor = [226, 229, 242];
    const waterTop = [96, 150, 190], waterDeep = [16, 44, 96];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const h = Math.floor(size * 0.52 + size * 0.10 * Math.cos((x / size) * TWO_PI));
            const dx = x - sx, dy = y - sy;
            const d = Math.sqrt(dx * dx + dy * dy);
            const glow = Math.exp(-(d * d) / (sunR * sunR)); // weiche Sonne 0..1
            if (y < h) {
                const t = h > 0 ? y / h : 0;
                let r = skyTop[0] + (skyHor[0] - skyTop[0]) * t;
                let g = skyTop[1] + (skyHor[1] - skyTop[1]) * t;
                let b = skyTop[2] + (skyHor[2] - skyTop[2]) * t;
                r += glow * 70; g += glow * 60; b += glow * 40;
                setPx(pix, size, x, y, clampF(r), clampF(g), clampF(b));
            } else {
                const t = (y - h) / Math.max(1, size - h);
                // Wiese oben, Wasser unten, sanfter Übergang
                let r = waterTop[0] + (waterDeep[0] - waterTop[0]) * t;
                let g = waterTop[1] + (waterDeep[1] - waterTop[1]) * t;
                let b = waterTop[2] + (waterDeep[2] - waterTop[2]) * t;
                const shimmer = 6 * Math.sin(x * 0.8 + y * 0.2); // sanfte Wellen
                g += shimmer; b += shimmer * 0.6;
                r += glow * 40; g += glow * 30;
                setPx(pix, size, x, y, clampF(r), clampF(g), clampF(b));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stil: Pixelstyle — symmetrischer 16x16 "Alien", scharf hochskaliert
// ---------------------------------------------------------------------------
const PX_MAP = {
    '.': [20, 24, 34],  // Hintergrund
    k: [10, 10, 12],    // Outline
    g: [104, 224, 112], // Körper hell
    G: [28, 130, 62],   // Körper dunkel
    d: [12, 74, 34],    // Füße / Details
    w: [255, 255, 255], // Weiß
    r: [255, 70, 60],   // Rot (Augen)
    y: [252, 216, 40]   // Gelb (Antenne)
};
const PX_SPRITE = [
    "................",
    ".......yy.......",
    "......ywwy......",
    "......wkkw......",
    "...kkggggggkk...",
    "..kggrrwwrrggk..",
    ".kgrrrwwwwrrrgk.",
    "kggggggggggggggk",
    "kgGggggggggggGgk",
    "kgGGggggggggGGgk",
    ".kGggggggggggGk.",
    "..kGkkkkkkkkGk..",
    "...kkddddddkk...",
    "....kddddddk....",
    "....kdd..ddk....",
    "....kk....kk...."
];

function fillPixelstyle(pix, size) {
    const block = size / 16; // alle erlaubten Größen sind durch 16 teilbar
    for (let y = 0; y < size; y++) {
        const sy = Math.min(15, Math.floor(y / block));
        const row = PX_SPRITE[sy];
        for (let x = 0; x < size; x++) {
            const sx = Math.min(15, Math.floor(x / block));
            const c = PX_MAP[row[sx]];
            setPx(pix, size, x, y, c[0], c[1], c[2]);
        }
    }
}

// ---------------------------------------------------------------------------
// Einstiegspunkte
// ---------------------------------------------------------------------------
export function testImagePixels(type, size) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`Ungültige Größe: ${size}`);
    if (size % 1 !== 0 || size > 4096) throw new Error(`Ungültige Größe: ${size}`);
    const pix = new Uint8ClampedArray(size * size * 4);
    switch (type) {
        case 'stress': fillStress(pix, size); break;
        case 'sweet': fillSweet(pix, size); break;
        case 'real': fillReal(pix, size); break;
        case 'pixelstyle': fillPixelstyle(pix, size); break;
        default: throw new Error(`Unbekannter Testbild-Typ: ${type}`);
    }
    return pix;
}

export function generateTestImage(type, size) {
    return new ImageData(testImagePixels(type, size), size, size);
}
