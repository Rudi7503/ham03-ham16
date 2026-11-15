import { HAM_CONFIGS } from '../codecs/configs.js';
import { clamp, getMetricDistFunc } from '../codecs/utils.js';

export const CHANNEL_DEFS = {
    "HAM01": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM02": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM03": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM04": { r: [-2, 2], g: [-2, 2], b: [-2, 2] },
    "HAM05": { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    "HAM06": { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    "HAM08": { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] },
    "HAM04_DELTA": { r: [-1, 1], g: [-1, 1], b: [-1, 1] },
    "HAM05_DELTA": { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    "HAM06_DELTA": { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] },
    "HAM08_DELTA": { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] }
};

// ---------------------------------------------------------------------------
// Gemeinsame Tabellen-Bauer: EINE Quelle für Encode, lokalen Re-Encode und die
// Werte-Liste im Fehlerbild-Fenster.
// ---------------------------------------------------------------------------

// Alle Delta-Kommandos eines Sub-Formats inkl. der bereits eingerechneten
// Farbverschiebungen (Kanalwert × Schritt × Turbo-Multiplikator).
function buildFormatDeltaCache(fmt, stepVal) {
    // HAM12 ist ein reines Anker-Format (Direktfarbanker) und hat keine
    // Kanal-Deltas. Ohne diese Sperre entstünde aus dem Fallback [-1,1] ein
    // Delta-Befehl, der sich nicht kodieren lässt: beim Packen wurde daraus ein
    // 12-Bit-Wort, das als schwarzer Anker dekodiert (stiller Datenverlust).
    if (fmt === "HAM12") return [];
    const effConfig = HAM_CONFIGS[fmt] || { slotsPerBank: 0, hasTurbo: false };
    let multipliers;
    if (fmt === "HAM05_DELTA") {
        multipliers = [4, 16];
    } else if (fmt === "HAM06_DELTA" || fmt === "HAM08_DELTA") {
        multipliers = [1, 4, 8, 16];
    } else {
        multipliers = effConfig.hasTurbo ? [1, 4] : [1];
    }
    const rChan = CHANNEL_DEFS[fmt]?.r || [-1, 1];
    const gChan = CHANNEL_DEFS[fmt]?.g || [-1, 1];
    const bChan = CHANNEL_DEFS[fmt]?.b || [-1, 1];
    const cache = [];

    for (let mi = 0; mi < multipliers.length; mi++) {
        const m = multipliers[mi];
        const sr = stepVal.r * m, sg = stepVal.g * m, sb = stepVal.b * m;
        for (let ri = 0; ri < rChan.length; ri++) {
            for (let gi = 0; gi < gChan.length; gi++) {
                for (let bi = 0; bi < bChan.length; bi++) {
                    if (fmt === "HAM01" && (gi !== ri || bi !== ri)) continue;
                    if (fmt === "HAM02" && (bi !== ri)) continue;
                    if (fmt === "HAM03" && (bi !== ri)) continue; // R+B gekoppelt

                    const cmdObj = {
                        isAnchor: false,
                        format: fmt,
                        rIndex: ri,
                        gIndex: gi,
                        bIndex: bi
                    };
                    if (fmt === "HAM05_DELTA") {
                        cmdObj.isTurbo = (m === 16);
                    } else if (fmt === "HAM06_DELTA" || fmt === "HAM08_DELTA") {
                        cmdObj.turboIndex = mi;
                        cmdObj.isTurbo = (mi > 0);
                    } else {
                        cmdObj.isTurbo = (m === 4);
                    }

                    cache.push({
                        cmd: cmdObj,
                        dr: rChan[ri] * sr,
                        dg: gChan[gi] * sg,
                        db: bChan[bi] * sb
                    });
                }
            }
        }
    }
    return cache;
}

// Anker-Kommandos + Absolut-Slot je Sub-Format. Die Cmd-Objekte sind
// unveränderlich und werden über alle Pixel geteilt; die Farbe wird pro Pixel
// direkt aus paletteRAM gelesen (die Palette kann sich ändern).
function buildFormatAnchorInfo(fmt, offset) {
    const effConfig = HAM_CONFIGS[fmt] || { slotsPerBank: 0 };
    const slots = effConfig.slotsPerBank || 0;
    const arr = [];
    for (let s = 0; s < slots; s++) {
        arr.push({ cmd: { isAnchor: true, format: fmt, anchorIdx: s }, absSlot: (offset + s) % 256 });
    }
    return arr;
}

// Sub-Format der Phase an Pixelindex i (Mischraster) bzw. das Format selbst.
export function phaseFormatAt(format, imgW, pxIndex) {
    const config = HAM_CONFIGS[format];
    if (config && config.isMixed && Array.isArray(config.sequence) && config.sequence.length > 0) {
        return config.sequence[pxIndex % config.sequence.length];
    }
    return format;
}

// Hat dieses Sub-Format an dieser Position einen Anker?
export function formatHasAnchors(fmt) {
    if (fmt === "HAM12") return true;          // Direktfarbanker
    const cfg = HAM_CONFIGS[fmt];
    return !!(cfg && cfg.slotsPerBank > 0);
}

