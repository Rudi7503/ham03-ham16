// core/feedback.js

// Hilfsfunktion zum Extrahieren der Bit-Tiefe
function getFormatBits(fmt) {
    if (!fmt) return 8;
    if (fmt.includes("01")) return 1;
    if (fmt.includes("02")) return 2;
    if (fmt.includes("03")) return 3;
    if (fmt.includes("04")) return 4;
    if (fmt.includes("05")) return 5;
    if (fmt.includes("06")) return 6;
    return 8;
}

/**
 * Smart Bandwidth Filter mit Double Buffering:
 * Verhindert das "Verschmieren" (Kaskadieren) von Pixeln im selben Durchlauf.
 */
export function applySmartBandwidthFilter(originalRgba, decodedRgba, width, height, stepVal, config, currentFormat, tolerance = 2.5) {
    const N = width * height;
    let targetRgba = new Uint8ClampedArray(originalRgba); 
    
    let isGood = new Uint8Array(N);
    let sequence = config.isMixed && config.sequence ? config.sequence : [currentFormat];
    let stepThreshold = (stepVal.r + stepVal.g + stepVal.b) * tolerance; 

    // 1. Schwellenwert-Analyse und Maskierung
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let i = y * width + x;
            let idx = i * 4;
            
            let err = Math.abs(originalRgba[idx] - decodedRgba[idx]) + 
                      Math.abs(originalRgba[idx+1] - decodedRgba[idx+1]) + 
                      Math.abs(originalRgba[idx+2] - decodedRgba[idx+2]);
            
            isGood[i] = err <= stepThreshold ? 1 : 0;
        }
    }

    // 2. Spatial Shift (Bandweiten-Routing)
    let shiftedRgba = new Uint8ClampedArray(targetRgba);
    let shiftCount = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let i = y * width + x;
            if (isGood[i]) continue; 

            let seqIdx = x % sequence.length;
            let fmt = sequence[seqIdx];
            let bits = getFormatBits(fmt);

            if (bits <= 4 && x > 0 && x < width - 1) {
                let leftFmt = sequence[(x - 1) % sequence.length];
                let rightFmt = sequence[(x + 1) % sequence.length];
                
                let leftBits = getFormatBits(leftFmt);
                let rightBits = getFormatBits(rightFmt);

                let targetX = x;
                if (leftBits > bits && leftBits >= rightBits) targetX = x - 1;
                else if (rightBits > bits) targetX = x + 1;

                if (targetX !== x) {
                    let targetIdx = (y * width + targetX) * 4;
                    let srcIdx = i * 4;
                    shiftedRgba[targetIdx]     = originalRgba[srcIdx];
                    shiftedRgba[targetIdx + 1] = originalRgba[srcIdx + 1];
                    shiftedRgba[targetIdx + 2] = originalRgba[srcIdx + 2];
                    
                    shiftCount++;
                }
            }
        }
    }

    // 3. Modifizierter 3x3 Gauß-Filter mit Double Buffering
    // Wir lesen AUS dem geshiften Puffer und schreiben IN ein separates Ziel-Array,
    // damit modifizierte Pixel die Nachbarbereiche im selben Durchlauf nicht "verseuchen".
    let finalTarget = new Uint8ClampedArray(shiftedRgba);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let i = y * width + x;
            if (isGood[i]) continue; // Geschützte Bereiche bleiben komplett unangetastet

            let seqIdx = x % sequence.length;
            let fmt = sequence[seqIdx];
            let bits = getFormatBits(fmt);

            let centerWeight = (bits >= 6) ? 8 : (bits >= 4 ? 4 : 2);
            
            let sumR = 0, sumG = 0, sumB = 0, totalWeight = 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    let nx = x + dx;
                    let ny = y + dy;
                    
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        let ni = ny * width + nx;
                        let nIdx = ni * 4;
                        
                        let weight = 0;
                        if (dx === 0 && dy === 0) {
                            weight = centerWeight;
                        } else {
                            // Gute Kanten-Pixel zählen doppelt als Anker
                            weight = isGood[ni] ? 2 : 1; 
                        }

                        // WICHTIG: Lesen aus shiftedRgba (Read-Only Quelle für den Filter)
                        sumR += shiftedRgba[nIdx] * weight;
                        sumG += shiftedRgba[nIdx + 1] * weight;
                        sumB += shiftedRgba[nIdx + 2] * weight;
                        totalWeight += weight;
                    }
                }
            }

            let outIdx = i * 4;
            // Schreiben in den separaten finalTarget Puffer
            finalTarget[outIdx]     = sumR / totalWeight;
            finalTarget[outIdx + 1] = sumG / totalWeight;
            finalTarget[outIdx + 2] = sumB / totalWeight;
            finalTarget[outIdx + 3] = 255; 
        }
    }

    return { target: finalTarget, shiftCount: shiftCount };
}