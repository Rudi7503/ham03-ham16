# Referenzsatz 640×256

Erzeugt mit `make_ref_640.mjs`. Geprüft mit `test_ref_640.mjs`.

## Herkunft

- **Encoder:** Code ab Commit `48890d1` (unverändert bis HEAD).
- **Quellbild:** dieselbe 1120×1120-JPEG wie beim 320×256-Satz
  (sha256 `3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f`).
- **Skalierung:** `resizeImage` (Lanczos) mit **unabhängigen Faktoren je Achse**:
  x = 640/1120 = 0,5714, y = 256/1120 = 0,2286. Das ganze Bild wird auf 640×256
  abgebildet — **kein Beschnitt, keine Ränder**, dafür anisotrop (Seitenverhältnis
  verändert). `input_640x256.rgb` ist das tatsächliche Encoder-Eingabebild
  (491520 Byte, sha256 `4c1368dfaf4e7ac92609d5635fb17e4cfa38b37815f96c2c1dabe5b2d9aca882`).
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
| HAM03 | `04c0526b00553717ed3955f55c83733a913e3840f62c71282015be0335f07e41` | `748761455366b190832f4eadc111093fe07b7c251851becba3133f1afa158aa3` | `881290b62da8aada578b38cd9fe0f864e85ffd361effd3cb86405592d0afaf37` | identisch | byte-exakt |
| HAM04 | `eca49a707eaf95824661bd0379fcddc0aab14570742cfdaa0ada6f1643e3b6b4` | `b522aac883b0400d776b2330ff85b1c77514c24496e2dfcf80ceab9bd9456a85` | `792096de06dc2c106ff626049278b2c9d63a430b91b0df78e87dbbe4efdee6e8` | identisch | byte-exakt |
| HAM05 | `0a72bda99e8d369b53f790960c1aacfdb840fd0f5003c4b7e80261539fdc0e5f` | `1eae79523b816e6b3371fe184b64576e9bd0f117a455091dceae1321755fa4d6` | `f6f773d14f4b270e32c45ffab4f2733c1dffe1bf9e662f44165f8f76d6655d89` | identisch | byte-exakt |
| HAM06 | `4b24b0e9fd6a1c9aaa8d2e0017549db626da0835c6bfb6718f39341d784f94c2` | `5302abdbd2ac3aa438a1d271cc77acc5c95852be461a0d493aabe23706208e1d` | `9761a437bd8410983fb026980fac8c667bf4b377ea6358c99e3f6f2bb51f3edc` | identisch | byte-exakt |
| HAM08 | `cb968bc0357b871e8b38e7054a713a28e4e6db6e155bdd2adae44f5fd22576cf` | `101bc7f7db3be05e3c781e7e38c4c2ca852da568ea43c9c1b1c40a0106e6b37b` | `e526fe316aa6bdbb6f174d73257c1382bf76ae4fe798a711cc2d38c928909607` | identisch | byte-exakt |

## Testbench-Dateien

In `mem/`: `hamXX_payload.mem` (32-Bit-Wörter, 8 Hexziffern, Byte0 in Bits 31:24),
`hamXX_expected.mem` (24 Bit RRGGBB je Pixel, y=0 zuerst), `hamXX_palette.mem`
(256 Zeilen RRGGBB). Erzeugt mit `make_ref_mem.mjs testbilder/ref640`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest ist nicht erfolgt.
