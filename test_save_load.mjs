// End-to-End: Speichern und wieder Laden, für ALLE Formate.
//
// Bildet genau den Weg der Oberfläche nach:
//   encode  ->  packPaletted/Ham12/DXT1  ->  buildHamFile (das macht "Speichern")
//           ->  Datei-Bytes  ->  parseHamHeader + decodeHamPayload ("Laden")
//           ->  Pixel vergleichen mit der Vorschau, die der Encoder liefert.
//
// Zusätzlich die beiden Invarianten, die im Betrieb zählen:
//   • erneutes Speichern der geladenen Datei ergibt byte-identische Bytes
//     (kein Drift zwischen Laden und Speichern)
//   • Kopffelder (Größe, Format, Schritt, Offset) kommen unverändert zurück
import { HAM_CONFIGS } from './src/codecs/configs.js';
import { encodePaletted, packPaletted, decodePaletted } from './src/core/module_paletted.js';
import { encodeHam12_16, packHam12_16, decodeHam12_16 } from './src/core/module_ham12_16.js';
import { encodeDXT1, decodeDXT1 } from './src/core/module_dxt1.js';
import { parseHamHeader, decodeHamPayload, buildHamFile, expectedPayloadBytes } from './src/core/ham_file.js';

const W = 64, H = 32, TOTAL = W * H;
const px = new Uint8ClampedArray(TOTAL * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        px[o] = (x * 4 + y * 8) % 256;
        px[o + 1] = (y * 8) % 256;
        px[o + 2] = (x * 8) % 256;
        px[o + 3] = 255;
    }
}
// Palette mit echten Farben (nicht alles schwarz), damit Anker sichtbar wirken
const palette = new Uint8Array(768);
for (let i = 0; i < 768; i++) palette[i] = (i * 53 + 17) % 256;
const step = { r: 4, g: 4, b: 4 };
const OFFSET = 0;

let fehler = 0;
const check = (name, cond, detail) => {
    if (!cond) { fehler++; console.log(`FEHL ${name}${detail ? ' — ' + detail : ''}`); }
};

const namen = Object.keys(HAM_CONFIGS);
let geprueft = 0;
const probleme = [];

for (const fmt of namen) {
    try {
        let previewPixels, payload;

        if (fmt === 'DXT1') {
            payload = encodeDXT1(px, W, H);
            previewPixels = decodeDXT1(payload, W, H);
        } else if (fmt === 'HAM12' || fmt === 'HAM16') {
            const commands = await encodeHam12_16(px, W, H, fmt, step);
            payload = packHam12_16(commands, fmt);
            previewPixels = decodeHam12_16(commands, W, H, step);
        } else {
            const { commands } = await encodePaletted(px, W, H, fmt, step, palette.slice(), OFFSET, 'greedy', 'yuv_weight');
            payload = packPaletted(commands, fmt);
            previewPixels = decodePaletted(commands, W, H, step, palette, OFFSET);
        }

        // --- SPEICHERN: genau der Aufruf, den btnSave macht ---
        const datei = buildHamFile({ width: W, height: H, format: fmt, step, offset: OFFSET, palette, payload });

        // --- LADEN: genau der Weg von parseHamHeader + decodeHamPayload ---
        const kopf = parseHamHeader(datei);
        const geladen = decodeHamPayload(kopf);

        // Kopffelder
        check(`${fmt}: Größe im Kopf`, kopf.width === W && kopf.height === H, `${kopf.width}x${kopf.height}`);
        check(`${fmt}: Formatname im Kopf`, kopf.format === fmt, kopf.format);
        check(`${fmt}: Schritt im Kopf`, kopf.step.r === step.r && kopf.step.g === step.g && kopf.step.b === step.b);
        check(`${fmt}: Offset im Kopf`, kopf.offset === OFFSET);
        check(`${fmt}: Nutzlast im Kopf == gespeicherte Nutzlast`,
            kopf.payload.length === payload.length, `${kopf.payload.length} vs ${payload.length}`);
        const soll = expectedPayloadBytes(fmt, TOTAL);
        if (soll !== null) check(`${fmt}: Nutzlastgröße folgt der Bitrate`, kopf.payload.length === soll, `${kopf.payload.length} vs ${soll}`);

        // Pixel: Vorschau (vor dem Speichern) == geladene Datei
        let diff = 0;
        for (let i = 0; i < TOTAL * 4; i++) {
            if (geladen.pixels[i] !== previewPixels[i]) diff++;
        }
        check(`${fmt}: Bild nach dem Laden == Vorschau vor dem Speichern`, diff === 0, `${diff} Kanalwerte abweichend`);

        // Befehlskette: DXT1 hat keine, alle anderen müssen wieder da sein
        if (fmt === 'DXT1') {
            check(`${fmt}: keine Befehlskette nach dem Laden`, geladen.commands === null);
        } else {
            check(`${fmt}: Befehlskette nach dem Laden vollständig`,
                geladen.commands && geladen.commands.length === TOTAL, String(geladen.commands?.length));
        }

        // Palette kommt unverändert zurück (wird bei HAM12/16/DXT1 nicht benutzt)
        let palGleich = true;
        for (let i = 0; i < 768; i++) if (kopf.palette[i] !== palette[i]) { palGleich = false; break; }
        check(`${fmt}: Palette unverändert`, palGleich);

        // --- Zweites Speichern nach dem Laden: byte-identisch? ---
        const nochmal = buildHamFile({
            width: kopf.width, height: kopf.height, format: kopf.format,
            step: kopf.step, offset: kopf.offset, palette: kopf.palette, payload: kopf.payload
        });
        let byteGleich = datei.length === nochmal.length;
        if (byteGleich) for (let i = 0; i < datei.length; i++) if (datei[i] !== nochmal[i]) { byteGleich = false; break; }
        check(`${fmt}: Speichern -> Laden -> Speichern ist byte-identisch`, byteGleich);

        geprueft++;
    } catch (e) {
        probleme.push(`${fmt}: Ausnahme ${e.message}`);
    }
}

for (const p of probleme) console.log('FEHL ' + p);
fehler += probleme.length;
console.log(`\n${geprueft}/${namen.length} Formate: Speichern und Laden geprüft`);

// --- Referenzdateien: laden -> speichern -> byte-identisch? ---
// Das ist der Test auf den ausgelieferten Dateien: was Toby bekommt, muss die
// Oberfläche unverändert wieder herausgeben können.
import fs from 'node:fs';
let refGeprueft = 0, refFehler = 0;
for (const dir of ['testbilder/ref', 'testbilder/ref640', 'testbilder/ref512', 'testbilder/ref256bit']) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ham')).sort()) {
        const pfad = `${dir}/${f}`;
        const original = new Uint8Array(fs.readFileSync(pfad));
        const kopf = parseHamHeader(original);
        const nochmal = buildHamFile({
            width: kopf.width, height: kopf.height, format: kopf.format,
            step: kopf.step, offset: kopf.offset, palette: kopf.palette, payload: kopf.payload
        });
        let gleich = original.length === nochmal.length;
        if (gleich) for (let i = 0; i < original.length; i++) if (original[i] !== nochmal[i]) { gleich = false; break; }
        refGeprueft++;
        if (!gleich) { refFehler++; console.log(`FEHL ${pfad}: Laden+Speichern nicht byte-identisch`); }
    }
}
console.log(`${refGeprueft} Referenzdateien: Laden und Speichern byte-identisch (${refFehler} Abweichungen)`);
fehler += refFehler;

console.log(fehler === 0 ? 'SPEICHERN UND WIEDER LADEN FUNKTIONIERT FUER ALLE FORMATE' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
