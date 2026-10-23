# HAM-Dateiformat — Spezifikation

**Version 4** · Stand 2026-10-23 · beschreibt die `.ham`-Datei vollständig, sodass ein
Decoder ohne Zugriff auf den Quellcode gebaut werden kann.

Detailtiefe zur Paletten-Familie (Bit-Layouts, Decoder-Referenzcode, Herleitung) steht
zusätzlich in `HAM06-SPEZIFIKATION.md`. Dieses Dokument ist eigenständig: alles, was zum
Dekodieren nötig ist, steht hier.

---

## 0. Geltungsbereich und Abgrenzung

- Die Datei enthält **kein** Amiga-HAM6/HAM8. Die Namen `HAM03` … `HAM08` bezeichnen
  Sub-Formate dieses Projekts mit fester Bitbreite (3/4/5/6/8 Bit), nicht die
  Amiga-Bitplanemodi mit Steuerbits.
- Es gibt **keine** Kompression, keine Prüfsumme und keine Längenangabe der Nutzlast.
- **Version 4 ist nicht abwärtskompatibel zu Version 3**: dort bedeutete das Modusbit
  `1` = Anker, seit Version 4 ist es umgekehrt. Ein Leser muss die Version prüfen und
  ältere Dateien abweisen, statt sie falsch zu dekodieren.

---

## 1. Container-Kopf

Alle Mehrbyte-Felder des Kopfes sind **Little-Endian** (so sagt es das Flag in Byte 5;
die Referenz schreibt immer 0). Die Nutzlast danach ist **nicht** davon betroffen.

| Offset | Größe | Feld | Bedeutung |
|---|---|---|---|
| 0 | 4 | Magic | ASCII `HAM!` = Bytes `72, 65, 77, 33` |
| 4 | 1 | Version | **4** |
| 5 | 1 | Endianness | `0` = Kopffelder Little-Endian |
| 6 | 2 | Breite | uint16, Pixel |
| 8 | 2 | Höhe | uint16, Pixel |
| 10 | 1 | `fLen` | Länge des Formatnamens in Bytes |
| 11 | `fLen` | Formatname | UTF-8, z. B. `HAM_32BIT_63436343` |
| 11+`fLen` | 3 | Schrittweite | `step.r`, `step.g`, `step.b` (je uint8) |
| 14+`fLen` | 1 | Offset | Paletten-Offset 0…255 |
| 15+`fLen` | 768 | Palette | 256 Einträge × (R, G, B) |
| 783+`fLen` | Rest | Nutzlast | Aufbau siehe §2 |

Kopfgröße = `783 + fLen` Byte. Die Gesamtgröße ist `783 + fLen + Nutzlast`.

Hinweise:
- Ein Decoder muss **zuerst den Formatnamen** lesen und dann die passende
  Nutzlast-Familie wählen (§2). Der Name entscheidet, nicht die Palette.
- `Palette[0]` ist im Encoder immer `(0,0,0)`.
- `step` und `offset` werden **nur** von der Paletten-Familie ausgewertet.

---

## 2. Nutzlast-Familien

| Familie | Formatnamen | Aufbau | Größe für `W*H` Pixel |
|---|---|---|---|
| **A · Paletten-Bitstrom** | `HAM_32BIT_*` (13 Varianten), rein `HAM03`,`HAM04`,`HAM05`,`HAM06`,`HAM08` | kontinuierlicher Bitstrom in 32-Bit-Wörtern, §3 | `ceil(W*H * bits_je_pixel / 32) * 4` |
| **B · HAM12/HAM16** | `HAM12`, `HAM16` | ein 16-Bit-Wort je Pixel, §4 | `W*H*2` |
| **C · DXT1** | `DXT1` | 8 Byte je 4×4-Block, §5 | `ceil(W/4)*ceil(H/4)*8` |

Unbekannter Formatname: abbrechen. Ein stilles Weiterlaufen erzeugt Bildmüll.

