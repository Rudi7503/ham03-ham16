// Prüft die Modusbit-Konvention: 0 = Anker, 1 = Delta.
//
// Getestet wird auf drei Ebenen:
//   1. Die rohen Codes im gepackten Strom (Bit-Ebene, unabhängig vom Entpacker)
//   2. Die Befehlsobjekte nach unpack (semantisch)
//   3. Die dekodierten Pixel (Round-Trip)
// Zusätzlich HAM12/HAM16 über ihre eigenen Pack-/Entpackfunktionen.

import { HAM_CONFIGS } from './src/codecs/configs.js';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './src/core/module_paletted.js';
import { packHam12_16, unpackHam12_16 } from './src/core/module_ham12_16.js';

const BITS = { HAM01: 1, HAM02: 2, HAM03: 3, HAM04: 4, HAM05: 5, HAM06: 6, HAM08: 8 };
// Modusbit = höchstwertiges Bit des Codes; HAM01/HAM02 haben keines
const MODEBIT = { HAM01: 0, HAM02: 0, HAM03: 4, HAM04: 8, HAM05: 16, HAM06: 32, HAM08: 128 };

const W = 16, H = 4, TOTAL = W * H, STEP = { r: 4, g: 4, b: 4 };

// Synthetisches Testbild: 1-Pixel-Wechsel (der harte Fall) plus Verläufe
const px = new Uint8ClampedArray(TOTAL * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i] = (x * 37 + y * 11) % 256;
        px[i + 1] = (x & 1) ? 255 : 0;
        px[i + 2] = ((x * 13) | (y << 4)) % 256;
        px[i + 3] = 255;
    }
}
const basePalette = new Uint8Array(768);
for (let i = 0; i < 768; i++) basePalette[i] = (i * 97 + 13) % 256;
basePalette[0] = basePalette[1] = basePalette[2] = 0;

// Rohe Codes eines gepackten Stroms auslesen (eigene Implementierung,
// absichtlich unabhängig von unpackPaletted)
function rawCodes(bytes, seq, total) {
    const out = [];
    let p = 0;
    for (let done = 0; done < total;) {
        const w32 = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
        p += 4;
        let shift = 32;
        for (let j = 0; j < seq.length && done < total; j++, done++) {
            const bits = BITS[seq[j]];
            shift -= bits;
            out.push({ fmt: seq[j], v: (w32 >>> shift) & ((1 << bits) - 1) });
        }
    }
    return out;
}

let fehler = 0, geprueftenFormate = 0, ankerGesamt = 0, deltaGesamt = 0;

const mixedFormats = Object.keys(HAM_CONFIGS).filter(f => HAM_CONFIGS[f].isMixed);
// greedy wählt bei kleinen Bildern fast nur Anker. delta_only/anchor_only
// erzwingen den jeweils anderen Pfad, sonst bliebe er ungeprüft.
const STRATEGIEN = ['greedy', 'delta_only', 'anchor_only'];

for (const fmtName of mixedFormats) {
    const cfg = HAM_CONFIGS[fmtName];
    const seq = cfg.sequence;

    let anker = 0, delta = 0, assertFehler = [], pixDiff = 0;

    for (const strategie of STRATEGIEN) {
    const { commands } = await encodePaletted(
        px, W, H, fmtName, STEP, basePalette.slice(), 0, strategie, 'yuv_weight'
    );
    const bytes = packPaletted(commands, fmtName);
    const codes = rawCodes(bytes, seq, TOTAL);
    const back = unpackPaletted(bytes, fmtName, TOTAL);
    const decA = decodePaletted(commands, W, H, STEP, basePalette, 0);
    const decB = decodePaletted(back, W, H, STEP, basePalette, 0);

    for (let i = 0; i < TOTAL; i++) {
        const c = commands[i], b = back[i], code = codes[i];
        const mb = MODEBIT[code.fmt];

        // --- Ebene 1: rohes Modusbit ---
        if (mb > 0) {
            if (c.isAnchor) {
                anker++;
                if ((code.v & mb) !== 0) assertFehler.push(`${strategie} px${i} ${code.fmt}: Anker hat Modusbit 1 (v=${code.v})`);
                if ((code.v & (mb - 1)) !== (c.anchorIdx & (mb - 1))) assertFehler.push(`${strategie} px${i} ${code.fmt}: Anker-Slot ${c.anchorIdx} != ${code.v & (mb - 1)}`);
            } else {
                delta++;
                if ((code.v & mb) === 0) assertFehler.push(`${strategie} px${i} ${code.fmt}: Delta hat Modusbit 0 (v=${code.v})`);
            }
        } else if (!c.isAnchor) {
            delta++;
        }

        // --- Ebene 2: Semantik nach dem Entpacken ---
        if (c.isAnchor !== b.isAnchor) assertFehler.push(`${strategie} px${i}: isAnchor ${c.isAnchor} != ${b.isAnchor}`);
        else if (c.isAnchor && (c.anchorIdx ?? 0) !== (b.anchorIdx ?? 0)) assertFehler.push(`${strategie} px${i}: anchorIdx ${c.anchorIdx} != ${b.anchorIdx}`);
        else if (!c.isAnchor) {
            if (!!c.isTurbo !== !!b.isTurbo) assertFehler.push(`${strategie} px${i}: isTurbo ${c.isTurbo} != ${b.isTurbo}`);
            if ((c.rIndex ?? 0) !== (b.rIndex ?? 0)) assertFehler.push(`${strategie} px${i}: rIndex ${c.rIndex} != ${b.rIndex}`);
            if ((c.gIndex ?? 0) !== (b.gIndex ?? 0)) assertFehler.push(`${strategie} px${i}: gIndex ${c.gIndex} != ${b.gIndex}`);
            if ((c.bIndex ?? 0) !== (b.bIndex ?? 0)) assertFehler.push(`${strategie} px${i}: bIndex ${c.bIndex} != ${b.bIndex}`);
        }
    }

    // --- Ebene 3: Pixel ---
    for (let i = 0; i < decA.length; i++) if (decA[i] !== decB[i]) pixDiff++;
    }

    geprueftenFormate++;
    ankerGesamt += anker;
    deltaGesamt += delta;
    const ok = assertFehler.length === 0 && pixDiff === 0;
    if (!ok) fehler++;
    console.log(`${ok ? 'OK  ' : 'FEHL'} ${fmtName.padEnd(22)} Anker ${String(anker).padStart(3)}  Delta ${String(delta).padStart(3)}  Pixel-Abweichungen ${pixDiff}`);
    if (assertFehler.length) assertFehler.slice(0, 4).forEach(m => console.log(`       ! ${m}`));
}

