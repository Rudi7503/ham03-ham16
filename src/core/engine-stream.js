// src/core/engine-stream.js
import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, get_yuv_dist, get_rgb_dist } from '../codecs/utils.js';

export async function encodeStream(origData, imgW, imgH, format, userSegments, globalPaletteRAM, strategy, metric, max_depth, progressCallback, startOverride=0, endOverride=0) {
    let totalPixels = imgW * imgH;
    let config = HAM_CONFIGS[format];
    
    let activeCmds = [...userSegments];
    if (activeCmds.length === 0) {
        activeCmds.push({ absEnd: totalPixels, waitPixels: totalPixels, bank: 0, step: 4 });
    }

    let commandArray = [];
    let acc_r = 127, acc_g = 127, acc_b = 127;
    let slotsPerBank = config.slotsPerBank || 0;
    
    let wait_counter = 0;
    let cmd_idx = 0;
    let currentBank = activeCmds[0].bank;
    let currentStep = activeCmds[0].step;

    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;

    // Statistik-Zähler
    let stats = { anchorCount: 0, deltaCount: 0, turboCount: 0 };

    function findBestBranch(x, y, c_acc, d) {
        if (d === max_depth || x >= imgW) return { cost: 0, cmd: null, r: c_acc.r, g: c_acc.g, b: c_acc.b };

        let pIdx = y * imgW + x;
        let origIdx = pIdx * 4;
        let tr = origData[origIdx], tg = origData[origIdx + 1], tb = origData[origIdx + 2];
        let branches = [];

        // 1. ANKER-ZWEIGE
        if (strategy !== 'delta_only') {
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

        // 2. DELTA-ZWEIGE
        if (strategy !== 'anchor_only') {
            let multipliers = config.hasTurbo ? [0, 1] : [0];
            for (let t of multipliers) {
                let m = t ? 4 : 1;
                let s = currentStep * m;

                if (config.isPaletted) {
                    for (let ri = 0; ri < config.channels.r.length; ri++) {
                        for (let gi = 0; gi < config.channels.g.length; gi++) {
                            for (let bi = 0; bi < config.channels.b.length; bi++) {
                                let dr = config.channels.r[ri] * s;
                                let dg = config.channels.g[gi] * s;
                                let db = config.channels.b[bi] * s;

                                let nr = clamp(c_acc.r + dr, 0, 255);
                                let ng = clamp(c_acc.g + dg, 0, 255);
                                let nb = clamp(c_acc.b + db, 0, 255);

                                branches.push({ 
                                    cmd: { isAnchor: false, isTurbo: (m === 4), rIndex: ri, gIndex: gi, bIndex: bi }, 
                                    r: nr, g: ng, b: nb 
                                });
                            }
                        }
                    }
                } else {
                    let diffR = tr - c_acc.r, diffG = tg - c_acc.g, diffB = tb - c_acc.b;
                    if (format === "HAM16") {
                        let dr = clamp(Math.round(diffR / s), -8, 7);
                        let dg = clamp(Math.round(diffG / s), -16, 15);
                        let db = clamp(Math.round(diffB / s), -16, 15);
                        branches.push({ 
                            cmd: { isAnchor: false, format: "HAM16", isTurbo: (m===4), dr, dg, db }, 
                            r: clamp(c_acc.r + dr * s, 0, 255), g: clamp(c_acc.g + dg * s, 0, 255), b: clamp(c_acc.b + db * s, 0, 255) 
                        });
                    } else if (format === "HAM12") {
                        let dr = clamp(Math.round(diffR / s), -4, 3);
                        let dg = clamp(Math.round(diffG / s), -8, 7);
                        let db = clamp(Math.round(diffB / s), -4, 3);
                        branches.push({ 
                            cmd: { isAnchor: false, format: "HAM12", isTurbo: (m===4), dr, dg, db }, 
                            r: clamp(c_acc.r + dr * s, 0, 255), g: clamp(c_acc.g + dg * s, 0, 255), b: clamp(c_acc.b + db * s, 0, 255) 
                        });
                    }
                }
            }
        }

        let best_cost = Infinity;
        let best_branch = null;
        let evaluatedBranches = branches.length > 200 ? branches.slice(0, 200) : branches;

        for (let b of evaluatedBranches) {
            let next_acc = { r: b.r, g: b.g, b: b.b };
            let next_res = findBestBranch(x + 1, y, next_acc, d + 1);
            let dist = metric === 'yuv' ? get_yuv_dist(tr, tg, tb, b.r, b.g, b.b) : get_rgb_dist(tr, tg, tb, b.r, b.g, b.b);
            let total = dist + next_res.cost;

            if (total < best_cost) {
                best_cost = total;
                best_branch = { cost: total, cmd: b.cmd, r: b.r, g: b.g, b: b.b };
            }
        }
        return best_branch || { cost: 0, cmd: branches[0]?.cmd || { isAnchor: true, anchorIdx: 0 }, r: c_acc.r, g: c_acc.g, b: c_acc.b };
    }

    for (let i = 0; i < totalPixels; i++) {
        if (cmd_idx < activeCmds.length && wait_counter === activeCmds[cmd_idx].waitPixels) {
            wait_counter = 0; cmd_idx++;
            if (cmd_idx < activeCmds.length) { currentBank = activeCmds[cmd_idx].bank; currentStep = activeCmds[cmd_idx].step; }
        }

        if (i >= simStart && i < simEnd) {
            let best = findBestBranch(i % imgW, Math.floor(i / imgW), { r: acc_r, g: acc_g, b: acc_b }, 0);
            commandArray.push(best.cmd);
            acc_r = best.r; acc_g = best.g; acc_b = best.b;

            // Zähle Anker vs. Deltas vs. Turbo
            if (best.cmd.isAnchor) {
                stats.anchorCount++;
            } else {
                stats.deltaCount++;
                if (best.cmd.isTurbo) stats.turboCount++;
            }
        } else {
            commandArray.push({ isAnchor: true, anchorIdx: 0 });
            stats.anchorCount++;
        }

        wait_counter++;

        if (i % (imgW*2) === 0 && progressCallback) {
            progressCallback(i, totalPixels);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (progressCallback) progressCallback(totalPixels, totalPixels);
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