---

## 3. Familie A — Paletten-Bitstrom

### 3.1 Bitstrom

- Der Strom wird **höchstwertiges Bit zuerst** gefüllt und in **32-Bit-Wörter**
  verpackt, die **Big-Endian** im Byte-Strom stehen.
- Jedes Pixel belegt `bits(fmt)` Bit — ohne Lücken zwischen den Pixeln.
- Das letzte Wort wird mit Nullen auf 4 Byte aufgefüllt; die Nutzlastlänge ist damit
  immer ein Vielfaches von 4.
- `pxIndex` ist der **absolute** Index im 1-D-Strom (`y*W + x`), nicht `x`.

### 3.2 Sub-Format je Pixel

- **Gemischt** (`HAM_32BIT_*`): `fmt = sequence[pxIndex % sequence.length]`
- **Rein** (`HAM03` … `HAM08`): `fmt` ist für alle Pixel der Formatname selbst

### 3.3 Sub-Formate: Breite, Slots, Deltastufen

| Sub-Format | Bits | Slots (`slotsPerBank`) | Turbo | Deltastufen je Kanal |
|---|---|---|---|---|
| HAM01 | 1 | 0 | nein | r=g=b gekoppelt: ±2 |
| HAM02 | 2 | 0 | nein | r,b gekoppelt ±2; g ±2 |
| HAM03 | 3 | 4 | nein | r,b gekoppelt ±2; g ±2 |
| HAM04 | 4 | 8 | nein | r ±2, g ±2, b ±2 (frei) |
| HAM05 | 5 | 16 | ja | r,g,b je ±1 |
| HAM06 | 6 | 32 | ja | r ±1, **g −2/−1/+1/+2**, b ±1 |
| HAM08 | 8 | 128 | ja | r,g,b je −2/−1/+1/+2 |

Deltastufen sind **Vielfache der Schrittweite**: `delta = stufe * step.kanal * (Turbo ? 4 : 1)`.
Turbo vervierfacht also, es verdoppelt nicht. `slotsPerBank = 0` heißt: keine Anker,
kein Modusbit.

### 3.4 Bit-Layouts

Modusbit = höchstwertiges Bit des Codes. **`0` = Anker, `1` = Delta.**

```
HAM06  Anker: Modusbit Bit5 = 0 → anchorIdx = v & 31     (Codes 0…31)
       Delta: Bit5 = 1, Bit4 = Turbo, Bit3 = rIndex,
              Bit2..1 = gIndex (2 Bit), Bit0 = bIndex     (Codes 32…63)

HAM05  Anker: Bit4 = 0 → anchorIdx = v & 15
       Delta: Bit4 = 1, Bit3 = Turbo, Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex

HAM04  Anker: Bit3 = 0 → anchorIdx = v & 7
       Delta: Bit3 = 1, Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex

HAM03  Anker: Bit2 = 0 → anchorIdx = v & 3
       Delta: Bit2 = 1, Bit1 = rIndex, Bit0 = gIndex, bIndex = rIndex (b an r gekoppelt)

HAM02  kein Modusbit: Bit1 = rIndex, Bit0 = gIndex, bIndex = rIndex

HAM01  kein Modusbit: Bit0 = Index für alle drei Kanäle (r = g = b)

HAM08  Anker: Bit7 = 0 → anchorIdx = v & 127
       Delta: Bit7 = 1, Bit6 = Turbo, Bit5..4 = rIndex,
              Bit3..2 = gIndex, Bit1..0 = bIndex (je 2 Bit)
```

### 3.5 Gemischte Formate

`sequence` wiederholt sich ab Pixel 0. Die Breiten einer Sequenz summieren sich immer
auf 32 (genau ein Wort).

