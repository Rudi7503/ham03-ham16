import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, get_yuv_dist, get_yuv_dist_weight, get_rgb_dist, get_yuv_dist_weight_heavy, get_rgb_abs_dist, get_redmean_dist, get_oklab_dist } from '../codecs/utils.js';

function getMetricDist(metric, r1, g1, b1, r2, g2, b2) {
    if (metric === 'oklab') return get_oklab_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'redmean') return get_redmean_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'yuv_weight_heavy') return get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2);
    if (metric === 'yuv') return get_yuv_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'rgb') return get_rgb_dist(r1, g1, b1, r2, g2, b2);
    if (metric === 'rgb_ABS') return get_rgb_abs_dist(r1, g1, b1, r2, g2, b2);
    return get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
}

const CHANNEL_DEFS = {
    "HAM04": { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    "HAM05": { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    "HAM06": { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    "HAM08_PAL": { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] }
};

export async function encodePaletted(origData, imgW, imgH, format, stepVal, paletteRAM, offset, strategy="both", metric="yuv_weight", max_depth=1, progressCallback=null, startOverride=0, endOverride=0, hybridPercent=5.0) {
    let totalPixels = imgW * imgH;
    let commands = new Array(totalPixels);
    let pixelStates = new Array(totalPixels);
    let config = HAM_CONFIGS[format];
    
    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;
    let isHybrid = strategy.startsWith('hybrid');
    let hybrid_depth = isHybrid ? (parseInt(strategy.split('_')[1]) || 3) : max_depth;
    let currentStrategy = isHybrid ? 'both' : strategy;

    // Slot 0 immer erzwingen
    paletteRAM[0] = 0; paletteRAM[1] = 0; paletteRAM[2] = 0;

    function findBestBranch(x, y, c_acc, metric) {
        let pIdx = y * imgW + x;
        let origIdx = pIdx * 4;
        let tr = origData[origIdx], tg = origData[origIdx+1], tb = origData[origIdx+2];

        let effFormat = config.isMixed ? config.sequence[pIdx % config.sequence.length] : format;
        let effConfig = HAM_CONFIGS[effFormat] || { slotsPerBank: 8, hasTurbo: false };
        
        let bestDist = Infinity;
        let bestCmd = null;
        let bestR, bestG, bestB;

        // Dynamische Ermittlung der Slot-Anzahl (unterstützt 8, 16, 32, 64 etc. voll aus)
        let slots = effConfig.slotsPerBank || config.slotsPerBank || 8;
        
        for (let s = 0; s < slots; s++) {
            let absSlot = (offset + s) % 256;
            let r = paletteRAM[absSlot*3], g = paletteRAM[absSlot*3+1], b = paletteRAM[absSlot*3+2];
            let dist = getMetricDist(metric, tr, tg, tb, r, g, b);
            
            if (dist === 0) return { cmd: { isAnchor: true, format: effFormat, anchorIdx: s }, r, g, b };
            if (dist < bestDist) { bestDist = dist; bestCmd = { isAnchor: true, format: effFormat, anchorIdx: s }; bestR = r; bestG = g; bestB = b; }
        }

        let hasTurbo = effConfig.hasTurbo || false;
        let multipliers = hasTurbo ? [1, 4] : [1];
        let rChan = CHANNEL_DEFS[effFormat]?.r || [-1, 1];
        let gChan = CHANNEL_DEFS[effFormat]?.g || [-1, 1];
        let bChan = CHANNEL_DEFS[effFormat]?.b || [-1, 1];

        for (let m of multipliers) {
            let sr = stepVal.r * m, sg = stepVal.g * m, sb = stepVal.b * m;
            for (let ri = 0; ri < rChan.length; ri++) {
                for (let gi = 0; gi < gChan.length; gi++) {
                    for (let bi = 0; bi < bChan.length; bi++) {
                        let nr = clamp(c_acc.r + rChan[ri] * sr, 0, 255);
                        let ng = clamp(c_acc.g + gChan[gi] * sg, 0, 255);
                        let nb = clamp(c_acc.b + bChan[bi] * sb, 0, 255);
                        
                        let dist = getMetricDist(metric, tr, tg, tb, nr, ng, nb);
                        
                        if (dist === 0) return { cmd: { isAnchor: false, format: effFormat, isTurbo: (m===4), rIndex: ri, gIndex: gi, bIndex: bi }, r: nr, g: ng, b: nb };
                        if (dist < bestDist) { bestDist = dist; bestCmd = { isAnchor: false, format: effFormat, isTurbo: (m===4), rIndex: ri, gIndex: gi, bIndex: bi }; bestR = nr; bestG = ng; bestB = nb; }
                    }
                }
            }
        }
        return { cmd: bestCmd, r: bestR, g: bestG, b: bestB };
    }
    
    async function encodeSpan(startPx, endPx, initialAcc, depth, phaseName) {
        let acc = { ...initialAcc };
        for (let i = startPx; i < endPx; i++) {
            if (i >= simStart && i < simEnd) {
                let best = findBestBranch(i % imgW, Math.floor(i / imgW), acc, metric);
                commands[i] = best.cmd;
                acc = { r: best.r, g: best.g, b: best.b };
                pixelStates[i] = acc;
            } else {
                let fallbackFmt = config.isMixed ? config.sequence[i % config.sequence.length] : format;
                commands[i] = { isAnchor: true, format: fallbackFmt, anchorIdx: 0 };
                pixelStates[i] = acc;
            }
            if (i % (imgW*2) === 0 && progressCallback) {
                progressCallback(phaseName, i - startPx, endPx - startPx);
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return acc;
    }

    await encodeSpan(0, totalPixels, { r: 127, g: 127, b: 127 }, isHybrid ? 1 : max_depth, "Phase 1: Greedy-Codierung");

    if (isHybrid) {
        if (progressCallback) progressCallback(`Phase 2: Fehlerstatistik`, 1, 1);
        await new Promise(r => setTimeout(r, 10)); 

        let blockStart = simStart;
        let allBlocks = [];
        while (blockStart < simEnd) {
            let blockEnd = blockStart + 1;
            while (blockEnd < simEnd && !commands[blockEnd].isAnchor) blockEnd++;
            let blockError = 0;
            for (let i = blockStart; i < blockEnd; i++) {
                let origIdx = i * 4, st = pixelStates[i];
                blockError += getMetricDist(metric, origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
            }
            allBlocks.push({start: blockStart, end: blockEnd, err: blockError / (blockEnd - blockStart)});
            blockStart = blockEnd;
        }

        allBlocks.sort((a, b) => b.err - a.err);
        let badBlocks = allBlocks.slice(0, Math.ceil(allBlocks.length * (hybridPercent / 100)));
        
        for (let b = 0; b < badBlocks.length; b++) {
            let startAcc = badBlocks[b].start === 0 ? { r: 127, g: 127, b: 127 } : pixelStates[badBlocks[b].start - 1];
            await encodeSpan(badBlocks[b].start, badBlocks[b].end, startAcc, hybrid_depth, `Phase 3: Lookahead (Repariere Blöcke)`);
            if (progressCallback && b % 5 === 0) progressCallback(`Phase 3: Hybrid Lookahead`, b + 1, badBlocks.length);
        }
    }

    return commands;
}

function getCmdVal(cmd) {
    let v = 0, bits = 4;
    let fmt = cmd.format;
    if (fmt === "HAM04") {
        bits = 4;
        if (cmd.isAnchor) v = 8 | (cmd.anchorIdx & 7);
        else v = (((cmd.rIndex||0)>0?1:0)<<2) | (((cmd.gIndex||0)>0?1:0)<<1) | ((cmd.bIndex||0)>0?1:0);
    } else if (fmt === "HAM05") {
        bits = 5;
        if (cmd.isAnchor) v = 16 | (cmd.anchorIdx & 15);
        else v = (((cmd.isTurbo?1:0)<<3) | ((cmd.rIndex||0)<<2) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (fmt === "HAM06") {
        bits = 6;
        if (cmd.isAnchor) v = 32 | (cmd.anchorIdx & 31);
        else v = (((cmd.isTurbo?1:0)<<4) | ((cmd.rIndex||0)<<3) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (fmt === "HAM08_PAL") {
        bits = 8;
        if (cmd.isAnchor) v = 128 | (cmd.anchorIdx & 127);
        else v = (((cmd.isTurbo?1:0)<<6) | ((cmd.rIndex||0)<<4) | ((cmd.gIndex||0)<<2) | (cmd.bIndex||0));
    }
    return { v, bits };
}

export function packPaletted(commands, format) {
    let config = HAM_CONFIGS[format];
    let out = [];
    let pixelsPerWord = config.sequence.length;
    for (let i = 0; i < commands.length; i += pixelsPerWord) {
        let w32 = 0, shift = 32;
        for (let j = 0; j < pixelsPerWord; j++) {
            if (i + j >= commands.length) break;
            let { v, bits } = getCmdVal(commands[i + j]);
            shift -= bits;
            w32 |= (v << shift);
        }
        w32 >>>= 0;
        out.push((w32 >>> 24) & 255, (w32 >>> 16) & 255, (w32 >>> 8) & 255, w32 & 255);
    }
    return new Uint8Array(out);
}

export function unpackPaletted(packedData, format, totalPixels) {
    let config = HAM_CONFIGS[format];
    let commands = new Array(totalPixels);
    let pixelsPerWord = config.sequence.length;
    let pIdx = 0;

    function parseVal(v, fmt) {
        if (fmt === "HAM04") {
            if (v & 8) return { isAnchor: true, format: fmt, anchorIdx: v & 7 };
            return { isAnchor: false, format: fmt, isTurbo: false, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM05") {
            if (v & 16) return { isAnchor: true, format: fmt, anchorIdx: v & 15 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 3) & 1) === 1, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM06") {
            if (v & 32) return { isAnchor: true, format: fmt, anchorIdx: v & 31 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 4) & 1) === 1, rIndex: (v >> 3) & 1, gIndex: (v >> 1) & 3, bIndex: v & 1 };
        } else if (fmt === "HAM08_PAL") {
            if (v & 128) return { isAnchor: true, format: fmt, anchorIdx: v & 127 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 6) & 1) === 1, rIndex: (v >> 4) & 3, gIndex: (v >> 2) & 3, bIndex: v & 3 };
        }
        return { isAnchor: true, format: fmt, anchorIdx: 0 };
    }

    for (let i = 0; i < packedData.length; i += 4) {
        if (pIdx >= totalPixels) break;
        let w32 = ((packedData[i] << 24) | (packedData[i+1] << 16) | (packedData[i+2] << 8) | packedData[i+3]) >>> 0;
        let shift = 32;
        
        for (let j = 0; j < pixelsPerWord; j++) {
            if (pIdx >= totalPixels) break;
            let fmt = config.sequence[j];
            let bits = (fmt === "HAM04") ? 4 : (fmt === "HAM05") ? 5 : (fmt === "HAM06") ? 6 : 8;
            shift -= bits;
            commands[pIdx++] = parseVal((w32 >>> shift) & ((1 << bits) - 1), fmt);
        }
    }
    return commands;
}

export function decodePaletted(commands, imgW, imgH, stepVal, paletteRAM, offset) {
    let out = new Uint8ClampedArray(imgW * imgH * 4);
    let acc = { r: 127, g: 127, b: 127 };

    for (let i = 0; i < commands.length; i++) {
        let cmd = commands[i];
        if (cmd.isAnchor) {
            let absSlot = (offset + cmd.anchorIdx) % 256;
            acc.r = paletteRAM[absSlot*3]; acc.g = paletteRAM[absSlot*3+1]; acc.b = paletteRAM[absSlot*3+2];
        } else {
            let m = cmd.isTurbo ? 4 : 1;
            let rChan = CHANNEL_DEFS[cmd.format]?.r || [-1, 1];
            let gChan = CHANNEL_DEFS[cmd.format]?.g || [-1, 1];
            let bChan = CHANNEL_DEFS[cmd.format]?.b || [-1, 1];
            
            let dr = rChan[cmd.rIndex || 0] || 0;
            let dg = gChan[cmd.gIndex || 0] || 0;
            let db = bChan[cmd.bIndex || 0] || 0;

            acc.r = clamp(acc.r + dr * (stepVal.r * m), 0, 255);
            acc.g = clamp(acc.g + dg * (stepVal.g * m), 0, 255);
            acc.b = clamp(acc.b + db * (stepVal.b * m), 0, 255);
        }
        let outIdx = i * 4;
        out[outIdx] = acc.r; out[outIdx + 1] = acc.g; out[outIdx + 2] = acc.b; out[outIdx + 3] = 255;
    }
    return out;
}