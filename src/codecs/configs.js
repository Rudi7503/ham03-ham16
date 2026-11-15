export const HAM_CONFIGS = {
    // --- Sub-Formate für gemischte Modi ---
    "HAM01": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: false,
        bits: 1
    },
    "HAM02": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: false,
        bits: 2
    },
    "HAM03": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 4,
        hasTurbo: false,
        bits: 3
    },
    "HAM04": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 8,
        hasTurbo: false,
        bits: 4
    },
    "HAM05": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 16,
        hasTurbo: true,
        bits: 5
    },
    "HAM06": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 32,
        hasTurbo: true,
        bits: 6
    },
    "HAM08": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 128,
        hasTurbo: true,
        bits: 8
    },

    // --- Neue reine HAM-Delta Sub-Formate (ohne Anker-Bit) ---
    "HAM04_DELTA": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: true,
        bits: 4
    },
    "HAM05_DELTA": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: true,
        bits: 5
    },
    "HAM06_DELTA": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: true,
        bits: 6
    },
    "HAM08_DELTA": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 0,
        hasTurbo: true,
        bits: 8
    },
    "HAM12_ANCHOR": {
        isPaletted: true,
        isMixed: false,
        isDirect: true,
        slotsPerBank: 0,
        hasTurbo: false,
        bits: 12
    },

    // --- Standard-Formate ---
    "HAM12": {
        isPaletted: false,
        isMixed: false,
        hasTurbo: true,
        bits: 12
    },
    "HAM16": {
        isPaletted: false,
        isMixed: false,
        hasTurbo: true,
        bits: 16
    },

    // --- 32-Bit Mischmodi (Exakt 4,0 Bit / Pixel im Schnitt 8 Pixel) ---
    "HAM_32BIT_44444444": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 8,
        sequence: ["HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04"]
    },
    "HAM_32BIT_53535353": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 16,
        sequence: ["HAM05", "HAM03", "HAM05", "HAM03", "HAM05", "HAM03", "HAM05", "HAM03"]
    },
    "HAM_32BIT_63436343": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM03", "HAM04", "HAM03", "HAM06", "HAM03", "HAM04", "HAM03"]
    },
     // --- 32-Bit Mischmodi (Exakt 4,6 Bit / Pixel im Schnitt 7 Pixel) ---
    "HAM_32BIT_6446444": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM04", "HAM04", "HAM06", "HAM04", "HAM04", "HAM04"]
    },
    "HAM_32BIT_5454545": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 16,
        sequence: ["HAM05", "HAM04", "HAM05", "HAM04", "HAM05", "HAM04", "HAM05"]
    },
    "HAM_32BIT_6454544": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM04", "HAM05", "HAM04", "HAM05", "HAM04", "HAM04"]
    },
    // --- 32-Bit Mischmodi (Exakt 5,3 Bit / Pixel im Schnitt 6 Pixel) ---
   
     "HAM_32BIT_655655": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM05", "HAM05", "HAM06", "HAM05", "HAM05"]
    },
     "HAM_32BIT_844844": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 127,
        sequence: ["HAM08", "HAM04", "HAM04", "HAM08", "HAM04", "HAM04"]
    },
     "HAM_32BIT_846554": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 127,
        sequence: ["HAM08", "HAM04", "HAM06", "HAM05", "HAM05", "HAM04"]
    },
     "HAM_32BIT_646565": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM04", "HAM06", "HAM05", "HAM06", "HAM05"]
    },

    // --- 32-Bit Mischmodi (Exakt 6,4 Bit / Pixel im Schnitt 5 Pixel) ---
    "HAM_32BIT_86666": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128,
        sequence: ["HAM08", "HAM06", "HAM06", "HAM06", "HAM06"]
    },
    "HAM_32BIT_85865": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128,
        sequence: ["HAM08", "HAM05", "HAM08", "HAM06", "HAM05"]
    },
    // --- 32-Bit Mischmodi (Exakt 8,0 Bit / Pixel im Schnitt 4 Pixel) ---
    "HAM_32BIT_8888": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128,
        sequence: ["HAM08", "HAM08", "HAM08", "HAM08"]
    },

    // --- Neue reine HAM-Delta Mischmodi & Kombinationen ---
    "HAM_32BIT_HAM08_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM08_DELTA", "HAM08_DELTA", "HAM08_DELTA", "HAM08_DELTA"]
    },
    "HAM_32BIT_12_5555_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM05_DELTA", "HAM05_DELTA", "HAM05_DELTA", "HAM05_DELTA"]
    },
    "HAM_256BIT_12_61x4_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", ...Array(61).fill("HAM04_DELTA")]
    },
    "HAM_256BIT_12_inter_5_4_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", ...Array(10).fill(["HAM05_DELTA", "HAM05_DELTA", "HAM05_DELTA", "HAM05_DELTA", "HAM04_DELTA"]).flat(), "HAM04_DELTA"]
    },
    "HAM_256BIT_12_48x5_4_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", ...Array(48).fill("HAM05_DELTA"), "HAM04_DELTA"]
    },
    "HAM_256BIT_12_8_46x5_6_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM08_DELTA", ...Array(46).fill("HAM05_DELTA"), "HAM06_DELTA"]
    },
    "HAM_256BIT_12_14x5_29x6_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", ...Array(14).fill("HAM05_DELTA"), ...Array(29).fill("HAM06_DELTA")]
    },
    "HAM_256BIT_12_40x6_4_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", ...Array(40).fill("HAM06_DELTA"), "HAM04_DELTA"]
    },
    "HAM_32BIT_12_686_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM06_DELTA", "HAM08_DELTA", "HAM06_DELTA"]
    },
    "HAM_32BIT_12_44444_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA"]
    },
    "HAM_32BIT_44444444_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA", "HAM04_DELTA"]
    },
    "HAM_32BIT_12_866_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM08_DELTA", "HAM06_DELTA", "HAM06_DELTA"]
    },
    "HAM_32BIT_12_4646_DELTA": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 0,
        sequence: ["HAM12_ANCHOR", "HAM04_DELTA", "HAM06_DELTA", "HAM04_DELTA", "HAM06_DELTA"]
    },
    "HAM_32BIT_12_686": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM12_ANCHOR", "HAM06", "HAM08", "HAM06"]
    },
    "HAM_32BIT_12_5555": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 16,
        sequence: ["HAM12_ANCHOR", "HAM05", "HAM05", "HAM05", "HAM05"]
    },

    // ... andere Formate ...
    "DXT1": {
        isPaletted: false,
        isMixed: false,
        isBlockBased: true,
        bits: 4
    }
    

};

// Anzahl erreichbarer Ankerslots eines (Sub-)Formats.
//
// ACHTUNG: 0 ist ein GÜLTIGER Wert — reine Delta-Formate und der
// HAM12_ANCHOR-Direktfarbanker haben keinen einzigen Palettenplatz. Der frühere
// Ausdruck `slotsPerBank || 8` bildete diese 0 auf 8 ab und täuschte damit acht
// nutzbare Slots vor (Palettenoptimierung und Sortierung rechneten mit Slots,
// die der Encoder nie anspringt). Der Ersatzwert gilt nur für UNBEKANNTE Formate.
export function slotsPerBankOf(fmt, fallback = 8) {
    const cfg = HAM_CONFIGS[fmt];
    if (!cfg) return fallback;
    return Number.isFinite(cfg.slotsPerBank) ? cfg.slotsPerBank : fallback;
}