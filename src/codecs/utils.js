// src/codecs/utils.js

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// Farbabstands-Metriken
export function get_yuv_dist(r1, g1, b1, r2, g2, b2) {
    return (0.299 * (r1 - r2) ** 2) + (0.587 * (g1 - g2) ** 2) + (0.114 * (b1 - b2) ** 2);
}

export function get_rgb_dist(r1, g1, b1, r2, g2, b2) {
    return ((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) / 3;
}

// Farb-Konvertierung für die HTML UI (Builder Modal)
export function hexToRgb(h) { 
    let b = parseInt(h.slice(1), 16); 
    return [(b >> 16) & 255, (b >> 8) & 255, b & 255]; 
}

export function rgbToHex(r, g, b) { 
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).padStart(6, '0'); 
}

// Generisches N-Bit Packing (für HAM05, HAM06 etc.)
export function pack_nbit(w, n) {
    let o = [], b = 0, bi = 0, m = (1 << n) - 1;
    for (let i = 0; i < w.length; i++) {
        b = (b << n) | (w[i] & m);
        bi += n;
        while (bi >= 8) {
            bi -= 8;
            o.push((b >> bi) & 0xFF);
        }
    }
    // Restliche Bits auffüllen
    if (bi > 0) o.push((b << (8 - bi)) & 0xFF);
    return new Uint8Array(o);
}

// Generisches N-Bit Unpacking
export function unpack_nbit(d, n, c) {
    let w = new Uint8Array(c), b = 0, bi = 0, p = 0, m = (1 << n) - 1;
    for (let i = 0; i < c; i++) {
        while (bi < n && p < d.length) {
            b = (b << 8) | d[p++];
            bi += 8;
        }
        if (bi >= n) {
            bi -= n;
            w[i] = (b >> bi) & m;
        } else {
            w[i] = 0;
        }
    }
    return w;
}