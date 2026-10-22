# HAM06 — Format-Spezifikation (Version 3 des `.ham`-Containers)

Zweck: Diese Datei beschreibt das Format so vollständig, dass daraus **ohne Zugriff
auf den Quellcode** ein Decoder gebaut werden kann. Alle Angaben sind aus der
Referenzimplementierung abgeleitet:

- `src/core/module_paletted.js` → `encodePaletted`, `decodePaletted`, `packPaletted`,
  `unpackPaletted`, `getCmdVal`, `CHANNEL_DEFS`, `buildFormatDeltaCache`
- `src/codecs/configs.js` → `HAM_CONFIGS`
- `src/modes/ham_builder.js` → Speichern (`btnSave`), `src/main.js` → Laden (`fileBin`)

---

## 0. WICHTIGSTE VORAB-KLÄRUNG: das ist NICHT Amiga-HAM6

Amiga-HAM6 ist 6 Bitplanes mit **2 Steuerbits + 4 Indexbits** (16 Grundfarben).
**Dieses** `HAM06` ist etwas anderes: 6 Bit pro Pixel, aufgeteilt in
**1 Anker-Bit + 5 Indexbits** (32 Palettenplätze) bzw. bei Deltas
**1 Turbo-Bit + 4 Richtungsbits**.

Wer „HAM06" liest und Amiga-Wissen anwendet, baut den falschen Decoder.

Zweitens: **HAM06 existiert in dieser Codebasis nur als Sub-Format.** Es gibt keinen
eigenständigen HAM06-Container. HAM06 tritt als *Phase* innerhalb der gemischten
32-Bit-Formate auf (siehe §5). Die Format-Auswahl der Anwendung bietet ausschließlich
gemischte Formate sowie HAM12/HAM16/DXT1 an — ein reines HAM06 wird nie gepackt
(`packPaletted` würde bei einem Format ohne `sequence` abstürzen). Ein Decoder
dekodiert also **einen gemischten 32-Bit-Strom**, und HAM06 ist eine seiner Phasen.

---

## 1. Dateiformat `.ham` (Container, Version 3)

Alle Mehrbyte-Felder des **Kopfes** sind Little-Endian (das Flag in Byte 5 sagt es;
in der Referenz ist es immer 0 = LE). **Die Pixelwörter danach sind immer
Big-Endian** — das Flag gilt *nicht* für sie (siehe §2).

| Offset | Größe | Inhalt |
|---|---|---|
| 0 | 4 | Magic: ASCII `HAM!` = Bytes `72, 65, 77, 33` |
| 4 | 1 | Version = **3** |
| 5 | 1 | Endianness-Flag: `0` = Little-Endian (Referenz schreibt immer 0) |
| 6 | 2 | Breite in Pixeln, uint16 |
| 8 | 2 | Höhe in Pixeln, uint16 |
| 10 | 1 | Länge `fLen` des Formatnamens in Bytes |
| 11 | `fLen` | Formatname, UTF-8, z. B. `HAM_32BIT_63436343` |
| 11+fLen | 3 | Schrittweite: `step.r`, `step.g`, `step.b` (je uint8) |
| 14+fLen | 1 | Paletten-Offset `offset` (uint8, 0–255) |
| 15+fLen | 768 | Palette: 256 Einträge × (R,G,B) |
| 783+fLen | Rest | Gepackte Pixelwörter (§2). Länge = `ceil(W*H / pixelsPerWord) * 4` |

Hinweise:
- Der Referenz-Loader **prüft Magic und Version nicht** und setzt nach dem Laden
  `Palette[0] = (0,0,0)`. Ein Decoder sollte Magic/Version prüfen.
- `step` und `offset` stehen in der Datei — ohne sie ist die Datei nicht dekodierbar.
  (Der Encoder schreibt die zum Encode-Zeitpunkt gültigen Werte.)
