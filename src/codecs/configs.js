export const HAM_CONFIGS = {
    // --- Sub-Formate für gemischte Modi ---
    "HAM04": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 8,
        hasTurbo: false,
        channels: { r: [-1, 1], g: [-1, 1], b: [-1, 1] }
    },
    "HAM05": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 16,
        hasTurbo: true,
        channels: { r: [-1, 1], g: [-1, 1], b: [-1, 1] }
    },
    "HAM06": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 32,
        hasTurbo: true,
        channels: { r: [-1, 1], g: [-2, -1, 1, 2], b: [-1, 1] }
    },
    "HAM08": {
        isPaletted: true,
        isMixed: false,
        slotsPerBank: 128,
        hasTurbo: true,
        channels: { r: [-2, -1, 1, 2], g: [-2, -1, 1, 2], b: [-2, -1, 1, 2] }
    },

    // --- Hauptformate ---
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
    "HAM_32Bit_44444444": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 8,
        sequence: ["HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04"]
    },
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