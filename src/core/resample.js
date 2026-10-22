// Hochwertige Bildskalierung, unabhängig von Canvas.
//
// Drei Verfahren, die sich objektiv vergleichen lassen:
//   'wavelet'  – dyadische Tiefpass-Schritte mit dem 9/7-Wavelet-Analysefilter
//                (CDF 9/7), danach ein bandbegrenzter Lanczos-3-Rest für den
//                nicht-dyadischen Restfaktor.
//   'lanczos'  – reines Lanczos-3 (windowed sinc), separierbar.
//   'box'      – Flächenmittel (nur Verkleinern), Referenz zum Vergleich.
//
// Alle Verfahren sind separierbar (erst horizontal, dann vertikal) und behandeln
// den Rand durch Spiegelung. Alpha wird auf 255 gesetzt.

const LANCZOS_HALF = 3;

function lanczos3(x) {
    if (x === 0) return 1;
    const ax = Math.abs(x);
    if (ax >= LANCZOS_HALF) return 0;
    const px = Math.PI * x;
    return (Math.sin(px) / px) * (Math.sin(px / LANCZOS_HALF) / (px / LANCZOS_HALF));
}

// CDF-9/7-Analysefilter (Tiefpass). Die rohen Koeffizienten sind auf sqrt(2)
// normiert (DWT-Konvention); hier auf Summe 1 gebracht, damit der Tiefpass
// die Helligkeit erhält (DC-neutral).
const LP97_RAW = [
    0.026748757411, -0.016864118443, -0.078223266529, 0.266864118443,
    0.602949018236, 0.266864118443, -0.078223266529, -0.016864118443,
    0.026748757411
];
const LP97_SUM = LP97_RAW.reduce((a, b) => a + b, 0);
const LP97 = LP97_RAW.map(v => v / LP97_SUM);

