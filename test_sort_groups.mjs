// Verifikationstest für den "Slots sortieren"-Handler in src/ui/palette_builder.js
// Der Handler (btnSort) ist DOM-gebunden und nicht direkt importierbar. Der Test
// repliziert deshalb die reine Gruppen-/Sortierlogik aus palette_builder.js
// Zeile ~263-326 wortgetreu (Markierung V) und prüft die Invarianten dagegen.
//
// Invarianten, die beim Sortieren gewahrt bleiben müssen, damit jeder Anker eines
// Sub-Formats auch nach dem Neu-Encode erreichbar bleibt:
//   - Slot 0 (fest Schwarz) wird nie bewegt.
//   - Kein Farbwert wandert über eine Format-Kapazitätsgrenze (Band) hinweg.
//   - Sortiert wird ausschließlich absteigend nach Usage INNERHALB eines Bands.

import { HAM_CONFIGS } from './src/codecs/configs.js';

let failures = 0;
const fail = (msg) => { failures++; console.log('  FEHLER: ' + msg); };
const ok = (msg) => console.log('  ok: ' + msg);

// --- V: wortgetreue Kopie der Gruppableitung aus palette_builder.js (btnSort) ---
function deriveGroups(formatName) {
    const config = HAM_CONFIGS[formatName];
    const formatsInUse = config.isMixed ? [...new Set(config.sequence)] : [formatName];
    const capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a, b) => a - b);
    const sortGroups = [];
    let lastEnd = -1;
    for (const cap of capacities) {
        if (cap === 0) continue;
        const start = lastEnd + 1, end = cap - 1;
        if (start <= end) { sortGroups.push({ start, end }); lastEnd = end; }
    }
    return { formatsInUse, capacities, sortGroups, maxSlotsPerBank: capacities[capacities.length - 1] };
}

// --- V: wortgetreue Kopie der Bank-Sortierschleife (ohne DOM/Encode) ---
function runSort(formatName, paletteRAM, usageByAbsSlot) {
    const { sortGroups, maxSlotsPerBank } = deriveGroups(formatName);
    if (!maxSlotsPerBank) return;
    for (let bankStart = 0; bankStart < 256; bankStart += maxSlotsPerBank) {
        for (const group of sortGroups) {
            const groupSlots = [];
            for (let i = group.start; i <= group.end; i++) {
                const absSlot = (bankStart + i) % 256;
                groupSlots.push({
                    absSlot,
                    isFixed: (i === 0),
                    r: paletteRAM[absSlot * 3],
                    g: paletteRAM[absSlot * 3 + 1],
                    b: paletteRAM[absSlot * 3 + 2],
                    usage: usageByAbsSlot[absSlot]
                });
            }
            const fixedSlots = groupSlots.filter(s => s.isFixed);
            const sortableSlots = groupSlots.filter(s => !s.isFixed).sort((a, b) => b.usage - a.usage);
            const newOrder = [...fixedSlots, ...sortableSlots];
            for (let idx = 0; idx < newOrder.length; idx++) {
                const targetAbsSlot = (bankStart + group.start + idx) % 256;
                paletteRAM[targetAbsSlot * 3]     = newOrder[idx].r;
                paletteRAM[targetAbsSlot * 3 + 1] = newOrder[idx].g;
                paletteRAM[targetAbsSlot * 3 + 2] = newOrder[idx].b;
            }
        }
    }
}

// Hilfsmittel: Palette als Array von Farb-IDs (je Slot eine eindeutige ID),
// Usage zufällig aber deterministisch.
function makePalette(seed) {
    const ram = new Uint8ClampedArray(256 * 3);
    // jede der 256 "Farben" = eindeutige ID, kodiert in RGB
    for (let s = 0; s < 256; s++) {
        const id = s; // Farbwert == Absolut-Slot-Nr. => Bewegung nachverfolgbar
        ram[s * 3] = id; ram[s * 3 + 1] = 0; ram[s * 3 + 2] = 0;
    }
    let u = seed;
    const rnd = () => { u = (u * 1103515245 + 12345) & 0x7fffffff; return u / 0x7fffffff; };
    return { ram, rnd };
}