// Kann jede Zeile der Breite `width` mit einem Anker beginnen?
// Fuer Mischformate wird der Zyklus der Zeilenanfaenge geprueft: Position
// k*width mod sequence.length. Reicht bis sequence.length, weil der Zyklus
// hoechstens so lang ist.
export function formatSupportsRowAnchors(format, width) {
    const cfg = HAM_CONFIGS[format];
    if (!cfg) return false;
    if (!cfg.isMixed || !Array.isArray(cfg.sequence) || cfg.sequence.length === 0) {
        return formatHasAnchors(format);
    }
    const seq = cfg.sequence;
    for (let k = 0; k < seq.length; k++) {
        if (!formatHasAnchors(seq[(k * width) % seq.length])) return false;
    }
    return true;
}
export async function encodePaletted(origData, imgW, imgH, format, stepVal, paletteRAM, offset, strategy="greedy", metric="yuv_weight", progressCallback=null, startOverride=0, endOverride=0, errorThreshold = 15.0, beamWidth = 6, forceRowAnchors = false) {
    let totalPixels = imgW * imgH;
    let commands = new Array(totalPixels);
    let config = HAM_CONFIGS[format];

    let simStart = startOverride || 0;
    let simEnd = endOverride || totalPixels;

    paletteRAM[0] = 0; paletteRAM[1] = 0; paletteRAM[2] = 0;

    let chunkSize = (config.isMixed && config.sequence) ? config.sequence.length : 1;

    const distFunc = getMetricDistFunc(metric);

    // Vorberechnete Delta- und Anker-Tabellen pro Sub-Format (siehe Helfer unten).
    // Werden auch vom lokalen Re-Encode und der Werte-Liste im Fehlerbild-Fenster
    // benutzt, damit es nur EINE Quelle für diese Logik gibt.
    let deltaCache = {};
    const formatsToCache = config.isMixed ? config.sequence : [format];
    for (let fmt of formatsToCache) {
        deltaCache[fmt] = buildFormatDeltaCache(fmt, stepVal);
    }

    let anchorInfo = {};
    // Warnungen waehrend des Encodens (einmal je Format/Strategie), damit die
    // Oberflaeche sagen kann, warum eine Einstellung nicht wie gewuenscht wirkt.
    const warnings = [];
    const warnRowAnchorFormats = new Set();
    const warnStrategyFormats = new Set();
    for (let fmt of formatsToCache) {
        anchorInfo[fmt] = buildFormatAnchorInfo(fmt, offset);
    }

    // Liefert die Kandidaten als flache Arrays (cmds/rs/gs/bs) statt als
    // Objekt-Array pro Pixel. So entfallen die vielen kurzlebigen
    // {cmd, r, g, b}-Wrapper-Allokationen im heißen Encode-Pfad.
    function getBranches(pxIdx, c_acc) {
        const effFormat = config.isMixed ? config.sequence[pxIdx % config.sequence.length] : format;
        const cmds = [];
        const rs = [], gs = [], bs = [];

        // forceRowAnchors: Am Zeilenanfang ist NUR ein Anker erlaubt. Damit wird
        // jede Zeile unabhaengig dekodierbar (kein Farbzustand aus der Vorderzeile
        // noetig) — Voraussetzung fuer Zeilensprung im Betrieb, z. B. Interlace.
        // Kostet keine Bytes (feste Bitrate), nur Farbfreiheit an diesem Pixel.
        //
        // WICHTIG: Das geht nur, wenn das Sub-Format an genau dieser Position
        // ueberhaupt Anker besitzt. Delta-Formate (slotsPerBank 0) und
        // HAM12-Formate an Delta-Positionen haben keinen Anker; ein
        // erzwungener Anker waere nicht kodierbar und die Datei dekodiert Unsinn.
        // In dem Fall wird der Zwang fuer dieses Pixel ignoriert und gemeldet.
        const rowStart = forceRowAnchors && (pxIdx % imgW) === 0;
        const anchorsHere = effFormat === "HAM12" ? [] : (anchorInfo[effFormat] || []);
        const canAnchorHere = effFormat === "HAM12" || anchorsHere.length > 0;
        if (rowStart && !canAnchorHere) {
            if (!warnRowAnchorFormats.has(effFormat)) {
                warnRowAnchorFormats.add(effFormat);
                warnings.push(`Zeilenanker an Position 0 nicht möglich: ${effFormat} hat dort keinen Anker (Format wird umsortiert/deaktiviert)`);
            }
        }
        const forceAnchorHere = rowStart && canAnchorHere;

        if (forceAnchorHere || strategy !== 'delta_only') {
            if (effFormat === "HAM12") {
                let tr = origData[pxIdx*4], tg = origData[pxIdx*4+1], tb = origData[pxIdx*4+2];
                let r3 = tr >> 5, g4 = tg >> 4, b3 = tb >> 5;
                for (let b10 of [0, 1]) {
                    let r4 = (r3 << 1) | b10, b4 = (b3 << 1) | b10;
                    let ar = r4 << 4, ag = g4 << 4, ab = b4 << 4;
                    cmds.push({ isAnchor: true, isDirect: true, format: "HAM12", r3, g4, b3, b10, r: ar, g: ag, b: ab });
                    rs.push(ar); gs.push(ag); bs.push(ab);
                }
            } else {
                for (let s = 0; s < anchorsHere.length; s++) {
                    const a = anchorsHere[s];
                    cmds.push(a.cmd);
                    rs.push(paletteRAM[a.absSlot * 3]);
                    gs.push(paletteRAM[a.absSlot * 3 + 1]);
                    bs.push(paletteRAM[a.absSlot * 3 + 2]);
                }
            }
        }

        if (!forceAnchorHere && strategy !== 'anchor_only') {
            const cachedDeltas = deltaCache[effFormat] || [];
            for (let i = 0; i < cachedDeltas.length; i++) {
                const d = cachedDeltas[i];
                cmds.push(d.cmd);
                rs.push(clamp(c_acc.r + d.dr, 0, 255));
                gs.push(clamp(c_acc.g + d.dg, 0, 255));
                bs.push(clamp(c_acc.b + d.db, 0, 255));
            }
        }

        if (cmds.length === 0) {
            // Keine Kandidaten: Es MUSS ein Befehl erzeugt werden, der vom Format
            // auch kodierbar ist. Vorher wurde hier immer ein Anker erfunden — bei
            // ankerlosen Formaten entstand so eine Datei, die nach dem Speichern
            // voellig anders dekodiert (stiller Datenverlust). Jetzt: Anker nur bei
            // vorhandenen Ankern, sonst der betragskleinste Delta-Befehl.
            if (effFormat === "HAM12") {
                let tr = origData[pxIdx*4], tg = origData[pxIdx*4+1], tb = origData[pxIdx*4+2];
                let r3 = tr >> 5, g4 = tg >> 4, b3 = tb >> 5;
                let b10 = 0;
                let ar = (r3 << 1) << 4, ag = g4 << 4, ab = (b3 << 1) << 4;
                cmds.push({ isAnchor: true, isDirect: true, format: "HAM12", r3, g4, b3, b10, r: ar, g: ag, b: ab });
                rs.push(ar); gs.push(ag); bs.push(ab);
            } else if (anchorsHere.length > 0) {
                const a = anchorsHere[0];
                cmds.push(a.cmd);
                rs.push(paletteRAM[a.absSlot * 3]);
                gs.push(paletteRAM[a.absSlot * 3 + 1]);
                bs.push(paletteRAM[a.absSlot * 3 + 2]);
            } else {
                const cands = deltaCache[effFormat] || [];
                if (cands.length === 0) {
                    throw new Error(`Format ${effFormat} hat weder Anker noch Deltas`);
                }
                // betragskleinster Delta-Befehl = kleinste Farbaenderung
                let best = cands[0];
                let bestMag = Infinity;
                for (const d of cands) {
                    const mag = Math.abs(d.dr) + Math.abs(d.dg) + Math.abs(d.db);
                    if (mag < bestMag) { bestMag = mag; best = d; }
                }
                cmds.push(best.cmd);
                rs.push(clamp(c_acc.r + best.dr, 0, 255));
                gs.push(clamp(c_acc.g + best.dg, 0, 255));
                bs.push(clamp(c_acc.b + best.db, 0, 255));
                if (!warnStrategyFormats.has(`${effFormat}|${strategy}`)) {
                    warnStrategyFormats.add(`${effFormat}|${strategy}`);
                    warnings.push(`Strategie "${strategy}" liefert für ${effFormat} keine Kandidaten; es wird ein Delta-Befehl verwendet (Format hat keine Anker)`);
                }
            }
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

    return { commands, warnings };
}

// Modusbit-Konvention (ab Formatversion 4):
//   Modusbit = 0  →  ANKER  (Palettenmodus), Nutzlast = Slotindex
//   Modusbit = 1  →  DELTA  (Nutzlast = Turbo + Kanalrichtungen)
// Das Modusbit ist jeweils das höchstwertige Bit des Codes: HAM03 Bit2 (4),
// HAM04 Bit3 (8), HAM05 Bit4 (16), HAM06 Bit5 (32), HAM08 Bit7 (128).
// HAM01/HAM02 haben keine Anker und damit kein Modusbit.
// Bis Version 3 war es umgekehrt (1 = Anker); solche Dateien sind nicht mehr
// lesbar und werden beim Laden abgewiesen.
function getCmdVal(cmd) {
    let v = 0, bits = 4;
    let fmt = cmd.format;
    
    if (fmt === "HAM01") {
        bits = 1; v = cmd.rIndex & 1;
    } else if (fmt === "HAM02") {
        bits = 2; v = ((cmd.rIndex & 1) << 1) | (cmd.gIndex & 1);
    } else if (fmt === "HAM03") {
        bits = 3;
        if (cmd.isAnchor) v = (cmd.anchorIdx & 3);
        else v = 4 | (((cmd.rIndex||0) & 1) << 1) | ((cmd.gIndex||0) & 1);
    } else if (fmt === "HAM04") {
        bits = 4;
        if (cmd.isAnchor) v = (cmd.anchorIdx & 7);
        else v = 8 | (((cmd.rIndex||0)>0?1:0)<<2) | (((cmd.gIndex||0)>0?1:0)<<1) | ((cmd.bIndex||0)>0?1:0);
    } else if (fmt === "HAM05") {
        bits = 5;
        if (cmd.isAnchor) v = (cmd.anchorIdx & 15);
        else v = 16 | (((cmd.isTurbo?1:0)<<3) | ((cmd.rIndex||0)<<2) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (fmt === "HAM06") {
        bits = 6;
        if (cmd.isAnchor) v = (cmd.anchorIdx & 31);
        else v = 32 | (((cmd.isTurbo?1:0)<<4) | ((cmd.rIndex||0)<<3) | ((cmd.gIndex||0)<<1) | (cmd.bIndex||0));
    } else if (fmt === "HAM08") {
        bits = 8;
        if (cmd.isAnchor) v = (cmd.anchorIdx & 127);
        else v = 128 | (((cmd.isTurbo?1:0)<<6) | ((cmd.rIndex||0)<<4) | ((cmd.gIndex||0)<<2) | (cmd.bIndex||0));
    } else if (fmt === "HAM04_DELTA") {
        bits = 4;
        v = (((cmd.isTurbo ? 1 : 0) << 3) |
             (((cmd.rIndex || 0) & 1) << 2) |
             (((cmd.gIndex || 0) & 1) << 1) |
             ((cmd.bIndex || 0) & 1));
    } else if (fmt === "HAM05_DELTA") {
        bits = 5;
        v = (((cmd.isTurbo ? 1 : 0) << 4) |
             (((cmd.rIndex || 0) & 1) << 3) |
             (((cmd.gIndex || 0) & 3) << 1) |
             ((cmd.bIndex || 0) & 1));
    } else if (fmt === "HAM06_DELTA") {
        bits = 6;
        const tIdx = cmd.turboIndex !== undefined ? cmd.turboIndex : (cmd.isTurbo ? 1 : 0);
        v = (((tIdx & 3) << 4) |
             (((cmd.rIndex || 0) & 1) << 3) |
             (((cmd.gIndex || 0) & 3) << 1) |
             ((cmd.bIndex || 0) & 1));
    } else if (fmt === "HAM08_DELTA") {
        bits = 8;
        const tIdx = cmd.turboIndex !== undefined ? cmd.turboIndex : (cmd.isTurbo ? 1 : 0);
        v = (((tIdx & 3) << 6) |
             (((cmd.rIndex || 0) & 3) << 4) |
             (((cmd.gIndex || 0) & 3) << 2) |
             ((cmd.bIndex || 0) & 3));
    } else if (fmt === "HAM12") {
        bits = 12;
        v = ((cmd.b10 & 1) << 10) | ((cmd.r3 & 7) << 7) | ((cmd.g4 & 0xF) << 3) | (cmd.b3 & 7);
    }
    return { v, bits };
}

// Bitbreite je Sub-Format (nur hier geführt, damit Packen und Entpacken
// dieselbe Quelle haben).
const BITS_BY_FMT = {
    HAM01: 1, HAM02: 2, HAM03: 3, HAM04: 4, HAM05: 5, HAM06: 6, HAM08: 8,
    HAM04_DELTA: 4, HAM05_DELTA: 5, HAM06_DELTA: 6, HAM08_DELTA: 8,
    HAM12: 12
};

// Packt die Befehlskette als kontinuierlichen Bitstrom (MSB-first) in
// 32-Bit-Wörter.
//
// Die Breite kommt aus getCmdVal und hängt nur vom Sub-Format des jeweiligen
// Pixels ab. Dadurch funktionieren gemischte UND reine Formate:
//   • gemischt: die Breiten einer Sequenz summieren sich auf 32, der Strom
//     erzeugt also Byte für Byte dieselben Wörter wie das frühere wortweise
//     Packen (Dateien bleiben kompatibel).
//   • rein (z. B. HAM06 mit 6 Bit): der Strom füllt die Wörter laufend weiter,
//     ohne dass eine Sequenz nötig wäre.
// Das letzte Wort wird mit Nullen auf 4 Byte aufgefüllt.
export function packPaletted(commands, format) {
    const out = [];
    let acc = 0, nbits = 0;
    for (let i = 0; i < commands.length; i++) {
        const { v, bits } = getCmdVal(commands[i]);
        acc = (acc << bits) | (v & ((1 << bits) - 1));
        nbits += bits;
        while (nbits >= 8) {
            nbits -= 8;
            out.push((acc >> nbits) & 255);
        }
        acc &= (1 << nbits) - 1;
    }
    if (nbits > 0) out.push((acc << (8 - nbits)) & 255);
    while (out.length % 4 !== 0) out.push(0);
    return new Uint8Array(out);
}

export function unpackPaletted(packedData, format, totalPixels) {
    const config = HAM_CONFIGS[format];
    // Reine Formate haben keine Sequenz: dann gilt für jeden Pixel das Format selbst.
    const seq = (config && config.isMixed && Array.isArray(config.sequence) && config.sequence.length > 0)
        ? config.sequence : null;
    const commands = new Array(totalPixels);
    let p = 0, acc = 0, nbits = 0;

    // Modusbit = 0 → Anker, = 1 → Delta (siehe getCmdVal)
    function parseVal(v, fmt) {
        if (fmt === "HAM01") {
            let dir = v & 1; return { isAnchor: false, format: fmt, rIndex: dir, gIndex: dir, bIndex: dir };
        } else if (fmt === "HAM02") {
            let rbDir = (v >> 1) & 1, gDir = v & 1; return { isAnchor: false, format: fmt, rIndex: rbDir, gIndex: gDir, bIndex: rbDir };
        } else if (fmt === "HAM03") {
            if ((v & 4) === 0) return { isAnchor: true, format: fmt, anchorIdx: v & 3 };
            let rbDir = (v >> 1) & 1;
            return { isAnchor: false, format: fmt, isTurbo: false, rIndex: rbDir, gIndex: v & 1, bIndex: rbDir };
        } else if (fmt === "HAM04") {
            if ((v & 8) === 0) return { isAnchor: true, format: fmt, anchorIdx: v & 7 };
            return { isAnchor: false, format: fmt, isTurbo: false, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM05") {
            if ((v & 16) === 0) return { isAnchor: true, format: fmt, anchorIdx: v & 15 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 3) & 1) === 1, rIndex: (v >> 2) & 1, gIndex: (v >> 1) & 1, bIndex: v & 1 };
        } else if (fmt === "HAM06") {
            if ((v & 32) === 0) return { isAnchor: true, format: fmt, anchorIdx: v & 31 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 4) & 1) === 1, rIndex: (v >> 3) & 1, gIndex: (v >> 1) & 3, bIndex: v & 1 };
        } else if (fmt === "HAM08") {
            if ((v & 128) === 0) return { isAnchor: true, format: fmt, anchorIdx: v & 127 };
            return { isAnchor: false, format: fmt, isTurbo: ((v >> 6) & 1) === 1, rIndex: (v >> 4) & 3, gIndex: (v >> 2) & 3, bIndex: v & 3 };
        } else if (fmt === "HAM04_DELTA") {
            return {
                isAnchor: false,
                format: fmt,
                isTurbo: ((v >> 3) & 1) === 1,
                rIndex: (v >> 2) & 1,
                gIndex: (v >> 1) & 1,
                bIndex: v & 1
            };
        } else if (fmt === "HAM05_DELTA") {
            let isTurbo = ((v >> 4) & 1) === 1;
            let rDir = (v >> 3) & 1;
            let gDir = (v >> 1) & 3;
            let bDir = v & 1;
            return { isAnchor: false, format: fmt, isTurbo, rIndex: rDir, gIndex: gDir, bIndex: bDir };
        } else if (fmt === "HAM06_DELTA") {
            let turboIndex = (v >> 4) & 3;
            let rDir = (v >> 3) & 1;
            let gDir = (v >> 1) & 3;
            let bDir = v & 1;
            return { isAnchor: false, format: fmt, turboIndex, isTurbo: turboIndex > 0, rIndex: rDir, gIndex: gDir, bIndex: bDir };
        } else if (fmt === "HAM08_DELTA") {
            let turboIndex = (v >> 6) & 3;
            let rDir = (v >> 4) & 3;
            let gDir = (v >> 2) & 3;
            let bDir = v & 3;
            return { isAnchor: false, format: fmt, turboIndex, isTurbo: turboIndex > 0, rIndex: rDir, gIndex: gDir, bIndex: bDir };
        } else if (fmt === "HAM12") {
            let b10 = (v >> 10) & 1;
            let r3 = (v >> 7) & 7;
            let g4 = (v >> 3) & 0xF;
            let b3 = v & 7;
            let ar = ((r3 << 1) | b10) << 4;
            let ag = g4 << 4;
            let ab = ((b3 << 1) | b10) << 4;
            return { isAnchor: true, isDirect: true, format: fmt, r3, g4, b3, b10, r: ar, g: ag, b: ab };
        }
        return { isAnchor: true, format: fmt, anchorIdx: 0 };
    }

    // Bitstrom lesen: pro Pixel so viele Bits ziehen, wie sein Sub-Format braucht
    for (let i = 0; i < totalPixels; i++) {
        const fmt = seq ? seq[i % seq.length] : format;
        const bits = BITS_BY_FMT[fmt] || 4;
        while (nbits < bits) {
            acc = (acc << 8) | (packedData[p++] || 0);
            nbits += 8;
        }
        nbits -= bits;
        const v = (acc >> nbits) & ((1 << bits) - 1);
        acc &= (1 << nbits) - 1;
        commands[i] = parseVal(v, fmt);
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
        if (fmt === "HAM05_DELTA") {
            tables[fmt] = {
                normal: make(CHANNEL_DEFS[fmt], 4),
                turbo: make(CHANNEL_DEFS[fmt], 16)
            };
        } else if (fmt === "HAM06_DELTA" || fmt === "HAM08_DELTA") {
            tables[fmt] = {
                t0: make(CHANNEL_DEFS[fmt], 1),
                t1: make(CHANNEL_DEFS[fmt], 4),
                t2: make(CHANNEL_DEFS[fmt], 8),
                t3: make(CHANNEL_DEFS[fmt], 16)
            };
        } else {
            tables[fmt] = { normal: make(CHANNEL_DEFS[fmt], 1), turbo: make(CHANNEL_DEFS[fmt], 4) };
        }
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
        if (cmd.isAnchor) {
            if (cmd.isDirect) {
                r = cmd.r; g = cmd.g; b = cmd.b;
            } else if (SLOT_COUNT_BY_FMT[cmd.format] > 0) {
                const absIdx = ((offset + cmd.anchorIdx) % 256) * 3;
                r = paletteRAM[absIdx]; g = paletteRAM[absIdx + 1]; b = paletteRAM[absIdx + 2];
            }
        } else {
            const table = deltaTables[cmd.format] || deltaTables.fallback;
            let t;
            if (table.t0) {
                const idx = cmd.turboIndex !== undefined ? cmd.turboIndex : (cmd.isTurbo ? 1 : 0);
                t = idx === 0 ? table.t0 : (idx === 1 ? table.t1 : (idx === 2 ? table.t2 : table.t3));
            } else {
                t = cmd.isTurbo ? table.turbo : table.normal;
            }
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
        // HAM12 tritt in zwei Rollen auf: als eigenes 16-Bit-Format (dort ohne
        // isDirect) und als 12-Bit-Direktanker in gemischten Strömen (isDirect).
        if (cmd.isDirect) {
            return `ham12 direct rgb(${cmd.r}, ${cmd.g}, ${cmd.b})`;
        }
        if (cmd.format === "HAM12" || cmd.format === "HAM16") {
            return `${fmt} anker`;
        }
        return `${fmt} ankerslot ${cmd.anchorIdx} (abs ${(offset + cmd.anchorIdx) % 256})`;
    }

    if (cmd.format === "HAM04_DELTA") {
        const m = cmd.isTurbo ? 4 : 1;
        const dr = CHANNEL_DEFS[cmd.format].r[cmd.rIndex || 0] * step.r * m;
        const dg = CHANNEL_DEFS[cmd.format].g[cmd.gIndex || 0] * step.g * m;
        const db = CHANNEL_DEFS[cmd.format].b[cmd.bIndex || 0] * step.b * m;
        const turbo = cmd.isTurbo ? " (turbo 4x)" : " (1x)";
        return `ham4delta r ${signedDelta(dr)} g ${signedDelta(dg)} b ${signedDelta(db)}${turbo}`;
    }
    if (cmd.format === "HAM05_DELTA") {
        const m = cmd.isTurbo ? 16 : 4;
        const dr = CHANNEL_DEFS[cmd.format].r[cmd.rIndex || 0] * step.r * m;
        const dg = CHANNEL_DEFS[cmd.format].g[cmd.gIndex || 0] * step.g * m;
        const db = CHANNEL_DEFS[cmd.format].b[cmd.bIndex || 0] * step.b * m;
        const turbo = cmd.isTurbo ? " (turbo 16x)" : " (4x)";
        return `ham5delta r ${signedDelta(dr)} g ${signedDelta(dg)} b ${signedDelta(db)}${turbo}`;
    }
    if (cmd.format === "HAM06_DELTA" || cmd.format === "HAM08_DELTA") {
        const mults = [1, 4, 8, 16];
        const m = mults[cmd.turboIndex || (cmd.isTurbo ? 1 : 0)];
        const dr = CHANNEL_DEFS[cmd.format].r[cmd.rIndex || 0] * step.r * m;
        const dg = CHANNEL_DEFS[cmd.format].g[cmd.gIndex || 0] * step.g * m;
        const db = CHANNEL_DEFS[cmd.format].b[cmd.bIndex || 0] * step.b * m;
        const turbo = ` (${m}x)`;
        return `${cmd.format.toLowerCase()} r ${signedDelta(dr)} g ${signedDelta(dg)} b ${signedDelta(db)}${turbo}`;
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

// ---------------------------------------------------------------------------
// Lokales Modifizieren: Hilfsfunktionen für das Fehlerbild-Fenster
// ---------------------------------------------------------------------------

// Akkumulator-Farbe direkt VOR Pixel pxIndex (entspricht dem Decoder-Zustand).
export function computeAccAtPixel(commands, pxIndex, stepVal, paletteRAM, offset) {
    let r = 127, g = 127, b = 127;
    const tables = getDecodeDeltaTables(stepVal);
    const limit = Math.min(pxIndex, commands.length);
    for (let i = 0; i < limit; i++) {
        const cmd = commands[i];
        if (cmd.isAnchor && SLOT_COUNT_BY_FMT[cmd.format] > 0) {
            const absIdx = ((offset + cmd.anchorIdx) % 256) * 3;
            r = paletteRAM[absIdx]; g = paletteRAM[absIdx + 1]; b = paletteRAM[absIdx + 2];
        } else {
            const table = tables[cmd.format] || tables.fallback;
            const t = cmd.isTurbo ? table.turbo : table.normal;
            r = clamp(r + (t.r[cmd.rIndex || 0] || 0), 0, 255);
            g = clamp(g + (t.g[cmd.gIndex || 0] || 0), 0, 255);
            b = clamp(b + (t.b[cmd.bIndex || 0] || 0), 0, 255);
        }
    }
    return { r, g, b };
}

// Alle Werte, die an dieser Pixelposition technisch erreichbar sind:
// Anker-Slots der Phase + alle Delta-Varianten (aus dem aktuellen acc).
// Sortiert nach Nähe zur Zielfarbe (bester erreichbarer Wert zuerst).
export function listReachableValues({ format, imgW, pxIndex, stepVal, paletteRAM, offset, acc, target, metric = 'yuv_weight' }) {
    const effFormat = phaseFormatAt(format, imgW, pxIndex);
    const distFunc = getMetricDistFunc(metric);
    const values = [];

    for (const a of buildFormatAnchorInfo(effFormat, offset)) {
        const r = paletteRAM[a.absSlot * 3], g = paletteRAM[a.absSlot * 3 + 1], b = paletteRAM[a.absSlot * 3 + 2];
        values.push({ r, g, b, cmd: a.cmd, kind: 'anchor', dist: distFunc(target.r, target.g, target.b, r, g, b) });
    }
    for (const d of buildFormatDeltaCache(effFormat, stepVal)) {
        const r = clamp(acc.r + d.dr, 0, 255), g = clamp(acc.g + d.dg, 0, 255), b = clamp(acc.b + d.db, 0, 255);
        values.push({ r, g, b, cmd: d.cmd, kind: 'delta', dist: distFunc(target.r, target.g, target.b, r, g, b) });
    }

    values.sort((a, b) => a.dist - b.dist);
    return { effFormat, acc, values };
}

// Farbresultat EINES Kommandos bei gegebenem Akkumulator (Decoder-Semantik).
function commandResultColor(cmd, acc, tables, paletteRAM, offset) {
    if (cmd.isAnchor && SLOT_COUNT_BY_FMT[cmd.format] > 0) {
        const a = ((offset + cmd.anchorIdx) % 256) * 3;
        return { r: paletteRAM[a], g: paletteRAM[a + 1], b: paletteRAM[a + 2] };
    }
    const table = tables[cmd.format] || tables.fallback;
    const t = cmd.isTurbo ? table.turbo : table.normal;
    return {
        r: clamp(acc.r + (t.r[cmd.rIndex || 0] || 0), 0, 255),
        g: clamp(acc.g + (t.g[cmd.gIndex || 0] || 0), 0, 255),
        b: clamp(acc.b + (t.b[cmd.bIndex || 0] || 0), 0, 255)
    };
}

// Lokaler Encode ab startPx.
//
//  * Das erste Kommando kann GEPINNT werden (`forcedFirstCmd`) — so wird das
//    vom Nutzer gewählte Pixel exakt getroffen und kann nicht wegoptimiert werden.
//  * Die ersten `lookaheadPx` Pixel laufen mit einem Receding-Horizon-BEAM
//    (Tiefe beamDepth, Breite beamWidth), danach Greedy.
//  * RESYNC (Kern): Ein Anker ist NICHT nötig. Sobald der neue Akkumulator nach
//    einem Pixel wieder genau dem Wert entspricht, den dieses Pixel VOR der
//    Änderung hatte (`resyncRef` = altes Decodiert-Bild), ist der Zustand
//    identisch zum Original-Lauf → der ursprüngliche Befehlsrest bleibt gültig.
//    Das trifft meist nach wenigen Pixeln zu (Anker nur als Sicherheitsnetz:
//    `stopAtPx` = nächster Original-Anker, falls kein Wert-Resync kommt).
//  * `targetData` ist das Ziel der Nachcodierung: das Quellbild (Standard) oder
//    das alte Decodiert-Bild (dann bleibt außer dem geänderten Pixel alles
//    unverändert).
export function encodeLocalSpan({ origData, imgW, format, stepVal, paletteRAM, offset,
                                 metric = 'yuv_weight', startPx, existingCommands,
                                 minEndPx = startPx + 1, maxPixels = 8192,
                                 stopAtPx = -1, forcedFirstCmd = null,
                                 lookaheadPx = 32, beamWidth = 8, beamDepth = 3,
                                 resyncRef = null, targetData = null }) {
    const distFunc = getMetricDistFunc(metric);
    const tables = getDecodeDeltaTables(stepVal);
    const searchTarget = targetData || origData;
    const cache = new Map();
    const tablesFor = (fmt) => {
        if (!cache.has(fmt)) {
            cache.set(fmt, { deltas: buildFormatDeltaCache(fmt, stepVal), anchors: buildFormatAnchorInfo(fmt, offset) });
        }
        return cache.get(fmt);
    };

    let acc = computeAccAtPixel(existingCommands, startPx, stepVal, paletteRAM, offset);
    const newCmds = [];

    // Ist die vorhandene Datei zeilenverankert? Dann muss eine lokale Korrektur
    // das erhalten, sonst verliert die betroffene Zeile ihre Unabhängigkeit und
    // die Interlace-Zusage bricht still. Erkannt wird das aus den Befehlen selbst
    // (jede Zeile beginnt mit einem Anker), nicht aus der Oberfläche — es zählt
    // die Eigenschaft der Datei, nicht die aktuelle Einstellung.
    const zeilenverankert = (() => {
        if (!existingCommands || existingCommands.length < imgW) return false;
        const zeilen = Math.floor(existingCommands.length / imgW);
        for (let y = 0; y < zeilen; y++) {
            const c = existingCommands[y * imgW];
            if (!c || !c.isAnchor) return false;
        }
        return true;
    })();

    const stop = (stopAtPx > startPx) ? Math.min(stopAtPx, startPx + maxPixels) : -1;
    const hardEnd = Math.min(existingCommands.length, startPx + maxPixels, stop > 0 ? stop : Infinity);
    const minResync = Math.max(startPx + 1, minEndPx);
    const lookaheadEnd = startPx + Math.max(0, lookaheadPx);
    let usedLookahead = 0;

    // Alle Kandidaten eines Pixels (Anker zuerst → Anker gewinnt Gleichstand,
    // genau wie im Hauptencoder).
    const branchesFor = (px, accNow) => {
        const t = tablesFor(phaseFormatAt(format, imgW, px));
        const out = [];
        // Zeilenverankerte Datei: am Zeilenanfang darf nur ein Anker stehen.
        // Hat das Format dort keine Anker, bleibt es bei den normalen Kandidaten
        // (dann war die Datei faktisch nicht zeilenverankert).
        const nurAnker = zeilenverankert && (px % imgW) === 0 && t.anchors.length > 0;
        for (const a of t.anchors) {
            const r = paletteRAM[a.absSlot * 3], g = paletteRAM[a.absSlot * 3 + 1], b = paletteRAM[a.absSlot * 3 + 2];
            out.push({ cmd: a.cmd, r, g, b });
        }
        if (!nurAnker) {
            for (const d of t.deltas) {
                out.push({
                    cmd: d.cmd,
                    r: clamp(accNow.r + d.dr, 0, 255),
                    g: clamp(accNow.g + d.dg, 0, 255),
                    b: clamp(accNow.b + d.db, 0, 255)
                });
            }
        }
        return out;
    };

    const chooseGreedy = (px, accNow) => {
        const o = px * 4;
        const tr = searchTarget[o], tg = searchTarget[o + 1], tb = searchTarget[o + 2];
        let best = null, bestScore = Infinity;
        for (const br of branchesFor(px, accNow)) {
            const sc = distFunc(tr, tg, tb, br.r, br.g, br.b);
            if (sc < bestScore) { bestScore = sc; best = br; }
        }
        return best;
    };

    // Receding Horizon: Kommando für EIN Pixel so wählen, dass der Fehler über
    // die nächsten beamDepth Pixel minimal wird (Beam-Pruning auf beamWidth).
    const chooseWithLookahead = (px, accNow, horizonEnd) => {
        let level = [{ cost: 0, acc: accNow, first: null }];
        for (let d = 0; d < beamDepth; d++) {
            const cur = px + d;
            if (cur >= horizonEnd) break;
            const o = cur * 4;
            const tr = searchTarget[o], tg = searchTarget[o + 1], tb = searchTarget[o + 2];
            const next = [];
            for (const node of level) {
                for (const br of branchesFor(cur, node.acc)) {
                    next.push({
                        cost: node.cost + distFunc(tr, tg, tb, br.r, br.g, br.b),
                        acc: { r: br.r, g: br.g, b: br.b },
                        first: d === 0 ? br : node.first
                    });
                }
            }
            if (!next.length) break;
            next.sort((a, b) => a.cost - b.cost);
            level = next.slice(0, beamWidth);
        }
        return level[0] ? level[0].first : null;
    };

    let zeilenAnkerErzwungen = false;
    let i = startPx;
    for (; i < hardEnd; i++) {
        let pick = null;

        if (i === startPx && forcedFirstCmd) {
            // Gepinntes Kommando: exakt das gewählte Ergebnis.
            // Ausnahme: in einer zeilenverankerten Datei muss der Zeilenanfang ein
            // Anker bleiben. Ein gepinnter Delta-Befehl würde die Zeile von der
            // Vorderzeile abhängig machen (Interlace-Zusage kaputt) — dann wird
            // stattdessen der nächstliegende Anker gewählt.
            const istZeilenAnfang = zeilenverankert && (i % imgW) === 0;
            const ankerHier = tablesFor(phaseFormatAt(format, imgW, i)).anchors;
            if (istZeilenAnfang && !forcedFirstCmd.isAnchor && ankerHier.length > 0) {
                let bestA = null, bestD = Infinity;
                for (const a of ankerHier) {
                    const ar = paletteRAM[a.absSlot * 3], ag = paletteRAM[a.absSlot * 3 + 1], ab = paletteRAM[a.absSlot * 3 + 2];
                    const d = (ar - acc.r) ** 2 + (ag - acc.g) ** 2 + (ab - acc.b) ** 2;
                    if (d < bestD) { bestD = d; bestA = { cmd: a.cmd, r: ar, g: ag, b: ab }; }
                }
                pick = bestA;
                zeilenAnkerErzwungen = true;
            } else {
                const col = commandResultColor(forcedFirstCmd, acc, tables, paletteRAM, offset);
                pick = { cmd: forcedFirstCmd, r: col.r, g: col.g, b: col.b };
            }
        } else if (i < lookaheadEnd) {
            pick = chooseWithLookahead(i, acc, Math.min(lookaheadEnd, hardEnd));
            if (pick) usedLookahead++;
        }
        if (!pick) pick = chooseGreedy(i, acc);
        if (!pick) break;

        newCmds.push(pick.cmd);
        acc = { r: pick.r, g: pick.g, b: pick.b };

        // WERT-RESYNC: Akkumulator entspricht wieder dem alten Decodiert-Wert
        // dieses Pixels → der restliche Original-Befehlsstrom ist gültig.
        if (resyncRef && i + 1 >= minResync) {
            const o = i * 4;
            if (acc.r === resyncRef[o] && acc.g === resyncRef[o + 1] && acc.b === resyncRef[o + 2]) {
                return { commands: newCmds, startPx, endPx: i + 1, resynced: true, valueResync: true, usedLookahead, zeilenAnkerErzwungen };
            }
        }
    }

    // Sicherheitsnetz: Original-Anker an stopAtPx unverändert übernehmen
    if (stop > 0 && i === stop) {
        const orig = existingCommands[stop];
        if (orig && orig.isAnchor) {
            newCmds.push(orig);
            return { commands: newCmds, startPx, endPx: stop + 1, resynced: true, forced: true, usedLookahead, zeilenAnkerErzwungen };
        }
    }

    return { commands: newCmds, startPx, endPx: i, resynced: false, usedLookahead, zeilenAnkerErzwungen };
}

// Decodiert [startPx, endPx) neu in einen vorhandenen RGBA-Puffer.
export function decodeRangeInto(outData, commands, startPx, endPx, accStart, stepVal, paletteRAM, offset) {
    const tables = getDecodeDeltaTables(stepVal);
    let r = accStart.r, g = accStart.g, b = accStart.b;
    for (let i = startPx; i < endPx; i++) {
        const cmd = commands[i];
        if (cmd.isAnchor && SLOT_COUNT_BY_FMT[cmd.format] > 0) {
            const absIdx = ((offset + cmd.anchorIdx) % 256) * 3;
            r = paletteRAM[absIdx]; g = paletteRAM[absIdx + 1]; b = paletteRAM[absIdx + 2];
        } else {
            const table = tables[cmd.format] || tables.fallback;
            const t = cmd.isTurbo ? table.turbo : table.normal;
            r = clamp(r + (t.r[cmd.rIndex || 0] || 0), 0, 255);
            g = clamp(g + (t.g[cmd.gIndex || 0] || 0), 0, 255);
            b = clamp(b + (t.b[cmd.bIndex || 0] || 0), 0, 255);
        }
        const o = i * 4;
        outData[o] = r; outData[o + 1] = g; outData[o + 2] = b; outData[o + 3] = 255;
    }
    return { r, g, b };
}