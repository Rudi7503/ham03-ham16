// src/core/decoder.js
import { clamp } from '../codecs/utils.js';

export function decodeStream(commandArray, imgW, imgH, globalPaletteRAM, userSegments, config) {
    let totalPixels = imgW * imgH;
    let out = new Uint8ClampedArray(totalPixels * 4);
    let acc_r = 127, acc_g = 127, acc_b = 127;

    let activeCmds = [...userSegments];
    if (activeCmds.length === 0) {
        activeCmds.push({ absEnd: totalPixels, waitPixels: totalPixels, bank: 0, step: 4 });
    }

    let slotsPerBank = config.slotsPerBank || 0;
    let wait_counter = 0, cmd_idx = 0;
    let currentBank = activeCmds[0].bank, currentStep = activeCmds[0].step;

    for (let i = 0; i < commandArray.length; i++) {
        if (cmd_idx < activeCmds.length && wait_counter === activeCmds[cmd_idx].waitPixels) {
            wait_counter = 0; cmd_idx++;
            if (cmd_idx < activeCmds.length) { currentBank = activeCmds[cmd_idx].bank; currentStep = activeCmds[cmd_idx].step; }
        }

        let cmd = commandArray[i];

        if (cmd.isAnchor) {
            if (config.isPaletted) {
                let absoluteSlot = (currentBank * slotsPerBank) + (cmd.anchorIdx || 0);
                let off = absoluteSlot * 3;
                acc_r = globalPaletteRAM[off];
                acc_g = globalPaletteRAM[off + 1];
                acc_b = globalPaletteRAM[off + 2];
            } else {
                acc_r = cmd.r; 
                acc_g = cmd.g; 
                acc_b = cmd.b;
            }
        } else {
            let multiplier = cmd.isTurbo ? 4 : 1;
            let s = currentStep * multiplier;

            if (cmd.dr !== undefined || cmd.dg !== undefined || cmd.db !== undefined) {
                // Direkte native Deltas (HAM12 / HAM16)
                acc_r = clamp(acc_r + (cmd.dr || 0) * s, 0, 255);
                acc_g = clamp(acc_g + (cmd.dg || 0) * s, 0, 255);
                acc_b = clamp(acc_b + (cmd.db || 0) * s, 0, 255);
            } else {
                // Paletten-basierte Kanal-Deltas (HAM04 - HAM08_PAL)
                let dr = config.channels.r[cmd.rIndex || 0] || 0;
                let dg = config.channels.g[cmd.gIndex || 0] || 0;
                let db = config.channels.b[cmd.bIndex || 0] || 0;

                acc_r = clamp(acc_r + dr * s, 0, 255);
                acc_g = clamp(acc_g + dg * s, 0, 255);
                acc_b = clamp(acc_b + db * s, 0, 255);
            }
        }

        let outIdx = i * 4;
        out[outIdx] = acc_r;
        out[outIdx + 1] = acc_g;
        out[outIdx + 2] = acc_b;
        out[outIdx + 3] = 255;

        wait_counter++;
    }

    return out;
}