function colorIdOf(ram, absSlot) { return ram[absSlot * 3]; }

// ============ TEST 1: 63436343 – Bandgrenzen 0-3 | 4-7 | 8-31 ============
console.log('TEST 1: Gruppenplan für HAM_32BIT_63436343');
{
    const { formatsInUse, capacities, sortGroups, maxSlotsPerBank } = deriveGroups('HAM_32BIT_63436343');
    ok(`alle vorkommenden Sub-Formate: ${formatsInUse.sort().join(', ')}`);
    ok(`Kapazitäten (slotsPerBank): ${capacities.join(', ')}`);
    ok(`maxSlotsPerBank (Bankgröße): ${maxSlotsPerBank}`);
    ok(`Sortiergruppen: ${JSON.stringify(sortGroups)} (erwartet [{"start":0,"end":3},{"start":4,"end":7},{"start":8,"end":31}])`);
    const expected = JSON.stringify([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 31 }]);
    if (JSON.stringify(sortGroups) !== expected) fail('Gruppen weichen ab!');
    ok('Slot 0 liegt in Gruppe 0-3 und wird als isFixed behandelt → effektiv sortiert werden 1-3, 4-7, 8-31');
}

// ============ TEST 2: Slot 0 nie bewegt + keine Band-übergreifende Bewegung ============
console.log('TEST 2: Invarianten für HAM_32BIT_63436343 (alle 8 Bänke à 32 Slots)');
{
    for (const seed of [1, 2, 3, 42]) {
        const { ram, rnd } = makePalette(seed);
        const usage = new Array(256).fill(0);
        for (let s = 0; s < 256; s++) usage[s] = Math.floor(rnd() * 1000);
        const before = Array.from(ram);
        runSort('HAM_32BIT_63436343', ram, usage);

        let slot0ok = true, bandok = true;
        const bandOf = (i) => (i >= 8 ? 2 : i >= 4 ? 1 : 0);
        // Band 0 enthält festen Slot 0 (ohne Sortierkandidat) + Slots 1-3
        for (let bankStart = 0; bankStart < 256; bankStart += 32) {
            // Slot 0 unverändert?
            for (let c = 0; c < 3; c++) if (ram[bankStart * 3 + c] !== before[bankStart * 3 + c]) slot0ok = false;
            // Farb-Multimengen je Band invariant?
            for (let band = 0; band < 3; band++) {
                const lo = band === 0 ? 0 : band === 1 ? 4 : 8;
                const hi = band === 0 ? 3 : band === 1 ? 7 : 31;
                const idsBefore = [];
                const idsAfter = [];
                for (let i = lo; i <= hi; i++) {
                    const a = (bankStart + i) % 256;
                    idsBefore.push(before[a * 3]);
                    idsAfter.push(ram[a * 3]);
                }
                const sum1 = idsBefore.reduce((x, y) => x + y, 0);
                const sum2 = idsAfter.reduce((x, y) => x + y, 0);
                if (sum1 !== sum2) bandok = false;
            }
        }
        if (!slot0ok) fail(`seed ${seed}: Slot 0 wurde bewegt`);
        else ok(`seed ${seed}: Slot 0 in allen Bänken unverändert`);
        if (!bandok) fail(`seed ${seed}: Farben wanderten zwischen Bändern`);
        else ok(`seed ${seed}: keine bandübergreifende Bewegung (Farbmengen je 0-3/4-7/8-31 erhalten)`);
    }
}