- Die Palette wird als 256 Tripel gespeichert, obwohl je nach Format nur die ersten
  `slotsPerBank` Einträge erreichbar sind.

---

## 2. Pixelstrom: Wortaufbau und Phasenzuordnung

- Ein **Wort** ist 32 Bit = 4 Byte, im Byte-Strom **Big-Endian** (`Byte0 = MSB`).
- Ein Wort enthält `pixelsPerWord` Pixel. `pixelsPerWord = sequence.length` des
  Formats (4 bis 8; siehe §5).
- Die Bits werden **von oben nach unten** gefüllt: das erste Pixel des Wortes belegt
  die höchsten Bits. Innerhalb eines Pixelcodes ist das **höchstwertige Bit zuerst**.
- Die Bitbreite je Position im Wort ist durch das Sub-Format an dieser Position
  festgelegt (Tabelle §4). Die Breiten einer Sequenz summieren sich **immer auf 32**.
- Das letzte Wort darf teilweise gefüllt sein, wenn `W*H` kein Vielfaches von
  `pixelsPerWord` ist; die **niedrigen Restbits bleiben 0**.
- Die Phase eines Pixels ist `sequence[pxIndex % sequence.length]`, wobei `pxIndex`
  der **absolute Pixelindex im 1-D-Strom** ist (`pxIndex = y*W + x`), **nicht** `x`.
  Bei Bildbreiten, die kein Vielfaches der Sequenzlänge sind, verschiebt sich die
  Phasenfolge daher von Zeile zu Zeile.

---

## 3. Decoder-Semantik pro Pixel

Der Decoder hält einen **Akkumulator** `(r,g,b)` — die zuletzt ausgegebene Farbe:

1. Initialisierung **einmal vor dem ganzen Bild**: `(r,g,b) = (127,127,127)`.
   **Kein Rücksetzen am Zeilenanfang** — der Akkumulator läuft durchgehend über alle
   Pixel des 1-D-Stroms.
2. Für jedes Pixel `i` von 0 bis `W*H-1`:
   - Sub-Format `fmt = sequence[i % sequence.length]`
   - Code `v` aus dem Bitstrom lesen, `bits(fmt)` Bits (§4)
   - **Anker** (falls das Anker-Bit gesetzt ist):
     `(r,g,b) = Palette[(offset + anchorIdx) mod 256]`
   - **Delta** (sonst):
     `r = clamp(r + D[fmt].r[rIndex], 0, 255)`, analog g und b, mit
     `D[fmt].c[k] = CHANNEL_DEFS[fmt].c[k] * step.c * (isTurbo ? 4 : 1)`
   - Ausgabe: `(r, g, b, 255)` als RGBA, Alpha immer **255**.

`anchorIdx` ist der **relative** Slot innerhalb der Phase (0 … slotsPerBank-1);
der absolute Palettenplatz ist `(offset + anchorIdx) mod 256`. Eine Phase kann nur
die Plätze `0 … slotsPerBank-1` ihrer Bank erreichen.

---

## 4. Sub-Formate: Bitbreiten und Bit-Layouts

`bits(fmt)` ist die Breite des Codes *dieser* Phase im Wort.

| Format | bits | Slots (`slotsPerBank`) | Turbo | Kanal-Deltas (Index → Wert) |
|---|---|---|---|---|
| HAM01 | 1 | 0 | nein | r,g,b gekoppelt: `[-2, 2]` |
| HAM02 | 2 | 0 | nein | r,b gekoppelt `[-2,2]`; g `[-2,2]` |
| HAM03 | 3 | 4 | nein | r,b gekoppelt `[-2,2]`; g `[-2,2]` |
| HAM04 | 4 | 8 | nein | r `[-2,2]`, g `[-2,2]`, b `[-2,2]` (frei) |
| HAM05 | 5 | 16 | **ja** | r `[-1,1]`, g `[-1,1]`, b `[-1,1]` |
| **HAM06** | **6** | **32** | **ja** | r `[-1,1]`, **g `[-2,-1,1,2]`**, b `[-1,1]` |
| HAM08 | 8 | 128 | **ja** | r,g,b je `[-2,-1,1,2]` |

