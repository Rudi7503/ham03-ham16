import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, getMetricDistFunc } from '../codecs/utils.js';

export const CHANNEL_DEFS = {
    "HAM01": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM02": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM03": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM04": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM05": { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    "HAM06": { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    "HAM08": { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] }
};

export async function encodePaletted(origData, imgW, imgH, format, stepVal, paletteRAM, offset, strategy="greedy", metric="yuv_weight", progressCallback=null, startOverride=0, endOverride=0, errorThreshold = 15.0, beamWidth = 6) {
    let totalPixels = imgW * imgH;
    let commands = new Array(totalPixels);
    let config = HAM_CONFIGS[format];

    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;

    paletteRAM[0] = 0; paletteRAM[1] = 0; paletteRAM[2] = 0;

    let chunkSize = (config.isMixed && config.sequence) ? config.sequence.length : 1;

    const distFunc = getMetricDistFunc(metric);

    let deltaCache = {};
    let formatsToCache = config.isMixed ? config.sequence : [format];
    
    for (let fmt of formatsToCache) {
        let effConfig = HAM_CONFIGS[fmt] || { slotsPerBank: 0, hasTurbo: false };
        let multipliers = effConfig.hasTurbo ? [1, 4] : [1];
        let rChan = CHANNEL_DEFS[fmt]?.r || [-1, 1];
        let gChan = CHANNEL_DEFS[fmt]?.g || [-1, 1];
        let bChan = CHANNEL_DEFS[fmt]?.b || [-1, 1];
        let cache = [];

        for (let m of multipliers) {
            let sr = stepVal.r * m, sg = stepVal.g * m, sb = stepVal.b * m;
            for (let ri = 0; ri < rChan.length; ri++) {
                for (let gi = 0; gi < gChan.length; gi++) {
                    for (let bi = 0; bi < bChan.length; bi++) {
                        
                        if (fmt === "HAM01" && (gi !== ri || bi !== ri)) continue;
                        if (fmt === "HAM02" && (bi !== ri)) continue;
                        if (fmt === "HAM03" && (bi !== ri)) continue; // R+B gekoppelt

                        cache.push({
                            cmd: { isAnchor: false, format: fmt, isTurbo: (m===4), rIndex: ri, gIndex: gi, bIndex: bi },
                            dr: rChan[ri] * sr,
                            dg: gChan[gi] * sg,
                            db: bChan[bi] * sb
                        });
                    }
                }
            }
        }
        deltaCache[fmt] = cache;
    }

    // Vorberechnete Anker-Kommandos + Absolut-Slots pro Format. Die Anker-Cmd-
    // Objekte sind unveränderlich und werden über alle Pixel geteilt; die Farbe
    // wird pro Pixel direkt aus paletteRAM gelesen (die Palette kann sich ändern).
    let anchorInfo = {};
    for (let fmt of formatsToCache) {
        let effConfig = HAM_CONFIGS[fmt] || { slotsPerBank: 0 };
        let slots = effConfig.slotsPerBank || 0;
        let arr = [];
        for (let s = 0; s < slots; s++) {
            arr.push({ cmd: { isAnchor: true, format: fmt, anchorIdx: s }, absSlot: (offset + s) % 256 });
        }
        anchorInfo[fmt] = arr;
    }

    // Liefert die Kandidaten als flache Arrays (cmds/rs/gs/bs) statt als
    // Objekt-Array pro Pixel. So entfallen die vielen kurzlebigen
    // {cmd, r, g, b}-Wrapper-Allokationen im heißen Encode-Pfad.
    function getBranches(pxIdx, c_acc) {
        const effFormat = config.isMixed ? config.sequence[pxIdx % config.sequence.length] : format;
        const cmds = [];
        const rs = [], gs = [], bs = [];

        if (strategy !== 'delta_only') {
            const anchors = anchorInfo[effFormat];
            for (let s = 0; s < anchors.length; s++) {
                const a = anchors[s];
                cmds.push(a.cmd);
                rs.push(paletteRAM[a.absSlot * 3]);
                gs.push(paletteRAM[a.absSlot * 3 + 1]);
                bs.push(paletteRAM[a.absSlot * 3 + 2]);
            }
        }

        if (strategy !== 'anchor_only') {
            const cachedDeltas = deltaCache[effFormat];
            for (let i = 0; i < cachedDeltas.length; i++) {
                const d = cachedDeltas[i];
                cmds.push(d.cmd);
                rs.push(clamp(c_acc.r + d.dr, 0, 255));
                gs.push(clamp(c_acc.g + d.dg, 0, 255));
                bs.push(clamp(c_acc.b + d.db, 0, 255));
            }
        }

        if (cmds.length === 0) {
            cmds.push({ isAnchor: true, format: effFormat, anchorIdx: 0 });
            rs.push(c_acc.r); gs.push(c_acc.g); bs.push(c_acc.b);
        }
        return { cmds, rs, gs, bs, len: cmds.length };
    }

    let acc = { r: 127, g: 127, b: 127 };
    let forceLookahead = false;

    for (let i = simStart; i < simEnd; i += chunkSize) {
        let actualChunkSize = Math.min(chunkSize, simEnd - i);
        let greedyCost = 0;
        let currentGreedyAcc = { ...acc };
        let greedyPath = [];

        for (let c = 0; c < actualChunkSize; c++) {
            let pxIdx = i + c;
            let { cmds, rs, gs, bs, len } = getBranches(pxIdx, currentGreedyAcc);
            
            let effFormat = config.isMixed ? config.sequence[pxIdx % config.sequence.length] : format;
            let effConfig = HAM_CONFIGS[effFormat] || { slotsPerBank: 0 };
            let canAnchor = (effConfig.slotsPerBank > 0);
            
            let nextPxIdx = pxIdx + 1;
            let nextFormat = null;
            if (nextPxIdx < simEnd) {
                nextFormat = config.isMixed ? config.sequence[nextPxIdx % config.sequence.length] : format;
            }
            
            let isNextHam03 = (nextFormat === "HAM03");
            let do2PxLookahead = canAnchor && isNextHam03;

            let tr = origData[pxIdx*4], tg = origData[pxIdx*4+1], tb = origData[pxIdx*4+2];
            let tr2 = 0, tg2 = 0, tb2 = 0;
            
            if (do2PxLookahead) {
                tr2 = origData[nextPxIdx*4];
                tg2 = origData[nextPxIdx*4+1];
                tb2 = origData[nextPxIdx*4+2];
            }

            let bestScore = Infinity;   
            let bestDist1 = Infinity;   
            let bestCmd = cmds[0];
            let bestR = rs[0], bestG = gs[0], bestB = bs[0];

            for (let bi = 0; bi < len; bi++) {
                const br = rs[bi], bg = gs[bi], bb = bs[bi];
                let dist1 = distFunc(tr, tg, tb, br, bg, bb);
                let score = dist1;

                if (do2PxLookahead) {
                    const nextBranches = getBranches(nextPxIdx, { r: br, g: bg, b: bb });
                    let bestDist2 = Infinity;
                    for (let bi2 = 0; bi2 < nextBranches.len; bi2++) {
                        let d2 = distFunc(tr2, tg2, tb2, nextBranches.rs[bi2], nextBranches.gs[bi2], nextBranches.bs[bi2]);
                        if (d2 < bestDist2) bestDist2 = d2;
                    }
                    score += bestDist2;
                }

                if (score < bestScore) {
                    bestScore = score;
                    bestDist1 = dist1;
                    bestCmd = cmds[bi];
                    bestR = br; bestG = bg; bestB = bb;
                }
            }
            
            greedyCost += bestDist1; 
            currentGreedyAcc = { r: bestR, g: bestG, b: bestB };
            greedyPath.push({ cmd: bestCmd, r: bestR, g: bestG, b: bestB });
        }

        let bestChunkCmds = greedyPath.map(b => b.cmd);
        let finalAcc = currentGreedyAcc;
        let greedyAvgCost = greedyCost / actualChunkSize;
        let startsWithAnchor = greedyPath[0].cmd.isAnchor;
        
        let needsLookahead = (greedyAvgCost > errorThreshold) || (forceLookahead && !startsWithAnchor);

        if (strategy === 'lookahead_chunk' && actualChunkSize > 1 && needsLookahead) {
            let bestDfsCost = greedyCost;
            let bestChunkPath = greedyPath;

            let currentBeam = [{ cost: 0, acc: { ...acc }, path: [] }];

            for (let c = 0; c < actualChunkSize; c++) {
                let pxIdx = i + c;
                let tr = origData[pxIdx*4], tg = origData[pxIdx*4+1], tb = origData[pxIdx*4+2];
                let nextBeam = [];

                for (let node of currentBeam) {
                    const branches = getBranches(pxIdx, node.acc);

                    for (let bi = 0; bi < branches.len; bi++) {
                        const br = branches.rs[bi], bg = branches.gs[bi], bb = branches.bs[bi];
                        const dist = distFunc(tr, tg, tb, br, bg, bb);
                        const newCost = node.cost + dist;

                        if (newCost < bestDfsCost) {
                            nextBeam.push({
                                cost: newCost,
                                acc: { r: br, g: bg, b: bb },
                                path: [...node.path, { cmd: branches.cmds[bi], r: br, g: bg, b: bb }]
                            });
                        }
                    }
                }

                if (nextBeam.length === 0) break;

                nextBeam.sort((a, b) => a.cost - b.cost);
                currentBeam = nextBeam.slice(0, beamWidth);

                if (c === actualChunkSize - 1 && currentBeam.length > 0) {
                    if (currentBeam[0].cost < bestDfsCost) {
                        bestDfsCost = currentBeam[0].cost;
                        bestChunkPath = currentBeam[0].path;
                    }
                }
            }

            if (bestChunkPath && bestChunkPath.length === actualChunkSize) {
                bestChunkCmds = bestChunkPath.map(b => b.cmd);
                finalAcc = { r: bestChunkPath[actualChunkSize-1].r, g: bestChunkPath[actualChunkSize-1].g, b: bestChunkPath[actualChunkSize-1].b };
            }
            forceLookahead = true; 
        } else {
            forceLookahead = false; 
        }

        for (let c = 0; c < actualChunkSize; c++) {
            let pxIdx = i + c;
            commands[pxIdx] = bestChunkCmds[c];
        }
        acc = finalAcc;

        if (progressCallback && i % (imgW * 4) === 0) {
            progressCallback(`Encoding (${strategy})`, i, simEnd);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    return { commands };
}

function getCmdVal(cmd) {
    let v = 0, bits = 4;
    let fmt = cmd.format;
    
    if (fmt === "HAM01") {
        bits = 1; v = cmd.rIndex & 1;
    } else if (fmt === "HAM02") {
        bits = 2; v = ((cmd.rIndex & 1) << 1) | (cmd.gIndex & 1);
    } else if (fmt === "HAM03") {
        bits = 3;
        if (cmd.isAnchor) v = 4 | (cmd.anchorIdx & 3);
        else v = (((cmd.rIndex||0) & 1) << 1) | ((cmd.gIndex||0) & 1);
    } else if (fmt === "HAM04") {
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
    } else if (fmt === "HAM08") {
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
        if (fmt === "HAM01") {
            let dir = v & 1; return { isAnchor: false, format: fmt, rIndex: dir, gIndex: dir, bIndex: dir };
        } else if (fmt === "HAM02") {
            let rbDir = (v >> 1) & 1, gDir = v & 1; return { isAnchor: false, format: fmt, rIndex: rbDir, gIndex: gDir, bIndex: rbDir };
        } else if (fmt === "HAM03") {
            if (v & 4) return { isAnchor: true, format: fmt, anchorIdx: v & 3 };
            let rbDir = (v >> 1) & 1;
            return { isAnchor: false, format: fmt, isTurbo: false, rIndex: rbDir, gIndex: v & 1, bIndex: rbDir };
        } else if (fmt === "HAM04") {
            if (v & 8) return { isAnchor: true, format: fmt, anchorIdx: v & 7 };
            return { isAnchor: false, format: fmt, isTurbo: false, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM05") {
            if (v & 16) return { isAnchor: true, format: fmt, anchorIdx: v & 15 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 3) & 1) === 1, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM06") {
            if (v & 32) return { isAnchor: true, format: fmt, anchorIdx: v & 31 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 4) & 1) === 1, rIndex: (v >> 3) & 1, gIndex: (v >> 1) & 3, bIndex: v & 1 };
        } else if (fmt === "HAM08") {
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
            let bits = (fmt === "HAM01") ? 1 : (fmt === "HAM02") ? 2 : (fmt === "HAM03") ? 3 : (fmt === "HAM04") ? 4 : (fmt === "HAM05") ? 5 : (fmt === "HAM06") ? 6 : 8;
            shift -= bits;
            commands[pIdx++] = parseVal((w32 >>> shift) & ((1 << bits) - 1), fmt);
        }
    }
    return commands;
}

// Baut pro Format Tabellen mit den bereits eingerechneten Delta-Werten
// (Kanal-Wert × Schritt × Turbo-Multiplikator). Dadurch braucht die heiße
// Dekodier-Schleife pro Pixel nur noch einen Array-Zugriff statt der
// CHANNEL_DEFS-Suche und mehrerer Multiplikationen.
function buildDecodeDeltaTables(stepVal) {
    const make = (chans, m) => ({
        r: chans.r.map((c) => c * stepVal.r * m),
        g: chans.g.map((c) => c * stepVal.g * m),
        b: chans.b.map((c) => c * stepVal.b * m)
    });
    const tables = {};
    for (const fmt of Object.keys(CHANNEL_DEFS)) {
        tables[fmt] = { normal: make(CHANNEL_DEFS[fmt], 1), turbo: make(CHANNEL_DEFS[fmt], 4) };
    }
    // Fallback entspricht exakt dem früheren Verhalten für unbekannte Formate.
    tables.fallback = {
        normal: make({ r: [-1, 1], g: [-1, 1], b: [-1, 1] }, 1),
        turbo: make({ r: [-1, 1], g: [-1, 1], b: [-1, 1] }, 4)
    };
    return tables;
}

// Anzahl der Anker-Slots je Format (0 = keine Anker) als flache Tabelle
// vorberechnet, damit die heiße Dekodier-Schleife keine Lookups mit
// Optional-Chaining mehr braucht.
const SLOT_COUNT_BY_FMT = (() => {
    const m = {};
    for (const fmt of Object.keys(HAM_CONFIGS)) {
        m[fmt] = (HAM_CONFIGS[fmt] && HAM_CONFIGS[fmt].slotsPerBank) || 0;
    }
    return m;
})();

// Cache für die Delta-Tabellen: Innerhalb einer Battle-Serie (viele Kandidaten
// mit gleicher Schrittweite) werden die Tabellen so nur einmal aufgebaut.
let deltaTablesCacheKey = null;
let deltaTablesCache = null;
function getDecodeDeltaTables(stepVal) {
    const key = `${stepVal.r},${stepVal.g},${stepVal.b}`;
    if (deltaTablesCacheKey !== key || !deltaTablesCache) {
        deltaTablesCacheKey = key;
        deltaTablesCache = buildDecodeDeltaTables(stepVal);
    }
    return deltaTablesCache;
}

export function decodePaletted(commands, imgW, imgH, stepVal, paletteRAM, offset) {
    let out = new Uint8ClampedArray(imgW * imgH * 4);
    const deltaTables = getDecodeDeltaTables(stepVal);
    // Akkumulator als Skalare statt Objekt: deutlich schneller pro Pixel.
    let r = 127, g = 127, b = 127;

    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (cmd.isAnchor && SLOT_COUNT_BY_FMT[cmd.format] > 0) {
            const absIdx = ((offset + cmd.anchorIdx) % 256) * 3;
            r = paletteRAM[absIdx]; g = paletteRAM[absIdx + 1]; b = paletteRAM[absIdx + 2];
        } else {
            const table = deltaTables[cmd.format] || deltaTables.fallback;
            const t = cmd.isTurbo ? table.turbo : table.normal;
            const ri = cmd.rIndex || 0, gi = cmd.gIndex || 0, bi = cmd.bIndex || 0;
            r = clamp(r + (t.r[ri] || 0), 0, 255);
            g = clamp(g + (t.g[gi] || 0), 0, 255);
            b = clamp(b + (t.b[bi] || 0), 0, 255);
        }
        const outIdx = i * 4;
        out[outIdx] = r; out[outIdx + 1] = g; out[outIdx + 2] = b; out[outIdx + 3] = 255;
    }
    return out;
}

