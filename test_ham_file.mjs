// Prüft das gemeinsame Datei-Modul (src/core/ham_file.js): Kopf lesen, Nutzlast
// dekodieren, Datei schreiben — für Paletten-, HAM12/16- und DXT1-Dateien.
//
// Hintergrund: Der Ladezweig der Oberfläche kannte DXT1 nicht. Eine gespeicherte
// DXT1-Datei landete im Palettenpfad und wurde komplett schwarz angezeigt — ohne
// Fehlermeldung. Dieser Test hält den Lade-Pfad für alle Formatfamilien fest.
import fs from 'node:fs';
import { parseHamHeader, decodeHamPayload, buildHamFile, expectedPayloadBytes, HAM_VERSION } from './src/core/ham_file.js';
import { encodeDXT1, decodeDXT1 } from './src/core/module_dxt1.js';

let fehler = 0;
const check = (name, cond, detail) => {
    console.log(`${cond ? 'OK  ' : 'FEHL'} ${name}${detail && !cond ? ' — ' + detail : ''}`);
    if (!cond) fehler++;
};

// --- 1. Referenzdateien über den gemeinsamen Pfad lesen ---
for (const [dir, groesse] of [['testbilder/ref', '320x256'], ['testbilder/ref640', '640x256']]) {
    for (const m of ['03', '04', '05', '06', '08']) {
        const pfad = `${dir}/ham${m}.ham`;
        if (!fs.existsSync(pfad)) continue;
        const h = parseHamHeader(fs.readFileSync(pfad));
        const d = decodeHamPayload(h);
        const rgb = fs.readFileSync(`${dir}/ham${m}_decoded.rgb`);
        let diff = 0;
        for (let i = 0; i < h.width * h.height; i++) {
            if (d.pixels[i * 4] !== rgb[i * 3] || d.pixels[i * 4 + 1] !== rgb[i * 3 + 1] || d.pixels[i * 4 + 2] !== rgb[i * 3 + 2]) diff++;
        }
        check(`${h.format} ${groesse}: Dekodierung == Rasterdatei`, diff === 0, `${diff} Pixel abweichend`);
        const erwartet = expectedPayloadBytes(h.format, h.width * h.height);
        check(`${h.format} ${groesse}: Nutzlastgröße folgt der Bitrate`, erwartet === h.payload.length,
            `${h.payload.length} statt ${erwartet}`);
    }
}

// --- 2. DXT1: schreiben, lesen, dekodieren ---
const W = 64, H = 32;
const px = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        px[o] = (x * 4) % 256; px[o + 1] = (y * 8) % 256; px[o + 2] = ((x + y) * 3) % 256; px[o + 3] = 255;
    }
}
const dxtPayload = encodeDXT1(px, W, H);
const datei = buildHamFile({ width: W, height: H, format: 'DXT1', step: { r: 1, g: 1, b: 1 }, palette: new Uint8Array(768), payload: dxtPayload });
const kopf = parseHamHeader(datei);
const dec = decodeHamPayload(kopf);
check('DXT1: Formatname im Kopf', kopf.format === 'DXT1', kopf.format);
check('DXT1: keine Befehlskette', dec.commands === null);
check('DXT1: Nutzlast = 8 Byte je 4x4-Block', kopf.payload.length === Math.ceil(W / 4) * Math.ceil(H / 4) * 8,
    `${kopf.payload.length} Byte`);
const direkt = decodeDXT1(kopf.payload, W, H);
let gleich = 0;
for (let i = 0; i < W * H * 4; i++) if (direkt[i] !== dec.pixels[i]) gleich++;
check('DXT1: Lade-Pfad == decodeDXT1', gleich === 0, `${gleich} Abweichungen`);

// Der alte Fehler: über den Palettenpfad wäre alles schwarz. Gegenprobe, dass
// das Bild überhaupt Farben hat (nicht bloß zufällig schwarz dekodiert).
let farbig = 0;
for (let i = 0; i < W * H; i++) {
    if (dec.pixels[i * 4] > 8 || dec.pixels[i * 4 + 1] > 8 || dec.pixels[i * 4 + 2] > 8) farbig++;
}
check('DXT1: Bild ist nicht schwarz (alter Fehler)', farbig > (W * H) * 0.95, `nur ${farbig} von ${W * H} farbig`);

// --- 3. Versionsprüfung ---
const alt = new Uint8Array(datei); alt[4] = 3;
let abgewiesen = false;
try { parseHamHeader(alt); } catch (e) { abgewiesen = /version 3/i.test(e.message); }
check('Version 3 wird klar abgewiesen', abgewiesen);

// --- 4. Unbekanntes Format wird abgelehnt (kein stilles Falschbild) ---
const unbekannt = buildHamFile({ width: 4, height: 4, format: 'GIBTSNICHT', step: { r: 1, g: 1, b: 1 }, palette: new Uint8Array(768), payload: new Uint8Array(8) });
let abgelehnt = false;
try { decodeHamPayload(parseHamHeader(unbekannt)); } catch (e) { abgelehnt = /unbekanntes Format/.test(e.message); }
check('Unbekanntes Format wird beim Dekodieren abgelehnt', abgelehnt);

console.log(fehler === 0 ? '\nDATEI-MODUL UND LADE-PFAD STIMMEN (Palette, HAM12/16, DXT1)' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
