# Referenzvektoren der fünf HAM-Dateien

Erzeugt mit `make_ref_vectors.mjs` aus den echten `.ham`-Dateien. Geprüft mit
`test_ref_vectors.mjs`.

## Herkunft

- **Encoder:** Code ab Commit `48890d1` (dort wurden die reinen Formate wählbar und
  das Versionsbyte auf 4 gesetzt). Die formatrelevanten Dateien
  `src/core/module_paletted.js` und `src/core/palette_optimizer.js` sind seit
  `48890d1` bis `HEAD` unverändert (0 Commits laut `git log 48890d1..HEAD`).
- **Quellbild:** `Leonardo_Phoenix_10_A_young_adult_with_a_mix_of_frustration_an_0.jpg`,
  1120×1120, sha256 `3e3bf8d601dde2fb7dcef1c985fb0e97b413bead961b52456af83bf7dc11647f`
- **Skalierung:** `resizeInto(..., lanczos, fill)` → 320×256, seitenverhältnistreu,
  Überstand mittig beschnitten. Ergebnis: `input_320x256.rgb` (245 760 Byte,
  sha256 `938f7c1b900aaa026179167e01004f0990586c6f4e281202b519b47b2c5edabc`).
- **Schrittweite:** 4/4/4 · **Offset:** 0 · Strategie `greedy` · Metrik `yuv_weight`

### Reproduktionsbeweis

Jede Datei wurde aus `input_320x256.rgb` nachgerechnet — mit der Palette, der
Schrittweite und dem Offset **aus der Datei selbst** — und die Nutzlast byteweise
verglichen (`make_ref_vectors.mjs` führt diesen Test bei jedem Lauf aus):

| Datei | abweichende Bytes | Ergebnis |
|---|---|---|
| `ham03.ham` | 0 von 30720 | **byte-exakt reproduziert** |
| `ham04.ham` | 0 von 40960 | **byte-exakt reproduziert** |
| `ham05.ham` | 0 von 51200 | **byte-exakt reproduziert** |
| `ham06.ham` | 0 von 61440 | **byte-exakt reproduziert** |
| `ham08.ham` | 0 von 81920 | **byte-exakt reproduziert** |

Alle fünf Dateien sind damit aus **einem** Eingabebild und **einem** Encoderstand
herleitbar. `ham03`, `ham06` und `ham08` stammen aus dem ersten Satz, `ham04` und
`ham05` wurden am 2026-10-23 neu erzeugt, weil ihre Vorgänger nicht reproduzierbar
waren (die Skalierung lief dort noch über `canvas.drawImage`, gestreckt und
browserabhängig).

## Kopfdaten

| Modus | Datei | Bytes | Nutzlast | Breite×Höhe | step | offset | Palette[0..5] |
|---|---|---|---|---|---|---|---|
| HAM03 | `ham03.ham` | 31508 | 30720 | 320×256 | 4/4/4 | 0 | 0, 0, 0, 183, 188, 179, 109, 96, 92, 115, 32, 25, 86, 84, 76, 157, 62, 48 |
| HAM04 | `ham04.ham` | 41748 | 40960 | 320×256 | 4/4/4 | 0 | 0, 0, 0, 89, 78, 72, 188, 182, 173, 218, 213, 212, 46, 45, 40, 127, 33, 20 |
| HAM05 | `ham05.ham` | 51988 | 51200 | 320×256 | 4/4/4 | 0 | 0, 0, 0, 71, 63, 54, 83, 80, 72, 119, 119, 112, 194, 191, 185, 54, 51, 44 |
| HAM06 | `ham06.ham` | 62228 | 61440 | 320×256 | 4/4/4 | 0 | 0, 0, 0, 65, 57, 47, 71, 63, 52, 75, 67, 56, 81, 75, 65, 215, 216, 213 |
| HAM08 | `ham08.ham` | 82708 | 81920 | 320×256 | 4/4/4 | 0 | 0, 0, 0, 70, 62, 51, 66, 58, 48, 64, 56, 46, 68, 60, 49, 226, 226, 224 |

