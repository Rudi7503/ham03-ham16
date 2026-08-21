import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, get_rgb_abs_dist, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_redmean_dist, get_oklab_dist } from '../codecs/utils.js';
import { decodeStream } from './decoder.js';
import { encodeStream } from './engine-stream.js';

export const errorBins = [0, 5, 10, 20, 50, 100];

function getAnalysisDist(metric, r1, g1, b1, r2, g2, b2) {
    if (metric === 'oklab') return get_oklab_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'redmean') return get_redmean_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'yuv_weight_heavy') return get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2);
    if (metric === 'yuv_weight') return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
    if (metric === 'yuv') return get_yuv_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'rgb') return get_rgb_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'rgb_ABS') return get_rgb_abs_dist(r1, g1, b1, r2, g2, b2);
    return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
}

export function getImageHistogram(imgData, imgW, imgH, stepVal, topN = 10, paletteRAM = null, offset = 0, optRegion = null) {
    let data = imgData.data;
    let colorMap = new Map();
    let totalPixels = imgW * imgH;
    
    let stride = Math.max(1, Math.floor(totalPixels / 10000));
    let avgStep = (stepVal.r + stepVal.g + stepVal.b) / 3.0;
    let clusterRadius = Math.max(4, Math.floor(avgStep));

    let usedColorsSet = new Set();
    if (paletteRAM) {
        for (let i = 0; i < 256; i++) {
            let r = paletteRAM[i * 3], g = paletteRAM[i * 3 + 1], b = paletteRAM[i * 3 + 2];
            let qr = Math.round(r / clusterRadius) * clusterRadius;
            let qg = Math.round(g / clusterRadius) * clusterRadius;
            let qb = Math.round(b / clusterRadius) * clusterRadius;
            usedColorsSet.add(`${qr},${qg},${qb}`);
        }
    }

    for (let i = 0; i < totalPixels; i += stride) {
        if (optRegion) {
            let x = i % imgW;
            let y = Math.floor(i / imgW);
            if (x < optRegion.x || x >= optRegion.x + optRegion.width || y < optRegion.y || y >= optRegion.y + optRegion.height) {
                continue;
            }
        }

        let idx = i * 4;
        let r = Math.min(255, Math.round(data[idx] / clusterRadius) * clusterRadius);
        let g = Math.min(255, Math.round(data[idx+1] / clusterRadius) * clusterRadius);
        let b = Math.min(255, Math.round(data[idx+2] / clusterRadius) * clusterRadius);
        
        let key = `${r},${g},${b}`;
        if (!usedColorsSet.has(key)) {
            colorMap.set(key, (colorMap.get(key) || 0) + 1);
        }
    }

    return Array.from(colorMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(e => {
            let [r,g,b] = e[0].split(',').map(Number);
            return { r, g, b, count: e[1] };
        });
}

export function autoFillPaletteFromImage(imgData, imgW, imgH, paletteRAM, offset, slots, stepVal) {
    let topColors = getImageHistogram(imgData, imgW, imgH, stepVal, slots, paletteRAM, offset);
    
    for (let i = 0; i < slots; i++) {
        let absSlot = (offset + i) % 256;
        if (i < topColors.length) {
            paletteRAM[absSlot * 3] = topColors[i].r;
            paletteRAM[absSlot * 3 + 1] = topColors[i].g;
            paletteRAM[absSlot * 3 + 2] = topColors[i].b;
        } else {
            paletteRAM[absSlot * 3] = 0;
            paletteRAM[absSlot * 3 + 1] = 0;
            paletteRAM[absSlot * 3 + 2] = 0;
        }
    }
}

export function computeDetailedAnalysis(origData, decData, imgW, imgH, startPx, endPx, stepVal = {r:4, g:4, b:4}, metric = 'yuv_weight', config = null, optRegion = null) {
    let stats = {
        global: { top10: [], avgRgb: 0, avgYuv: 0, byBitDepth: {} },
        segment: { top10: [], avgRgb: 0, avgYuv: 0 },
        histogram: { rgbBins: new Array(errorBins.length + 1).fill(0), yuvBins: new Array(errorBins.length + 1).fill(0) }
    };

    let g_rgbSum = 0, g_metricSum = 0;
    let s_rgbSum = 0, s_metricSum = 0;
    let s_count = 0;

    let globalErrorMap = new Map();
    let bitDepthMaps = {}; 
    let segmentErrorMap = new Map();
    let totalPixels = imgW * imgH;
    
    let clusterRadius = Math.max(2, Math.floor((stepVal.r + stepVal.g + stepVal.b) / 3));

    for (let i = 0; i < totalPixels; i++) {
        if (optRegion) {
            let x = i % imgW;
            let y = Math.floor(i / imgW);
            if (x < optRegion.x || x >= optRegion.x + optRegion.width || y < optRegion.y || y >= optRegion.y + optRegion.height) {
                continue;
            }
        }

        let idx = i * 4;
        let r1 = origData[idx], g1 = origData[idx+1], b1 = origData[idx+2];
        let r2 = decData[idx], g2 = decData[idx+1], b2 = decData[idx+2];

        let rMse = get_rgb_dist(r1, g1, b1, r2, g2, b2);
        let metricMse = getAnalysisDist(metric, r1, g1, b1, r2, g2, b2);

        g_rgbSum += rMse;
        g_metricSum += metricMse;

        let bits = 8;
        if (config) {
            if (config.isMixed && config.sequence) {
                let x = i % imgW;
                let seqIdx = x % config.sequence.length;
                let fmt = config.sequence[seqIdx];
                bits = (fmt === "HAM01") ? 1 : (fmt === "HAM02") ? 2 : (fmt === "HAM03") ? 3 : (fmt === "HAM04") ? 4 : (fmt === "HAM05") ? 5 : (fmt === "HAM06") ? 6 : (fmt === "HAM08_PAL") ? 8 : 8;
            } else if (config.bits) {
                bits = config.bits;
            }
        }

        if (metricMse > 1) { 
            let qR1 = Math.round(r1/clusterRadius)*clusterRadius, qG1 = Math.round(g1/clusterRadius)*clusterRadius, qB1 = Math.round(b1/clusterRadius)*clusterRadius;
            let qR2 = Math.round(r2/clusterRadius)*clusterRadius, qG2 = Math.round(g2/clusterRadius)*clusterRadius, qB2 = Math.round(b2/clusterRadius)*clusterRadius;
            
            let key = `I${qR1},${qG1},${qB1}|S${qR2},${qG2},${qB2}`;
            
            if (!globalErrorMap.has(key)) {
                globalErrorMap.set(key, { r1, g1, b1, r2, g2, b2, mse: metricMse, count: 0, x: i % imgW, y: Math.floor(i / imgW), bits: bits });
            }
            globalErrorMap.get(key).count++;

            if (!bitDepthMaps[bits]) bitDepthMaps[bits] = new Map();
            if (!bitDepthMaps[bits].has(key)) {
                bitDepthMaps[bits].set(key, { r1, g1, b1, r2, g2, b2, mse: metricMse, count: 0, x: i % imgW, y: Math.floor(i / imgW), bits: bits });
            }
            bitDepthMaps[bits].get(key).count++;
        }

        let rBinIdx = errorBins.findIndex(val => rMse <= val);
        stats.histogram.rgbBins[rBinIdx === -1 ? errorBins.length : rBinIdx]++;

        let metricBinIdx = errorBins.findIndex(val => metricMse <= val);
        stats.histogram.yuvBins[metricBinIdx === -1 ? errorBins.length : metricBinIdx]++;

        if (i >= startPx && i < endPx) {
            s_rgbSum += rMse;
            s_metricSum += metricMse;
            s_count++;
            
            if (metricMse > 1) {
                let qR1 = Math.round(r1/clusterRadius)*clusterRadius, qG1 = Math.round(g1/clusterRadius)*clusterRadius, qB1 = Math.round(b1/clusterRadius)*clusterRadius;
                let qR2 = Math.round(r2/clusterRadius)*clusterRadius, qG2 = Math.round(g2/clusterRadius)*clusterRadius, qB2 = Math.round(b2/clusterRadius)*clusterRadius;
                let key = `I${qR1},${qG1},${qB1}|S${qR2},${qG2},${qB2}`;
                
                if (!segmentErrorMap.has(key)) segmentErrorMap.set(key, { r1, g1, b1, r2, g2, b2, mse: metricMse, count: 0, x: i % imgW, y: Math.floor(i / imgW), bits: bits });
                segmentErrorMap.get(key).count++;
            }
        }
    }

    let validPixels = g_rgbSum === 0 ? 1 : (g_rgbSum / totalPixels); 
    if(optRegion && optRegion.width > 0) validPixels = optRegion.width * optRegion.height;

    stats.global.avgRgb = g_rgbSum / validPixels;
    stats.global.avgYuv = g_metricSum / validPixels;

    // Helper für die abwechselnde Sortierung (Reißverschlussverfahren)
    function interleaveErrors(errorArray, maxLen = 10) {
        let weighted = [...errorArray].sort((a, b) => (b.mse * b.count) - (a.mse * a.count));
        let pure = [...errorArray].sort((a, b) => b.mse - a.mse);
        let combined = [];
        let added = new Set();
        let wIdx = 0, pIdx = 0;
        
        while (combined.length < maxLen && (wIdx < weighted.length || pIdx < pure.length)) {
            while (wIdx < weighted.length && added.has(weighted[wIdx])) wIdx++;
            if (wIdx < weighted.length && combined.length < maxLen) {
                weighted[wIdx].sortType = "⚖️ Menge"; 
                combined.push(weighted[wIdx]);
                added.add(weighted[wIdx]);
                wIdx++;
            }
            
            while (pIdx < pure.length && added.has(pure[pIdx])) pIdx++;
            if (pIdx < pure.length && combined.length < maxLen) {
                pure[pIdx].sortType = "🔥 Spitze"; 
                combined.push(pure[pIdx]);
                added.add(pure[pIdx]);
                pIdx++;
            }
        }
        return combined;
    }

    stats.global.top10 = interleaveErrors(Array.from(globalErrorMap.values()), 10);

    for (let b in bitDepthMaps) {
        stats.global.byBitDepth[b] = interleaveErrors(Array.from(bitDepthMaps[b].values()), 10);
    }

    if (s_count > 0) {
        stats.segment.avgRgb = s_rgbSum / s_count;
        stats.segment.avgYuv = s_metricSum / s_count;
        stats.segment.top10 = interleaveErrors(Array.from(segmentErrorMap.values()), 10);
    }

    return stats;
}

export async function runSimulationWithStrategy(sPx, ePx, origData, imgW, palette, stepVal, strategy, metric, max_depth, format, currentOffset = 0, optRegion = null) {
    let imgH = origData.length / (imgW * 4);
    let segs = [{ absEnd: origData.length / 4, waitPixels: origData.length / 4, offset: currentOffset, step: stepVal }];
    
    let encodeResult = await encodeStream(origData, imgW, imgH, format, segs, palette, strategy, metric, max_depth, null, sPx, ePx);
    let config = HAM_CONFIGS[format];
    let decoded = decodeStream(encodeResult.commandArray, imgW, imgH, palette, segs, config);
    
    let yuvSum = 0, rgbSum = 0, maxYuv = 0, count = 0;
    
    for (let i = sPx; i < ePx; i++) { 
        if (optRegion) {
            let x = i % imgW;
            let y = Math.floor(i / imgW);
            if (x < optRegion.x || x >= optRegion.x + optRegion.width || y < optRegion.y || y >= optRegion.y + optRegion.height) {
                continue;
            }
        }

        let idx = i * 4;
        let r1 = origData[idx], g1 = origData[idx+1], b1 = origData[idx+2];
        let r2 = decoded[idx], g2 = decoded[idx+1], b2 = decoded[idx+2];
        
        let yDist = getAnalysisDist(metric, r1, g1, b1, r2, g2, b2);
        let rDist = get_rgb_dist(r1, g1, b1, r2, g2, b2);
        
        yuvSum += yDist;
        rgbSum += rDist;
        if (yDist > maxYuv) maxYuv = yDist;
        count++;
    }

    if (count === 0) count = 1;

    let avgRgb = rgbSum / count;
    let avgYuv = yuvSum / count;
    let alpha = 0.2;
    let beta = 0.5;  
    let stepPenalty = stepVal.r + stepVal.g + stepVal.b;
    let score = avgYuv + (alpha * maxYuv) + (beta * stepPenalty);

    return { avgRgb, avgYuv, maxYuv, score };
}