// ---------------------------------------------------------------------------
// Gewichte je Zielposition (eine Achse)
// ---------------------------------------------------------------------------
function axisWeights(srcLen, dstLen, kernel, support) {
    const scale = srcLen / dstLen;
    // Beim Verkleinern wird der Kernel mit dem Faktor gestreckt: das ist der
    // Anti-Alias-Tiefpass. Beim Vergrößern bleibt er schmal (reine Interpolation).
    const fscale = scale > 1 ? scale : 1;
    const radius = support * fscale;
    const out = new Array(dstLen);

    for (let d = 0; d < dstLen; d++) {
        const center = (d + 0.5) * scale - 0.5;
        const lo = Math.ceil(center - radius);
        const hi = Math.floor(center + radius);
        const idx = [];
        const wg = [];
        let sum = 0;
        for (let i = lo; i <= hi; i++) {
            const v = kernel((i - center) / fscale);
            if (v === 0) continue;
            // Randspiegelung
            let si = i;
            if (si < 0) si = -si - 1;
            if (si >= srcLen) si = 2 * srcLen - si - 1;
            if (si < 0) si = 0;
            if (si >= srcLen) si = srcLen - 1;
            idx.push(si); wg.push(v); sum += v;
        }
        if (sum !== 0) for (let k = 0; k < wg.length; k++) wg[k] /= sum;
        out[d] = { idx, w: wg };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Separierbare Anwendung: horizontal auf Float, dann vertikal nach RGBA
// ---------------------------------------------------------------------------
function resample(src, sw, sh, dw, dh, kernel, support) {
    const wx = axisWeights(sw, dw, kernel, support);
    const wy = axisWeights(sh, dh, kernel, support);

    // horizontal: sw x sh -> dw x sh
    const tmp = new Float32Array(dw * sh * 3);
    for (let y = 0; y < sh; y++) {
        const rowIn = y * sw * 4;
        const rowOut = y * dw * 3;
        for (let x = 0; x < dw; x++) {
            const { idx, w } = wx[x];
            let r = 0, g = 0, b = 0;
            for (let k = 0; k < idx.length; k++) {
                const o = rowIn + idx[k] * 4;
                const wk = w[k];
                r += src[o] * wk; g += src[o + 1] * wk; b += src[o + 2] * wk;
            }
            const t = rowOut + x * 3;
            tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
        }
    }

    // vertikal: dw x sh -> dw x dh
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const { idx, w } = wy[y];
        const rowOut = y * dw * 4;
        for (let x = 0; x < dw; x++) {
            let r = 0, g = 0, b = 0;
            const col = x * 3;
            for (let k = 0; k < idx.length; k++) {
                const t = idx[k] * dw * 3 + col;
                const wk = w[k];
                r += tmp[t] * wk; g += tmp[t + 1] * wk; b += tmp[t + 2] * wk;
            }
            const o = rowOut + x * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Dyadischer Wavelet-Schritt: 9/7-Tiefpass + Dezimierung um 2 je Achse
// ---------------------------------------------------------------------------
function lowpassHalfWidth(src, sw, sh) {
    const dw = Math.max(1, Math.ceil(sw / 2));
    const out = new Float32Array(dw * sh * 4);
    const half = (LP97.length - 1) / 2;
    for (let y = 0; y < sh; y++) {
        const rowIn = y * sw * 4, rowOut = y * dw * 4;
        for (let x = 0; x < dw; x++) {
            // Ausgabepixel x deckt die Quellpixel [2x, 2x+1] ab, sein Mittelpunkt
            // liegt also bei 2x+1 (nicht bei 2x). Ein Versatz hier wäre ein halber
            // Pixel Bildverschiebung und würde die Rundreise messbar verschlechtern.
            const center = x * 2 + 1;
            let r = 0, g = 0, b = 0;
            for (let k = -half; k <= half; k++) {
                let sx = center + k;
                if (sx < 0) sx = -sx - 1;
                if (sx >= sw) sx = 2 * sw - sx - 1;
                if (sx < 0) sx = 0;
                if (sx >= sw) sx = sw - 1;
                const o = rowIn + sx * 4;
                const w = LP97[k + half];
                r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w;
            }
            const t = rowOut + x * 4;
            out[t] = r; out[t + 1] = g; out[t + 2] = b; out[t + 3] = 255;
        }
    }
    return { data: out, w: dw, h: sh };
}

function lowpassHalfHeight(src, sw, sh) {
    const dh = Math.max(1, Math.ceil(sh / 2));
    const out = new Float32Array(sw * dh * 4);
    const half = (LP97.length - 1) / 2;
    for (let y = 0; y < dh; y++) {
        const center = y * 2 + 1;   // Mitte des 2er-Blocks, siehe lowpassHalfWidth
        const rowOut = y * sw * 4;
        for (let x = 0; x < sw; x++) {
            const col = x * 4;
            let r = 0, g = 0, b = 0;
            for (let k = -half; k <= half; k++) {
                let sy = center + k;
                if (sy < 0) sy = -sy - 1;
                if (sy >= sh) sy = 2 * sh - sy - 1;
                if (sy < 0) sy = 0;
                if (sy >= sh) sy = sh - 1;
                const o = sy * sw * 4 + col;
                const w = LP97[k + half];
                r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w;
            }
            const t = rowOut + col;
            out[t] = r; out[t + 1] = g; out[t + 2] = b; out[t + 3] = 255;
        }
    }
    return { data: out, w: sw, h: dh };
}

function toU8(src, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out;
}

// ---------------------------------------------------------------------------
// Öffentliche Verfahren
// ---------------------------------------------------------------------------

// Wavelet: solange beide Achsen mindestens um Faktor 2 verkleinert werden,
// dyadische 9/7-Tiefpass-Schritte; den Rest übernimmt Lanczos.
export function resizeWavelet(src, sw, sh, dw, dh) {
    if (dw === sw && dh === sh) return new Uint8ClampedArray(src);

    let cur = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) cur[i] = src[i];
    let cw = sw, ch = sh;

    let k = 0;
    while (cw >= dw * 2 && ch >= dh * 2) {
        const a = lowpassHalfWidth(cur, cw, ch);
        const b = lowpassHalfHeight(a.data, a.w, a.h);
        cur = b.data; cw = b.w; ch = b.h;
        k++;
        if (k > 12) break; // Sicherheitsnetz
    }

    if (cw === dw && ch === dh) return toU8(cur, cw, ch);
    return resample(toU8(cur, cw, ch), cw, ch, dw, dh, lanczos3, LANCZOS_HALF);
}

export function resizeLanczos(src, sw, sh, dw, dh) {
    if (dw === sw && dh === sh) return new Uint8ClampedArray(src);
    return resample(src, sw, sh, dw, dh, lanczos3, LANCZOS_HALF);
}

// Flächenmittel über den überdeckten Quellbereich (nur Verkleinern sinnvoll).
export function resizeBox(src, sw, sh, dw, dh) {
    if (dw === sw && dh === sh) return new Uint8ClampedArray(src);
    const out = new Uint8ClampedArray(dw * dh * 4);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * sy)));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * sx)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const o = (yy * sw + xx) * 4;
                    r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
                }
            }
            const o = (y * dw + x) * 4;
            out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
        }
    }
    return out;
}

