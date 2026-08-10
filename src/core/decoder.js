// src/core/decoder.js
import { clamp } from '../codecs/utils.js';

/**
 * Universeller Decoder für alle Formate (HAM04 bis HAM08_PAL sowie 12/16).
 * Verarbeitet ein Command-Array unter Berücksichtigung von Stream-Segmenten und Bänken.
 */
export function decodeStream(commandArray, imgW, imgH, globalPaletteRAM, userSegments, config) {
    let totalPixels = imgW * imgH;
    let out = new Uint8ClampedArray(totalPixels * 4);
    let acc_r = 127, acc_g = 127, acc_b = 127;

    // Segmente für den Stream normalisieren
    let activeCmds = [...userSegments];
    if (activeCmds.length === 0) {
        activeCmds.push({ absEnd: totalPixels, waitPixels: totalPixels, bank: 0, step: {r:4, g:4, b:4} });
    } else if (activeCmds[activeCmds.length - 1].absEnd < totalPixels) {
        let last = activeCmds[activeCmds.length - 1];
        activeCmds.push({ 
            absEnd: totalPixels, 
            waitPixels: totalPixels - last.absEnd, 
            bank: last.bank, 
            step: last.step 
        });
    }

    let slotsPerBank = config.slotsPerBank || 8;
    let wait_counter = 0;
    let cmd_idx = 0;
    let currentBank = activeCmds[0].bank;
    let currentStep = activeCmds[0].step;

    for (let i = 0; i < commandArray.length; i++) {
        if (cmd_idx < activeCmds.length && wait_counter === activeCmds[cmd_idx].waitPixels) {
            wait_counter = 0;
            cmd_idx++;
            if (cmd_idx < activeCmds.length) {
                currentBank = activeCmds[cmd_idx].bank;
                currentStep = activeCmds[cmd_idx].step;
            }
        }

        let cmd = commandArray[i];

        if (cmd.isAnchor) {
            if (config.isPaletted) {
                // Bank-Umschaltung: Berechnet den absoluten Slot im 256er RAM
                let absoluteSlot = (currentBank * slotsPerBank) + (cmd.anchorIdx || 0);
                let off = absoluteSlot * 3;
                acc_r = globalPaletteRAM[off];
                acc_g = globalPaletteRAM[off + 1];
                acc_b = globalPaletteRAM[off + 2];
            } else if (cmd.r !== undefined) {
                // Direkter RGB-Anker für feste Modi (HAM12/HAM16)
                acc_r = cmd.r; 
                acc_g = cmd.g; 
                acc_b = cmd.b;
            }
        } else {
            let multiplier = cmd.isTurbo ? 4 : 1;
            let sr = currentStep.r * multiplier;
            let sg = currentStep.g * multiplier;
            let sb = currentStep.b * multiplier;

            if (cmd.dr !== undefined || cmd.dg !== undefined || cmd.db !== undefined) {
                acc_r = clamp(acc_r + (cmd.dr || 0) * sr, 0, 255);
                acc_g = clamp(acc_g + (cmd.dg || 0) * sg, 0, 255);
                acc_b = clamp(acc_b + (cmd.db || 0) * sb, 0, 255);
            } else {
                let dr = config.channels.r[cmd.rIndex || 0] || 0;
                let dg = config.channels.g[cmd.gIndex || 0] || 0;
                let db = config.channels.b[cmd.bIndex || 0] || 0;

                acc_r = clamp(acc_r + dr * sr, 0, 255);
                acc_g = clamp(acc_g + dg * sg, 0, 255);
                acc_b = clamp(acc_b + db * sb, 0, 255);
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