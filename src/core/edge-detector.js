// src/core/edge-detector.js

export function computeEdgeMask(imageData, imgW, imgH, lowThreshold = 50, highThreshold = 150) {
    let src = imageData.data;
    let totalPixels = imgW * imgH;

    // 1. Graustufen-Konvertierung
    let gray = new Float32Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
        let idx = i * 4;
        gray[i] = 0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2];
    }

    // 2. Gauss-Filter (Rauschreduktion)
    let smoothed = new Float32Array(totalPixels);
    const kGaussian = [
        [2, 4,  5,  4, 2],
        [4, 9, 12,  9, 4],
        [5, 12,15, 12, 5],
        [4, 9, 12,  9, 4],
        [2, 4,  5,  4, 2]
    ];
    let kSum = 159;

    for (let y = 2; y < imgH - 2; y++) {
        for (let x = 2; x < imgW - 2; x++) {
            let sum = 0;
            for (let ky = -2; ky <= 2; ky++) {
                for (let kx = -2; kx <= 2; kx++) {
                    sum += gray[(y + ky) * imgW + (x + kx)] * kGaussian[ky + 2][kx + 2];
                }
            }
            smoothed[y * imgW + x] = sum / kSum;
        }
    }

    // 3. Gradienten-Berechnung (Sobel X und Y) & Richtung
    let magnitude = new Float32Array(totalPixels);
    let direction = new Float32Array(totalPixels); // 0: 0°, 1: 45°, 2: 90°, 3: 135°

    const kX = [[-1,0,1], [-2,0,2], [-1,0,1]];
    const kY = [[-1,-2,-1], [0,0,0], [1,2,1]];

    for (let y = 1; y < imgH - 1; y++) {
        for (let x = 1; x < imgW - 1; x++) {
            let gx = 0, gy = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    let val = smoothed[(y + ky) * imgW + (x + kx)];
                    gx += val * kX[ky + 1][kx + 1];
                    gy += val * kY[ky + 1][kx + 1];
                }
            }
            let idx = y * imgW + x;
            magnitude[idx] = Math.sqrt(gx * gx + gy * gy);

            // Richtung quantisieren (0, 45, 90, 135 Grad)
            let angle = Math.atan2(gy, gx) * (180 / Math.PI);
            if (angle < 0) angle += 180;
            
            if ((angle >= 0 && angle < 22.5) || (angle >= 157.5 && angle <= 180)) direction[idx] = 0;
            else if (angle >= 22.5 && angle < 67.5) direction[idx] = 45;
            else if (angle >= 67.5 && angle < 112.5) direction[idx] = 90;
            else direction[idx] = 135;
        }
    }

    // 4. Non-Maximum Suppression (NMS) - Macht Kanten 1 Pixel dünn
    let nms = new Float32Array(totalPixels);
    for (let y = 1; y < imgH - 1; y++) {
        for (let x = 1; x < imgW - 1; x++) {
            let idx = y * imgW + x;
            let m = magnitude[idx];
            let dir = direction[idx];
            let m1 = 0, m2 = 0;

            if (dir === 0) {
                m1 = magnitude[y * imgW + (x - 1)];
                m2 = magnitude[y * imgW + (x + 1)];
            } else if (dir === 45) {
                m1 = magnitude[(y - 1) * imgW + (x + 1)];
                m2 = magnitude[(y + 1) * imgW + (x - 1)];
            } else if (dir === 90) {
                m1 = magnitude[(y - 1) * imgW + x];
                m2 = magnitude[(y + 1) * imgW + x];
            } else if (dir === 135) {
                m1 = magnitude[(y - 1) * imgW + (x - 1)];
                m2 = magnitude[(y + 1) * imgW + (x + 1)];
            }

            if (m >= m1 && m >= m2) {
                nms[idx] = m;
            } else {
                nms[idx] = 0;
            }
        }
    }

    // 5. Hystereseschwelle (Double Threshold & Edge Tracking)
    let outData = new Uint8ClampedArray(totalPixels * 4);
    let edges = new Uint8Array(totalPixels); // 0 = kein, 1 = schwach, 2 = stark

    const STRONG = 2;
    const WEAK = 1;

    for (let i = 0; i < totalPixels; i++) {
        if (nms[i] >= highThreshold) {
            edges[i] = STRONG;
        } else if (nms[i] >= lowThreshold) {
            edges[i] = WEAK;
        }
    }

    // Blob-Verbindung (Hystereseschwelle: Schwache Kanten behalten, wenn mit starker Kante verbunden)
    for (let y = 1; y < imgH - 1; y++) {
        for (let x = 1; x < imgW - 1; x++) {
            let idx = y * imgW + x;
            if (edges[idx] === WEAK) {
                let connectedToStrong = false;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        if (edges[(y + ky) * imgW + (x + kx)] === STRONG) {
                            connectedToStrong = true;
                            break;
                        }
                    }
                    if (connectedToStrong) break;
                }
                if (connectedToStrong) edges[idx] = STRONG;
                else edges[idx] = 0;
            }
        }
    }

    // Finales ImageData erzeugen (Rot markiert für das Overlay)
    for (let i = 0; i < totalPixels; i++) {
        let outIdx = i * 4;
        if (edges[i] === STRONG) {
            outData[outIdx]     = 255; // R
            outData[outIdx + 1] = 0;   // G
            outData[outIdx + 2] = 0;   // B
            outData[outIdx + 3] = 255; // Alpha
        } else {
            outData[outIdx + 3] = 0;   // Transparent
        }
    }

    return new ImageData(outData, imgW, imgH);
}
// src/core/edge-detector.js

export function extractContours(edgeMaskImageData, imgW, imgH, minLength = 5) {
    let data = edgeMaskImageData.data;
    let visited = new Uint8Array(imgW * imgH);
    let contours = [];

    // 8-Wege-Nachbarschaft (Oben, Unten, Links, Rechts + Diagonalen)
    const dirs = [
        [1, 0], [1, 1], [0, 1], [-1, 1], 
        [-1, 0], [-1, -1], [0, -1], [1, -1]
    ];

    for (let y = 0; y < imgH; y++) {
        for (let x = 0; x < imgW; x++) {
            let idx = y * imgW + x;
            
            // Wenn der Pixel rot ist (Kante) und noch nicht besucht wurde
            if (data[idx * 4] > 100 && visited[idx] === 0) {
                let contour = [];
                let stack = [[x, y]];
                visited[idx] = 1;

                // Linie verfolgen (Depth-First-Search)
                while (stack.length > 0) {
                    let [cx, cy] = stack.pop();
                    contour.push({ x: cx, y: cy });

                    // Alle 8 Nachbarn prüfen
                    for (let i = 0; i < dirs.length; i++) {
                        let nx = cx + dirs[i][0];
                        let ny = cy + dirs[i][1];

                        if (nx >= 0 && nx < imgW && ny >= 0 && ny < imgH) {
                            let nIdx = ny * imgW + nx;
                            // Wenn der Nachbar auch eine Kante ist und unbesucht
                            if (data[nIdx * 4] > 100 && visited[nIdx] === 0) {
                                visited[nIdx] = 1;
                                stack.push([nx, ny]);
                            }
                        }
                    }
                }
                
                // Nur Linien behalten, die lang genug sind (Filtert winzige Punkte)
                if (contour.length >= minLength) {
                    contours.push(contour);
                }
            }
        }
    }

    return contours; // Array von Linien. Jede Linie ist ein Array von {x, y} Objekten.
}