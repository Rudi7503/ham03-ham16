# HAM06 — Format-Spezifikation (Version 4 des `.ham`-Containers)

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
**1 Modusbit + 5 Indexbits** (32 Palettenplätze) bzw. bei Deltas
**1 Turbo-Bit + 4 Richtungsbits**.

Wer „HAM06" liest und Amiga-Wissen anwendet, baut den falschen Decoder.

Zweitens: **HAM06 kommt in zwei Rollen vor.** Einmal als *Phase* innerhalb der
gemischten 32-Bit-Formate (siehe §5), einmal als **reines Format** mit dem
Formatnamen `HAM06`, bei dem jeder Bildpunkt dieselben 6 Bit bekommt. Beide
Rollen liegen im selben Container und werden allein durch den Formatnamen im
Kopf unterschieden. Ein Decoder muss daher beide beherrschen; §2 (Bitstrom) und
§6 (Decoder) decken beide ab. Reine Formate gibt es für HAM03, HAM04, HAM05,
HAM06 und HAM08.

---

## 1. Dateiformat `.ham` (Container, Version 4)

> **Version 4 ≠ Version 3.** Ab Version 4 gilt: **Modusbit `0` = Anker,
> `1` = Delta** (bis Version 3 war es umgekehrt). Die Bedeutung der Bits hat sich
> damit geändert, nicht nur die Verpackung — eine Datei mit Version 3 dekodiert
> unter dieser Spezifikation **falsch** (Anker und Deltas wären vertauscht).
> Das Programm schreibt Version 4 und weist ältere Dateien beim Laden ab, statt
> sie still falsch zu dekodieren.

Alle Mehrbyte-Felder des **Kopfes** sind Little-Endian (das Flag in Byte 5 sagt es;
in der Referenz ist es immer 0 = LE). **Die Pixelwörter danach sind immer
Big-Endian** — das Flag gilt *nicht* für sie (siehe §2).

| Offset | Größe | Inhalt |
|---|---|---|
| 0 | 4 | Magic: ASCII `HAM!` = Bytes `72, 65, 77, 33` |
| 4 | 1 | Version = **4** |
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
- Die Referenz prüft beim Laden **nur die Version** (alles außer 4 wird mit Meldung
  abgewiesen) und setzt nach dem Laden `Palette[0] = (0,0,0)`. Ein Decoder sollte
  zusätzlich das Magic prüfen.
- `step` und `offset` stehen in der Datei — ohne sie ist die Datei nicht dekodierbar.
  (Der Encoder schreibt die zum Encode-Zeitpunkt gültigen Werte.)
- Die Palette wird als 256 Tripel gespeichert, obwohl je nach Format nur die ersten
  `slotsPerBank` Einträge erreichbar sind.

---

## 2. Pixelstrom: Bitstrom und Phasenzuordnung

Der Pixelstrom ist ein **kontinuierlicher Bitstrom**, der in 32-Bit-Wörtern
(Big-Endian) abgelegt wird:

- Ein **Wort** ist 32 Bit = 4 Byte, im Byte-Strom **Big-Endian** (`Byte0 = MSB`).
- Jedes Pixel schreibt `bits(fmt)` Bits, **höchstwertiges Bit zuerst** (Tabelle §4).
  Es gibt keine Auffüll-Lücken zwischen den Pixeln: der Strom läuft durch.
- Das **letzte** Wort wird mit Nullen auf 4 Byte aufgefüllt. Die Dateigröße ist
  daher immer ein Vielfaches von 4 Byte.
- Bei **gemischten** Formaten ist `fmt` das Sub-Format an dieser Position
  (`sequence[pxIndex % sequence.length]`, siehe §5); die Breiten einer Sequenz
  summieren sich **immer auf 32**, sodass jedes Sequenz-Vielfache genau ein Wort
  füllt.
- Bei **reinen** Formaten (HAM03 … HAM08, Formatname ohne `sequence`) gilt für
  **jedes** Pixel dasselbe Sub-Format. Beispiele: HAM06 mit 6 Bit → 16 Pixel je
  3 Wörter (96 Bit); HAM08 mit 8 Bit → 4 Pixel je Wort; HAM03 mit 3 Bit →
  32 Pixel je 3 Wörter.