function signedDelta(v) {
    return v > 0 ? `+${v}` : `${v}`;
}

// Beschreibt ein einzelnes Kommando für die Pixel-Anzeige im UI, z. B.
// "ham03 ankerslot 2 (abs 18)" oder "ham05 r +6 g +12 b -6". Liefert null,
// wenn kein (oder kein beschreibbares) Kommando vorliegt.
export function describeCommand(cmd, step, offset = 0) {
    if (!cmd || !cmd.format) return null;
    const fmt = cmd.format.toLowerCase();

    if (cmd.isAnchor) {
        if (cmd.format === "HAM12" || cmd.format === "HAM16") {
            return `${fmt} anker`;
        }
        return `${fmt} ankerslot ${cmd.anchorIdx} (abs ${(offset + cmd.anchorIdx) % 256})`;
    }

    if (cmd.format === "HAM12" || cmd.format === "HAM16") {
        const m = cmd.isTurbo ? 4 : 1;
        const dr = cmd.dr * step.r * m;
        const dg = cmd.dg * step.g * m;
        const db = cmd.db * step.b * m;
        return `${fmt} r${signedDelta(dr)} g${signedDelta(dg)} b${signedDelta(db)}`;
    }

    const chans = CHANNEL_DEFS[cmd.format] || { r: [-1, 1], g: [-1, 1], b: [-1, 1] };
    const m = cmd.isTurbo ? 4 : 1;
    const dr = (chans.r[cmd.rIndex || 0] || 0) * step.r * m;
    const dg = (chans.g[cmd.gIndex || 0] || 0) * step.g * m;
    const db = (chans.b[cmd.bIndex || 0] || 0) * step.b * m;
    return `${fmt} r${signedDelta(dr)} g${signedDelta(dg)} b${signedDelta(db)}`;
}