# Referenzsatz 640×256

Erzeugt mit `make_ref_640.mjs`, Paletten nachoptimiert mit `optimize_ref_640.mjs`.
**Diese Datei wird von `update_index_640.mjs` aus den Dateien erzeugt** — alle
Größen und Prüfsummen sind gemessen, nicht eingetragen. \
Geprüft mit `test_ref640_index.mjs` (Vergleich Index ↔ Dateien) und
`test_ref_mem.mjs testbilder/ref640` (Testbench-Dateien).

## Herkunft

- **Encoder:** Code ab Commit `48890d1` (unverändert bis HEAD).
- **Quellbild:** dieselbe 1120×1120-JPEG wie beim 320×256-Satz
  (sha256 `3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f`).
- **Skalierung:** `resizeImage` (Lanczos) mit **unabhängigen Faktoren je Achse**:
  x = 640/1120 = 0,5714, y = 256/1120 = 0,2286. Das ganze Bild wird auf 640×256
  abgebildet — **kein Beschnitt, keine Ränder**, dafür anisotrop. \
  `input_640x256.rgb` = tatsächliches Encoder-Eingabebild (491520 Byte,
  sha256 `4c1368dfaf4e7ac92609d5635fb17e4cfa38b37815f96c2c1dabe5b2d9aca882`).
- **Paletten:** Startpunkt 320×256-Satz, dann `runManualRefinement` (Slot für Slot,
  ausgehend von der vorhandenen Palette, Reihenfolge `usage`) auf 640×256:

  | Modus | vorher | nachher | besser |
  |---|---|---|---|
  | HAM03 | 32,67 | 32,52 | 0,5 % |
  | HAM04 | 14,44 | 14,40 | 0,3 % |
  | HAM05 | 5,13 | 5,10 | 0,6 % |
  | HAM06 | 3,34 | 3,29 | 1,5 % |
  | HAM08 | — | — | nicht nachoptimiert, Palette aus dem 320er Satz |

  Der Hybrid-Optimierer (`runHybridOptimization`) eignet sich dafür **nicht**: er
  führt die vorhandene Palette nicht als Kandidat mit und verschlechterte HAM06 im
  Test von 3,57 auf 5,24.
- **Schrittweite** 4/4/4 · **Offset** 0 · Strategie `greedy` · Metrik `yuv_weight`

## Dateien

| Modus | `.ham` | Bytes | Nutzlast | Wörter | `.rgb` (RGB, 3 Byte/Pixel, oben→unten) |
|---|---|---|---|---|---|
| HAM03 | `ham03.ham` | 62228 | 61440 | 15360 | `ham03_decoded.rgb` |
| HAM04 | `ham04.ham` | 82708 | 81920 | 20480 | `ham04_decoded.rgb` |
| HAM05 | `ham05.ham` | 103188 | 102400 | 25600 | `ham05_decoded.rgb` |
| HAM06 | `ham06.ham` | 123668 | 122880 | 30720 | `ham06_decoded.rgb` |
| HAM08 | `ham08.ham` | 164628 | 163840 | 40960 | `ham08_decoded.rgb` |

## Prüfsummen

| Modus | sha256 `.ham` | sha256 Raster | sha256 Palette | Round-Trip | Reproduktion |
|---|---|---|---|---|---|
| HAM03 | `db081a1de238426acafe37aa93489d9a1fca44467966ae24c039bb2abc369ef9` | `c27962be979ae42f6b65f67c8f797b62c7130035bc762e1f45b8177f9ef19f3f` | `a9f0f2872cfdb508a1262348fde44a8b8cf85fb9ada25cff2b8ee8bb04747335` | identisch | byte-exakt |
| HAM04 | `0a4a4c96d1abf88d55aff2996ca8e78d3db082bc477ff294a052eb2f22f1df9e` | `72e2e411a84e0fe5e9ed0e019d66e41ed727eff2a6a2f0bc999ca9d29e4aab73` | `4a75790fbbe0c55cb511d9db3261dc51e51d57de6d1dd23ba2ccf1f02c65de14` | identisch | byte-exakt |
| HAM05 | `9f288e9bc06d02c00fc350c3ebec02d6073195c78b3c60dee96805086eb33e1c` | `acfb7dde4d27c1a28f472ff0b1eaa37ff9937c21124fd638597d9218f54d2d55` | `1463332a4b357030bfbacf26a7c742a9940f136c356b6f1f5b8c3e0358431e70` | identisch | byte-exakt |
| HAM06 | `9820392aa1de10e6cdee8b9d22163eaf93da94d7513c7412b1572b1a8ae17807` | `e3761dafe2897894d8cd9473b72c56291896a660c72b0d0f9d259d205351556a` | `fa64343bf54b45b932887700c71e8d57196bbcb0e9a9571949745ab3b84d61ae` | identisch | byte-exakt |
| HAM08 | `cb968bc0357b871e8b38e7054a713a28e4e6db6e155bdd2adae44f5fd22576cf` | `101bc7f7db3be05e3c781e7e38c4c2ca852da568ea43c9c1b1c40a0106e6b37b` | `e526fe316aa6bdbb6f174d73257c1382bf76ae4fe798a711cc2d38c928909607` | identisch | byte-exakt |

## Testbench-Dateien

In `mem/`: `hamXX_payload.mem` (32-Bit-Wörter, 8 Hexziffern, Byte0 in Bits 31:24),
`hamXX_expected.mem` (24 Bit RRGGBB je Pixel, y=0 zuerst), `hamXX_palette.mem`
(256 Zeilen RRGGBB). Erzeugt mit `make_ref_mem.mjs testbilder/ref640`, Prüfsummen in
`mem/INDEX.md`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest gegen diese Dateien ist
zum Zeitpunkt dieses Index noch nicht erfolgt.