„Turbo" verdoppelt nichts, sondern **vervierfacht** die Schrittweite
(Multiplikator `m = 4` statt `1`). `slotsPerBank = 0` bedeutet: dieses Format hat
**keine** Anker (es gibt nur Deltas); das Anker-Bit existiert dann nicht.

### Bit-Layouts (Bit 0 = niederstwertigstes Bit des Codes)

**HAM06** (das Kernstück):
```
Anker:  Bit5 = 1                        → anchorIdx = v & 31      (v = 32 … 63)
Delta:  Bit5 = 0
        Bit4 = Turbo (0/1)
        Bit3 = rIndex  (1 Bit)
        Bit2..1 = gIndex (2 Bit)
        Bit0 = bIndex  (1 Bit)
```
Deltawerte: `r = ±1 * step.r * m`, `g ∈ {-2,-1,+1,+2}[gIndex] * step.g * m`,
`b = ±1 * step.b * m`, mit `m = Turbo ? 4 : 1`.
Anker-Codes: `32 | anchorIdx`; Delta-Codes: `0 … 31`.

**HAM05:**
```
Anker: Bit4 = 1 → anchorIdx = v & 15      Delta: Bit4=0
       Bit3 = Turbo, Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex   (je 1 Bit)
```

**HAM04:**
```
Anker: Bit3 = 1 → anchorIdx = v & 7       Delta: Bit3=0
       Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex
```

**HAM03:**
```
Anker: Bit2 = 1 → anchorIdx = v & 3       Delta: Bit2=0
       Bit1 = rIndex, Bit0 = gIndex, bIndex = rIndex   ← b ist an r GEKOPPELT
```

**HAM02** (keine Anker):
```
Bit1 = rIndex, Bit0 = gIndex, bIndex = rIndex
```

**HAM01** (keine Anker):
```
Bit0 = Index für alle drei Kanäle (r = g = b, reine Helligkeitsänderung)
```

**HAM08:**
```
Anker: Bit7 = 1 → anchorIdx = v & 127     Delta: Bit7=0
       Bit6 = Turbo, Bit5..4 = rIndex, Bit3..2 = gIndex, Bit1..0 = bIndex (je 2 Bit)
```

---

## 5. Gemischte 32-Bit-Formate (wo HAM06 tatsächlich vorkommt)

`sequence` ist die Phasenfolge; sie wiederholt sich alle `sequence.length` Pixel.
Die Bitbreiten der Sequenz summieren sich immer auf 32 (ein Wort).

| Formatname | Slots/Bank | Sequenz | Breiten |
|---|---|---|---|
| `HAM_32BIT_44444444` | 8 | HAM04 ×8 | 4×8 = 32 |
| `HAM_32BIT_53535353` | 16 | HAM05,HAM03 ×4 | 5,3 … = 32 |
| **`HAM_32BIT_63436343`** | **32** | **HAM06,HAM03,HAM04,HAM03 ×2** | **6,3,4,3,6,3,4,3 = 32** |
| `HAM_32BIT_6446444` | 32 | HAM06,HAM04,HAM04,HAM06,HAM04,HAM04,HAM04 | 6,4,4,6,4,4,4 = 32 |
| `HAM_32BIT_5454545` | 16 | HAM05,HAM04,HAM05,HAM04,HAM05,HAM04,HAM05 | 5,4,5,4,5,4,5 = 32 |
| `HAM_32BIT_6454544` | 32 | HAM06,HAM04,HAM05,HAM04,HAM05,HAM04,HAM04 | 6,4,5,4,5,4,4 = 32 |
| `HAM_32BIT_655655` | 32 | HAM06,HAM05,HAM05,HAM06,HAM05,HAM05 | 6,5,5,6,5,5 = 32 |
| `HAM_32BIT_844844` | 127 | HAM08,HAM04,HAM04,HAM08,HAM04,HAM04 | 8,4,4,8,4,4 = 32 |
| `HAM_32BIT_846554` | 127 | HAM08,HAM04,HAM06,HAM05,HAM05,HAM04 | 8,4,6,5,5,4 = 32 |
| `HAM_32BIT_646565` | 32 | HAM06,HAM04,HAM06,HAM05,HAM06,HAM05 | 6,4,6,5,6,5 = 32 |
| `HAM_32BIT_86666` | 128 | HAM08,HAM06,HAM06,HAM06,HAM06 | 8,6,6,6,6 = 32 |
| `HAM_32BIT_85865` | 128 | HAM08,HAM05,HAM08,HAM06,HAM05 | 8,5,8,6,5 = 32 |
| `HAM_32BIT_8888` | 128 | HAM08 ×4 | 8×4 = 32 |