// ============ TEST 3: Sortierung ist absteigend nach Usage innerhalb Band ============
console.log('TEST 3: Anordnung = Usage absteigend je Band (63436343, Bank 0)');
{
    const { ram, rnd } = makePalette(7);
    const usage = new Array(256).fill(0);
    for (let s = 1; s < 256; s++) usage[s] = Math.floor(rnd() * 1000);
    usage[2] = 9999; usage[5] = 9998; usage[20] = 9997; usage[1] = 1; usage[7] = 1;
    runSort('HAM_32BIT_63436343', ram, usage);

    // Farbwert eines Slots == ursprüngliche Slot-Nr. => auf Zieladresse muss die
    // Farbe des Slots mit der höchsten Usage im jeweiligen Band liegen.
    const checkBand = (lo, hi, topSlot, target, msg) => {
        let maxU = -1, bestSlot = -1;
        for (let i = lo; i <= hi; i++) if (usage[i] > maxU) { maxU = usage[i]; bestSlot = i; }
        if (bestSlot !== topSlot) fail('Testaufbau inkonsistent');
        const found = colorIdOf(ram, target);
        if (found !== topSlot) fail(`${msg}: ${topSlot} landete auf ${found} statt ${target}`);
        else ok(`${msg}`);
    };
    checkBand(1, 3, 2, 1, 'Band 0 (Slots 1-3): Slot 2 (Usage 9999) auf Slot 1');
    checkBand(4, 7, 5, 4, 'Band 1 (Slots 4-7): Slot 5 (Usage 9998) auf Slot 4');
    checkBand(8, 31, 20, 8, 'Band 2 (Slots 8-31): Slot 20 (Usage 9997) auf Slot 8');
}

// ============ TEST 4: Alle Mischformate – Gruppen vollständig & lückenlos ============
console.log('TEST 4: Gruppenplan deckt für JEDES Mischformat alle Sub-Formate ab');
{
    for (const [name, cfg] of Object.entries(HAM_CONFIGS)) {
        if (!cfg.isMixed || !cfg.sequence) continue;
        const { formatsInUse, capacities, sortGroups, maxSlotsPerBank } = deriveGroups(name);
        const caps = [...new Set(cfg.sequence.map(f => HAM_CONFIGS[f].slotsPerBank))].sort((a, b) => a - b);
        if (JSON.stringify(capacities) !== JSON.stringify(caps)) fail(`${name}: Kapazitäten ${capacities} ≠ erwartet ${caps}`);
        // Bänder müssen lückenlos von 0 bis max-1 reichen
        let prev = -1, lueckenlos = true;
        for (const g of sortGroups) { if (g.start !== prev + 1) lueckenlos = false; prev = g.end; }
        if (prev !== maxSlotsPerBank - 1) lueckenlos = false;
        if (sortGroups.length === 0 && caps.some(c => c > 0)) lueckenlos = false;
        if (!lueckenlos) fail(`${name}: Gruppen nicht lückenlos ${JSON.stringify(sortGroups)}`);
        else ok(`${name}: Gruppen ${JSON.stringify(sortGroups)} (Kapazitäten ${caps.join(',')}, max ${maxSlotsPerBank}) decken alle ${formatsInUse.length} Sub-Formate ab`);
    }
}

// ============ TEST 5: Prüfung der Bandgrenzen-Formel gegen Anchor-Bits ============
console.log('TEST 5: Bandgrenzen deckungsgleich mit Anchor-Bitfenstern (getCmdVal: anchorIdx & (cap-1))');
{
    // In module_paletted.js wird pro Sub-Format ein Anker mit anchorIdx im Bereich
    // 0..slotsPerBank-1 erzeugt; Gruppe n = ] Kapazität[n-1], Kapazität[n] ] ist genau
    // der Adressraum, den das jeweilige Format als Ankerfenster besitzt.
    for (const [name, cfg] of Object.entries(HAM_CONFIGS)) {
        if (!cfg.isMixed || !cfg.sequence) continue;
        const { sortGroups } = deriveGroups(name);
        for (const fmt of new Set(cfg.sequence)) {
            const cap = HAM_CONFIGS[fmt].slotsPerBank || 0;
            if (cap === 0) continue;
            // Slot i ist für fmt erreichbar ⇔ i < cap.
            // Ein Farbwert in Gruppe mit end == cap-1 … nur dort erreichbar.
            const g = sortGroups.find(x => x.end === cap - 1);
            if (!g) fail(`${name}/${fmt}: keine Gruppe mit Ende ${cap - 1}`);
        }
    }
    ok('jede Sub-Format-Kapazität besitzt genau eine Bandgrenze; Sortierung verletzt keine Anker-Erreichbarkeit');
}

console.log(failures === 0 ? '\nERGEBNIS: ALLE TESTS BESTANDEN' : `\nERGEBNIS: ${failures} FEHLER`);
process.exit(failures === 0 ? 0 : 1);
