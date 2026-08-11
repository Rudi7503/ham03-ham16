// src/codecs/utils.js

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// Farbabstands-Metriken
export function get_yuv_dist(r1, g1, b1, r2, g2, b2) {
    return (0.299 * (r1 - r2) ** 2) + (0.587 * (g1 - g2) ** 2) + (0.114 * (b1 - b2) ** 2);
}
export function get_yuv_dist_weight(r1, g1, b1, r2, g2, b2) {
    let y1 =  0.299 * r1 + 0.587 * g1 + 0.114 * b1;
    let u1 = -0.147 * r1 - 0.289 * g1 + 0.436 * b1;
    let v1 =  0.615 * r1 - 0.515 * g1 - 0.100 * b1;

    let y2 =  0.299 * r2 + 0.587 * g2 + 0.114 * b2;
    let u2 = -0.147 * r2 - 0.289 * g2 + 0.436 * b2;
    let v2 =  0.615 * r2 - 0.515 * g2 - 0.100 * b2;

    let dy = y1 - y2;
    let du = u1 - u2;
    let dv = v1 - v2;

    // Summe der Gewichte (4 + 1 + 1 = 6) -> durch 6.0 teilen für Normalisierung
    return ((dy * dy * 4.0) + (du * du * 1.0) + (dv * dv * 1.0)) / 6.0;
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