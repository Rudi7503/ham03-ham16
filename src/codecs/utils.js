export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

export function get_yuv_dist(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return (0.299 * dr * dr) + (0.587 * dg * dg) + (0.114 * db * db);
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

    return ((dy * dy * 4.0) + (du * du * 1.0) + (dv * dv * 1.0)) / 6.0;
}

export function get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2) {
    let y1 =  0.299 * r1 + 0.587 * g1 + 0.114 * b1;
    let u1 = -0.147 * r1 - 0.289 * g1 + 0.436 * b1;
    let v1 =  0.615 * r1 - 0.515 * g1 - 0.100 * b1;

    let y2 =  0.299 * r2 + 0.587 * g2 + 0.114 * b2;
    let u2 = -0.147 * r2 - 0.289 * g2 + 0.436 * b2;
    let v2 =  0.615 * r2 - 0.515 * g2 - 0.100 * b2;

    let dy = y1 - y2;
    let du = u1 - u2;
    let dv = v1 - v2;

    return ((dy * dy * 8.0) + (du * du * 1.0) + (dv * dv * 1.0)) / 10.0;
}

export function get_redmean_dist(r1, g1, b1, r2, g2, b2) {
    let rMean = (r1 + r2) / 2.0;
    let dr = r1 - r2;
    let dg = g1 - g2;
    let db = b1 - b2;
    
    let weightR = 2.0 + (rMean / 256.0);
    let weightG = 4.0;
    let weightB = 2.0 + ((255.0 - rMean) / 256.0);
    
    return (weightR * dr * dr + weightG * dg * dg + weightB * db * db) / 9.0;
}

// Lookup-Tabelle: sRGB-Kanal (0-255) → lineare Helligkeit.
// Vermeidet 6x Math.pow() pro Distanz-Berechnung. Oklab ist die
// rechenintensivste Metrik des Encoders und wird pro Pixel mehrfach aufgerufen.
const SRGB_TO_LINEAR = (() => {
    const lut = new Float64Array(256);
    for (let c = 0; c < 256; c++) {
        const v = c / 255.0;
        lut[c] = v >= 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
    }
    return lut;
})();

export function get_oklab_dist(r1, g1, b1, r2, g2, b2) {
    // Vollständig inline berechnet: keine Closure- und Objekt-Allokationen pro Pixel.
    const lr1 = SRGB_TO_LINEAR[r1], lg1 = SRGB_TO_LINEAR[g1], lb1 = SRGB_TO_LINEAR[b1];
    const lr2 = SRGB_TO_LINEAR[r2], lg2 = SRGB_TO_LINEAR[g2], lb2 = SRGB_TO_LINEAR[b2];

    const l1 = 0.4122214708*lr1 + 0.5363325363*lg1 + 0.0514459929*lb1;
    const m1 = 0.2119034982*lr1 + 0.6806995451*lg1 + 0.1073969566*lb1;
    const s1 = 0.0883024619*lr1 + 0.2817188376*lg1 + 0.6299787005*lb1;
    const l1_ = Math.cbrt(l1), m1_ = Math.cbrt(m1), s1_ = Math.cbrt(s1);
    const L1 = 0.2104542553*l1_ + 0.7936177850*m1_ - 0.0040720468*s1_;
    const A1 = 1.9779984951*l1_ - 2.4285922050*m1_ + 0.4505937099*s1_;
    const B1 = 0.0259040371*l1_ + 0.7827717662*m1_ - 0.8086757660*s1_;

    const l2 = 0.4122214708*lr2 + 0.5363325363*lg2 + 0.0514459929*lb2;
    const m2 = 0.2119034982*lr2 + 0.6806995451*lg2 + 0.1073969566*lb2;
    const s2 = 0.0883024619*lr2 + 0.2817188376*lg2 + 0.6299787005*lb2;
    const l2_ = Math.cbrt(l2), m2_ = Math.cbrt(m2), s2_ = Math.cbrt(s2);
    const L2 = 0.2104542553*l2_ + 0.7936177850*m2_ - 0.0040720468*s2_;
    const A2 = 1.9779984951*l2_ - 2.4285922050*m2_ + 0.4505937099*s2_;
    const B2 = 0.0259040371*l2_ + 0.7827717662*m2_ - 0.8086757660*s2_;

    const dL = L1 - L2, dA = A1 - A2, dB = B1 - B2;
    return (dL*dL + dA*dA + dB*dB) * 100000.0;
}

export function get_rgb_dist(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return (dr * dr + dg * dg + db * db) / 3;
}

export function get_rgb_abs_dist(r1, g1, b1, r2, g2, b2) {
    return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

export function getMetricDistFunc(metric) {
    if (metric === 'oklab') return get_oklab_dist;
    if (metric === 'redmean') return get_redmean_dist;
    if (metric === 'yuv_weight_heavy') return get_yuv_dist_weight_heavy;
    if (metric === 'rgb') return get_rgb_dist;
    if (metric === 'rgb_ABS') return get_rgb_abs_dist;
    if (metric === 'yuv') return get_yuv_dist;
    return get_yuv_dist_weight;
}

export function hexToRgb(h) { 
    let b = parseInt(h.slice(1), 16); 
    return [(b >> 16) & 255, (b >> 8) & 255, b & 255]; 
}

export function rgbToHex(r, g, b) { 
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).padStart(6, '0'); 
}