| Formatname | Sequenz | Breiten |
|---|---|---|
| `HAM_32BIT_44444444` | HAM04 ×8 | 4×8 = 32 |
| `HAM_32BIT_53535353` | HAM05,HAM03 ×4 | 5,3 … = 32 |
| `HAM_32BIT_63436343` | HAM06,HAM03,HAM04,HAM03 ×2 | 6,3,4,3,6,3,4,3 = 32 |
| `HAM_32BIT_6446444` | HAM06,HAM04,HAM04,HAM06,HAM04,HAM04,HAM04 | 6,4,4,6,4,4,4 = 32 |
| `HAM_32BIT_5454545` | HAM05,HAM04,HAM05,HAM04,HAM05,HAM04,HAM05 | 5,4,5,4,5,4,5 = 32 |
| `HAM_32BIT_6454544` | HAM06,HAM04,HAM05,HAM04,HAM05,HAM04,HAM04 | 6,4,5,4,5,4,4 = 32 |
| `HAM_32BIT_655655` | HAM06,HAM05,HAM05,HAM06,HAM05,HAM05 | 6,5,5,6,5,5 = 32 |
| `HAM_32BIT_844844` | HAM08,HAM04,HAM04,HAM08,HAM04,HAM04 | 8,4,4,8,4,4 = 32 |
| `HAM_32BIT_846554` | HAM08,HAM04,HAM06,HAM05,HAM05,HAM04 | 8,4,6,5,5,4 = 32 |
| `HAM_32BIT_646565` | HAM06,HAM04,HAM06,HAM05,HAM06,HAM05 | 6,4,6,5,6,5 = 32 |
| `HAM_32BIT_86666` | HAM08,HAM06,HAM06,HAM06,HAM06 | 8,6,6,6,6 = 32 |
| `HAM_32BIT_85865` | HAM08,HAM05,HAM08,HAM06,HAM05 | 8,5,8,6,5 = 32 |
| `HAM_32BIT_8888` | HAM08 ×4 | 8×4 = 32 |

Beispiel `HAM_32BIT_63436343`: 4,0 Bit/Pixel → `W*H/2` Byte.

### 3.6 Dekodier-Algorithmus

```
acc = (127, 127, 127)            # einmal, KEIN Rücksetzen pro Zeile
für pxIndex = 0 … W*H-1:
    fmt  = gemischt ? sequence[pxIndex % len] : formatname
    v    = nächste bits(fmt) Bit aus dem Strom (MSB-first)
    mb   = Modusbit von fmt        # 4/8/16/32/128, bei HAM01/02: keins
    wenn mb > 0 und (v & mb) == 0:
        slot = v & (mb - 1)
        acc  = palette[(offset + slot) mod 256] * 3
    sonst:
        m    = turbo ? 4 : 1
        acc.r = clamp(acc.r + stufe_r(index) * step.r * m, 0, 255)
        acc.g = clamp(acc.g + stufe_g(index) * step.g * m, 0, 255)
        acc.b = clamp(acc.b + stufe_b(index) * step.b * m, 0, 255)
    schreibe (acc.r, acc.g, acc.b, 255)
```

---

## 4. Familie B — HAM12 / HAM16

Ein **16-Bit-Wort je Pixel**, Big-Endian (höherwertiges Byte zuerst). Modusbit ist
**Bit15** bei HAM16 und **Bit11** bei HAM12; `0` = Anker, `1` = Delta.

### 4.1 HAM16 (Bit15 = Modusbit)

```
Anker: Bit15 = 0
       Bit14..10 = r5, Bit9..5 = g5, Bit4..0 = b5
       Farbe: r = r5<<3, g = g5<<3, b = b5<<3

Delta: Bit15 = 1, Bit14 = Turbo
       Bit13..10 = dr (4 Bit, vorzeichenbehaftet, −8…7)
       Bit9..5   = dg (5 Bit, vorzeichenbehaftet, −16…15)
       Bit4..0   = db (5 Bit, vorzeichenbehaftet, −16…15)
```

### 4.2 HAM12 (Bit11 = Modusbit)

