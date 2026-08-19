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

    // --- 32-Bit Mischmodi (Exakt 4,0 Bit / Pixel im Schnitt) ---
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
    "HAM_32BIT_44444444": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04"]
    },
    "HAM_32BIT_63436343": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM03", "HAM04", "HAM03", "HAM06", "HAM03", "HAM04", "HAM03"]
    },
     // --- Weitere gemischte Bestandskonfigurationen ---
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
    "HAM_32BIT_655655": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32,
        sequence: ["HAM06", "HAM05", "HAM05", "HAM06", "HAM05", "HAM05"]
    },
    "HAM_32BIT_86666": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128,
        sequence: ["HAM08", "HAM06", "HAM06", "HAM06", "HAM06"]
    },
    "HAM_32BIT_8888": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128,
        sequence: ["HAM08", "HAM08", "HAM08", "HAM08"]
    }
};