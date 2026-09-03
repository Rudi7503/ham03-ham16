// src/core/optimizer_worker.js

import { HAM_CONFIGS } from '../codecs/configs.js';
import { encodePaletted, decodePaletted } from './module_paletted.js';
import { computeAvgYuvScore } from './analysis.js';
// Der Worker lauscht auf Nachrichten vom Haupt-Thread
self.onmessage = async (e) => {
    const { 
        candidate, origData, imgW, imgH, format, 
        step, metric, offset, basePaletteRAM, slotToFill, optRegion 
    } = e.data;

    try {
        // 1. Lokale Kopie der Palette erstellen und den Kandidaten in den Ziel-Slot einsetzen
        let localPalette = new Uint8Array(basePaletteRAM);
        localPalette[slotToFill * 3]     = candidate.r;
        localPalette[slotToFill * 3 + 1] = candidate.g;
        localPalette[slotToFill * 3 + 2] = candidate.b;

        // 2. Bild mit dieser Test-Palette encodieren (progressCallback = null, damit es extrem schnell läuft)
        let encodeRes = await encodePaletted(
            origData, imgW, imgH, format, step, localPalette, offset, 
            "greedy", metric, null, 0, 0, 15.0 
        );

        // 3. Bild decodieren
        let decodedPixels = decodePaletted(encodeRes.commands, imgW, imgH, step, localPalette, offset);

        // 4. Fehlerwert (Score) berechnen. Bewusst NICHT computeDetailedAnalysis:
        //    die schlanke Variante liefert exakt denselben avgYuv-Wert, spart aber
        //    die teure Top10-/Histogramm-Analyse (Maps + String-Keys pro Pixel),
        //    die in jedem Battle-Kandidaten nur den Score liefern würde.
        let score = computeAvgYuvScore(origData, decodedPixels, imgW, imgH, metric, optRegion);

        // 5. Ergebnis (Score) an den Haupt-Thread zurückschicken
        self.postMessage({ candidate: candidate, score: score });

    } catch (error) {
        // Falls was crasht, geben wir einen unendlichen Fehlerwert zurück, 
        // damit dieser Kandidat definitiv verliert.
        console.error("Worker Error:", error);
        self.postMessage({ candidate: candidate, score: Infinity });
    }
};