```
Anker: Bit11 = 0
       Bit10 = b10 (gemeinsames niederes Bit für R und B)
       Bit9..7 = r3, Bit6..3 = g4, Bit2..0 = b3
       Farbe: r = ((r3<<1) | b10) << 4
              g = g4 << 4
              b = ((b3<<1) | b10) << 4

Delta: Bit11 = 1, Bit10 = Turbo
       Bit9..7 = dr (3 Bit, −4…3)
       Bit6..3 = dg (4 Bit, −8…7)
       Bit2..0 = db (3 Bit, −4…3)
```

### 4.3 Dekodier-Algorithmus

Identisch zu §3.6, nur ohne Palette:

```
acc = (127, 127, 127)
für jeden Pixel:
    wenn Anker: acc = Farbe aus den Wortfeldern (siehe 4.1/4.2)
    sonst:      acc.kanal = clamp(acc.kanal + d_kanal * step.kanal * (turbo?4:1), 0, 255)
    schreibe (acc.r, acc.g, acc.b, 255)
```

`step`, `offset` und `palette` aus dem Kopf sind hier **unbenutzt**.

---

## 5. Familie C — DXT1 (BC1)

8 Byte je 4×4-Block, **Little-Endian**, Blöcke zeilenweise von oben links:

| Byte im Block | Inhalt |
|---|---|
| 0–1 | `color0` als RGB565 |
| 2–3 | `color1` als RGB565 |
| 4–7 | 32 Bit Index, 2 Bit je Pixel (Bit 0–1 = Pixel 0 des Blocks) |

RGB565-Expansion: `r = (c>>11)&31`, `g = (c>>5)&63`, `b = c&31`;
nach 8 Bit üblich `(v<<3) | (v>>2)` bzw. `(v<<2) | (v>>4)` für Grün.

```
wenn color0 > color1:  4 Farben  c0, c1, (2*c0+c1)/3, (c0+2*c1)/3
sonst:                 3 Farben  c0, c1, (c0+c1)/2, Index 3 = transparentes Schwarz
```

Der Encoder dieses Projekts füllt Pixel außerhalb des Bildes durch **Randwiederholung**
(`x >= W → W-1`), damit Randblöcke keine Fremdfarben bekommen.

`palette`, `offset` und `step` sind hier unbenutzt. Die Datei enthält **keine**
Befehlskette; nach dem Dekodieren ist sie nicht mehr re-encodierbar wie die anderen
Familien.

---

## 6. Testvektoren

Alle Werte maschinell gegen die Referenz-Implementierung erzeugt und geprüft
(`test_dateiformat.mjs`).

### 6.1 Familie A — `HAM_32BIT_63436343`

`W=8`, `H=1`, `step=(4,4,4)`, `offset=0`, Palette Slot 0 = (0,0,0), Slot 1 = (255,0,0).

Nutzlast: `0x06 0x7F 0xC2 0x44`

| px | Format | Code | Bedeutung | Ergebnis |
|---|---|---|---|---|
| 0 | HAM06 | 1 | Anker Slot 1 | (255, 0, 0) |
| 1 | HAM03 | 4 | Delta, alle −2 → −8 | (247, 0, 0) |
| 2 | HAM04 | 15 | Delta, alle +2 → +8 | (255, 8, 8) |
| 3 | HAM03 | 7 | Delta, alle +2 → +8 | (255, 16, 16) |
| 4 | HAM06 | 48 | Delta Turbo, Index 0 → −16/−32/−16 | (239, 0, 0) |
| 5 | HAM03 | 4 | −8 | (231, 0, 0) |
| 6 | HAM04 | 8 | −8 | (223, 0, 0) |
| 7 | HAM03 | 4 | −8 | (215, 0, 0) |

### 6.2 Familie B — HAM16

`W=3`, `H=1`, `step=(4,4,4)`. Nutzlast (6 Byte): `0x30 0xFF 0xB4 0xFE 0xCF 0x02`
= Wörter `0x30FF`, `0xB4FE`, `0xCF02`.