export function resizeImage(src, sw, sh, dw, dh, method = 'wavelet') {
    if (method === 'lanczos') return resizeLanczos(src, sw, sh, dw, dh);
    if (method === 'box') return resizeBox(src, sw, sh, dw, dh);
    return resizeWavelet(src, sw, sh, dw, dh);
}

// ---------------------------------------------------------------------------
// Seitenverhältnistreues Skalieren in einen festen Rahmen
// ---------------------------------------------------------------------------
// 'fit'  – ganzes Bild hineinpassen, Ränder bleiben schwarz (nichts geht verloren)
// 'fill' – Rahmen füllen, Überstand wird beschnitten (keine Ränder, Randbereiche weg)
// In beiden Fällen wird NICHT verzerrt; nur 'stretch' würde das (absichtlich nicht
// mehr angeboten, weil es Bilder staucht).
export function innerSize(sw, sh, dw, dh, mode) {
    const s = mode === 'fill'
        ? Math.max(dw / sw, dh / sh)
        : Math.min(dw / sw, dh / sh);
    return {
        w: Math.max(1, Math.round(sw * s)),
        h: Math.max(1, Math.round(sh * s))
    };
}

export function resizeInto(src, sw, sh, dw, dh, method = 'lanczos', mode = 'fit') {
    const { w: iw, h: ih } = innerSize(sw, sh, dw, dh, mode);
    const inner = resizeImage(src, sw, sh, iw, ih, method);

    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;   // Alpha, RGB bleibt 0

    const ox = Math.round((dw - iw) / 2);
    const oy = Math.round((dh - ih) / 2);

    // Überlappungsbereich (bei 'fill' ist das innere Bild größer als der Rahmen)
    const sx0 = Math.max(0, -ox), sy0 = Math.max(0, -oy);
    const sx1 = Math.min(iw, dw - ox), sy1 = Math.min(ih, dh - oy);

    for (let y = sy0; y < sy1; y++) {
        const dy = y + oy;
        if (dy < 0 || dy >= dh) continue;
        for (let x = sx0; x < sx1; x++) {
            const dx = x + ox;
            if (dx < 0 || dx >= dw) continue;
            const s = (y * iw + x) * 4;
            const d = (dy * dw + dx) * 4;
            out[d] = inner[s]; out[d + 1] = inner[s + 1]; out[d + 2] = inner[s + 2];
        }
    }
    return { pixels: out, innerW: iw, innerH: ih, offsetX: ox, offsetY: oy };
}
