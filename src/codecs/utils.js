export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

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

export function get_oklab_dist(r1, g1, b1, r2, g2, b2) {
    const toLin = (c) => {
        let v = c / 255.0;
        return v >= 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
    };

    const toOklab = (r, g, b) => {
        let lr = toLin(r), lg = toLin(g), lb = toLin(b);
        let l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
        let m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
        let s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

        let l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
        return {
            L: 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
            a: 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
            b: 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_
        };
    };

    let o1 = toOklab(r1, g1, b1);
    let o2 = toOklab(r2, g2, b2);
    
    let dL = o1.L - o2.L;
    let da = o1.a - o2.a;
    let db = o1.b - o2.b;
    
    return (dL*dL + da*da + db*db) * 100000.0;
}

export function get_rgb_dist(r1, g1, b1, r2, g2, b2) {
    return ((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2) / 3;
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