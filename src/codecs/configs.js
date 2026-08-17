export const HAM_CONFIGS = {
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
        slotsPerBank: 8, // HAM04 nutzt 3 Anker-Bits = 2^3 = 8 Slots
        sequence: ["HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04", "HAM04"] // 8 * 4 = 32 Bit
    },
    "HAM_32BIT_6446444": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32, // Enthält HAM06 (5 Anker-Bits = 32 Slots) & HAM04 (8 Slots) -> Max Bank 32
        sequence: ["HAM06", "HAM04", "HAM04", "HAM06", "HAM04", "HAM04", "HAM04"]
    },
    "HAM_32BIT_5454545": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 16, // Enthält HAM05 (4 Anker-Bits = 16 Slots) & HAM04 (8 Slots) -> Max Bank 16
        sequence: ["HAM05", "HAM04", "HAM05", "HAM04", "HAM05", "HAM04", "HAM05"]
    },
    "HAM_32BIT_6454544": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32, // Enthält HAM06 (32 Slots), HAM05 (16 Slots), HAM04 (8 Slots) -> Max Bank 32
        sequence: ["HAM06", "HAM04", "HAM05", "HAM04", "HAM05", "HAM04", "HAM04"]
    },
    "HAM_32BIT_655655": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 32, // Enthält HAM06 (32 Slots) & HAM05 (16 Slots) -> Max Bank 32
        sequence: ["HAM06", "HAM05", "HAM05", "HAM06", "HAM05", "HAM05"]
    },
    "HAM_32BIT_86666": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128, // Enthält HAM08_PAL (7 Anker-Bits = 128 Slots) & HAM06 (32 Slots) -> Max Bank 128
        sequence: ["HAM08_PAL", "HAM06", "HAM06", "HAM06", "HAM06"]
    },
    "HAM_32BIT_8888": {
        isPaletted: true,
        isMixed: true,
        slotsPerBank: 128, // Enthält HAM08_PAL (7 Anker-Bits = 128 Slots) -> Max Bank 128
        sequence: ["HAM08_PAL", "HAM08_PAL", "HAM08_PAL", "HAM08_PAL"]
    }
};