Alle Dateien: Magic `HAM!`, Version 4, Kopf 20 Byte (11 + 5 Zeichen Formatname +
3 Byte Schrittweite + 1 Byte Offset), 768 Byte Palette, Nutzlast Big-Endian,
Modusbit **0 = Anker, 1 = Delta**.

## Vektoren

Auszug aus `vectors.json`. Jeder Eintrag nennt Pixelindex, Code als Binärfolge
(MSB-first, Breite = Bits des Modus), Akkumulator vorher/nachher und den
erwarteten RGB-Wert. `vectors.json` enthält zusätzlich `ungeklemmt`, `delta`
und `turboFaktor`.

### HAM03 — `ham03.ham`

Anker 11673, Deltas 70247, Turbo 0; Klemmung auf 0: 686×, auf 255: 52×.

**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 0 | 0,0 | 011 | (127, 127, 127) | (115, 32, 25) | (115, 32, 25) |
| 1 | 1,0 | 100 | (115, 32, 25) | (107, 24, 17) | (107, 24, 17) |
| 2 | 2,0 | 101 | (107, 24, 17) | (99, 32, 9) | (99, 32, 9) |
| 3 | 3,0 | 101 | (99, 32, 9) | (91, 40, 1) | (91, 40, 1) |
| 4 | 4,0 | 100 | (91, 40, 1) | (83, 32, 0) | (83, 32, 0) |
| 5 | 5,0 | 101 | (83, 32, 0) | (75, 40, 0) | (75, 40, 0) |
| 6 | 6,0 | 101 | (75, 40, 0) | (67, 48, 0) | (67, 48, 0) |
| 7 | 7,0 | 100 | (67, 48, 0) | (59, 40, 0) | (59, 40, 0) |

**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 318 | 318,0 | 110 | (45, 48, 28) | (53, 40, 36) | (53, 40, 36) |
| 319 | 319,0 | 100 | (53, 40, 36) | (45, 32, 28) | (45, 32, 28) |
| 320 | 0,1 | 111 | (45, 32, 28) | (53, 40, 36) | (53, 40, 36) |
| 321 | 1,1 | 101 | (53, 40, 36) | (45, 48, 28) | (45, 48, 28) |
| 322 | 2,1 | 110 | (45, 48, 28) | (53, 40, 36) | (53, 40, 36) |

**Klemmung unten** (ein Kanal würde negativ):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 3 | 3,0 | 101 | (99, 32, 9) | (91, 40, 1) | (91, 40, 1) |
| 4 | 4,0 | 100 | (91, 40, 1) | (83, 32, 0) | (83, 32, 0) |
| 5 | 5,0 | 101 | (83, 32, 0) | (75, 40, 0) | (75, 40, 0) |

**Klemmung oben** (ein Kanal würde über 255 gehen):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 10516 | 276,32 | 111 | (239, 244, 235) | (247, 252, 243) | (247, 252, 243) |
| 10517 | 277,32 | 101 | (247, 252, 243) | (239, 255, 235) | (239, 255, 235) |
| 10518 | 278,32 | 110 | (239, 255, 235) | (247, 247, 243) | (247, 247, 243) |

### HAM04 — `ham04.ham`

Anker 21279, Deltas 60641, Turbo 0; Klemmung auf 0: 132×, auf 255: 65×.

**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 0 | 0,0 | 0100 | (127, 127, 127) | (46, 45, 40) | (46, 45, 40) |
| 1 | 1,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 2 | 2,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 3 | 3,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 4 | 4,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 5 | 5,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 6 | 6,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 7 | 7,0 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |

**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 318 | 318,0 | 1100 | (46, 45, 40) | (54, 37, 32) | (54, 37, 32) |
| 319 | 319,0 | 1010 | (54, 37, 32) | (46, 45, 24) | (46, 45, 24) |
| 320 | 0,1 | 0100 | (46, 45, 24) | (46, 45, 40) | (46, 45, 40) |
| 321 | 1,1 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |
| 322 | 2,1 | 0100 | (46, 45, 40) | (46, 45, 40) | (46, 45, 40) |