| px | Wort | Bedeutung | Ergebnis |
|---|---|---|---|
| 0 | `0x30FF` | Anker r5=12, g5=7, b5=31 | (96, 56, 248) |
| 1 | `0xB4FE` | Delta dr=−3, dg=+7, db=−2 | (84, 84, 240) |
| 2 | `0xCF02` | Delta Turbo dr=+3, dg=−8, db=+2 | (132, 0, 255) |

Prüfpunkte: Klemmung (Grün 84−128 → 0, Blau 240+32 → 255) und Turbo ×4.

### 6.3 Familie B — HAM12

`W=3`, `H=1`, `step=(4,4,4)`. Nutzlast: `0x06 0xE3 0x0A 0xBE 0x0D 0xC2`
= Wörter `0x06E3`, `0x0ABE`, `0x0DC2`.

| px | Wort | Bedeutung | Ergebnis |
|---|---|---|---|
| 0 | `0x06E3` | Anker b10=1, r3=5, g4=12, b3=3 | (176, 192, 112) |
| 1 | `0x0ABE` | Delta dr=−3, dg=+7, db=−2 | (164, 220, 104) |
| 2 | `0x0DC2` | Delta Turbo dr=+3, dg=−8, db=+2 | (212, 92, 136) |

### 6.4 Familie C — DXT1

Ein Block `W=4`, `H=4`: linke Hälfte Rot, rechte Hälfte Grün.
Nutzlast (8 Byte): `0x00 0xF8 0xE0 0x07 0x50 0x50 0x50 0x50`

- `color0 = 0xF800` → (255, 0, 0)
- `color1 = 0x07E0` → (0, 255, 0)
- Indizes `0x50505050`: Pixel 0,1 → Index 0 (rot); Pixel 2,3 → Index 1 (grün)

Ergebnis der ersten Zeile: (255,0,0) (255,0,0) (0,255,0) (0,255,0)

### 6.5 Familie A konkret — HAM04 (reines Format)

HAM04 belegt **4 Bit je Pixel**, also 8 Pixel je 32-Bit-Wort → `W*H/2` Byte
(bei nicht durch 8 teilbarer Pixelzahl: `ceil(W*H*4/32)*4`). Modusbit ist **Bit3**;
Turbo gibt es nicht.

| Code | Bedeutung |
|---|---|
| 0–7 | **Anker**, `anchorIdx = v` → `Palette[(offset + v) mod 256]` |
| 8 | Delta r−, g−, b− |
| 9 | Delta r−, g−, b+ |
| 10 | Delta r−, g+, b− |
| 11 | Delta r−, g+, b+ |
| 12 | Delta r+, g−, b− |
| 13 | Delta r+, g−, b+ |
| 14 | Delta r+, g+, b− |
| 15 | Delta r+, g+, b+ |

Deltabits: `1 r g b` (Bit3 = 1, Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex).
Index `1` heißt **+2**, Index `0` heißt **−2**, jeweils × `step.kanal`.
Die drei Kanäle sind **unabhängig** (bei HAM03 wären r und b gekoppelt).

> Achtung: der Code `0` ist ein **Anker** auf Palettenplatz `offset`, kein
> „nichts". Eine Nutzlast aus lauter Nullen ergibt eine Fläche in einer Farbe.

Ein Wort mit den Codes 3, 13, 0, 10, 15, 8, 5, 14:

```
Bit   31..28 27..24 23..20 19..16 15..12 11..8  7..4  3..0
Code     3     13      0     10     15     8     5    14
Bin    0011   1101   0000   1010   1111  1000  0101  1110
```

= `0x3D0AF85E` → Bytes im Container `3D 0A F8 5E` (Big-Endian).

Vollständige Beispieldatei im Repo: **`testbilder/ham04-beispiel.ham`** (792 Byte,
8×1, `step` 4/4/4, `offset` 0). Aufbau:

