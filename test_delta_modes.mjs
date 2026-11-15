import assert from 'node:assert';
import { HAM_CONFIGS } from './src/codecs/configs.js';
import {
    CHANNEL_DEFS,
    encodePaletted,
    decodePaletted,
    packPaletted,
    unpackPaletted
} from './src/core/module_paletted.js';

console.log("=== Starte Test-Suite für reine HAM-Delta-Modi ===");

// 1. Bit- und Config-Prüfung
// HAM12_ANCHOR und die darauf aufbauenden 12er-/256-Bit-Formate wurden entfernt.
const deltaConfigs = [
    "HAM04_DELTA",
    "HAM05_DELTA",
    "HAM06_DELTA",
    "HAM08_DELTA",
    "HAM_32BIT_HAM08_DELTA",
    "HAM_32BIT_44444444_DELTA"
];

for (const name of deltaConfigs) {
    const cfg = HAM_CONFIGS[name];
    assert(cfg, `Config ${name} fehlt!`);
    console.log(`OK   Config ${name}: isMixed=${cfg.isMixed}, bits=${cfg.bits || 'seq'}`);
}

// 2. Roundtrip-Prüfung für Kodierung & Dekodierung (getCmdVal <-> parseVal)
console.log("\n--- Teste Pack/Unpack Roundtrip ---");

// Test HAM05_DELTA (5 Bit: 32 Codes)
{
    const cmds = [];
    for (let isTurbo of [false, true]) {
        for (let ri = 0; ri < 2; ri++) {
            for (let gi = 0; gi < 4; gi++) {
                for (let bi = 0; bi < 2; bi++) {
                    cmds.push({ isAnchor: false, format: "HAM05_DELTA", isTurbo, rIndex: ri, gIndex: gi, bIndex: bi });
                }
            }
        }
    }
    assert.strictEqual(cmds.length, 32);
    const packed = packPaletted(cmds, "HAM05_DELTA");
    const unpacked = unpackPaletted(packed, "HAM05_DELTA", cmds.length);
    for (let i = 0; i < cmds.length; i++) {
        assert.strictEqual(unpacked[i].format, "HAM05_DELTA");
        assert.strictEqual(unpacked[i].isTurbo, cmds[i].isTurbo);
        assert.strictEqual(unpacked[i].rIndex, cmds[i].rIndex);
        assert.strictEqual(unpacked[i].gIndex, cmds[i].gIndex);
        assert.strictEqual(unpacked[i].bIndex, cmds[i].bIndex);
    }
    console.log("OK   HAM05_DELTA alle 32 Codes packen/entpacken bit-exakt");
}

// Test HAM06_DELTA (6 Bit: 64 Codes)
{
    const cmds = [];
    for (let t = 0; t < 4; t++) {
        for (let ri = 0; ri < 2; ri++) {
            for (let gi = 0; gi < 4; gi++) {
                for (let bi = 0; bi < 2; bi++) {
                    cmds.push({ isAnchor: false, format: "HAM06_DELTA", turboIndex: t, rIndex: ri, gIndex: gi, bIndex: bi });
                }
            }
        }
    }
    assert.strictEqual(cmds.length, 64);
    const packed = packPaletted(cmds, "HAM06_DELTA");
    const unpacked = unpackPaletted(packed, "HAM06_DELTA", cmds.length);
    for (let i = 0; i < cmds.length; i++) {
        assert.strictEqual(unpacked[i].format, "HAM06_DELTA");
        assert.strictEqual(unpacked[i].turboIndex, cmds[i].turboIndex);
        assert.strictEqual(unpacked[i].rIndex, cmds[i].rIndex);
        assert.strictEqual(unpacked[i].gIndex, cmds[i].gIndex);
        assert.strictEqual(unpacked[i].bIndex, cmds[i].bIndex);
    }
    console.log("OK   HAM06_DELTA alle 64 Codes (4-Stufen Turboturbo) packen/entpacken bit-exakt");
}