**Klemmung unten** (ein Kanal würde negativ):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 6802 | 82,21 | 1100 | (8, 8, 8) | (16, 0, 0) | (16, 0, 0) |
| 6803 | 83,21 | 1010 | (16, 0, 0) | (8, 8, 0) | (8, 8, 0) |
| 6804 | 84,21 | 1100 | (8, 8, 0) | (16, 0, 0) | (16, 0, 0) |

**Klemmung oben** (ein Kanal würde über 255 gehen):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 9893 | 293,30 | 1111 | (242, 237, 236) | (250, 245, 244) | (250, 245, 244) |
| 9894 | 294,30 | 1111 | (250, 245, 244) | (255, 253, 252) | (255, 253, 252) |
| 9895 | 295,30 | 0010 | (255, 253, 252) | (188, 182, 173) | (188, 182, 173) |

### HAM05 — `ham05.ham`

Anker 18020, Deltas 63900, Turbo 5299; Klemmung auf 0: 109×, auf 255: 46×.

**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 0 | 0,0 | 00101 | (127, 127, 127) | (54, 51, 44) | (54, 51, 44) |
| 1 | 1,0 | 10000 | (54, 51, 44) | (50, 47, 40) | (50, 47, 40) |
| 2 | 2,0 | 10000 | (50, 47, 40) | (46, 43, 36) | (46, 43, 36) |
| 3 | 3,0 | 10010 | (46, 43, 36) | (42, 47, 32) | (42, 47, 32) |
| 4 | 4,0 | 10101 | (42, 47, 32) | (46, 43, 36) | (46, 43, 36) |
| 5 | 5,0 | 10101 | (46, 43, 36) | (50, 39, 40) | (50, 39, 40) |
| 6 | 6,0 | 10010 | (50, 39, 40) | (46, 43, 36) | (46, 43, 36) |
| 7 | 7,0 | 10010 | (46, 43, 36) | (42, 47, 32) | (42, 47, 32) |

**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 318 | 318,0 | 10010 | (50, 39, 32) | (46, 43, 28) | (46, 43, 28) |
| 319 | 319,0 | 10101 | (46, 43, 28) | (50, 39, 32) | (50, 39, 32) |
| 320 | 0,1 | 10011 | (50, 39, 32) | (46, 43, 36) | (46, 43, 36) |
| 321 | 1,1 | 10101 | (46, 43, 36) | (50, 39, 40) | (50, 39, 40) |
| 322 | 2,1 | 10010 | (50, 39, 40) | (46, 43, 36) | (46, 43, 36) |

**Turbo** (erster Turbo-Delta mit Umgebung):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 209 | 209,0 | 00111 | (108, 98, 91) | (96, 94, 87) | (96, 94, 87) |
| 210 | 210,0 | 00100 | (96, 94, 87) | (194, 191, 185) | (194, 191, 185) |
| 211 | 211,0 | 11110 | (194, 191, 185) | (210, 207, 169) | (210, 207, 169) |
| 212 | 212,0 | 11100 | (210, 207, 169) | (226, 191, 153) | (226, 191, 153) |
| 213 | 213,0 | 11000 | (226, 191, 153) | (210, 175, 137) | (210, 175, 137) |

**Klemmung unten** (ein Kanal würde negativ):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 5839 | 79,18 | 11000 | (32, 30, 28) | (16, 14, 12) | (16, 14, 12) |
| 5840 | 80,18 | 11110 | (16, 14, 12) | (32, 30, 0) | (32, 30, 0) |
| 5841 | 81,18 | 01000 | (32, 30, 0) | (32, 30, 28) | (32, 30, 28) |

**Klemmung oben** (ein Kanal würde über 255 gehen):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 1173 | 213,3 | 11100 | (226, 191, 153) | (242, 175, 137) | (242, 175, 137) |
| 1174 | 214,3 | 11110 | (242, 175, 137) | (255, 191, 121) | (255, 191, 121) |
| 1175 | 215,3 | 01001 | (255, 191, 121) | (157, 140, 131) | (157, 140, 131) |

### HAM06 — `ham06.ham`

Anker 33460, Deltas 48460, Turbo 4195; Klemmung auf 0: 114×, auf 255: 60×.

