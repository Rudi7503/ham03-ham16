export const HAM_CONFIGS = {
    "HAM04": {
        name: "HAM04",
        isPaletted: true,
        slotsPerBank: 8,
        maxAnchor: 7,
        hasTurbo: false,
        channels: { r: [1, -1], g: [1, -1], b: [1, -1] }
    },
    "HAM05": {
        name: "HAM05",
        isPaletted: true,
        slotsPerBank: 16,
        maxAnchor: 15,
        hasTurbo: true,
        channels: { r: [1, -1], g: [1, -1], b: [1, -1] }
    },
    "HAM06": {
        name: "HAM06",
        isPaletted: true,
        slotsPerBank: 32,
        maxAnchor: 31,
        hasTurbo: true,
        channels: { r: [1, -1], g: [1, 2, -2, -1], b: [1, -1] }
    },
    "HAM08_PAL": {
        name: "HAM08_PAL",
        isPaletted: true,
        slotsPerBank: 128,
        maxAnchor: 127,
        hasTurbo: true,
        channels: { r: [1, 2, -2, -1], g: [1, 2, -2, -1], b: [1, 2, -2, -1] }
    },
    "HAM12": {
        name: "HAM12",
        isPaletted: false,
        slotsPerBank: 0,
        maxAnchor: 0,
        hasTurbo: true,
        channels: { r: [1, -1], g: [1, -1], b: [1, -1] }
    },
    "HAM16": {
        name: "HAM16",
        isPaletted: false,
        slotsPerBank: 0,
        maxAnchor: 0,
        hasTurbo: true,
        channels: { r: [1, -1], g: [1, -1], b: [1, -1] }
    },
    "HAM_16BIT": {
        name: "HAM_16BIT",
        isPaletted: true,
        isMixed: true,                     // Aktiviert den Pixel-zu-Pixel Formatwechsel
        sequence: ["HAM06", "HAM04", "HAM06"],
        slotsPerBank: 32,                  // Das Maximum (HAM06 benötigt 32 Slots)
        maxAnchor: 31,
        hasTurbo: true
    }
};