// Test HAM08_DELTA (8 Bit: 256 Codes)
{
    const cmds = [];
    for (let t = 0; t < 4; t++) {
        for (let ri = 0; ri < 4; ri++) {
            for (let gi = 0; gi < 4; gi++) {
                for (let bi = 0; bi < 4; bi++) {
                    cmds.push({ isAnchor: false, format: "HAM08_DELTA", turboIndex: t, rIndex: ri, gIndex: gi, bIndex: bi });
                }
            }
        }
    }
    assert.strictEqual(cmds.length, 256);
    const packed = packPaletted(cmds, "HAM08_DELTA");
    const unpacked = unpackPaletted(packed, "HAM08_DELTA", cmds.length);
    for (let i = 0; i < cmds.length; i++) {
        assert.strictEqual(unpacked[i].format, "HAM08_DELTA");
        assert.strictEqual(unpacked[i].turboIndex, cmds[i].turboIndex);
        assert.strictEqual(unpacked[i].rIndex, cmds[i].rIndex);
        assert.strictEqual(unpacked[i].gIndex, cmds[i].gIndex);
        assert.strictEqual(unpacked[i].bIndex, cmds[i].bIndex);
    }
    console.log("OK   HAM08_DELTA alle 256 Codes (4-Stufen Turboturbo) packen/entpacken bit-exakt");
}

// 3. 32-Bit-Mischsequenzen prüfen
console.log("\n--- Teste 32-Bit Mischsequenz Wort-Größen ---");
const mixedToTest = [
    { name: "HAM_32BIT_HAM08_DELTA", expectedBitsPerWord: 32, pxPerWord: 4 },
    { name: "HAM_32BIT_44444444_DELTA", expectedBitsPerWord: 32, pxPerWord: 8 }
];

for (const m of mixedToTest) {
    const cfg = HAM_CONFIGS[m.name];
    assert(cfg && cfg.sequence, `Sequence fehlt für ${m.name}`);
    let sumBits = 0;
    for (const sub of cfg.sequence) {
        const subCfg = HAM_CONFIGS[sub];
        assert(subCfg, `Sub-Format ${sub} nicht gefunden!`);
        sumBits += subCfg.bits;
    }
    assert.strictEqual(sumBits, m.expectedBitsPerWord, `${m.name} Summe Bits ist ${sumBits} != ${m.expectedBitsPerWord}`);
    assert.strictEqual(cfg.sequence.length, m.pxPerWord, `${m.name} Pixel pro Wort ist ${cfg.sequence.length} != ${m.pxPerWord}`);
    console.log(`OK   ${m.name}: ${cfg.sequence.join('+')} = ${sumBits} Bits (${m.pxPerWord} Px/Wort)`);
}

// 4. End-to-End Encode -> Pack -> Unpack -> Decode
console.log("\n--- Teste End-to-End Pipeline mit Farbbild ---");
const W = 40, H = 10;
const testImg = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        testImg[idx] = Math.round((x / W) * 255);       // R Gradient
        testImg[idx + 1] = Math.round((y / H) * 255);   // G Gradient
        testImg[idx + 2] = Math.round(((x + y) / (W + H)) * 255); // B
        testImg[idx + 3] = 255;
    }
}

const paletteRAM = new Uint8Array(256 * 3);
const stepVal = { r: 4, g: 4, b: 4 };

for (const m of mixedToTest) {
    const res = await encodePaletted(
        testImg, W, H, m.name, stepVal, paletteRAM, 0, "greedy", "rgb"
    );
    const cmds = res.commands;
    assert.strictEqual(cmds.length, W * H);

    const packed = packPaletted(cmds, m.name);
    // Erwartete Bytezahl: (W*H / pxPerWord) * 4
    const expectedBytes = Math.ceil((W * H) / m.pxPerWord) * 4;
    assert.strictEqual(packed.length, expectedBytes, `Nutzlastgröße für ${m.name}: ${packed.length} != ${expectedBytes}`);

    const unpacked = unpackPaletted(packed, m.name, W * H);
    assert.strictEqual(unpacked.length, W * H);

    const decoded = decodePaletted(unpacked, W, H, stepVal, paletteRAM, 0);
    assert.strictEqual(decoded.length, W * H * 4);
    assert(decoded.some(v => v > 0), "Decodiertes Bild darf nicht komplett schwarz sein");
    console.log(`OK   ${m.name}: Encode -> Pack (${packed.length} Bytes) -> Unpack -> Decode erfolgreich`);
}

console.log("\n=======================================================");
console.log("ALLE TESTS FÜR REINE HAM-DELTA-MODI ERFOLGREICH BESTANDEN!");
console.log("=======================================================");
