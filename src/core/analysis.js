import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, get_rgb_abs_dist, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_redmean_dist, get_oklab_dist, rgbToHex } from '../codecs/utils.js';
import { decodeStream } from './decoder.js';
import { encodeStream } from './engine-stream.js';
export const errorBins = [0, 5, 10, 20, 50, 100];

export function computeDetailedAnalysis(origData, decData, imgW, imgH, startPx, endPx) {
    let stats = {
        global: { top5: [], avgRgb: 0, avgYuv: 0 },
        segment: { top5: [], avgRgb: 0, avgYuv: 0 },
        histogram: { rgbBins: new Array(errorBins.length + 1).fill(0), yuvBins: new Array(errorBins.length + 1).fill(0) }
    };

    let g_rgbSum = 0, g_yuvSum = 0;
    let s_rgbSum = 0, s_yuvSum = 0;
    let s_count = 0;

    let allGlobal = [];
    let allSegment = [];
    let totalPixels = imgW * imgH;

    for (let i = 0; i < totalPixels; i++) {
        let idx = i * 4;
        let r1 = origData[idx], g1 = origData[idx+1], b1 = origData[idx+2];
        let r2 = decData[idx], g2 = decData[idx+1], b2 = decData[idx+2];

        let rMse = get_rgb_dist(r1, g1, b1, r2, g2, b2);
        let yMse = get_yuv_dist(r1, g1, b1, r2, g2, b2);

        g_rgbSum += rMse;
        g_yuvSum += yMse;
        
        let diffText = `Ist: ${r1},${g1},${b1} | Soll: ${r2},${g2},${b2} | Diff: ${r1-r2},${g1-g2},${b1-b2}`;

        allGlobal.push({ pixelIdx: i, x: i % imgW, y: Math.floor(i / imgW), mse: yMse, details: diffText });

        let rBinIdx = errorBins.findIndex(val => rMse <= val);
        stats.histogram.rgbBins[rBinIdx === -1 ? errorBins.length : rBinIdx]++;

        let yBinIdx = errorBins.findIndex(val => yMse <= val);
        stats.histogram.yuvBins[yBinIdx === -1 ? errorBins.length : yBinIdx]++;

        if (i >= startPx && i < endPx) {
            s_rgbSum += rMse;
            s_yuvSum += yMse;
            s_count++;
            allSegment.push({ pixelIdx: i, x: i % imgW, y: Math.floor(i / imgW), mse: yMse, details: diffText });
        }
    }

    stats.global.avgRgb = g_rgbSum / totalPixels;
    stats.global.avgYuv = g_yuvSum / totalPixels;
    stats.global.top5 = allGlobal.sort((a, b) => b.mse - a.mse).slice(0, 5);

    if (s_count > 0) {
        stats.segment.avgRgb = s_rgbSum / s_count;
        stats.segment.avgYuv = s_yuvSum / s_count;
        stats.segment.top5 = allSegment.sort((a, b) => b.mse - a.mse).slice(0, 5);
    }

    return stats;
}

export async function runSimulationWithStrategy(sPx, ePx, origData, imgW, palette, stepVal, strategy, metric, max_depth, format, currentOffset = 0) {
    let imgH = origData.length / (imgW * 4);
    
    let segs = [{ absEnd: origData.length / 4, waitPixels: origData.length / 4, offset: currentOffset, step: stepVal }];
    
    let encodeResult = await encodeStream(origData, imgW, imgH, format, segs, palette, strategy, metric, max_depth, null, sPx, ePx);
    
    let config = HAM_CONFIGS[format];
    let decoded = decodeStream(encodeResult.commandArray, imgW, imgH, palette, segs, config);
    
    let yuvSum = 0, rgbSum = 0, maxYuv = 0, count = 0;
    
    for (let i = sPx; i < ePx; i += 2) {
        let idx = i * 4;
        let r1 = origData[idx], g1 = origData[idx+1], b1 = origData[idx+2];
        let r2 = decoded[idx], g2 = decoded[idx+1], b2 = decoded[idx+2];
        
        let yDist = 0;
        if (metric === 'oklab') {
            yDist = get_oklab_dist(r1, g1, b1, r2, g2, b2);
        } else if (metric === 'redmean') {
            yDist = get_redmean_dist(r1, g1, b1, r2, g2, b2);
        } else if (metric === 'yuv_weight_heavy') {
            yDist = get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2);
        } else if (metric === 'yuv_weight') {
            yDist = get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
        } else if (metric === 'yuv') {
            yDist = get_yuv_dist(r1, g1, b1, r2, g2, b2);
        } else if (metric === 'rgb') {
            yDist = get_rgb_dist(r1, g1, b1, r2, g2, b2);
        } else {
            yDist = get_rgb_abs_dist(r1, g1, b1, r2, g2, b2);
        }
        
        let rDist = get_rgb_dist(r1, g1, b1, r2, g2, b2);
        
        yuvSum += yDist;
        rgbSum += rDist;
        if (yDist > maxYuv) maxYuv = yDist;
        count++;
    }

    let avgRgb = rgbSum / count;
    let avgYuv = yuvSum / count;

    let alpha = 0.2;
    let beta = 0.5;  
    let stepPenalty = stepVal.r + stepVal.g + stepVal.b;

    let score = avgYuv + (alpha * maxYuv) + (beta * stepPenalty);

    return { avgRgb, avgYuv, maxYuv, score };
}