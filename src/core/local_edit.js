// src/core/local_edit.js
//
// Lokales Modifizieren eines bereits codierten Bildes.
//
// Idee: Der Encoder läuft als 1-D-Kette in Rasterreihenfolge und trägt einen
// Akkumulator (acc-Farbe) über die Pixel. Ändert man nur das Quellpixel k, sind
// alle Befehle VOR k unverändert gültig. Ab k wird neu encodiert — aber nur bis
// zum "Resync": sobald dort ein Anker entsteht, der exakt dem Anker des
// Original-Laufs an derselben Stelle entspricht, ist der Akkumulator danach
// identisch und der ursprüngliche Befehlsrest kann unverändert angehängt werden.
// Danach wird nur der betroffene Pixelbereich neu decodiert und das Fehlerbild
// für diesen Bereich aktualisiert.

import { HAM_CONFIGS } from '../codecs/configs.js';
import { computeAccAtPixel, encodeLocalSpan, decodeRangeInto } from './module_paletted.js';

export function canLocalEdit(format) {
    const cfg = HAM_CONFIGS[format];
    return !!(cfg && cfg.isPaletted && !cfg.isBlockBased);
}

/**
 * Führt den lokalen Re-Encode aus. `commands` und `decodedData` werden IN PLACE
 * aktualisiert (Befehle ab startPx, Decode im Bereich [startPx, endPx)).
 *
 * @returns {{ok:boolean, reason?:string, resynced?:boolean, startPx?:number, endPx?:number, span?:number}}
 */
export function performLocalEdit({
    sourceData, width, height, format, stepVal, paletteRAM, offset,
    metric = 'yuv_weight', commands, decodedData,
    startPx, minEndPx = startPx + 1, maxPixels = 4096
}) {
    if (!canLocalEdit(format)) {
        return { ok: false, reason: 'Lokale Änderungen gibt es nur für die HAM-Palettenformate (nicht für HAM12/16 oder DXT1).' };
    }
    if (!commands || commands.length === 0) {
        return { ok: false, reason: 'Keine Kommandodaten — bitte zuerst „2. Codieren“ drücken.' };
    }
    if (!sourceData || !decodedData) {
        return { ok: false, reason: 'Quell- oder Decode-Daten fehlen.' };
    }

    const accStart = computeAccAtPixel(commands, startPx, stepVal, paletteRAM, offset);
    const res = encodeLocalSpan({
        origData: sourceData, imgW: width, format, stepVal, paletteRAM, offset, metric,
        startPx, existingCommands: commands, minEndPx, maxPixels
    });

    if (res.commands.length === 0) return { ok: false, reason: 'Es konnte kein Befehl erzeugt werden.' };

    for (let i = 0; i < res.commands.length; i++) commands[res.startPx + i] = res.commands[i];
    decodeRangeInto(decodedData, commands, res.startPx, res.endPx, accStart, stepVal, paletteRAM, offset);

    return {
        ok: true,
        resynced: res.resynced,
        startPx: res.startPx,
        endPx: res.endPx,
        span: res.endPx - res.startPx
    };
}

/**
 * Aktualisiert das rohe Fehlerbild (|Quelle − Decode| je Kanal) für einen
 * Pixelbereich. Die Anzeige-Filter (Schwelle/Ignorieren) macht das Fenster.
 */
export function updateErrorRange(errorData, sourceData, decodedData, startPx, endPx) {
    if (!errorData) return;
    const total = errorData.length / 4;
    const from = Math.max(0, startPx);
    const to = Math.min(endPx, total);
    for (let i = from; i < to; i++) {
        const o = i * 4;
        errorData[o] = Math.abs(sourceData[o] - decodedData[o]);
        errorData[o + 1] = Math.abs(sourceData[o + 1] - decodedData[o + 1]);
        errorData[o + 2] = Math.abs(sourceData[o + 2] - decodedData[o + 2]);
        errorData[o + 3] = 255;
    }
}
