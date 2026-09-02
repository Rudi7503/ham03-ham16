import { clamp, getMetricDistFunc } from '../codecs/utils.js';

export async function encodeHam12_16(origData, imgW, imgH, format, stepVal, strategy="both", metric="yuv_weight", max_depth=1, progressCallback=null, startOverride=0, endOverride=0, hybridPercent=5.0) {
    let totalPixels = imgW * imgH;
    let commands = new Array(totalPixels);
    let pixelStates = new Array(totalPixels);
    
    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;
    let isHybrid = strategy.startsWith('hybrid');
    let hybrid_depth = isHybrid ? (parseInt(strategy.split('_')[1]) || 3) : max_depth;
    let currentStrategy = isHybrid ? 'both' : strategy;
    let sr = stepVal.r, sg = stepVal.g, sb = stepVal.b;
    const distFunc = getMetricDistFunc(metric);

    function findBestBranch(x, y, c_acc, d, max_d) {
        if (d === max_d || x >= imgW) return { cost: 0, cmd: null, r: c_acc.r, g: c_acc.g, b: c_acc.b };

        let pIdx = y * imgW + x;
        let origIdx = pIdx * 4;
        let tr = origData[origIdx], tg = origData[origIdx + 1], tb = origData[origIdx + 2];
        let branches = [];

        if (currentStrategy !== 'delta_only') {
            if (format === "HAM16") {
                let r5 = Math.round(tr / 255 * 31), g5 = Math.round(tg / 255 * 31), b5 = Math.round(tb / 255 * 31);
                let ar = r5 << 3, ag = g5 << 3, ab = b5 << 3;
                branches.push({ cmd: { isAnchor: true, format: "HAM16", r5, g5, b5, r: ar, g: ag, b: ab }, r: ar, g: ag, b: ab });
            } else {
                let r3 = tr >> 5, g4 = tg >> 4, b3 = tb >> 5;
                for (let b10 of [0, 1]) {
                    let r4 = (r3 << 1) | b10, b4 = (b3 << 1) | b10;
                    let ar = r4 << 4, ag = g4 << 4, ab = b4 << 4;
                    branches.push({ cmd: { isAnchor: true, format: "HAM12", r3, g4, b3, b10, r: ar, g: ag, b: ab }, r: ar, g: ag, b: ab });
                }
            }
        }

        if (currentStrategy !== 'anchor_only') {
            let diffR = tr - c_acc.r, diffG = tg - c_acc.g, diffB = tb - c_acc.b;
            for (let isTurbo of [false, true]) {
                let m = isTurbo ? 4 : 1;
                let csr = sr * m, csg = sg * m, csb = sb * m;
                if (format === "HAM16") {
                    let dr = clamp(Math.round(diffR / csr), -8, 7), dg = clamp(Math.round(diffG / csg), -16, 15), db = clamp(Math.round(diffB / csb), -16, 15);
                    let nr = clamp(c_acc.r + dr * csr, 0, 255), ng = clamp(c_acc.g + dg * csg, 0, 255), nb = clamp(c_acc.b + db * csb, 0, 255);
                    branches.push({ cmd: { isAnchor: false, format: "HAM16", isTurbo, dr, dg, db }, r: nr, g: ng, b: nb });
                } else {
                    let dr = clamp(Math.round(diffR / csr), -4, 3), dg = clamp(Math.round(diffG / csg), -8, 7), db = clamp(Math.round(diffB / csb), -4, 3);
                    let nr = clamp(c_acc.r + dr * csr, 0, 255), ng = clamp(c_acc.g + dg * csg, 0, 255), nb = clamp(c_acc.b + db * csb, 0, 255);
                    branches.push({ cmd: { isAnchor: false, format: "HAM12", isTurbo, dr, dg, db }, r: nr, g: ng, b: nb });
                }
            }
        }

        for (let b of branches) {
            b.baseCost = distFunc(tr, tg, tb, b.r, b.g, b.b);
        }
        branches.sort((a, b) => a.baseCost - b.baseCost);
        
        let evaluated = max_d > 1 ? branches.slice(0, 4) : branches;
        
        let best_cost = Infinity;
        let best_branch = null;

        for (let b of evaluated) {
            let total = b.baseCost;
            if (d + 1 < max_d) {
                let next_res = findBestBranch(x + 1, y, { r: b.r, g: b.g, b: b.b }, d + 1, max_d);
                total += next_res.cost;
            }
            if (total < best_cost) {
                best_cost = total;
                best_branch = { cost: total, cmd: b.cmd, r: b.r, g: b.g, b: b.b };
            }
        }
        return best_branch || { cost: 0, cmd: branches[0].cmd, r: c_acc.r, g: c_acc.g, b: c_acc.b };
    }

    async function encodeSpan(startPx, endPx, initialAcc, depth, phaseName) {
        let acc = { ...initialAcc };
        for (let i = startPx; i < endPx; i++) {
            if (i >= simStart && i < simEnd) {
                let best = findBestBranch(i % imgW, Math.floor(i / imgW), acc, 0, depth);
                commands[i] = best.cmd;
                acc = { r: best.r, g: best.g, b: best.b };
                pixelStates[i] = acc;
            } else {
                commands[i] = { isAnchor: true, format, anchorIdx: 0 };
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
                blockError += distFunc(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
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

export function packHam12_16(commands, format) {
    let out = new Uint8Array(commands.length * 2);
    for (let i = 0; i < commands.length; i++) {
        let cmd = commands[i], w = 0;
        if (format === "HAM16") {
            if (cmd.isAnchor) w = 0x8000 | ((cmd.r5 & 31) << 10) | ((cmd.g5 & 31) << 5) | (cmd.b5 & 31);
            else w = ((cmd.isTurbo ? 1 : 0) << 14) | ((cmd.dr & 15) << 10) | ((cmd.dg & 31) << 5) | (cmd.db & 31);
        } else {
            if (cmd.isAnchor) w = 0x800 | ((cmd.b10 & 1) << 10) | ((cmd.r3 & 7) << 7) | ((cmd.g4 & 15) << 3) | (cmd.b3 & 7);
            else w = ((cmd.isTurbo ? 1 : 0) << 10) | ((cmd.dr & 7) << 7) | ((cmd.dg & 15) << 3) | (cmd.db & 7);
        }
        out[i * 2] = (w >> 8) & 255;
        out[i * 2 + 1] = w & 255;
    }
    return out;
}

export function unpackHam12_16(packedData, format, totalPixels) {
    let commands = new Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
        let b0 = packedData[i * 2] || 0;
        let b1 = packedData[i * 2 + 1] || 0;
        let w = (b0 << 8) | b1;
        
        if (format === "HAM16") {
            if (w & 0x8000) {
                let r5 = (w >> 10) & 31, g5 = (w >> 5) & 31, b5 = w & 31;
                commands[i] = { isAnchor: true, format, r5, g5, b5, r: r5 << 3, g: g5 << 3, b: b5 << 3 };
            } else {
                let dr = (w >> 10) & 15; dr = (dr & 8) ? dr - 16 : dr;
                let dg = (w >> 5) & 31;  dg = (dg & 16) ? dg - 32 : dg;
                let db = w & 31;         db = (db & 16) ? db - 32 : db;
                commands[i] = { isAnchor: false, format, isTurbo: ((w >> 14) & 1) === 1, dr, dg, db };
            }
        } else {
            if (w & 0x800) {
                let b10 = (w >> 10) & 1, r3 = (w >> 7) & 7, g4 = (w >> 3) & 15, b3 = w & 7;
                commands[i] = { isAnchor: true, format, b10, r3, g4, b3, r: ((r3<<1)|b10)<<4, g: g4<<4, b: ((b3<<1)|b10)<<4 };
            } else {
                let dr = (w >> 7) & 7;  dr = (dr & 4) ? dr - 8 : dr;
                let dg = (w >> 3) & 15; dg = (dg & 8) ? dg - 16 : dg;
                let db = w & 7;         db = (db & 4) ? db - 8 : db;
                commands[i] = { isAnchor: false, format, isTurbo: ((w >> 10) & 1) === 1, dr, dg, db };
            }
        }
    }
    return commands;
}

export function decodeHam12_16(commands, imgW, imgH, stepVal) {
    let out = new Uint8ClampedArray(imgW * imgH * 4);
    let acc = { r: 127, g: 127, b: 127 };
    for (let i = 0; i < commands.length; i++) {
        let cmd = commands[i];
        if (cmd.isAnchor) {
            acc.r = cmd.r; acc.g = cmd.g; acc.b = cmd.b;
        } else {
            let m = cmd.isTurbo ? 4 : 1;
            acc.r = clamp(acc.r + cmd.dr * (stepVal.r * m), 0, 255);
            acc.g = clamp(acc.g + cmd.dg * (stepVal.g * m), 0, 255);
            acc.b = clamp(acc.b + cmd.db * (stepVal.b * m), 0, 255);
        }
        let outIdx = i * 4;
        out[outIdx] = acc.r; out[outIdx + 1] = acc.g; out[outIdx + 2] = acc.b; out[outIdx + 3] = 255;
    }
    return out;
}