// src/core/builder.js
import { HAM_CONFIGS } from '../codecs/configs.js';
import { get_rgb_dist, hexToRgb, rgbToHex } from '../codecs/utils.js';

export function simulateBuilderEncode(startPx, endPx, imgData, imgW, palette, targetSlot, stepVal, format) {
    let config = HAM_CONFIGS[format] || HAM_CONFIGS["HAM04"];
    let histMap = new Map();
    let mseMap = new Map();

    let totalPixels = imgData.length / 4;
    let end = Math.min(totalPixels, endPx);

    for (let i = startPx; i < end; i++) {
        let idx = i * 4;
        let r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
        let hex = rgbToHex(r, g, b);

        // Zähle Farben für das Histogramm
        histMap.set(hex, (histMap.get(hex) || 0) + 1);

        // Berechne Distanz zur Zielfarbe im anvisierten Slot
        let sr = palette[targetSlot][0];
        let sg = palette[targetSlot][1];
        let sb = palette[targetSlot][2];

        let dist = get_rgb_dist(r, g, b, sr, sg, sb);
        mseMap.set(hex, (mseMap.get(hex) || 0) + dist);
    }

    let filteredHist = Array.from(histMap.entries())
        .map(([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    let topMse = Array.from(mseMap.entries())
        .map(([hex, val]) => ({ hex, val: val / histMap.get(hex) }))
        .sort((a, b) => b.val - a.val)
        .slice(0, 10);

    return { topHist: filteredHist, topMse };
}