Für `HAM_32BIT_63436343` gilt konkret:
- Phase 0, 4 → **HAM06** (6 Bit, 32 Slots, Turbo)
- Phase 1, 3, 5, 7 → HAM03 (3 Bit, 4 Slots, kein Turbo)
- Phase 2, 6 → HAM04 (4 Bit, 8 Slots, kein Turbo)
- Gepackte Größe: **4 Bit pro Pixel** = `W*H/2` Byte (plus Kopf).

„Schwache" Phasen (HAM03 mit 4 Plätzen, HAM04 mit 8) können nur wenige Palettenfarben
anspringen; HAM06 kann alle 32. Das ist der Grund, warum die Anwendung Kanten auf
HAM06-Phasen verschiebt.

---

## 6. Referenz-Decoder (abhängigkeitsfreies JavaScript)

```js
// Bitbreiten je Sub-Format
const BITS = { HAM01:1, HAM02:2, HAM03:3, HAM04:4, HAM05:5, HAM06:6, HAM08:8 };
const SLOTS = { HAM01:0, HAM02:0, HAM03:4, HAM04:8, HAM05:16, HAM06:32, HAM08:128 };
const TURBO = { HAM01:false, HAM02:false, HAM03:false, HAM04:false, HAM05:true, HAM06:true, HAM08:true };

// Kanal-Deltas als Vielfache der Schrittweite (Index → Kanalwert)
const CH = {
  HAM01: { r:[-2,2],              g:[-2,2],              b:[-2,2] },
  HAM02: { r:[-2,2],              g:[-2,2],              b:[-2,2] },
  HAM03: { r:[-2,2],              g:[-2,2],              b:[-2,2] },
  HAM04: { r:[-2,2],              g:[-2,2],              b:[-2,2] },
  HAM05: { r:[-1,1],              g:[-1,1],              b:[-1,1] },
  HAM06: { r:[-1,1],              g:[-2,-1,1,2],         b:[-1,1] },
  HAM08: { r:[-2,-1,1,2],         g:[-2,-1,1,2],         b:[-2,-1,1,2] }
};

const clamp = (v) => v < 0 ? 0 : (v > 255 ? 255 : v);

// Ein Code -> Kommando {anchor|delta}
function parseCode(v, fmt) {
  const slots = SLOTS[fmt];
  if (slots > 0) {
    const anchorBit = slots;           // 4,8,16,32 bzw. 128 = genau das Anker-Bit
    if (v & anchorBit) return { anchor: true, idx: v & (slots - 1) };
  }
  switch (fmt) {
    case 'HAM01': return { anchor:false, turbo:false, r:v&1, g:v&1, b:v&1 };
    case 'HAM02': { const rb=(v>>1)&1; return { anchor:false, turbo:false, r:rb, g:v&1, b:rb }; }
    case 'HAM03': { const rb=(v>>1)&1; return { anchor:false, turbo:false, r:rb, g:v&1, b:rb }; }
    case 'HAM04': return { anchor:false, turbo:false, r:(v>>2)&1, g:(v>>1)&1, b:v&1 };
    case 'HAM05': return { anchor:false, turbo:!!((v>>3)&1), r:(v>>2)&1, g:(v>>1)&1, b:v&1 };
    case 'HAM06': return { anchor:false, turbo:!!((v>>4)&1), r:(v>>3)&1, g:(v>>1)&3, b:v&1 };
    case 'HAM08': return { anchor:false, turbo:!!((v>>6)&1), r:(v>>4)&3, g:(v>>2)&3, b:v&3 };
  }
  return { anchor:true, idx:0 };
}

// Ganze Datei dekodieren -> Uint8ClampedArray RGBA
function decodeHam(bytes) {
  const u8 = new Uint8Array(bytes);
  const dv = new DataView(bytes);
  if (!(u8[0]===72 && u8[1]===65 && u8[2]===77 && u8[3]===33)) throw new Error('kein HAM!-Magic');
  if (u8[4] !== 3) throw new Error('unbekannte Version ' + u8[4]);
  const le = u8[5] === 0;
  const W = dv.getUint16(6, le), H = dv.getUint16(8, le);
  const fLen = u8[10];
  let p = 11;
  const format = new TextDecoder().decode(u8.slice(p, p + fLen)); p += fLen;
  const step = { r: u8[p++], g: u8[p++], b: u8[p++] };
  const offset = u8[p++];
  const palette = u8.slice(p, p + 768); p += 768;
  const packed = u8.slice(p);

  const seq = FORMATS[format];                 // siehe §5
  const ppw = seq.length;
  const out = new Uint8ClampedArray(W * H * 4);

  let r = 127, g = 127, b = 127;
  let px = 0, wi = 0;
  const total = W * H;
  while (px < total) {
    // 32-Bit-Wort, BIG-Endian
    const w32 = ((packed[wi]<<24) | (packed[wi+1]<<16) | (packed[wi+2]<<8) | packed[wi+3]) >>> 0;
    wi += 4;
    let shift = 32;
    for (let j = 0; j < ppw && px < total; j++, px++) {
      const fmt = seq[j];
      const bits = BITS[fmt];
      shift -= bits;
      const v = (w32 >>> shift) & ((1 << bits) - 1);
      const cmd = parseCode(v, fmt);
      if (cmd.anchor) {
        const a = ((offset + cmd.idx) % 256) * 3;
        r = palette[a]; g = palette[a+1]; b = palette[a+2];
      } else {
        const m = (cmd.turbo && TURBO[fmt]) ? 4 : 1;
        r = clamp(r + CH[fmt].r[cmd.r] * step.r * m);
        g = clamp(g + CH[fmt].g[cmd.g] * step.g * m);
        b = clamp(b + CH[fmt].b[cmd.b] * step.b * m);
      }
      const o = px * 4;
      out[o] = r; out[o+1] = g; out[o+2] = b; out[o+3] = 255;
    }
  }
  return { width: W, height: H, format, step, offset, palette, rgba: out };
}
```

