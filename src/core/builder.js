import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, get_rgb_abs_dist, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_redmean_dist, get_oklab_dist, rgbToHex, hexToRgb, clamp } from '../codecs/utils.js';

export function simulateBuilderEncode(startPx, endPx, imgData, imgW, palette, relativeTargetSlot, stepVal, format, metric = 'oklab', currentOffset = 0) {
    let config = HAM_CONFIGS[format] || HAM_CONFIGS["HAM04"];
    
    // Baut für Mixed Formate eine grobe Super-Menge aller verfügbaren Deltas
    let effChannelsR = [], effChannelsG = [], effChannelsB = [];
    let hasTurbo = false;
    
    if (config.isMixed) {
        config.sequence.forEach(fmt => {
            let sub = HAM_CONFIGS[fmt];
            sub.channels.r.forEach(v => { if(!effChannelsR.includes(v)) effChannelsR.push(v); });
            sub.channels.g.forEach(v => { if(!effChannelsG.includes(v)) effChannelsG.push(v); });
            sub.channels.b.forEach(v => { if(!effChannelsB.includes(v)) effChannelsB.push(v); });
            if (sub.hasTurbo) hasTurbo = true;
        });
    } else {
        effChannelsR = config.channels.r;
        effChannelsG = config.channels.g;
        effChannelsB = config.channels.b;
        hasTurbo = config.hasTurbo;
    }

    let histMap = new Map();
    let errorMap = new Map();

    let totalPixels = imgData.length / 4;
    let end = Math.min(totalPixels, endPx);

    const getDist = (r1, g1, b1, r2, g2, b2) => {
        if (metric === 'oklab') return get_oklab_dist(r1, g1, b1, r2, g2, b2);
        if (metric === 'redmean') return get_redmean_dist(r1, g1, b1, r2, g2, b2);
        if (metric === 'yuv_weight_heavy') return get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2);
        if (metric === 'yuv_weight') return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
        if (metric === 'yuv') return get_yuv_dist(r1, g1, b1, r2, g2, b2);
        if (metric === 'rgb') return get_rgb_dist(r1, g1, b1, r2, g2, b2);
        if (metric === 'rgb_ABS') return get_rgb_abs_dist(r1, g1, b1, r2, g2, b2);
        return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
    };

    for (let i = startPx; i < end; i++) {
        let idx = i * 4;
        let r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
        let hex = rgbToHex(r, g, b);
        histMap.set(hex, (histMap.get(hex) || 0) + 1);
    }

    let multipliers = hasTurbo ? [0, 1] : [0];

    for (let [hex, count] of histMap.entries()) {
        let [r, g, b] = hexToRgb(hex);
        let minErr = Infinity;

        if (relativeTargetSlot === 0) {
            minErr = getDist(r, g, b, 0, 0, 0); 
        } else {
            // Sucht in den Slots, die vom aktuellen Offset aus bis zum Target Slot liegen
            for (let s = 0; s < relativeTargetSlot; s++) {
                let absoluteSlot = (currentOffset + s) % 256;
                let sr = palette[absoluteSlot][0], sg = palette[absoluteSlot][1], sb = palette[absoluteSlot][2];
                let d = getDist(r, g, b, sr, sg, sb);
                if (d < minErr) minErr = d;

                if (minErr > 2) {
                    for (let t of multipliers) {
                        let m = t ? 4 : 1;
                        let sr_step = stepVal.r * m;
                        let sg_step = stepVal.g * m;
                        let sb_step = stepVal.b * m;
                        for (let ri = 0; ri < effChannelsR.length; ri++) {
                            for (let gi = 0; gi < effChannelsG.length; gi++) {
                                for (let bi = 0; bi < effChannelsB.length; bi++) {
                                    let nr = clamp(sr + effChannelsR[ri] * sr_step, 0, 255);
                                    let ng = clamp(sg + effChannelsG[gi] * sg_step, 0, 255);
                                    let nb = clamp(sb + effChannelsB[bi] * sb_step, 0, 255);
                                    
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