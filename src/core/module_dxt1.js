// src/core/module_dxt1.js

function colorTo565(r, g, b) {
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function colorFrom565(c) {
    let r5 = (c >> 11) & 31;
    let g6 = (c >> 5) & 63;
    let b5 = c & 31;
    return {
        r: (r5 << 3) | (r5 >> 2),
        g: (g6 << 2) | (g6 >> 4),
        b: (b5 << 3) | (b5 >> 2)
    };
}

function getLuminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getDistance(r1, g1, b1, r2, g2, b2) {
    return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

export function encodeDXT1(imgData, imgW, imgH) {
    // DXT1 benötigt durch 4 teilbare Auflösungen
    let blocksX = Math.ceil(imgW / 4);
    let blocksY = Math.ceil(imgH / 4);
    let buffer = new ArrayBuffer(blocksX * blocksY * 8); // 8 Bytes pro 4x4 Block
    let view = new DataView(buffer);
    let offset = 0;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            let blockPixels = [];
            let minLuma = 256, maxLuma = -1;
            let minColor = [0, 0, 0], maxColor = [255, 255, 255];

            // 1. Pixel des 4x4 Blocks einlesen & Min/Max Luminanz finden
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    let px = bx * 4 + x;
                    let py = by * 4 + y;
                    if (px >= imgW) px = imgW - 1;
                    if (py >= imgH) py = imgH - 1;

                    let idx = (py * imgW + px) * 4;
                    let r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
                    blockPixels.push({ r, g, b });

                    let luma = getLuminance(r, g, b);
                    if (luma > maxLuma) { maxLuma = luma; maxColor = [r, g, b]; }
                    if (luma < minLuma) { minLuma = luma; minColor = [r, g, b]; }
                }
            }

            // 2. 16-Bit Farben generieren (DXT1 Regel: color0 > color1 für 4 deckende Farben)
            let c0_16 = colorTo565(maxColor[0], maxColor[1], maxColor[2]);
            let c1_16 = colorTo565(minColor[0], minColor[1], minColor[2]);
            
            if (c0_16 < c1_16) {
                let temp = c0_16; c0_16 = c1_16; c1_16 = temp;
            } else if (c0_16 === c1_16) {
                // Notlösung, falls Block einfarbig ist, aber c0 > c1 sein muss
                if (c0_16 > 0) c1_16 = c0_16 - 1; 
            }

            view.setUint16(offset, c0_16, true);
            view.setUint16(offset + 2, c1_16, true);

            // 3. 4-Farben-Palette des Blocks aufbauen
            let rgb0 = colorFrom565(c0_16);
            let rgb1 = colorFrom565(c1_16);
            let palette = [
                rgb0,
                rgb1,
                { r: Math.floor((2 * rgb0.r + rgb1.r) / 3), g: Math.floor((2 * rgb0.g + rgb1.g) / 3), b: Math.floor((2 * rgb0.b + rgb1.b) / 3) },
                { r: Math.floor((rgb0.r + 2 * rgb1.r) / 3), g: Math.floor((rgb0.g + 2 * rgb1.g) / 3), b: Math.floor((rgb0.b + 2 * rgb1.b) / 3) }
            ];

            // 4. Pixel-Indizes berechnen (16 x 2-Bit)
            let indices = 0;
            for (let i = 0; i < 16; i++) {
                let px = blockPixels[i];
                let bestDist = Infinity;
                let bestIdx = 0;
                for (let c = 0; c < 4; c++) {
                    let dist = getDistance(px.r, px.g, px.b, palette[c].r, palette[c].g, palette[c].b);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = c;
                    }
                }
                indices |= (bestIdx << (i * 2));
            }

            view.setUint32(offset + 4, indices, true);
            offset += 8;
        }
    }
    return new Uint8Array(buffer);
}

export function decodeDXT1(packedData, imgW, imgH) {
    let out = new Uint8ClampedArray(imgW * imgH * 4);
    let view = new DataView(packedData.buffer, packedData.byteOffset, packedData.byteLength);
    let blocksX = Math.ceil(imgW / 4);
    let blocksY = Math.ceil(imgH / 4);
    let offset = 0;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            if (offset >= view.byteLength) break;
            
            let c0_16 = view.getUint16(offset, true);
            let c1_16 = view.getUint16(offset + 2, true);
            let indices = view.getUint32(offset + 4, true);
            offset += 8;

            let rgb0 = colorFrom565(c0_16);
            let rgb1 = colorFrom565(c1_16);
            let palette = [rgb0, rgb1, {r:0,g:0,b:0}, {r:0,g:0,b:0}];

            if (c0_16 > c1_16) {
                palette[2] = { r: Math.floor((2 * rgb0.r + rgb1.r) / 3), g: Math.floor((2 * rgb0.g + rgb1.g) / 3), b: Math.floor((2 * rgb0.b + rgb1.b) / 3) };
                palette[3] = { r: Math.floor((rgb0.r + 2 * rgb1.r) / 3), g: Math.floor((rgb0.g + 2 * rgb1.g) / 3), b: Math.floor((rgb0.b + 2 * rgb1.b) / 3) };
            } else {
                palette[2] = { r: Math.floor((rgb0.r + rgb1.r) / 2), g: Math.floor((rgb0.g + rgb1.g) / 2), b: Math.floor((rgb0.b + rgb1.b) / 2) };
                palette[3] = { r: 0, g: 0, b: 0 }; // Transparent in DXT1, hier Schwarz
            }

            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    let px = bx * 4 + x;
                    let py = by * 4 + y;
                    if (px < imgW && py < imgH) {
                        let bitPos = (y * 4 + x) * 2;
                        let colorIdx = (indices >> bitPos) & 3;
                        let outIdx = (py * imgW + px) * 4;
                        
                        out[outIdx] = palette[colorIdx].r;
                        out[outIdx + 1] = palette[colorIdx].g;
                        out[outIdx + 2] = palette[colorIdx].b;
                        out[outIdx + 3] = 255;
                    }
                }
            }
        }
    }
    return out;
}