`FORMATS` ist die Tabelle aus §5 (Sequenz je Formatname). Achtung: der Anker-Test
`v & slots` funktioniert, weil `slots` (4/8/16/32/128) genau das jeweilige Anker-Bit
ist; für Formate **ohne** Slots (HAM01/02) gibt es kein Anker-Bit.

---

## 7. Handgerechneter Testvektor (bitte im Decoder nachrechnen)

Bewusst klein und vollständig von Hand aus der Spezifikation gerechnet — **nicht**
maschinell erzeugt (siehe §8).

- Format `HAM_32BIT_63436343`, `W = 8`, `H = 1`, `step = (4,4,4)`, `offset = 0`
- Palette: Slot 0 = (0,0,0), Slot 1 = (255,0,0), Rest hier irrelevant

Codes je Phase (Sequenz HAM06, HAM03, HAM04, HAM03, HAM06, HAM03, HAM04, HAM03):

| Phase | Format | Code `v` | Bedeutung | Akkumulator danach |
|---|---|---|---|---|
| 0 | HAM06 | 33 | Anker (32\|1) → Slot 1 | (255, 0, 0) |
| 1 | HAM03 | 0 | r=g=b Index 0 = −2 → −8 | (247, 0, 0) |
| 2 | HAM04 | 7 | r=g=b Index 1 = +2 → +8 | (255, 8, 8) |
| 3 | HAM03 | 3 | r=g=b Index 1 = +2 → +8 | (255, 16, 16) |
| 4 | HAM06 | 16 | Turbo, Index 0 → r −16, g −32, b −16 | (239, 0, 0) |
| 5 | HAM03 | 0 | −8 | (231, 0, 0) |
| 6 | HAM04 | 0 | −8 | (223, 0, 0) |
| 7 | HAM03 | 0 | −8 | (215, 0, 0) |

