// src/core/builder.js
import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, get_yuv_dist, get_yuv_dist_weight, rgbToHex, hexToRgb, clamp } from '../codecs/utils.js';

export function simulateBuilderEncode(startPx, endPx, imgData, imgW, palette, targetSlot, stepVal, format, metric = 'yuv_weight') {
    let config = HAM_CONFIGS[format] || HAM_CONFIGS["HAM04"];
    let slotsPerBank = config.slotsPerBank || 8;
    let bankIdx = Math.floor(targetSlot / slotsPerBank);
    let startSlot = bankIdx * slotsPerBank;

    let histMap = new Map();
    let errorMap = new Map();

    let totalPixels = imgData.length / 4;
    let end = Math.min(totalPixels, endPx);

    // Hilfsfunktion für die gewählte Metrik
    const getDist = (r1, g1, b1, r2, g2, b2) => {
        if (metric === 'yuv_weight') return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
        if (metric === 'yuv') return get_yuv_dist(r1, g1, b1, r2, g2, b2);
        return get_rgb_dist(r1, g1, b1, r2, g2, b2);
    };

    for (let i = startPx; i < end; i++) {
        let idx = i * 4;
        let r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
        let hex = rgbToHex(r, g, b);
        histMap.set(hex, (histMap.get(hex) || 0) + 1);
    }

    let multipliers = config.hasTurbo ? [0, 1] : [0];

    for (let [hex, count] of histMap.entries()) {
        let [r, g, b] = hexToRgb(hex);
        let minErr = Infinity;

        if (targetSlot === startSlot) {
            minErr = getDist(r, g, b, 0, 0, 0); 
        } else {
            for (let s = startSlot; s < targetSlot; s++) {
                let sr = palette[s][0], sg = palette[s][1], sb = palette[s][2];
                let d = getDist(r, g, b, sr, sg, sb);
                if (d < minErr) minErr = d;

                if (minErr > 2) {
                    for (let t of multipliers) {
                        let m = t ? 4 : 1;
                        let sr_step = stepVal.r * m;
                        let sg_step = stepVal.g * m;
                        let sb_step = stepVal.b * m;
                        for (let ri = 0; ri < config.channels.r.length; ri++) {
                            for (let gi = 0; gi < config.channels.g.length; gi++) {
                                for (let bi = 0; bi < config.channels.b.length; bi++) {
                                    let nr = clamp(sr + config.channels.r[ri] * sr_step, 0, 255);
                                    let ng = clamp(sg + config.channels.g[gi] * sg_step, 0, 255);
                                    let nb = clamp(sb + config.channels.b[bi] * sb_step, 0, 255);
                                    
                                    let d2 = getDist(r, g, b, nr, ng, nb);
                                    if (d2 < minErr) minErr = d2;
                                }
                            }
                        }
                    }
                }
            }
        }
        errorMap.set(hex, minErr);
    }

    let filteredHist = [];
    let topMse = [];

    for (let [hex, count] of histMap.entries()) {
        let remainingError = errorMap.get(hex);
        if (remainingError > 2) {
            filteredHist.push({ hex, count });
            topMse.push({ hex, val: remainingError * count });
        }
    }

    if (topMse.length === 0 && histMap.size > 0) {
        for (let [hex, count] of histMap.entries()) {
             topMse.push({ hex, val: errorMap.get(hex) * count });
             filteredHist.push({ hex, count });
        }
    }

    filteredHist.sort((a, b) => b.count - a.count);
    topMse.sort((a, b) => b.val - a.val);

    return { topHist: filteredHist.slice(0, 10), topMse: topMse.slice(0, 10) };
}