```
48 41 4D 21              "HAM!"
04                       Version 4
00                       Little-Endian
08 00                    Breite 8
01 00                    Höhe 1
05                       Formatname 5 Byte
48 41 4D 30 34           "HAM04"
04 04 04                 step r/g/b
00                       offset
<768 Byte>               Palette
3D 0A F8 5E              Nutzlast (1 Wort, 8 Pixel)
```

Mit Palette Slot 0 = (0,0,0), Slot 3 = (200,100,50), Slot 5 = (10,20,30) liefert die
Datei diese acht Pixel:

`(200,100,50) (208,92,58) (0,0,0) (0,8,0) (8,16,8) (0,8,0) (10,20,30) (18,28,22)`

Hinweis: reines `HAM04` und `HAM_32BIT_44444444` erzeugen **byte-identische**
Nutzlast (4 Bit/Pixel, dieselbe Wortbelegung); sie unterscheiden sich nur im
Formatnamen.

---

## 7. Prüfliste für Decoder-Implementierungen

Häufige Fehlerquellen, in der Reihenfolge, in der sie auftreten:

1. **Modusbit-Richtung** — `0` = Anker, `1` = Delta (seit Version 4). Umgedreht
   ergibt ein völlig anderes Bild, ohne Fehlermeldung.
2. **Pixelindex statt x** — die Phase hängt am absoluten Index. Wer `x % len` rechnet,
   bekommt ab der zweiten Zeile ein anderes Muster als der Encoder.
3. **Akkumulator zurücksetzen** — er läuft durchgehend über das ganze Bild. Ein Reset
   am Zeilenanfang verschiebt alle Farben.
4. **Startwert** — (127,127,127), nicht (0,0,0).
5. **Klemmung** — jede Deltarechnung auf 0…255 begrenzen, auch nach Turbo.
6. **Turbo ×4**, nicht ×2.
7. **Kopffelder Little-Endian, Nutzlast Big-Endian** — das sind zwei verschiedene
   Endianness in einer Datei.
8. **Anker nur bei `slotsPerBank > 0`** — HAM01/HAM02 haben kein Modusbit; wer dort
   eines annimmt, halbiert den Wertebereich.
9. **Palette nur bei Familie A** — bei HAM12/16 und DXT1 steht sie im Kopf, ist aber
   bedeutungslos.
10. **Letztes Wort** — Nullen auffüllen, nicht als Pixel interpretieren.

---

## 8. Was die Datei nicht enthält

- Keine Längenangabe der Nutzlast (aus `W`, `H` und Formatname berechenbar).
- Keine Prüfsumme, keine Signatur pro Block, keine Kompression.
- Keine Information über die Herkunft (Quellbild, Encoder-Einstellungen außer
  `step`/`offset`, Strategie, Fehlerschwelle).
- Kein Flag für „reines" oder „gemischtes" Format — das ergibt sich aus dem Namen.

---

## 9. Versionshistorie

| Version | Änderung |
|---|---|
| 4 | Modusbit umgedreht: `0` = Anker, `1` = Delta (vorher umgekehrt). Reine Formate HAM03–HAM08 als eigene Container-Formate; Nutzlast als kontinuierlicher Bitstrom statt wortweise je Sequenz. |
| 3 | Modusbit `1` = Anker. Nur gemischte 32-Bit-Formate als Paletten-Nutzlast. Dateien dieser Version sind mit Version 4 **nicht** lesbar. |

---

## 10. Prüfskripte im Projekt

| Skript | Prüft |
|---|---|
| `test_dateiformat.mjs` | alle Testvektoren aus §6 |
| `test_modebit.mjs` | Modusbit auf Bit-, Befehls- und Pixelebene; alle Formate, inkl. reiner |
| `test_pure_e2e.mjs` | reine Formate durch die echte Encode-Kette |
| `test_spec_extract.mjs` | extrahiert den Referenz-Decoder aus `HAM06-SPEZIFIKATION.md` und vergleicht |