// --- HAM12 / HAM16: eigenes Packformat, gleiches Modusbit-Prinzip ---
for (const fmt of ['HAM12', 'HAM16']) {
    const mb = fmt === 'HAM16' ? 0x8000 : 0x800;
    const cmds = fmt === 'HAM16'
        ? [
            { isAnchor: true, format: fmt, r5: 12, g5: 7, b5: 31 },
            { isAnchor: false, format: fmt, isTurbo: false, dr: -3, dg: 7, db: -2 },
            { isAnchor: false, format: fmt, isTurbo: true, dr: 3, dg: -8, db: 2 }
        ]
        : [
            { isAnchor: true, format: fmt, b10: 1, r3: 5, g4: 12, b3: 3 },
            { isAnchor: false, format: fmt, isTurbo: false, dr: -3, dg: 7, db: -2 },
            { isAnchor: false, format: fmt, isTurbo: true, dr: 3, dg: -8, db: 2 }
        ];
    const packed = packHam12_16(cmds, fmt);
    const back = unpackHam12_16(packed, fmt, cmds.length);

    const woerter = [];
    for (let i = 0; i < cmds.length; i++) woerter.push((packed[i * 2] << 8) | packed[i * 2 + 1]);

    const prob = [];
    if ((woerter[0] & mb) !== 0) prob.push(`Anker hat Modusbit gesetzt (w=0x${woerter[0].toString(16)})`);
    if ((woerter[1] & mb) === 0) prob.push(`Delta hat Modusbit nicht gesetzt (w=0x${woerter[1].toString(16)})`);
    if ((woerter[2] & mb) === 0) prob.push(`Turbo-Delta hat Modusbit nicht gesetzt (w=0x${woerter[2].toString(16)})`);
    if (!back[0].isAnchor || !back[1].isAnchor === false) { /* Platzhalter, Details unten */ }
    if (back[0].isAnchor !== true) prob.push('Anker nicht als Anker entpackt');
    if (back[1].isAnchor !== false || back[2].isAnchor !== false) prob.push('Delta nicht als Delta entpackt');
    if (back[1].isTurbo !== false || back[2].isTurbo !== true) prob.push('Turbo-Flag falsch');
    if (back[1].dr !== -3 || back[1].dg !== 7 || back[1].db !== -2) prob.push(`Delta-Werte falsch: ${back[1].dr},${back[1].dg},${back[1].db}`);
    if (fmt === 'HAM16' && (back[0].r5 !== 12 || back[0].g5 !== 7 || back[0].b5 !== 31)) prob.push('HAM16-Ankelfelder falsch');
    if (fmt === 'HAM12' && (back[0].b10 !== 1 || back[0].r3 !== 5 || back[0].g4 !== 12 || back[0].b3 !== 3)) prob.push('HAM12-Ankelfelder falsch');

    const ok = prob.length === 0;
    if (!ok) fehler++;
    console.log(`${ok ? 'OK  ' : 'FEHL'} ${fmt.padEnd(22)} Wörter ${woerter.map(w => '0x' + w.toString(16).padStart(4, '0')).join(' ')}`);
    prob.forEach(m => console.log(`       ! ${m}`));
}

console.log(`\nFormate geprüft: ${geprueftenFormate} + HAM12/HAM16 | Anker: ${ankerGesamt} | Deltas: ${deltaGesamt}`);
if (ankerGesamt === 0) { console.log('WARNUNG: kein einziger Anker geprüft — Test wäre wertlos'); fehler++; }
if (deltaGesamt === 0) { console.log('WARNUNG: kein einziges Delta geprüft — Test wäre wertlos'); fehler++; }
console.log(fehler === 0 ? '\nALLE PRUEFUNGEN BESTANDEN' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