- Die Phase eines Pixels ist `sequence[pxIndex % sequence.length]`, wobei `pxIndex`
  der **absolute Pixelindex im 1-D-Strom** ist (`pxIndex = y*W + x`), **nicht** `x`.
  Bei Bildbreiten, die kein Vielfaches der Sequenzlänge sind, verschiebt sich die
  Phasenfolge daher von Zeile zu Zeile.
- Gepackte Nutzlast: `ceil(W*H * bits_je_pixel / 32) * 4` Byte — bei gemischten
  Formaten mit dem Mittel der Sequenz, bei reinen Formaten mit der festen Breite.

---

## 3. Decoder-Semantik pro Pixel

Der Decoder hält einen **Akkumulator** `(r,g,b)` — die zuletzt ausgegebene Farbe:

1. Initialisierung **einmal vor dem ganzen Bild**: `(r,g,b) = (127,127,127)`.
   **Kein Rücksetzen am Zeilenanfang** — der Akkumulator läuft durchgehend über alle
   Pixel des 1-D-Stroms.
2. Für jedes Pixel `i` von 0 bis `W*H-1`:
   - Sub-Format `fmt = sequence[i % sequence.length]`
   - Code `v` aus dem Bitstrom lesen, `bits(fmt)` Bits (§4)
   - **Anker** (falls das Modusbit `0` ist):
     `(r,g,b) = Palette[(offset + anchorIdx) mod 256]`
   - **Delta** (falls das Modusbit `1` ist):
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
**keine** Anker (es gibt nur Deltas); ein Modusbit existiert dann nicht.

### Bit-Layouts (Bit 0 = niederstwertigstes Bit des Codes)

**Modusbit-Konvention (ab Version 4): `0` = Anker, `1` = Delta.**
Das Modusbit ist jeweils das höchstwertige Bit des Codes. Beim Anker ist die
Nutzlast der Slotindex, beim Delta Turbo- und Richtungsbits. HAM01/HAM02 haben
keine Anker und damit kein Modusbit.

**HAM06** (das Kernstück):
```
Anker:  Bit5 = 0                        → anchorIdx = v & 31      (v = 0 … 31)
Delta:  Bit5 = 1
        Bit4 = Turbo (0/1)
        Bit3 = rIndex  (1 Bit)
        Bit2..1 = gIndex (2 Bit)
        Bit0 = bIndex  (1 Bit)
```
Deltawerte: `r = ±1 * step.r * m`, `g ∈ {-2,-1,+1,+2}[gIndex] * step.g * m`,
`b = ±1 * step.b * m`, mit `m = Turbo ? 4 : 1`.
Anker-Codes: `0 … 31`; Delta-Codes: `32 | payload` = `32 … 63`.

**HAM05:**
```
Anker: Bit4 = 0 → anchorIdx = v & 15      Delta: Bit4 = 1
       Bit3 = Turbo, Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex   (je 1 Bit)
```

**HAM04:**
```
Anker: Bit3 = 0 → anchorIdx = v & 7       Delta: Bit3 = 1
       Bit2 = rIndex, Bit1 = gIndex, Bit0 = bIndex
```

**HAM03:**
```
Anker: Bit2 = 0 → anchorIdx = v & 3       Delta: Bit2 = 1
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
Anker: Bit7 = 0 → anchorIdx = v & 127     Delta: Bit7 = 1
       Bit6 = Turbo, Bit5..4 = rIndex, Bit3..2 = gIndex, Bit1..0 = bIndex (je 2 Bit)
```

**HAM12 / HAM16** (eigene Module, gleiches Prinzip): Das Modusbit ist bei HAM16
Bit15, bei HAM12 Bit11 — ebenfalls `0` = Anker, `1` = Delta.

---

## 5. Formate im Container

### 5a. Gemischte 32-Bit-Formate

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

### 5b. Reine Formate

Hier steht der Formatname direkt für ein Sub-Format, und **jeder** Bildpunkt nutzt es.
Es gibt keine Sequenz und keine Phasenverschiebung über die Zeile.

