import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, get_yuv_dist, get_yuv_dist_weight, get_rgb_dist, get_yuv_dist_weight_heavy, get_rgb_abs_dist, get_redmean_dist, get_oklab_dist } from '../codecs/utils.js';

export async function encodeStream(origData, imgW, imgH, format, userSegments, globalPaletteRAM, strategy, metric, max_depth, progressCallback, startOverride=0, endOverride=0, hybridPercent=5.0) {
    let totalPixels = imgW * imgH;
    let config = HAM_CONFIGS[format];
    
    let activeCmds = [...userSegments];
    if (activeCmds.length === 0) {
        activeCmds.push({ absEnd: totalPixels, waitPixels: totalPixels, offset: 0, step: {r:4, g:4, b:4} });
    }

    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;

    let isHybrid = strategy.startsWith('hybrid');
    let hybrid_depth = isHybrid ? (parseInt(strategy.split('_')[1]) || 3) : max_depth;
    let currentStrategy = isHybrid ? 'both' : strategy;

    let commandArray = new Array(totalPixels);
    let pixelStates = new Array(totalPixels);
    
    let stats = { anchorCount: 0, deltaCount: 0, turboCount: 0 };

    function findBestBranch(x, y, c_acc, d, max_d, currentOffset, currentStep) {
        if (d === max_d || x >= imgW) return { cost: 0, cmd: null, r: c_acc.r, g: c_acc.g, b: c_acc.b };

        let pIdx = y * imgW + x;
        let origIdx = pIdx * 4;
        let tr = origData[origIdx], tg = origData[origIdx + 1], tb = origData[origIdx + 2];
        let branches = [];

        let effFormat = format;
        let effConfig = config;
        if (config.isMixed) {
            let seqIdx = x % config.sequence.length;
            effFormat = config.sequence[seqIdx];
            effConfig = HAM_CONFIGS[effFormat];
        }

        if (currentStrategy !== 'delta_only') {
            if (effConfig.isPaletted) {
                let slotsForPixel = effConfig.slotsPerBank;
                for (let i = 0; i < slotsForPixel; i++) {
                    let absoluteSlot = (currentOffset + i) % 256;
                    let r = globalPaletteRAM[absoluteSlot * 3], g = globalPaletteRAM[absoluteSlot * 3 + 1], b = globalPaletteRAM[absoluteSlot * 3 + 2];
                    branches.push({ cmd: { isAnchor: true, anchorIdx: i }, r, g, b });
                }
            } else if (effFormat === "HAM16") {
                let r5 = Math.round(tr / 255 * 31), g5 = Math.round(tg / 255 * 31), b5 = Math.round(tb / 255 * 31);
                let ar = r5 << 3, ag = g5 << 3, ab = b5 << 3;
                branches.push({ cmd: { isAnchor: true, format: "HAM16", r: ar, g: ag, b: ab, r5, g5, b5 }, r: ar, g: ag, b: ab });
            } else if (effFormat === "HAM12") {
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
            let multipliers = effConfig.hasTurbo ? [0, 1] : [0];
            for (let t of multipliers) {
                let m = t ? 4 : 1;
                let sr = currentStep.r * m, sg = currentStep.g * m, sb = currentStep.b * m;

                if (effConfig.isPaletted) {
                    for (let ri = 0; ri < effConfig.channels.r.length; ri++) {
                        for (let gi = 0; gi < effConfig.channels.g.length; gi++) {
                            for (let bi = 0; bi < effConfig.channels.b.length; bi++) {
                                branches.push({ 
                                    cmd: { isAnchor: false, isTurbo: (m === 4), rIndex: ri, gIndex: gi, bIndex: bi }, 
                                    r: clamp(c_acc.r + effConfig.channels.r[ri] * sr, 0, 255), 
                                    g: clamp(c_acc.g + effConfig.channels.g[gi] * sg, 0, 255), 
                                    b: clamp(c_acc.b + effConfig.channels.b[bi] * sb, 0, 255) 
                                });
                            }
                        }
                    }
                } else {
                    let diffR = tr - c_acc.r, diffG = tg - c_acc.g, diffB = tb - c_acc.b;
                    if (effFormat === "HAM16") {
                        let dr = clamp(Math.round(diffR / sr), -8, 7), dg = clamp(Math.round(diffG / sg), -16, 15), db = clamp(Math.round(diffB / sb), -16, 15);
                        branches.push({ 
                            cmd: { isAnchor: false, format: "HAM16", isTurbo: (m===4), dr, dg, db }, 
                            r: clamp(c_acc.r + dr * sr, 0, 255), g: clamp(c_acc.g + dg * sg, 0, 255), b: clamp(c_acc.b + db * sb, 0, 255) 
                        });
                    } else if (effFormat === "HAM12") {
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
            let next_res = findBestBranch(x + 1, y, { r: b.r, g: b.g, b: b.b }, d + 1, max_d, currentOffset, currentStep);
            
            let dist = 0;
            if (metric === 'oklab') dist = get_oklab_dist(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'redmean') dist = get_redmean_dist(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'yuv_weight_heavy') dist = get_yuv_dist_weight_heavy(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'yuv_weight') dist = get_yuv_dist_weight(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'yuv') dist = get_yuv_dist(tr, tg, tb, b.r, b.g, b.b);
            else if (metric === 'rgb') dist = get_rgb_dist(tr, tg, tb, b.r, b.g, b.b);
            else dist = get_rgb_abs_dist(tr, tg, tb, b.r, b.g, b.b);

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
            let currentOffset = activeCmds[cmd_idx] ? (activeCmds[cmd_idx].offset || 0) : 0;
            let currentStep = activeCmds[cmd_idx] ? activeCmds[cmd_idx].step : {r:4, g:4, b:4};
            
            if (i >= simStart && i < simEnd) {
                let best = findBestBranch(i % imgW, Math.floor(i / imgW), acc, 0, depth, currentOffset, currentStep);
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

    await encodeSpan(0, totalPixels, { r: 127, g: 127, b: 127 }, isHybrid ? 1 : max_depth, false);

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
                
                if (metric === 'oklab') err = get_oklab_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'redmean') err = get_redmean_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'yuv_weight') err = get_yuv_dist_weight(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'yuv') err = get_yuv_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'yuv_weight_heavy') err = get_yuv_dist_weight_heavy(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else if (metric === 'rgb') err = get_rgb_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);
                else err = get_rgb_abs_dist(origData[origIdx], origData[origIdx+1], origData[origIdx+2], st.r, st.g, st.b);

                blockError += err;
            }
            
            let avgError = blockError / (blockEnd - blockStart);
            allBlocks.push({start: blockStart, end: blockEnd, err: avgError});
            blockStart = blockEnd;
        }

        allBlocks.sort((a, b) => b.err - a.err);
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

// Hilfsfunktion: Ermittelt den Binärwert und die Bit-Breite eines einzelnen Befehls
function getCmdVal(cmd, format) {
    let v = 0, bits = 0;
    if (format === "HAM04") {
        bits = 4;
        if (cmd.isAnchor) v = 8 | (cmd.anchorIdx & 7);
        else v = (((cmd.rIndex||0)>0?1:0)<<2) | (((cmd.gIndex||0)>0?1:0)<<1) | ((cmd.bIndex||0)>0?1:0);
    } else if (format === "HAM05") {
        bits = 5;
        if (cmd.isAnchor) v = 16 | (cmd.anchorIdx & 15);
        else v = (((cmd.isTurbo?1:0)<<3) | ((cmd.rIndex||0)<<2) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (format === "HAM06") {
        bits = 6;
        if (cmd.isAnchor) v = 32 | (cmd.anchorIdx & 31);
        else v = (((cmd.isTurbo?1:0)<<4) | ((cmd.rIndex||0)<<3) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (format === "HAM08_PAL") {
        bits = 8;
        if (cmd.isAnchor) v = 128 | (cmd.anchorIdx & 127);
        else v = (((cmd.isTurbo?1:0)<<6) | ((cmd.rIndex||0)<<4) | ((cmd.gIndex||0)<<2) | (cmd.bIndex||0));
    }
    return { v, bits };
}

function packCommandsToBinary(commands, format) {
    let config = HAM_CONFIGS[format];
    
    // Universeller Bit-Stream Packer für ALLE Mischformate (16-Bit, 32-Bit A-E)
    if (config && config.isMixed) {
        let bitStream = [];
        let currentByte = 0;
        let bitsInByte = 0;
        
        for (let i = 0; i < commands.length; i++) {
            let seqIdx = i % config.sequence.length;
            let fmt = config.sequence[seqIdx];
            let cmd = commands[i] || { isAnchor: true, anchorIdx: 0 };
            
            let { v, bits } = getCmdVal(cmd, fmt);
            
            // Bits einzeln von MSB zu LSB in den Stream schieben
            for (let b = bits - 1; b >= 0; b--) {
                let bit = (v >> b) & 1;
                currentByte = (currentByte << 1) | bit;
                bitsInByte++;
                
                if (bitsInByte === 8) {
                    bitStream.push(currentByte);
                    currentByte = 0;
                    bitsInByte = 0;
                }
            }
        }
        
        // Letztes Byte auffüllen, falls es nicht voll wurde
        if (bitsInByte > 0) {
            currentByte = currentByte << (8 - bitsInByte);
            bitStream.push(currentByte);
        }
        
        return new Uint8Array(bitStream);
    }

    // Reguläres Packing für Standard-Formate
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

// --- NEU: UNPACKER LOGIK FÜR LADE-FUNKTION ---
// --- UNPACKER LOGIK FÜR LADE-FUNKTION ---
export function unpackBinaryToCommands(packedData, format, totalPixels) {
    let config = HAM_CONFIGS[format];
    let commands = new Array(totalPixels);

    function parseCmdVal(v, fmt) {
        if (fmt === "HAM04") {
            if (v & 8) return { isAnchor: true, format: fmt, anchorIdx: v & 7 };
            return { isAnchor: false, format: fmt, rIndex: (v>>2)&1, gIndex: (v>>1)&1, bIndex: v&1 };
        } else if (fmt === "HAM05") {
            // HAM05: 5-Bit Wert. 
            // Entsprechend dem Encoder: Wenn Bit 4 (16) gesetzt ist, ist es ein Anker, 
            // ansonsten ein Delta-Befehl.
            if (v & 16) {
                return { isAnchor: true, format: fmt, anchorIdx: v & 15 };
            }
            return { 
                isAnchor: false, 
                format: fmt, 
                isTurbo: ((v >> 3) & 1) === 1, 
                rIndex: (v >> 2) & 1, 
                gIndex: (v >> 1) & 1, 
                bIndex: v & 1 
            };
        } else if (fmt === "HAM06") {
            if (v & 32) return { isAnchor: true, format: fmt, anchorIdx: v & 31 };
            return { isAnchor: false, format: fmt, isTurbo: ((v>>4)&1)===1, rIndex: (v>>3)&1, gIndex: (v>>1)&3, bIndex: v&1 };
        } else if (fmt === "HAM08_PAL") {
            if (v & 128) return { isAnchor: true, format: fmt, anchorIdx: v & 127 };
            return { isAnchor: false, format: fmt, isTurbo: ((v>>6)&1)===1, rIndex: (v>>4)&3, gIndex: (v>>2)&3, bIndex: v&3 };
        } else if (fmt === "HAM12") {
            if (v & 0x800) {
                return { 
                    isAnchor: true, 
                    format: fmt, 
                    b10: (v >> 10) & 1, 
                    r3: (v >> 7) & 7, 
                    g4: (v >> 3) & 15, 
                    b3: v & 7,
                    r: (((v >> 7) & 7) << 5) | (((v >> 10) & 1) ? 31 : 0),
                    g: ((v >> 3) & 15) << 4,
                    b: ((v & 7) << 5) | (((v >> 10) & 1) ? 31 : 0)
                };
            }
            let rawDr = (v >> 7) & 7; 
            let dr = (rawDr & 4) ? rawDr - 8 : rawDr;
            let rawDg = (v >> 3) & 15; 
            let dg = (rawDg & 8) ? rawDg - 16 : rawDg;
            let rawDb = v & 7; 
            let db = (rawDb & 4) ? rawDb - 8 : rawDb;
            
            return { 
                isAnchor: false, 
                format: fmt, 
                isTurbo: ((v >> 10) & 1) === 1, 
                dr, 
                dg, 
                db 
            };
        } else if (fmt === "HAM16") {
            if (v & 0x8000) {
                return { 
                    isAnchor: true, 
                    format: fmt, 
                    r5: (v >> 10) & 31, 
                    g5: (v >> 5) & 31, 
                    b5: v & 31 
                };
            }
            let rawDr = (v >> 10) & 15; let dr = rawDr >= 8 ? rawDr - 16 : rawDr;
            let rawDg = (v >> 5) & 31; let dg = rawDg >= 16 ? rawDg - 32 : rawDg;
            let rawDb = v & 31; let db = rawDb >= 16 ? db - 32 : db;
            return { 
                isAnchor: false, 
                format: fmt, 
                isTurbo: ((v >> 14) & 1) === 1, 
                dr, 
                dg, 
                db 
            };
        }
        return { isAnchor: true, format: fmt, anchorIdx: 0 };
    }

    if (config && config.isMixed) {
        let bitPos = 0;
        function readBits(numBits) {
            let val = 0;
            for (let i = 0; i < numBits; i++) {
                let byteIdx = Math.floor(bitPos / 8);
                let bitIdx = 7 - (bitPos % 8);
                if (byteIdx >= packedData.length) return 0;
                let bit = (packedData[byteIdx] >> bitIdx) & 1;
                val = (val << 1) | bit;
                bitPos++;
            }
            return val;
        }

        for (let i = 0; i < totalPixels; i++) {
            let seqIdx = i % config.sequence.length;
            let fmt = config.sequence[seqIdx];
            let bits = 0;
            if(fmt==="HAM04") bits=4;
            else if(fmt==="HAM05") bits=5;
            else if(fmt==="HAM06") bits=6;
            else if(fmt==="HAM08_PAL") bits=8;
            
            let v = readBits(bits);
            commands[i] = parseCmdVal(v, fmt);
        }
    } else {
        if (format === "HAM16" || format === "HAM12") {
            for (let i = 0; i < totalPixels; i++) {
                if (i*2+1 >= packedData.length) {
                    commands[i] = { isAnchor: true, format: format, anchorIdx: 0 };
                    continue;
                }
                let v = (packedData[i*2] << 8) | packedData[i*2+1];
                commands[i] = parseCmdVal(v, format);
            }
        } else {
            for (let i = 0; i < totalPixels; i++) {
                if (i >= packedData.length) {
                    commands[i] = { isAnchor: true, format: format, anchorIdx: 0 };
                    continue;
                }
                let v = packedData[i];
                commands[i] = parseCmdVal(v, format);
            }
        }
    }
    return commands;
}