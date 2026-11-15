import fs from 'fs';
import path from 'path';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './src/core/module_paletted.js';
import { HAM_CONFIGS } from './src/codecs/configs.js';

const pal = new Uint8Array(768);
const step = { r: 4, g: 4, b: 4 };

// Testdatenbank: alle alten (auch schwächeren) 32-Bit-Modi + neue 256-Bit-Kandidaten
const candidates = {
    // --- 256-Bit-Kandidaten (wenige Anker, hohe Delta-Kontinuität) ---
    '256_12_61x4_D': ['HAM12_ANCHOR', ...Array(61).fill('HAM04_DELTA')],
    '256_12_8_59x4_D': ['HAM12_ANCHOR', 'HAM08_DELTA', ...Array(59).fill('HAM04_DELTA')],
    '256_2x12_58x4_D': [...Array(2).fill(['HAM12_ANCHOR', ...Array(29).fill('HAM04_DELTA')]).flat()],
    '256_4x12_52x4_D': [...Array(4).fill(['HAM12_ANCHOR', ...Array(13).fill('HAM04_DELTA')]).flat()],
    '256_12_20x6_31x4_D': ['HAM12_ANCHOR', ...Array(20).fill('HAM06_DELTA'), ...Array(31).fill('HAM04_DELTA')],
    '256_12_48x5_4_D': ['HAM12_ANCHOR', ...Array(48).fill('HAM05_DELTA'), 'HAM04_DELTA'],
    '256_12_40x6_4_D': ['HAM12_ANCHOR', ...Array(40).fill('HAM06_DELTA'), 'HAM04_DELTA'],
    '256_12_20x8_14x6_D': ['HAM12_ANCHOR', ...Array(20).fill('HAM08_DELTA'), ...Array(14).fill('HAM06_DELTA')],
    '256_12_30x8_4_D': ['HAM12_ANCHOR', ...Array(30).fill('HAM08_DELTA'), 'HAM04_DELTA'],

    // --- 16 neue 256-Bit-Kandidaten (Fokus auf 5d/6d/8d/4d-Mixes) ---
    '256_12_24x5_31x4_D': ['HAM12_ANCHOR', ...Array(24).fill('HAM05_DELTA'), ...Array(31).fill('HAM04_DELTA')],
    '256_12_32x5_21x4_D': ['HAM12_ANCHOR', ...Array(32).fill('HAM05_DELTA'), ...Array(21).fill('HAM04_DELTA')],
    '256_12_40x5_11x4_D': ['HAM12_ANCHOR', ...Array(40).fill('HAM05_DELTA'), ...Array(11).fill('HAM04_DELTA')],
    '256_12_44x5_4x6_D': ['HAM12_ANCHOR', ...Array(44).fill('HAM05_DELTA'), ...Array(4).fill('HAM06_DELTA')],
    '256_12_8_46x5_6_D': ['HAM12_ANCHOR', 'HAM08_DELTA', ...Array(46).fill('HAM05_DELTA'), 'HAM06_DELTA'],
    '256_12_2x8_44x5_8_D': ['HAM12_ANCHOR', ...Array(2).fill('HAM08_DELTA'), ...Array(44).fill('HAM05_DELTA'), 'HAM08_DELTA'],
    '256_12_40x5_6x6_8_D': ['HAM12_ANCHOR', ...Array(40).fill('HAM05_DELTA'), ...Array(6).fill('HAM06_DELTA'), 'HAM08_DELTA'],
    '256_12_36x5_10x6_4_D': ['HAM12_ANCHOR', ...Array(36).fill('HAM05_DELTA'), ...Array(10).fill('HAM06_DELTA'), 'HAM04_DELTA'],
    '256_12_30x5_15x6_4_D': ['HAM12_ANCHOR', ...Array(30).fill('HAM05_DELTA'), ...Array(15).fill('HAM06_DELTA'), 'HAM04_DELTA'],
    '256_12_24x5_20x6_4_D': ['HAM12_ANCHOR', ...Array(24).fill('HAM05_DELTA'), ...Array(20).fill('HAM06_DELTA'), 'HAM04_DELTA'],
    '256_12_16x5_26x6_8_D': ['HAM12_ANCHOR', ...Array(16).fill('HAM05_DELTA'), ...Array(26).fill('HAM06_DELTA'), 'HAM08_DELTA'],
    '256_12_4x8_40x5_2x6_D': ['HAM12_ANCHOR', ...Array(4).fill('HAM08_DELTA'), ...Array(40).fill('HAM05_DELTA'), ...Array(2).fill('HAM06_DELTA')],
    '256_12_10x8_32x5_4_D': ['HAM12_ANCHOR', ...Array(10).fill('HAM08_DELTA'), ...Array(32).fill('HAM05_DELTA'), 'HAM04_DELTA'],
    '256_12_8_38x6_8_D': ['HAM12_ANCHOR', 'HAM08_DELTA', ...Array(38).fill('HAM06_DELTA'), 'HAM08_DELTA'],
    '256_2x12_44x5_2x6_D': ['HAM12_ANCHOR', ...Array(22).fill('HAM05_DELTA'), 'HAM06_DELTA', 'HAM12_ANCHOR', ...Array(22).fill('HAM05_DELTA'), 'HAM06_DELTA'],
    '256_2x12_36x6_4x4_D': ['HAM12_ANCHOR', ...Array(18).fill('HAM06_DELTA'), 'HAM04_DELTA', 'HAM04_DELTA', 'HAM12_ANCHOR', ...Array(18).fill('HAM06_DELTA'), 'HAM04_DELTA', 'HAM04_DELTA'],

    // --- 16 weitere 256-Bit-Kandidaten (5d/6d-Spektrum + Interleaving) ---
    '256_12_38x5_9x6_D': ['HAM12_ANCHOR', ...Array(38).fill('HAM05_DELTA'), ...Array(9).fill('HAM06_DELTA')],
    '256_12_32x5_14x6_D': ['HAM12_ANCHOR', ...Array(32).fill('HAM05_DELTA'), ...Array(14).fill('HAM06_DELTA')],
    '256_12_26x5_19x6_D': ['HAM12_ANCHOR', ...Array(26).fill('HAM05_DELTA'), ...Array(19).fill('HAM06_DELTA')],
    '256_12_20x5_24x6_D': ['HAM12_ANCHOR', ...Array(20).fill('HAM05_DELTA'), ...Array(24).fill('HAM06_DELTA')],
    '256_12_14x5_29x6_D': ['HAM12_ANCHOR', ...Array(14).fill('HAM05_DELTA'), ...Array(29).fill('HAM06_DELTA')],
    '256_12_8x5_34x6_D': ['HAM12_ANCHOR', ...Array(8).fill('HAM05_DELTA'), ...Array(34).fill('HAM06_DELTA')],
    '256_12_2x5_39x6_D': ['HAM12_ANCHOR', ...Array(2).fill('HAM05_DELTA'), ...Array(39).fill('HAM06_DELTA')],
    '256_12_42x5_5x6_4_D': ['HAM12_ANCHOR', ...Array(42).fill('HAM05_DELTA'), ...Array(5).fill('HAM06_DELTA'), 'HAM04_DELTA'],
    '256_12_46x5_6_8_D': ['HAM12_ANCHOR', ...Array(46).fill('HAM05_DELTA'), 'HAM06_DELTA', 'HAM08_DELTA'],
    '256_12_8_44x5_2x8_D': ['HAM12_ANCHOR', 'HAM08_DELTA', ...Array(44).fill('HAM05_DELTA'), 'HAM08_DELTA', 'HAM08_DELTA'],
    '256_12_2x8_42x5_3x6_D': ['HAM12_ANCHOR', 'HAM08_DELTA', 'HAM08_DELTA', ...Array(42).fill('HAM05_DELTA'), ...Array(3).fill('HAM06_DELTA')],
    '256_12_8_40x5_6x6_D': ['HAM12_ANCHOR', 'HAM08_DELTA', ...Array(40).fill('HAM05_DELTA'), ...Array(6).fill('HAM06_DELTA')],
    '256_12_2x8_36x5_8x6_D': ['HAM12_ANCHOR', 'HAM08_DELTA', 'HAM08_DELTA', ...Array(36).fill('HAM05_DELTA'), ...Array(8).fill('HAM06_DELTA')],
    '256_12_3x8_32x5_10x6_D': ['HAM12_ANCHOR', ...Array(3).fill('HAM08_DELTA'), ...Array(32).fill('HAM05_DELTA'), ...Array(10).fill('HAM06_DELTA')],
    '256_12_4_48x5_rev_D': ['HAM12_ANCHOR', 'HAM04_DELTA', ...Array(48).fill('HAM05_DELTA')],
    '256_12_inter_5_4_D': ['HAM12_ANCHOR', ...Array(10).fill(['HAM05_DELTA', 'HAM05_DELTA', 'HAM05_DELTA', 'HAM05_DELTA', 'HAM04_DELTA']).flat(), 'HAM04_DELTA'],

    // --- 32-Bit-Referenzen (inkl. schwächerer Modi für Vergleiche) ---
    '32_12_44444_D': HAM_CONFIGS.HAM_32BIT_12_44444_DELTA.sequence,
    '32_12_4646_D': HAM_CONFIGS.HAM_32BIT_12_4646_DELTA.sequence,
    '32_12_5555_D': HAM_CONFIGS.HAM_32BIT_12_5555_DELTA.sequence,
    '32_12_686_D': HAM_CONFIGS.HAM_32BIT_12_686_DELTA.sequence,
    '32_12_866_D': HAM_CONFIGS.HAM_32BIT_12_866_DELTA.sequence,
};

