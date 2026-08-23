// core/feedback.js

import { clamp } from '../codecs/utils.js';

/**
 * Superschneller separabler Box-Blur (O(N)) mit Fenstergröße W=8
 * Asymmetrisch (4 links, 3 rechts) zur Auslöschung des 32-Bit-Musters.
 * Nutzt strikt "Clamp to Edge" an den Bildrändern.
 */
function boxBlurW8(src, width, height) {
    let dst = new Float32Array(width * height);
    let temp = new Float32Array(width * height);
    const W = 8;
    const halfLeft = 4;
    const halfRight = 3;

    // Horizontaler Pass
    for (let y = 0; y < height; y++) {
        let offset = y * width;
        let sum = 0;
        
        // Initiales Fenster für x=0 aufbauen (Clamp to Edge)
        for (let i = -halfLeft; i <= halfRight; i++) {
            let px = Math.max(0, Math.min(width - 1, i));
            sum += src[offset + px];
        }
        temp[offset] = sum / W;
        
        // Sliding Window (Gleitende Summe)
        for (let x = 1; x < width; x++) {
            let subX = Math.max(0, x - halfLeft - 1);
            let addX = Math.min(width - 1, x + halfRight);
            sum += src[offset + addX] - src[offset + subX];
            temp[offset + x] = sum / W;
        }
    }

    // Vertikaler Pass
    for (let x = 0; x < width; x++) {
        let sum = 0;
        
        // Initiales Fenster für y=0 aufbauen (Clamp to Edge)
        for (let i = -halfLeft; i <= halfRight; i++) {
            let py = Math.max(0, Math.min(height - 1, i));
            sum += temp[py * width + x];
        }
        dst[x] = sum / W;
        
        // Sliding Window
        for (let y = 1; y < height; y++) {
            let subY = Math.max(0, y - halfLeft - 1);
            let addY = Math.min(height - 1, y + halfRight);
            sum += temp[addY * width + x] - temp[subY * width + x];
            dst[y * width + x] = sum / W;
        }
    }
    return dst;
}

/**
 * Führt den Guided Filter Algorithmus aus.
 * Alle Eingaben müssen im genormten Bereich [0.0, 1.0] vorliegen.
 */
function guidedFilter(guide, target, width, height, epsilon) {
    const N = width * height;
    
    let mean_I = boxBlurW8(guide, width, height);
    let mean_p = boxBlurW8(target, width, height);
    
    let II = new Float32Array(N);
    let Ip = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        II[i] = guide[i] * guide[i];
        Ip[i] = guide[i] * target[i];
    }
    
    let mean_II = boxBlurW8(II, width, height);
    let mean_Ip = boxBlurW8(Ip, width, height);
    
    let a = new Float32Array(N);
    let b = new Float32Array(N);
    
    for (let i = 0; i < N; i++) {
        let var_I = mean_II[i] - mean_I[i] * mean_I[i];
        let cov_Ip = mean_Ip[i] - mean_I[i] * mean_p[i];
        
        a[i] = cov_Ip / (var_I + epsilon);
        b[i] = mean_p[i] - a[i] * mean_I[i];
    }
    
    let mean_a = boxBlurW8(a, width, height);
    let mean_b = boxBlurW8(b, width, height);
    
    let q = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        q[i] = mean_a[i] * guide[i] + mean_b[i];
    }
    
    return q;
}

/**
 * Berechnet das manipulierte Zielbild für den Encoder (Pre-Compensation).
 * Nutzt das Luma-Leitbild zur Kanten-Erhaltung.
 * 
 * @param {boolean} returnErrorMap - Wenn true, wird zusätzlich ein verstärktes Fehler-Overlay zurückgegeben.
 */
export function generateFeedbackTarget(originalRgba, decodedRgba, width, height, lambda, epsilon, returnErrorMap = false) {
    const N = width * height;
    let guide = new Float32Array(N);
    let targetR = new Float32Array(N);
    let targetG = new Float32Array(N);
    let targetB = new Float32Array(N);

    // 1. Leitbild (Luma) und Fehlerkarten extrahieren (genormt auf 0..1)
    for (let i = 0; i < N; i++) {
        let idx = i * 4;
        let oR = originalRgba[idx] / 255.0;
        let oG = originalRgba[idx + 1] / 255.0;
        let oB = originalRgba[idx + 2] / 255.0;
        
        let dR = decodedRgba[idx] / 255.0;
        let dG = decodedRgba[idx + 1] / 255.0;
        let dB = decodedRgba[idx + 2] / 255.0;

        // Y-Kanal Berechnung
        guide[i] = 0.299 * oR + 0.587 * oG + 0.114 * oB;
        
        // Roher Fehler: Original minus Rekonstruktion
        targetR[i] = oR - dR;
        targetG[i] = oG - dG;
        targetB[i] = oB - dB;
    }

    // 2. Guided Filter über die Fehlerkarten laufen lassen
    let filteredR = guidedFilter(guide, targetR, width, height, epsilon);
    let filteredG = guidedFilter(guide, targetG, width, height, epsilon);
    let filteredB = guidedFilter(guide, targetB, width, height, epsilon);

    // 3. Neues Zielbild und optionales Fehler-Overlay berechnen
    let newTargetRgba = new Uint8ClampedArray(N * 4);
    let errorMapRgba = returnErrorMap ? new Uint8ClampedArray(N * 4) : null;

    for (let i = 0; i < N; i++) {
        let idx = i * 4;
        let nr = Math.round(originalRgba[idx] + (filteredR[i] * lambda * 255.0));
        let ng = Math.round(originalRgba[idx + 1] + (filteredG[i] * lambda * 255.0));
        let nb = Math.round(originalRgba[idx + 2] + (filteredB[i] * lambda * 255.0));

        newTargetRgba[idx] = clamp(nr, 0, 255);
        newTargetRgba[idx + 1] = clamp(ng, 0, 255);
        newTargetRgba[idx + 2] = clamp(nb, 0, 255);
        newTargetRgba[idx + 3] = 255;

        // Fehlerkarte bauen (5-fach verstärkt für bessere Sichtbarkeit)
        if (returnErrorMap) {
            errorMapRgba[idx]     = clamp(Math.abs(filteredR[i]) * 255.0 * 5, 0, 255);
            errorMapRgba[idx + 1] = clamp(Math.abs(filteredG[i]) * 255.0 * 5, 0, 255);
            errorMapRgba[idx + 2] = clamp(Math.abs(filteredB[i]) * 255.0 * 5, 0, 255);
            errorMapRgba[idx + 3] = 255;
        }
    }

    if (returnErrorMap) {
        return { target: newTargetRgba, errorMap: errorMapRgba };
    }
    return newTargetRgba;
}