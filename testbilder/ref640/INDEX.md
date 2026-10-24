# Referenzsatz 640×256

Erzeugt mit `make_ref_640.mjs`. Geprüft mit `test_ref_640.mjs`.

## Herkunft

- **Encoder:** Code ab Commit `48890d1` (unverändert bis HEAD).
- **Quellbild:** dieselbe 1120×1120-JPEG wie beim 320×256-Satz
  (sha256 `3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f`).
- **Skalierung:** `resizeInto(..., lanczos, fill)` → inneres Bild 640×640,
  Ausschnitt bei Offset (0, -192) → **640×256**.
  Das Zielformat ist 2,5:1; aus einem quadratischen Bild bleibt deshalb nur der
  mittlere Ausschnitt. `input_640x256.rgb` ist das tatsächliche Encoder-Eingabebild
  (491520 Byte, sha256 `a56641b2c43055cf9ed780b5879938d159b6736ca3a2c85e932e1e07871f584d`).
- **Paletten:** unverändert aus dem 320×256-Satz übernommen (`../ham0X.ham`), also
  **nicht** auf 640×256 optimiert — so vorgegeben, um die Auflösung isoliert zu
  vergleichen.
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
| HAM03 | `42bad22d4c5e6e47df5e38a32a8cc5d955ae2851ff9430f280ec71280779735c` | `dee174d462af759e839572e6fa921700c03f9047f3810971371ec66e18cc9392` | `881290b62da8aada578b38cd9fe0f864e85ffd361effd3cb86405592d0afaf37` | identisch | byte-exakt |
| HAM04 | `2e6943c9c5b04d93e921aaebb580c6a5cb0997a643460ad212af9ca36cf9be29` | `13b8bc3a8a8eb8a1bfc3af0d25dc1f2db721832ff40bb9c45c4074e5cd6e687b` | `792096de06dc2c106ff626049278b2c9d63a430b91b0df78e87dbbe4efdee6e8` | identisch | byte-exakt |
| HAM05 | `1b098af77c1589ce607e208239ab8c8c4033316c04c14df77a5ae2864f362815` | `fc38186801c3d66d60912cff0619aa87efddc44fba03e0854416f3fde05378d6` | `f6f773d14f4b270e32c45ffab4f2733c1dffe1bf9e662f44165f8f76d6655d89` | identisch | byte-exakt |
| HAM06 | `aa4409bc235244e0c9963768848f9a2e8c79bf2d7a61c11e297ec6a040c4073e` | `88c5730d8083e5d1284602b483bf23c2d4f4ebc1946d5e8d04e810a56fc1b188` | `9761a437bd8410983fb026980fac8c667bf4b377ea6358c99e3f6f2bb51f3edc` | identisch | byte-exakt |
| HAM08 | `c31162d6bf158be9d27173f873c228ba6a6ce956e9d98f95847b9a9c3c09c4d6` | `a2d652bb300e04747806fa58e9ddea2159941aa592f34a32238fb047110e62c1` | `e526fe316aa6bdbb6f174d73257c1382bf76ae4fe798a711cc2d38c928909607` | identisch | byte-exakt |

## Testbench-Dateien

In `mem/`: `hamXX_payload.mem` (32-Bit-Wörter, 8 Hexziffern, Byte0 in Bits 31:24),
`hamXX_expected.mem` (24 Bit RRGGBB je Pixel, y=0 zuerst), `hamXX_palette.mem`
(256 Zeilen RRGGBB). Erzeugt mit `make_ref_mem.mjs testbilder/ref640`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest ist nicht erfolgt.
