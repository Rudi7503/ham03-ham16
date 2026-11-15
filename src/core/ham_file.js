// Datei-Ebene: Kopf lesen/schreiben und Nutzlast dekodieren.
//
// EINE Quelle für alle, die .ham-Dateien lesen oder schreiben — Oberfläche,
// Referenz-Generatoren und Tests. Vorher hatte jeder Generator seine eigene
// Kopie von readHam/writeHam; dadurch liefen Prüfsummen und Dateiformat
// auseinander (der von extern gefundene Index-Fehler entstand genau so).
import { HAM_CONFIGS } from '../codecs/configs.js';
import { unpackPaletted, decodePaletted } from './module_paletted.js';
import { unpackHam12_16, decodeHam12_16 } from './module_ham12_16.js';
import { decodeDXT1 } from './module_dxt1.js';

export const HAM_VERSION = 4;
export const MAGIC = [72, 65, 77, 33]; // "HAM!"

// Liest den Kopf. Wirft bei ungültigem Magic oder unbekannter Version — ein
// stilles Weiterlaufen würde ein falsches Bild erzeugen.
export function parseHamHeader(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 20) throw new Error(`Datei zu kurz (${u8.length} Byte)`);
    for (let i = 0; i < 4; i++) {
        if (u8[i] !== MAGIC[i]) throw new Error('kein HAM!-Magic');
    }
    const version = u8[4];
    if (version !== HAM_VERSION) {
        throw new Error(`Formatversion ${version}, erwartet ${HAM_VERSION}. `
            + `Version 4 hat das Modusbit umgedreht; ältere Dateien sind nicht lesbar.`);
    }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const littleEndian = u8[5] === 0;
    const width = dv.getUint16(6, littleEndian);
    const height = dv.getUint16(8, littleEndian);
    const nameLen = u8[10];
    let p = 11;
    if (p + nameLen + 4 + 768 > u8.length) throw new Error('Kopf unvollständig (Formatname/Palette fehlen)');
    const format = new TextDecoder().decode(u8.slice(p, p + nameLen)); p += nameLen;
    const step = { r: u8[p++], g: u8[p++], b: u8[p++] };
    const offset = u8[p++];
    const palette = u8.slice(p, p + 768); p += 768;
    return {
        version, width, height, format, step, offset, palette,
        payload: u8.slice(p), headerBytes: p
    };
}

// Dekodiert die Nutzlast passend zum Formatnamen. Liefert immer Pixel; die
// Befehlskette nur, wenn das Format eine hat (DXT1 hat keine).
export function decodeHamPayload(h) {
    const total = h.width * h.height;
    if (h.format === 'DXT1') {
        return { commands: null, pixels: decodeDXT1(h.payload, h.width, h.height) };
    }
    if (h.format === 'HAM12' || h.format === 'HAM16') {
        const commands = unpackHam12_16(h.payload, h.format, total);
        return { commands, pixels: decodeHam12_16(commands, h.width, h.height, h.step) };
    }
    if (!HAM_CONFIGS[h.format]) throw new Error(`unbekanntes Format "${h.format}"`);
    const commands = unpackPaletted(h.payload, h.format, total);
    return { commands, pixels: decodePaletted(commands, h.width, h.height, h.step, h.palette, h.offset) };
}

// Baut eine vollständige Datei: Kopf + Palette + Nutzlast.
export function buildHamFile({ width, height, format, step, offset = 0, palette, payload, version = HAM_VERSION }) {
    const nameBytes = new TextEncoder().encode(format);
    const buf = new Uint8Array(11 + nameBytes.length + 4 + 768 + payload.length);
    const dv = new DataView(buf.buffer);
    buf.set(MAGIC, 0);
    dv.setUint8(4, version);
    dv.setUint8(5, 0);                    // Little-Endian für die Kopffelder
    dv.setUint16(6, width, true);
    dv.setUint16(8, height, true);
    dv.setUint8(10, nameBytes.length);
    let p = 11;
    buf.set(nameBytes, p); p += nameBytes.length;
    dv.setUint8(p++, step.r); dv.setUint8(p++, step.g); dv.setUint8(p++, step.b); dv.setUint8(p++, offset);
    if (palette) buf.set(palette, p);
    p += 768;
    buf.set(payload, p);
    return buf;
}

// Erwartete Nutzlastgröße in Byte für ein Format (ohne Kopf und Palette).
export function expectedPayloadBytes(format, totalPixels) {
    if (format === 'DXT1') {
        // Blockformat: 8 Byte je 4x4-Block; Breite/Höhe stecken im Aufrufer
        return null;
    }
    const cfg = HAM_CONFIGS[format];
    if (!cfg) return null;
    // HAM12/HAM16 sind eigene 16-Bit-Formate: eine Wort je Pixel, auch wenn
    // HAM12 davon nur 12 Bit belegt. Als Sub-Format in einem Mischstrom zählt
    // dagegen nur der 12-Bit-Anker — dafür greift der Zweig weiter unten.
    if (format === 'HAM12' || format === 'HAM16') {
        return totalPixels * 2;
    }
    if (cfg.isMixed && Array.isArray(cfg.sequence)) {
        // Die Bitbreite hängt vom Pixelindex ab, nicht vom Durchschnitt: bei einer
        // Sequenzlänge, die die Pixelzahl nicht teilt, endet der Strom mitten in
        // einer Periode. Mit dem Durchschnitt gerechnet kam bei
        // HAM_256BIT_12_48x5_4_DELTA (256 px, 50er-Periode) 164 statt 168 Byte
        // heraus — deshalb hier gliedweise aufsummieren.
        const seq = cfg.sequence;
        const perioden = Math.floor(totalPixels / seq.length);
        const rest = totalPixels % seq.length;
        const bitsProPeriode = seq.reduce((s, f) => s + (HAM_CONFIGS[f]?.bits || 0), 0);
        let bits = perioden * bitsProPeriode;
        for (let i = 0; i < rest; i++) bits += HAM_CONFIGS[seq[i]]?.bits || 0;
        return Math.ceil(bits / 32) * 4;
    }
    const bits = cfg.bits || 0;
    return Math.ceil(totalPixels * bits / 32) * 4;
}
