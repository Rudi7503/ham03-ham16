import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, get_rgb_abs_dist, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_redmean_dist, get_oklab_dist } from '../codecs/utils.js';

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

export function getImageHistogram(imgData, imgW, imgH, stepVal, topN = 10, paletteRAM = null, offset = 0) {
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
            if (r !== 0 || g !== 0 || b !== 0) {
                let qr = Math.round(r / clusterRadius) * clusterRadius;
                let qg = Math.round(g / clusterRadius) * clusterRadius;
                let qb = Math.round(b / clusterRadius) * clusterRadius;
                usedColorsSet.add(`${qr},${qg},${qb}`);
            }
        }
    }

    for (let i = 0; i < totalPixels; i += stride) {
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
            paletteRAM[absSlot * 3] = 127;
            paletteRAM[absSlot * 3 + 1] = 127;
            paletteRAM[absSlot * 3 + 2] = 127;
        }
    }
}

export function computeDetailedAnalysis(origData, decData, imgW, imgH, startPx, endPx, stepVal = {r:4, g:4, b:4}, metric = 'yuv_weight') {
    let stats = {
        global: { top10: [], avgRgb: 0, avgYuv: 0 },
        segment: { top10: [], avgRgb: 0, avgYuv: 0 },
        histogram: { rgbBins: new Array(errorBins.length + 1).fill(0), yuvBins: new Array(errorBins.length + 1).fill(0) }
    };

    let g_rgbSum = 0, g_metricSum = 0;
    let s_rgbSum = 0, s_metricSum = 0;
    let s_count = 0;

    let globalErrorMap = new Map();
    let segmentErrorMap = new Map();
    let totalPixels = imgW * imgH;
    
    let clusterRadius = Math.max(2, Math.floor((stepVal.r + stepVal.g + stepVal.b) / 3));

    for (let i = 0; i < totalPixels; i++) {
        let idx = i * 4;
        let origR = origData[idx], origG = origData[idx+1], origB = origData[idx+2];
        let decR = decData[idx], decG = decData[idx+1], decB = decData[idx+2];

        let rMse = get_rgb_dist(origR, origG, origB, decR, decG, decB);
        let metricMse = getAnalysisDist(metric, origR, origG, origB, decR, decG, decB);

        g_rgbSum += rMse;
        g_metricSum += metricMse;

        if (metricMse > 1) { 
            let qOrigR = Math.round(origR/clusterRadius)*clusterRadius, qOrigG = Math.round(origG/clusterRadius)*clusterRadius, qOrigB = Math.round(origB/clusterRadius)*clusterRadius;
            let qDecR = Math.round(decR/clusterRadius)*clusterRadius, qDecG = Math.round(decG/clusterRadius)*clusterRadius, qDecB = Math.round(decB/clusterRadius)*clusterRadius;
            
            let key = `O${qOrigR},${qOrigG},${qOrigB}|D${qDecR},${qDecG},${qDecB}`;
            
            if (!globalErrorMap.has(key)) {
                // r1/g1/b1 = Soll (Original), r2/g2/b2 = Ist (Decodiert)
                globalErrorMap.set(key, { r1: origR, g1: origG, b1: origB, r2: decR, g2: decG, b2: decB, mse: metricMse, count: 0, x: i % imgW, y: Math.floor(i / imgW) });
            }
            globalErrorMap.get(key).count++;
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
                let qOrigR = Math.round(origR/clusterRadius)*clusterRadius, qOrigG = Math.round(origG/clusterRadius)*clusterRadius, qOrigB = Math.round(origB/clusterRadius)*clusterRadius;
                let qDecR = Math.round(decR/clusterRadius)*clusterRadius, qDecG = Math.round(decG/clusterRadius)*clusterRadius, qDecB = Math.round(decB/clusterRadius)*clusterRadius;
                let key = `O${qOrigR},${qOrigG},${qOrigB}|D${qDecR},${qDecG},${qDecB}`;
                
                if (!segmentErrorMap.has(key)) {
                    segmentErrorMap.set(key, { r1: origR, g1: origG, b1: origB, r2: decR, g2: decG, b2: decB, mse: metricMse, count: 0, x: i % imgW, y: Math.floor(i / imgW) });
                }
                segmentErrorMap.get(key).count++;
            }
        }
    }

    stats.global.avgRgb = g_rgbSum / totalPixels;
    stats.global.avgYuv = g_metricSum / totalPixels;

    // Korrekte Sortierung rein nach MSE absteigend
    stats.global.top10 = Array.from(globalErrorMap.values())
        .sort((a, b) => b.mse - a.mse)
        .slice(0, 10);

    if (s_count > 0) {
        stats.segment.avgRgb = s_rgbSum / s_count;
        stats.segment.avgYuv = s_metricSum / s_count;
        stats.segment.top10 = Array.from(segmentErrorMap.values())
            .sort((a, b) => b.mse - a.mse)
            .slice(0, 10);
    }

    return stats;
}