**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 0 | 0,0 | 001011 | (127, 127, 127) | (50, 47, 42) | (50, 47, 42) |
| 1 | 1,0 | 100010 | (50, 47, 42) | (46, 43, 38) | (46, 43, 38) |
| 2 | 2,0 | 101010 | (46, 43, 38) | (50, 39, 34) | (50, 39, 34) |
| 3 | 3,0 | 100101 | (50, 39, 34) | (46, 43, 38) | (46, 43, 38) |
| 4 | 4,0 | 100100 | (46, 43, 38) | (42, 47, 34) | (42, 47, 34) |
| 5 | 5,0 | 101011 | (42, 47, 34) | (46, 43, 38) | (46, 43, 38) |
| 6 | 6,0 | 100100 | (46, 43, 38) | (42, 47, 34) | (42, 47, 34) |
| 7 | 7,0 | 101011 | (42, 47, 34) | (46, 43, 38) | (46, 43, 38) |

**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 318 | 318,0 | 101011 | (45, 45, 27) | (49, 41, 31) | (49, 41, 31) |
| 319 | 319,0 | 100011 | (49, 41, 31) | (45, 37, 35) | (45, 37, 35) |
| 320 | 0,1 | 101101 | (45, 37, 35) | (49, 41, 39) | (49, 41, 39) |
| 321 | 1,1 | 100100 | (49, 41, 39) | (45, 45, 35) | (45, 45, 35) |
| 322 | 2,1 | 101011 | (45, 45, 35) | (49, 41, 39) | (49, 41, 39) |

**Turbo** (erster Turbo-Delta mit Umgebung):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 209 | 209,0 | 010000 | (110, 98, 97) | (93, 91, 82) | (93, 91, 82) |
| 210 | 210,0 | 011111 | (93, 91, 82) | (226, 186, 113) | (226, 186, 113) |
| 211 | 211,0 | 111110 | (226, 186, 113) | (242, 218, 97) | (242, 218, 97) |
| 212 | 212,0 | 110000 | (242, 218, 97) | (226, 186, 81) | (226, 186, 81) |
| 213 | 213,0 | 111000 | (226, 186, 81) | (242, 154, 65) | (242, 154, 65) |

**Klemmung unten** (ein Kanal würde negativ):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 6160 | 80,19 | 101100 | (18, 11, 14) | (22, 15, 10) | (22, 15, 10) |
| 6161 | 81,19 | 111100 | (22, 15, 10) | (38, 31, 0) | (38, 31, 0) |
| 6162 | 82,19 | 101101 | (38, 31, 0) | (42, 35, 4) | (42, 35, 4) |

**Klemmung oben** (ein Kanal würde über 255 gehen):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 1811 | 211,5 | 111010 | (226, 186, 113) | (242, 170, 97) | (242, 170, 97) |
| 1812 | 212,5 | 111111 | (242, 170, 97) | (255, 202, 113) | (255, 202, 113) |
| 1813 | 213,5 | 100000 | (255, 202, 113) | (251, 194, 109) | (251, 194, 109) |

### HAM08 — `ham08.ham`

Anker 66236, Deltas 15684, Turbo 2875; Klemmung auf 0: 120×, auf 255: 47×.

**Frame-Start** (Pixel 0–7, Akkumulator startet bei 127,127,127):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 0 | 0,0 | 01011000 | (127, 127, 127) | (42, 44, 42) | (42, 44, 42) |
| 1 | 1,0 | 10100101 | (42, 44, 42) | (46, 40, 38) | (46, 40, 38) |
| 2 | 2,0 | 10011001 | (46, 40, 38) | (42, 44, 34) | (42, 44, 34) |
| 3 | 3,0 | 10100100 | (42, 44, 34) | (46, 40, 38) | (46, 40, 38) |
| 4 | 4,0 | 10011001 | (46, 40, 38) | (42, 44, 34) | (42, 44, 34) |
| 5 | 5,0 | 10100100 | (42, 44, 34) | (46, 40, 38) | (46, 40, 38) |
| 6 | 6,0 | 10011001 | (46, 40, 38) | (42, 44, 34) | (42, 44, 34) |
| 7 | 7,0 | 10100100 | (42, 44, 34) | (46, 40, 38) | (46, 40, 38) |

