// src/core/engine-stream.js
import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, get_yuv_dist, get_yuv_dist_weight, get_rgb_dist } from '../codecs/utils.js';

export async function encodeStream(origData, imgW, imgH, format, userSegments, globalPaletteRAM, strategy, metric, max_depth, progressCallback, startOverride=0, endOverride=0, hybridPercent=5.0) {
    let totalPixels = imgW * imgH;
    let config = HAM_CONFIGS[format];
    
    let activeCmds = [...userSegments];
    if (activeCmds.length === 0) {
        activeCmds.push({ absEnd: totalPixels, waitPixels: totalPixels, bank: 0, step: {r:4, g:4, b:4} });
    }

    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;

    let isHybrid = strategy.startsWith('hybrid');
    let hybrid_depth = isHybrid ? (parseInt(strategy.split('_')[1]) || 3) : max_depth;
    let currentStrategy = isHybrid ? 'both' : strategy;

    let commandArray = new Array(totalPixels);
    let pixelStates = new Array(totalPixels);
    
    let stats = { anchorCount: 0, deltaCount: 0, turboCount: 0 };
    let slotsPerBank = config.slotsPerBank || 0;

    function findBestBranch(x, y, c_acc, d, max_d, currentBank, currentStep) {
        if (d === max_d || x >= imgW) return { cost: 0, cmd: null, r: c_acc.r, g: c_acc.g, b: c_acc.b };

        let pIdx = y * imgW + x;
        let origIdx = pIdx * 4;
        let tr = origData[origIdx], tg = origData[origIdx + 1], tb = origData[origIdx + 2];
        let branches = [];

        if (currentStrategy !== 'delta_only') {
            if (config.isPaletted) {
                let startSlot = currentBank * slotsPerBank;
                for (let i = 0; i < slotsPerBank; i++) {
                    let slotIdx = startSlot + i;
                    let r = globalPaletteRAM[slotIdx * 3], g = globalPaletteRAM[slotIdx * 3 + 1], b = globalPaletteRAM[slotIdx * 3 + 2];
                    branches.push({ cmd: { isAnchor: true, anchorIdx: i }, r, g, b });
                }
            } else if (format === "HAM16") {
                let r5 = Math.round(tr / 255 * 31), g5 = Math.round(tg / 255 * 31), b5 = Math.round(tb / 255 * 31);
                let ar = r5 << 3, ag = g5 << 3, ab = b5 << 3;
                branches.push({ cmd: { isAnchor: true, format: "HAM16", r: ar, g: ag, b: ab, r5, g5, b5 }, r: ar, g: ag, b: ab });
            } else if (format === "HAM12") {
                let r3 = tr >> 5, g4 = tg >> 4, b3 = tb >> 5;
                for (let b10 of [0, 1]) {
                    let ar = (((r3 << 1) | b10) << 4) | ((r3 << 1) | b10);
                    let ag = (g4 << 4) | g4;
                    let ab = (((b3 << 1) | b10) << 4) | ((b3 << 1) | b10);
                    branches.push({ cmd: { isAnchor: true, format: "HAM12", r: ar, g: ag, b: ab, r3, g4, b3, b10 }, r: ar, g: ag, b: ab });
                }
            }
        }

        if (currentStrategy !== 'anchor_only') {
            let multipliers = config.hasTurbo ? [0, 1] : [0];
            for (let t of multipliers) {
                let m = t ? 4 : 1;
                let sr = currentStep.r * m, sg = currentStep.g * m, sb = currentStep.b * m;

                if (config.isPaletted) {
                    for (let ri = 0; ri < config.channels.r.length; ri++) {
                        for (let gi = 0; gi < config.channels.g.length; gi++) {
                            for (let bi = 0; bi < config.channels.b.length; bi++) {
                                branches.push({ 
                                    cmd: { isAnchor: false, isTurbo: (m === 4), rIndex: ri, gIndex: gi, bIndex: bi }, 
                                    r: clamp(c_acc.r + config.channels.r[ri] * sr, 0, 255), 
                                    g: clamp(c_acc.g + config.channels.g[gi] * sg, 0, 255), 
                                    b: clamp(c_acc.b + config.channels.b[bi] * sb, 0, 255) 
                                });
                            }
                        }
                    }
                } else {
                    let diffR = tr - c_acc.r, diffG = tg - c_acc.g, diffB = tb - c_acc.b;
                    if (format === "HAM16") {
                        let dr = clamp(Math.round(diffR / sr), -8, 7), dg = clamp(Math.round(diffG / sg), -16, 15), db = clamp(Math.round(diffB / sb), -16, 15);
                        branches.push({ 
                            cmd: { isAnchor: false, format: "HAM16", isTurbo: (m===4), dr, dg, db }, 
                            r: clamp(c_acc.r + dr * sr, 0, 255), g: clamp(c_acc.g + dg * sg, 0, 255), b: clamp(c_acc.b + db * sb, 0, 255) 
                        });
                    } else if (format === "HAM12") {
                        let dr = clamp(Math.round(diffR / sr), -4, 3), dg = clamp(Math.round(diffG / sg), -8, 7), db = clamp(Math.round(diffB / sb), -4, 3);
                        branches.push({ 
                            cmd: { isAnchor: false, format: "HAM12", isTurbo: (m===4), dr, dg, db }, 
                            r: clamp(c_acc.r + dr * sr, 0, 255), g: clamp(c_acc.g + dg * sg, 0, 255), b: clamp(c_acc.b + db * sb, 0, 255) 
                        });
                    }
                }
            }
        }

        let best_cost = Infinity;
        let best_branch = null;
        let evaluatedBranches = branches.length > 200 ? branches.slice(0, 200) : branches;

        for (let b of evaluatedBranches) {
            let next_res = findBestBranch(x + 1, y, { r: b.r, g: b.g, b: b.b }, d + 1, max_d, currentBank, currentStep);
            
            let dist = 0;
            if (metric === 'yuv_weight') dist = get_yuv_dist_weight(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'yuv') dist = get_yuv_dist(tr, tg, tb, b.r, b.g, b.b);
            else dist = get_rgb_dist(tr, tg, tb, b.r, b.g, b.b);

            let total = dist + next_res.cost;

            if (total < best_cost) {
                best_cost = total;
                best_branch = { cost: total, cmd: b.cmd, r: b.r, g: b.g, b: b.b };
            }
        }
        return best_branch || { cost: 0, cmd: branches[0]?.cmd || { isAnchor: true, anchorIdx: 0 }, r: c_acc.r, g: c_acc.g, b: c_acc.b };
    }

    async function encodeSpan(startPx, endPx, initialAcc, depth, isPass2 = false) {
        let acc = { ...initialAcc };
        let cmd_idx = 0;
        
        while (cmd_idx < activeCmds.length && startPx >= activeCmds[cmd_idx].absEnd) cmd_idx++;
        
        for (let i = startPx; i < endPx; i++) {
            let currentBank = activeCmds[cmd_idx] ? activeCmds[cmd_idx].bank : 0;
            let currentStep = activeCmds[cmd_idx] ? activeCmds[cmd_idx].step : {r:4, g:4, b:4};
            
            if (i >= simStart && i < simEnd) {
                let best = findBestBranch(i % imgW, Math.floor(i / imgW), acc, 0, depth, currentBank, currentStep);
                commandArray[i] = best.cmd;
                acc = { r: best.r, g: best.g, b: best.b };
                pixelStates[i] = acc;
            } else {
                commandArray[i] = { isAnchor: true, anchorIdx: 0 };
                pixelStates[i] = acc;
            }

            if (cmd_idx < activeCmds.length && (i + 1) === activeCmds[cmd_idx].absEnd) cmd_idx++;

            if (!isPass2 && i % (imgW*2) === 0 && progressCallback) {
                progressCallback("Phase 1: Greedy-Codierung", i, totalPixels);
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return acc;
    }

    // --- PHASE 1 ---
    await encodeSpan(0, totalPixels, { r: 127, g: 127, b: 127 }, isHybrid ? 1 : max_depth, false);

    // --- PHASE 2 & 3 (Fehleranalyse & Lookahead) ---
    if (isHybrid) {
        if (progressCallback) progressCallback(`Phase 2: Fehlerstatistik (Suche Top ${hybridPercent}%)`, 0, 1);
        await new Promise(r => setTimeout(r, 10)); 

        let blockStart = simStart;
        let allBlocks = [];
        
        while (blockStart < simEnd) {
            let blockEnd = blockStart + 1;
            while (blockEnd < simEnd && !commandArray[blockEnd].isAnchor) blockEnd++;
            
            let blockError = 0;
            for (let i = blockStart; i < blockEnd; i++) {
                let origIdx = i * 4;
                let st = pixelStates[i];
                let err = 0;
                
                if (metric === 'yuv_weight') err = get_yuv_dist_weight(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'yuv') err = get_yuv_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else err = get_rgb_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                
                blockError += err;
            }
            
            let avgError = blockError / (blockEnd - blockStart);
            allBlocks.push({start: blockStart, end: blockEnd, err: avgError});
            blockStart = blockEnd;
        }

        // Sortieren nach dem schlimmsten Fehler
        allBlocks.sort((a, b) => b.err - a.err);
        
        // Exakt X Prozent der Blöcke auswählen
        let targetCount = Math.ceil(allBlocks.length * (hybridPercent / 100));
        let badBlocks = allBlocks.slice(0, targetCount);
        
        for (let b = 0; b < badBlocks.length; b++) {
            let startAcc = badBlocks[b].start === 0 ? { r: 127, g: 127, b: 127 } : pixelStates[badBlocks[b].start - 1];
            await encodeSpan(badBlocks[b].start, badBlocks[b].end, startAcc, hybrid_depth, true);
            
            if (progressCallback) progressCallback(`Phase 3: Lookahead (Repariere ${badBlocks.length} Problem-Blöcke)`, b + 1, badBlocks.length);
            if (b % 5 === 0) await new Promise(r => setTimeout(r, 0));
        }
    }

    for (let i = simStart; i < simEnd; i++) {
        if (commandArray[i].isAnchor) stats.anchorCount++;
        else {
            stats.deltaCount++;
            if (commandArray[i].isTurbo) stats.turboCount++;
        }
    }
    
    let packedData = startOverride === 0 ? packCommandsToBinary(commandArray, format) : null;
    return { commandArray, packedData, stats };
}

function packCommandsToBinary(commands, format) {
    let rawWords = [];
    for (let cmd of commands) {
        let w = 0;
        if (format === "HAM04") {
            if (cmd.isAnchor) w = 8 | (cmd.anchorIdx & 7);
            else w = ((cmd.rIndex > 0 ? 1 : 0) << 2) | ((cmd.gIndex > 0 ? 1 : 0) << 1) | (cmd.bIndex > 0 ? 1 : 0);
        } else if (format === "HAM05") {
            if (cmd.isAnchor) w = 16 | (cmd.anchorIdx & 15);
            else w = ((cmd.isTurbo ? 1 : 0) << 3) | (cmd.rIndex << 2) | (cmd.gIndex << 1) | cmd.bIndex;
        } else if (format === "HAM06") {
            if (cmd.isAnchor) w = 32 | (cmd.anchorIdx & 31);
            else w = ((cmd.isTurbo ? 1 : 0) << 4) | (cmd.rIndex << 3) | (cmd.gIndex << 1) | cmd.bIndex;
        } else if (format === "HAM08_PAL") {
            if (cmd.isAnchor) w = 128 | (cmd.anchorIdx & 127);
            else w = ((cmd.isTurbo ? 1 : 0) << 6) | (cmd.rIndex << 4) | (cmd.gIndex << 2) | cmd.bIndex;
        } else if (format === "HAM12") {
            if (cmd.isAnchor) w = 0x800 | ((cmd.b10||0) << 10) | ((cmd.r3||0) << 7) | ((cmd.g4||0) << 3) | (cmd.b3||0);
            else w = ((cmd.isTurbo ? 1 : 0) << 10) | (((cmd.dr||0) & 7) << 7) | (((cmd.dg||0) & 15) << 3) | ((cmd.db||0) & 7);
        } else if (format === "HAM16") {
            if (cmd.isAnchor) w = 0x8000 | ((cmd.r5||0) << 10) | ((cmd.g5||0) << 5) | (cmd.b5||0);
            else w = ((cmd.isTurbo ? 1 : 0) << 14) | (((cmd.dr||0) & 15) << 10) | (((cmd.dg||0) & 31) << 5) | ((cmd.db||0) & 31);
        }
        rawWords.push(w);
    }
    if (format === "HAM16" || format === "HAM12") {
        let out = new Uint8Array(rawWords.length * 2);
        for (let i = 0; i < rawWords.length; i++) {
            out[i * 2] = rawWords[i] >> 8;
            out[i * 2 + 1] = rawWords[i] & 255;
        }
        return out;
    }
    return new Uint8Array(rawWords);
}