| Formatname | bits/Pixel | Slots | Turbo | Pixel je 32-Bit-Wort | Nutzlast für `W*H` Pixel |
|---|---|---|---|---|---|
| `HAM03` | 3 | 4 | nein | 32 je 3 Wörter | `ceil(W*H*3/32)*4` Byte |
| `HAM04` | 4 | 8 | nein | 8 | `ceil(W*H*4/32)*4` Byte |
| `HAM05` | 5 | 16 | ja | 32 je 5 Wörter | `ceil(W*H*5/32)*4` Byte |
| `HAM06` | 6 | 32 | ja | 16 je 3 Wörter | `ceil(W*H*6/32)*4` Byte |
| `HAM08` | 8 | 128 | ja | 4 | `W*H` Byte |

Beispiel HAM06, `128*128 = 16384` Pixel: `16384*6/32 = 3072` Wörter = **12288 Byte**
(gegenüber 8192 Byte beim gemischten `HAM_32BIT_63436343`).

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

// Phasenfolge je Formatname (§5) — ohne diese Tabelle ist der Decoder nicht lauffähig
const FORMATS = {
  HAM_32BIT_44444444: ['HAM04','HAM04','HAM04','HAM04','HAM04','HAM04','HAM04','HAM04'],
  HAM_32BIT_53535353: ['HAM05','HAM03','HAM05','HAM03','HAM05','HAM03','HAM05','HAM03'],
  HAM_32BIT_63436343: ['HAM06','HAM03','HAM04','HAM03','HAM06','HAM03','HAM04','HAM03'],
  HAM_32BIT_6446444:  ['HAM06','HAM04','HAM04','HAM06','HAM04','HAM04','HAM04'],
  HAM_32BIT_5454545:  ['HAM05','HAM04','HAM05','HAM04','HAM05','HAM04','HAM05'],
  HAM_32BIT_6454544:  ['HAM06','HAM04','HAM05','HAM04','HAM05','HAM04','HAM04'],
  HAM_32BIT_655655:   ['HAM06','HAM05','HAM05','HAM06','HAM05','HAM05'],
  HAM_32BIT_844844:   ['HAM08','HAM04','HAM04','HAM08','HAM04','HAM04'],
  HAM_32BIT_846554:   ['HAM08','HAM04','HAM06','HAM05','HAM05','HAM04'],
  HAM_32BIT_646565:   ['HAM06','HAM04','HAM06','HAM05','HAM06','HAM05'],
  HAM_32BIT_86666:    ['HAM08','HAM06','HAM06','HAM06','HAM06'],
  HAM_32BIT_85865:    ['HAM08','HAM05','HAM08','HAM06','HAM05'],
  HAM_32BIT_8888:     ['HAM08','HAM08','HAM08','HAM08']
};

const clamp = (v) => v < 0 ? 0 : (v > 255 ? 255 : v);

