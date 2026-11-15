# Referenzsatz 320×256 für die 256-Bit-Delta-Formate

Erzeugt mit `make_ref_256bit.mjs`. Eingabebild und Größe sind identisch mit
`testbilder/ref/`, damit man die Formate direkt vergleichen kann.

## Besonderheit dieser Formate

Jeder Block beginnt mit einem **HAM12**: 12 Bit Direktfarbe (3 Bit Rot,
4 Bit Grün, 3 Bit Blau, 1 gemeinsames Bit) — also **kein Palettenplatz**. Der
Rest des Blocks sind reine Deltas. Folge: **diese Formate brauchen keine
Palette**, die 768 Palettenbytes im Container sind alle 0. Eine
Palettenoptimierung hätte hier keine Wirkung (gemessen: leere und bunte Palette
ergeben byte-identische Nutzlast).

## Qualität und Kosten (auf diesem Bild gemessen)

| Format | Bit/Pixel | Blocklänge | Anker | MSE (yuv_weight) |
|---|---|---|---|---|
| HAM_256BIT_12_61x4_DELTA | 4.13 | 62 | 1322 | 387,25 |
| HAM_256BIT_12_14x5_29x6_DELTA | 5.82 | 44 | 1862 | 28,71 |

Zum Vergleich: `HAM_32BIT_63436343` (4,00 Bit/Pixel) erreicht auf demselben Bild
mit **leerer** Palette MSE 452,58 — seine Anker sind Palettenplätze, die hier
fehlen. Die Direktfarbanker machen diese Formate unabhängig von der Palette.

**Formatregel, die ein Decoder prüfen kann:** Ein Anker steht genau dann, wenn
`pixelIndex % Blocklänge === 0`. Abweichungen: HAM_256BIT_12_61x4_DELTA 0, HAM_256BIT_12_14x5_29x6_DELTA 0.

## Dateien

| Format | `.ham` | Bytes | Nutzlast | Wörter |
|---|---|---|---|---|
| HAM_256BIT_12_61x4_DELTA | `ham_256bit_12_61x4_delta.ham` | 43091 | 42284 | 10571 |
| HAM_256BIT_12_14x5_29x6_DELTA | `ham_256bit_12_14x5_29x6_delta.ham` | 60392 | 59580 | 14895 |

## Prüfsummen

| Format | sha256 `.ham` | sha256 Raster | sha256 Palette |
|---|---|---|---|
| HAM_256BIT_12_61x4_DELTA | `a5c60afbea3018468fc34459ac2b92af4f2786b1f465013574aff3dc663733e4` | `c9cfc9408432ebd15809181e48a926f08e32d25a08a040e6f2f0dd93970751fa` | `ef115a0e0c15cdc41958ca46b5b14b456115f4baec5e3ca68599d2a8f435e3b8` |
| HAM_256BIT_12_14x5_29x6_DELTA | `d4bf8f1d3893af6d6a1efa356e37e8ec370f0f53e3dbab672c474d5a7d631a6c` | `f00401210f6c28ab1dd217f349b0dff5f28884c347cea674f0368a9738ed4f26` | `ef115a0e0c15cdc41958ca46b5b14b456115f4baec5e3ca68599d2a8f435e3b8` |

## Testbench-Dateien

In `mem/`: Nutzlast als 32-Bit-Wörter (8 Hexziffern, Byte0 in Bits 31:24),
Sollpixel als 24 Bit RRGGBB je Pixel, Palette als 256 Zeilen — hier durchgehend
`000000`, weil das Format keine Palette benutzt. Erzeugt mit
`make_ref_mem.mjs testbilder/ref256bit`, geprüft mit
`test_ref_mem.mjs testbilder/ref256bit`.

## Stand

Reine Software-Referenz. FPGA-Build und Hardwaretest stehen aus.