Bitstrom MSB-first, Breiten 6,3,4,3,6,3,4,3:
`100001 000 0111 011 010000 000 0000 000`
= `1000 0100 0011 1011 0100 0000 0000 0000` = **0x843B4000**
→ Bytes im Container: `0x84, 0x3B, 0x40, 0x00`

Erwartete Ausgabe (RGBA):
`(255,0,0) (247,0,0) (255,8,8) (255,16,16) (239,0,0) (231,0,0) (223,0,0) (215,0,0)`

Prüfpunkte: Klemmung auf 0…255 (Phase 3: 263 → 255; Phase 4: −16 → 0),
Turbo ×4 statt ×2 (Phase 4), R/B-Kopplung in HAM03 (Phase 1, 3, 5, 7) und die
Tatsache, dass HAM06-Grün **vier** Stufen hat (`[-2,-1,1,2]`).

---

## 8. Was verifiziert ist — und was nicht

**Aus dem Quellcode gelesen und hier exakt wiedergegeben:** Container-Kopf (Writer
`btnSave`, Loader `fileBin`), Wortaufbau und Bitfolge (`packPaletted`/`unpackPaletted`),
alle Bit-Layouts (`getCmdVal`, `parseVal`), Kanal-Deltas (`CHANNEL_DEFS`), Turbo als
Faktor 4 (`buildFormatDeltaCache`), Akkumulator-Start (127,127,127), durchgehender
Akkumulator ohne Zeilenreset, Alpha 255 (`decodePaletted`), Phasenzuordnung über den
absoluten Pixelindex (`phaseFormatAt`).

**Nicht verifiziert:**
- Der Testvektor in §7 ist **von Hand** gerechnet. Ein Probelauf war nicht möglich,
  weil in der Arbeitsumgebung die Shell blockiert war. Er sollte gegen die echte
  Implementierung geprüft werden.
- Ob `step`/`offset` beim Speichern immer den Werten entsprechen, mit denen encodiert
  wurde, hängt von der Anwendung ab; die Datei trägt sie mit, ein Decoder muss ihnen
  vertrauen.
- Die Anwendung schreibt in Byte 5 immer 0. Ob eine Variante mit Big-Endian-Kopf
  existiert, ist nicht belegt; ein Decoder sollte das Flag trotzdem auswerten.
- `HAM12`/`HAM16`/`DXT1` sind **andere** Container-Inhalte (eigene Module) und hier
  nicht beschrieben.

**Empfohlener Abnahmetest:** Round-Trip mit der Referenz: Bild → `encodePaletted` →
`packPaletted` → Datei schreiben → mit dem eigenen Decoder lesen → Pixelvergleich
gegen `decodePaletted`. Zusätzlich der Testvektor aus §7.