const bitsOf = (f) => HAM_CONFIGS[f]?.bits ?? 0;

function loadBgra(filePath) {
    const bgra = fs.readFileSync(filePath);
    const w = 320;
    const h = Math.floor(bgra.length / 4 / w);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = bgra[i * 4 + 2];
        rgba[i * 4 + 1] = bgra[i * 4 + 1];
        rgba[i * 4 + 2] = bgra[i * 4];
        rgba[i * 4 + 3] = 255;
    }
    return { rgba, w, h };
}

const cliFiles = process.argv.slice(2);
const celleFiles = fs.existsSync('testbilder/celle')
    ? fs.readdirSync('testbilder/celle').filter((f) => f.endsWith('.bgra')).map((f) => path.join('testbilder/celle', f))
    : [];
const defaultFiles = ['testbilder/real-128.bgra', 'testbilder/real-256.bgra', ...celleFiles].filter((f) => fs.existsSync(f));
const files = cliFiles.length > 0 ? cliFiles : defaultFiles;

for (const filePath of files) {
    const { rgba, w, h } = loadBgra(filePath);
    console.log(`\n=== Bild: ${path.basename(filePath)} (${w}x${h}) ===`);
    console.log(
        'Kandidat'.padEnd(22),
        'Bits'.padStart(5),
        'Px/Seq'.padStart(7),
        'Bit/Px'.padStart(7),
        'PSNR (dB)'.padStart(10),
        'MSE'.padStart(9),
        'Roundtrip'
    );
    console.log('-'.repeat(74));

    for (const [name, seq] of Object.entries(candidates)) {
        const seqBits = seq.reduce((s, f) => s + bitsOf(f), 0);
        const bpp = seqBits / seq.length;
        HAM_CONFIGS.__TEST = { isPaletted: true, isMixed: true, slotsPerBank: 0, sequence: seq };

        const { commands: cmds } = await encodePaletted(rgba, w, h, '__TEST', step, pal, 0);
        const packed = packPaletted(cmds, '__TEST');
        const unpacked = unpackPaletted(packed, '__TEST', w * h);
        const dec = decodePaletted(unpacked, w, h, step, pal, 0);

        let mse = 0;
        for (let i = 0; i < w * h; i++) {
            const dr = rgba[i * 4] - dec[i * 4];
            const dg = rgba[i * 4 + 1] - dec[i * 4 + 1];
            const db = rgba[i * 4 + 2] - dec[i * 4 + 2];
            mse += (dr * dr + dg * dg + db * db) / 3;
        }
        mse /= w * h;
        const psnr = 10 * Math.log10((255 * 255) / mse);

        console.log(
            name.padEnd(22),
            String(seqBits).padStart(5),
            String(seq.length).padStart(7),
            bpp.toFixed(2).padStart(7),
            psnr.toFixed(2).padStart(10),
            mse.toFixed(1).padStart(9),
            'OK'
        );
    }
}