**Zeilenübergang** (Pixel 318–322 — 319 ist der letzte Pixel von Zeile 0, 320 der erste von Zeile 1):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 318 | 318,0 | 10010100 | (51, 41, 32) | (47, 37, 36) | (47, 37, 36) |
| 319 | 319,0 | 10011000 | (47, 37, 36) | (43, 41, 28) | (43, 41, 28) |
| 320 | 0,1 | 01011000 | (43, 41, 28) | (42, 44, 42) | (42, 44, 42) |
| 321 | 1,1 | 10100101 | (42, 44, 42) | (46, 40, 38) | (46, 40, 38) |
| 322 | 2,1 | 10011001 | (46, 40, 38) | (42, 44, 34) | (42, 44, 34) |

**Turbo** (erster Turbo-Delta mit Umgebung):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 209 | 209,0 | 01001001 | (107, 103, 93) | (97, 91, 80) | (97, 91, 80) |
| 210 | 210,0 | 01111100 | (97, 91, 80) | (228, 179, 98) | (228, 179, 98) |
| 211 | 211,0 | 11111100 | (228, 179, 98) | (255, 211, 114) | (255, 211, 114) |
| 212 | 212,0 | 11000000 | (255, 211, 114) | (223, 179, 82) | (223, 179, 82) |
| 213 | 213,0 | 11010100 | (223, 179, 82) | (207, 163, 50) | (207, 163, 50) |

**Klemmung unten** (ein Kanal würde negativ):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 6799 | 79,21 | 01001101 | (138, 97, 78) | (44, 33, 25) | (44, 33, 25) |
| 6800 | 80,21 | 11010100 | (44, 33, 25) | (28, 17, 0) | (28, 17, 0) |
| 6801 | 81,21 | 10000000 | (28, 17, 0) | (20, 9, 4) | (20, 9, 4) |

**Klemmung oben** (ein Kanal würde über 255 gehen):

| px | x,y | Code (binär) | Akku vorher | Akku nachher | RGB |
|---|---|---|---|---|---|
| 210 | 210,0 | 01111100 | (97, 91, 80) | (228, 179, 98) | (228, 179, 98) |
| 211 | 211,0 | 11111100 | (228, 179, 98) | (255, 211, 114) | (255, 211, 114) |
| 212 | 212,0 | 11000000 | (255, 211, 114) | (223, 179, 82) | (223, 179, 82) |

## Dateien in diesem Verzeichnis

| Datei | Inhalt |
|---|---|
| `ham03.ham` … `ham08.ham` | die fünf Originaldateien |
| `ham03_decoded.rgb` … `ham08_decoded.rgb` | **RGB-Rohdaten** des Dekodierlaufs, je 245 760 Byte: 3 Byte je Pixel, zeilenweise oben→unten, links→rechts, ohne Kopf |
| `input_320x256.rgb` | das bewiesene 320×256-Eingabebild (gleiches Layout) |
| `vectors.json` | Kopfdaten, Hashes und alle Vektoren maschinenlesbar |

## Prüfen

```
node make_ref_vectors.mjs     # erzeugt Rasterdaten, vectors.json und diese Datei neu
node test_ref_vectors.mjs     # prüft Hashes, Rohdaten und alle Sollwerte
```

## Was diese Vektoren belegen

- **Kein Zeilenreset:** bei HAM03, HAM04, HAM05 und HAM06 beginnt Pixel 320
  (erste Spalte von Zeile 1) **ohne Anker** — der Akkumulator läuft über die
  Zeilengrenze weiter. Bei HAM08 steht dort ein Anker, weil der Encoder dort fast
  jedes Pixel über die Palette setzt (80,9 % Anker).
- **Sättigung statt Modulo:** siehe die Klemmungstabellen; `ungeklemmt` steht in
  `vectors.json`. Beispiel HAM06 Pixel 1812: ungeklemmt (258, 202, 113) → (255, 202, 113).
  Modulo-256 würde (2, 202, 113) ergeben.
- **Turbo = Faktor 4**, nicht 2: `turboFaktor` ist in jeder Turbo-Zeile angegeben.