// Ein Code -> Kommando {anchor|delta}.  Modusbit 0 = Anker, 1 = Delta.
function parseCode(v, fmt) {
  const slots = SLOTS[fmt];
  if (slots > 0) {
    const anchorBit = slots;           // 4,8,16,32 bzw. 128 = genau das Modusbit
    if ((v & anchorBit) === 0) return { anchor: true, idx: v & (slots - 1) };
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
  if (u8[4] !== 4) throw new Error('unbekannte Version ' + u8[4]);
  const le = u8[5] === 0;
  const W = dv.getUint16(6, le), H = dv.getUint16(8, le);
  const fLen = u8[10];
  let p = 11;
  const format = new TextDecoder().decode(u8.slice(p, p + fLen)); p += fLen;
  const step = { r: u8[p++], g: u8[p++], b: u8[p++] };
  const offset = u8[p++];
  const palette = u8.slice(p, p + 768); p += 768;
  const packed = u8.slice(p);

  // Gemischt: Phasenfolge. Rein (kein Eintrag in FORMATS): ein Format für alle Pixel.
  const seq = FORMATS[format] || null;
  const out = new Uint8ClampedArray(W * H * 4);

  let r = 127, g = 127, b = 127;
  let bx = 0, nbits = 0, acc = 0;              // Bitstrom-Leser
  const total = W * H;
  for (let px = 0; px < total; px++) {
    const fmt = seq ? seq[px % seq.length] : format;
    const bits = BITS[fmt];
    while (nbits < bits) {                     // Bytes nachziehen, MSB-first
      acc = (acc << 8) | (packed[bx++] || 0);
      nbits += 8;
    }
    nbits -= bits;
    const v = (acc >> nbits) & ((1 << bits) - 1);
    acc &= (1 << nbits) - 1;

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
  return { width: W, height: H, format, step, offset, palette, rgba: out };
}
```

`FORMATS` ist die Tabelle aus §5 (Sequenz je Formatname) und oben mit abgedruckt,
damit der Code ohne Nachschlagen läuft. Fehlt ein Formatname in `FORMATS`, gilt er
als **reines** Format: dann bekommt jedes Pixel das Format selbst (§2). Der
Anker-Test `(v & slots) === 0` funktioniert, weil `slots` (4/8/16/32/128) genau das
jeweilige Modusbit ist — und das Modusbit ist 0, wenn ein Anker vorliegt. Für
Formate **ohne** Slots (HAM01/02) gibt es kein Modusbit.

---

## 7. Testvektor (maschinell bestätigt)

Klein und vollständig nachvollziehbar. Die Pixelwerte sind aus der Spezifikation
hergeleitet; der Vektor ist inzwischen **maschinell geprüft** (siehe §8).

- Format `HAM_32BIT_63436343`, `W = 8`, `H = 1`, `step = (4,4,4)`, `offset = 0`
- Palette: Slot 0 = (0,0,0), Slot 1 = (255,0,0), Rest hier irrelevant

Codes je Phase (Sequenz HAM06, HAM03, HAM04, HAM03, HAM06, HAM03, HAM04, HAM03).
Modusbit: **0 = Anker**, 1 = Delta:

| Phase | Format | Code `v` | Bedeutung | Akkumulator danach |
|---|---|---|---|---|
| 0 | HAM06 | 1 | Anker (Bit5 = 0) → Slot 1 | (255, 0, 0) |
| 1 | HAM03 | 4 | Delta (Bit2 = 1), r=g=b Index 0 = −2 → −8 | (247, 0, 0) |
| 2 | HAM04 | 15 | Delta (Bit3 = 1), r=g=b Index 1 = +2 → +8 | (255, 8, 8) |
| 3 | HAM03 | 7 | Delta (Bit2 = 1), +8 | (255, 16, 16) |
| 4 | HAM06 | 48 | Delta (Bit5 = 1), Turbo, Index 0 → r −16, g −32, b −16 | (239, 0, 0) |
| 5 | HAM03 | 4 | −8 | (231, 0, 0) |
| 6 | HAM04 | 8 | −8 | (223, 0, 0) |
| 7 | HAM03 | 4 | −8 | (215, 0, 0) |

Bitstrom MSB-first, Breiten 6,3,4,3,6,3,4,3:
`000001 100 1111 111 110000 100 1000 100`
= `0000 0110 0111 1111 1100 0010 0100 0100` = **0x067FC244**
→ Bytes im Container: `0x06, 0x7F, 0xC2, 0x44`

Erwartete Ausgabe (RGBA):
`(255,0,0) (247,0,0) (255,8,8) (255,16,16) (239,0,0) (231,0,0) (223,0,0) (215,0,0)`

Prüfpunkte: Klemmung auf 0…255 (Phase 3: 263 → 255; Phase 4: −16 → 0),
Turbo ×4 statt ×2 (Phase 4), R/B-Kopplung in HAM03 (Phase 1, 3, 5, 7), die
Tatsache, dass HAM06-Grün **vier** Stufen hat (`[-2,-1,1,2]`) und dass der Anker
das Modusbit **nicht** setzt (Phase 0: `v = 1`, nicht `v = 33`).

> Beim Umdrehen des Modusbits am 2026-10-22 hat sich nur die Zuordnung Code →
> Bedeutung geändert, nicht die Bildbedeutung. Deshalb sind die erwarteten Pixel
> identisch geblieben, der Bitstrom aber nicht: vorher `0x843B4000`. Wer diesen
> Vektor in einer alten Fassung der Spezifikation findet, hat Version 3 vor sich.

---

## 8. Was verifiziert ist — und was nicht

**Aus dem Quellcode gelesen und hier exakt wiedergegeben:** Container-Kopf (Writer
`btnSave`, Loader `fileBin`), Wortaufbau und Bitfolge (`packPaletted`/`unpackPaletted`),
alle Bit-Layouts (`getCmdVal`, `parseVal`), Kanal-Deltas (`CHANNEL_DEFS`), Turbo als
Faktor 4 (`buildFormatDeltaCache`), Akkumulator-Start (127,127,127), durchgehender
Akkumulator ohne Zeilenreset, Alpha 255 (`decodePaletted`), Phasenzuordnung über den
absoluten Pixelindex (`phaseFormatAt`).

**Maschinell geprüft (2026-10-22):**
- Der Referenz-Decoder aus §6 ist eine wörtliche Abschrift aus dieser Datei und
  liefert auf einem synthetischen 128×96-Bild für **alle 13 gemischten Formate**
  Pixel für Pixel dasselbe Ergebnis wie `decodePaletted`. Prüfskript:
  `test_spec_decode.mjs`. Er wird zusätzlich **direkt aus dieser Markdown-Datei
  extrahiert** und erneut geprüft (`test_spec_extract.mjs`), damit der abgedruckte
  Code nicht von der Implementierung abweichen kann.
- Die **reinen Formate** sind mit der echten Encode-Kette geprüft
  (`test_pure_e2e.mjs`): HAM03/04/05/06/08 auf einem echten 128×128-Foto, jeweils
  Encode → Packen → Entpacken → Dekodieren ohne eine einzige Pixelabweichung, mit
  den oben angegebenen Nutzlastgrößen, und Smart Target läuft auch ohne Mischraster.
- Der Testvektor aus §7 (`0x067FC244` → die acht angegebenen Pixel) wird
  maschinell nachgerechnet; vorher war er nur von Hand gerechnet.
- Die Modusbit-Konvention ist auf drei Ebenen geprüft (`test_modebit.mjs`):
  rohe Codes im Bitstrom (Anker ⇒ Modusbit 0, Delta ⇒ 1), Befehlsobjekte nach
  `unpackPaletted`, und die dekodierten Pixel. Abgedeckt: 13 gemischte Formate ×
  die Strategien `greedy`/`delta_only`/`anchor_only` (1664 Anker, 832 Deltas)
  sowie HAM12/HAM16. Der Anlass für die Strategien: mit `greedy` allein wählte der
  Encoder auf dem Testbild nur Anker, der Deltapfad blieb ungeprüft.

**Nicht verifiziert:**
- Ob `step`/`offset` beim Speichern immer den Werten entsprechen, mit denen encodiert
  wurde, hängt von der Anwendung ab; die Datei trägt sie mit, ein Decoder muss ihnen
  vertrauen.
- Die Anwendung schreibt in Byte 5 immer 0. Ob eine Variante mit Big-Endian-Kopf
  existiert, ist nicht belegt; ein Decoder sollte das Flag trotzdem auswerten.
- `HAM12`/`HAM16`/`DXT1` sind **andere** Container-Inhalte (eigene Module). Für
  HAM12/HAM16 ist nur das Packen/Entpacken und das Modusbit geprüft, das
  Bildformat selbst ist hier nicht beschrieben.
- Dateien mit Version 3 sind **absichtlich nicht** mehr lesbar; eine
  Abwärtskompatibilität gibt es nicht.

**Empfohlener Abnahmetest:** Round-Trip mit der Referenz: Bild → `encodePaletted` →
`packPaletted` → Datei schreiben → mit dem eigenen Decoder lesen → Pixelvergleich
gegen `decodePaletted`. Zusätzlich der Testvektor aus §7.
