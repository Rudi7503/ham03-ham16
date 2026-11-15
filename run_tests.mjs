// Testrunner: führt alle test_*.mjs aus, mit Zeitlimit je Skript und
// Sammelausgabe. Exitcode 1, sobald ein Test fehlschlägt.
//
//   node run_tests.mjs            Standardlauf (schnelle Tests, 120 s je Skript)
//   node run_tests.mjs --all      auch die langen Messläufe (600 s je Skript)
//   node run_tests.mjs test_x.mjs nur bestimmte Skripte
//
// Ein Skript gilt als Fehler, wenn es mit Code != 0 endet ODER das Zeitlimit
// reißt. Viele Skripte sind Messläufe ohne Assertions (Exit 0, Ausgabe mit
// Messwerten) — die laufen als "INFO" mit, damit man ihre Kennzahlen im Blick hat.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TIMEOUT_STD = 120_000;
const TIMEOUT_LANG = 600_000;

// Bekannt lange Skripte (Palettenoptimierung über Minuten) — nur mit --all
const LANG = new Set(['test_manual.mjs', 'test_refine.mjs', 'test_proxyres.mjs', 'test_real_analysis.mjs']);

const args = process.argv.slice(2);
const alle = args.includes('--all');
const nur = args.filter(a => !a.startsWith('--'));

const dateien = (nur.length ? nur : fs.readdirSync('.').filter(f => /^test_.*\.mjs$/.test(f)))
    .filter(f => alle || !LANG.has(f))
    .sort();

if (dateien.length === 0) {
    console.log('Keine Testskripte gefunden.');
    process.exit(1);
}

const zeilen = [];
let fehler = 0, info = 0, gesamtMs = 0;

for (const f of dateien) {
    const limit = LANG.has(f) ? TIMEOUT_LANG : TIMEOUT_STD;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [f], {
        encoding: 'utf8',
        timeout: limit,
        maxBuffer: 32 * 1024 * 1024
    });
    const ms = Date.now() - t0;
    gesamtMs += ms;

    const ausgabe = ((r.stdout || '') + (r.stderr || '')).trim();
    const zeilenOut = ausgabe.split('\n').filter(l => l.trim());
    const letzte = (zeilenOut[zeilenOut.length - 1] || '').trim().slice(0, 100);

    let status;
    if (r.error && r.error.code === 'ETIMEDOUT') { status = 'TIMEOUT'; fehler++; }
    else if (r.status === 0) { status = 'OK'; }
    else if (r.status === null) { status = 'ABBRUCH'; fehler++; }
    else { status = `FEHLER ${r.status}`; fehler++; }

    // Messläufe ohne Assertions: Ausgabe enthält typische Kennzahlen, Exit 0
    const istInfo = status === 'OK' && /###|MSE|===|Proxy|Palette\]|Statistik/.test(ausgabe);
    if (istInfo) info++;

    zeilen.push({ f, status, ms, letzte });
    const mark = status === 'OK' ? (istInfo ? 'INFO' : 'OK  ') : 'FEHL';
    console.log(`${mark} ${f.padEnd(28)} ${String(ms).padStart(7)} ms  ${letzte}`);
}

const ok = zeilen.filter(z => z.status === 'OK').length;
console.log('');
console.log(`Gesamt: ${dateien.length} Skripte in ${(gesamtMs / 1000).toFixed(1)} s — `
    + `OK ${ok} (davon Messläufe ${info}), Fehler ${fehler}`);
if (!alle && !nur.length) {
    console.log(`Ausgelassen (nur mit --all): ${[...LANG].join(', ')}`);
}
process.exit(fehler === 0 ? 0 : 1);
