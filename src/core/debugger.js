import { encodeHam12_16, decodeHam12_16, packHam12_16, unpackHam12_16 } from './module_ham12_16.js';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './module_paletted.js';

export async function debugRoundtripHam12_16(origData, imgW, imgH, format, stepVal, strategy, metric) {
    console.log(`--- START DEBUG ROUNDTRIP [MODUL: ${format} | ${strategy} | ${metric}] ---`);
    
    let cmds = await encodeHam12_16(origData, imgW, imgH, format, stepVal, strategy, metric, 1);
    let decodedOriginal = decodeHam12_16(cmds, imgW, imgH, stepVal);
    
    let packed = packHam12_16(cmds, format);
    let unpackedCmds = unpackHam12_16(packed, format, imgW * imgH);
    let decodedLoaded = decodeHam12_16(unpackedCmds, imgW, imgH, stepVal);

    let errorCount = 0;
    for (let i = 0; i < decodedOriginal.length; i++) {
        if (decodedOriginal[i] !== decodedLoaded[i]) {
            if (errorCount < 5) console.error(`Abweichung bei Byte-Index ${i} (Pixel ${Math.floor(i/4)}): Orig=${decodedOriginal[i]} != Geladen=${decodedLoaded[i]}`);
            errorCount++;
        }
    }
    
    if (errorCount === 0) {
        console.log("✅ ROUNDTRIP PERFEKT! Pixel-Puffer sind 100% identisch.");
        alert("✅ Test bestanden! Speichern und Laden verändert die Daten bei diesem Format nicht.");
        return true;
    } else {
        console.error(`❌ FEHLER: ${errorCount} Bytes weichen nach Speichern/Laden ab!`);
        alert(`❌ FEHLER! ${errorCount} Bytes stimmen nicht überein. Bitte drücke F12 und öffne die Entwicklerkonsole für Details!`);
        return false;
    }
}

export async function debugRoundtripPaletted(origData, imgW, imgH, format, stepVal, paletteRAM, offset, strategy, metric) {
    console.log(`--- START DEBUG ROUNDTRIP [MODUL: ${format} | ${strategy} | ${metric}] ---`);
    
    let cmds = await encodePaletted(origData, imgW, imgH, format, stepVal, paletteRAM, offset, strategy, metric, 1);
    let decodedOriginal = decodePaletted(cmds, imgW, imgH, stepVal, paletteRAM, offset);
    
    let packed = packPaletted(cmds, format);
    let unpackedCmds = unpackPaletted(packed, format, imgW * imgH);
    let decodedLoaded = decodePaletted(unpackedCmds, imgW, imgH, stepVal, paletteRAM, offset);

    let errorCount = 0;
    for (let i = 0; i < decodedOriginal.length; i++) {
        if (decodedOriginal[i] !== decodedLoaded[i]) {
             if (errorCount < 5) console.error(`Abweichung bei Byte-Index ${i} (Pixel ${Math.floor(i/4)}): Orig=${decodedOriginal[i]} != Geladen=${decodedLoaded[i]}`);
            errorCount++;
        }
    }
    
    if (errorCount === 0) {
        console.log("✅ ROUNDTRIP PERFEKT! Pixel-Puffer sind 100% identisch.");
        alert("✅ Test bestanden! Speichern und Laden verändert die Daten bei diesem Format nicht.");
        return true;
    } else {
        console.error(`❌ FEHLER: ${errorCount} Bytes weichen nach Speichern/Laden ab!`);
        alert(`❌ FEHLER! ${errorCount} Bytes stimmen nicht überein. Bitte drücke F12 und öffne die Entwicklerkonsole für Details!`);
        return false;
    }
}