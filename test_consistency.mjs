// Prüft, dass Katalog, Oberfläche und Dokumentation zusammenpassen:
// jede Sequenz besteht aus bekannten Sub-Formaten mit Bit-Summe 32/256, jedes
// Format ist in der Oberfläche wählbar, jedes Mischformat steht in der Doku.
import fs from 'node:fs';
import { HAM_CONFIGS } from './src/codecs/configs.js';

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

// 1. Sequenzen
let seqFehler = [];
for (const [name, cfg] of Object.entries(HAM_CONFIGS)) {
    if (!Array.isArray(cfg.sequence)) continue;
    const fehlend = [...new Set(cfg.sequence)].filter(f => !HAM_CONFIGS[f]);
    const bits = cfg.sequence.reduce((s, f) => s + (HAM_CONFIGS[f]?.bits || 0), 0);
    if (fehlend.length) seqFehler.push(`${name}: unbekannt ${fehlend.join(',')}`);
    else if (bits !== 32 && bits !== 256) seqFehler.push(`${name}: ${bits} Bit`);
}
check(`alle Sequenzen: Sub-Formate bekannt, Bit-Summe 32 oder 256 (${Object.keys(HAM_CONFIGS).length} Formate)`,
    seqFehler.length === 0, seqFehler.join('; '));

// 2. HAM12 in beiden Rollen
const mitHam12 = Object.entries(HAM_CONFIGS).filter(([, c]) => Array.isArray(c.sequence) && c.sequence.includes('HAM12'));
check('HAM12 ist als Sub-Format in gemischten Formaten vertreten', mitHam12.length > 0, `${mitHam12.length}`);
check('HAM12 traegt keine Ankerslots (Palette unbenutzt)', HAM_CONFIGS.HAM12.slotsPerBank === 0,
    String(HAM_CONFIGS.HAM12.slotsPerBank));
check('HAM12 hat als Sub-Format 12 Bit', HAM_CONFIGS.HAM12.bits === 12, String(HAM_CONFIGS.HAM12.bits));

// 3. Oberflaeche deckt den Katalog
const ui = fs.readFileSync('src/modes/ham_builder.js', 'utf8');
const optionen = [...ui.matchAll(/<option value="([A-Za-z0-9_]+)"/g)].map(m => m[1])
    .filter(o => /^HAM[A-Z0-9_]/.test(o) || o === 'DXT1');
const imKatalog = new Set(Object.keys(HAM_CONFIGS));
const tote = optionen.filter(o => !imKatalog.has(o) && o !== 'DXT1');
const fehlendUi = [...imKatalog].filter(f => !optionen.includes(f) && !['HAM01', 'HAM02'].includes(f));
check('keine Dropdown-Option ohne Konfiguration', tote.length === 0, tote.join(','));
check('jedes Katalog-Format ist waehlbar (ausser HAM01/HAM02)', fehlendUi.length === 0, fehlendUi.join(','));

// 4. Doku nennt jedes Mischformat
const doc = fs.readFileSync('HAM-DATEIFORMAT.md', 'utf8');
const missDoc = Object.entries(HAM_CONFIGS).filter(([, c]) => c.isMixed).map(([n]) => n)
    .filter(n => !doc.includes('`' + n + '`'));
check('jedes Mischformat steht in HAM-DATEIFORMAT.md', missDoc.length === 0, missDoc.join(','));

console.log(fehler === 0 ? '\nKATALOG, OBERFLAECHE UND DOKU STIMMEN UEBEREIN' : `\n${fehler} ABWEICHUNGEN`);
process.exit(fehler === 0 ? 0 : 1);
