# Testbench-Dateien (%h je Zeile, ohne @Adresse)

Erzeugt mit `make_ref_mem.mjs` aus den Referenzdateien in `../`. Geprüft mit
`test_ref_mem.mjs`.

## Formate

| Datei | Inhalt |
|---|---|
| `hamXX_payload.mem` | **32-Bit-Wort je Zeile**, 8 Hexziffern. Das **erste Byte der Datei steht in Bits 31:24** (Big-Endian wie im Container). Die Nutzlast ist bereits auf ein Vielfaches von 4 Byte aufgefüllt, die Nullwörter am Ende gehören zum Strom. |
| `hamXX_expected.mem` | **24-Bit RRGGBB je Zeile**, 6 Hexziffern, ein Pixel je Zeile. Reihenfolge: `y = 0` zuerst, innerhalb der Zeile `x = 0` zuerst (zeilenweise oben→unten, links→rechts). |
| `hamXX_palette.mem` | 256 Zeilen RRGGBB, Palettenplatz 0 zuerst. |

Hexziffern sind groß geschrieben; `$readmemh` akzeptiert beide Schreibweisen.
Für `$readmemh` ohne Adressangabe: `$readmemh("ham06_payload.mem", mem);` füllt
`mem[0]`, `mem[1]`, … in Dateireihenfolge.

## Zuordnung

| Modus | Nutzlast | Wörter | Sollpixel | Pixel | Breite×Höhe | step | offset |
|---|---|---|---|---|---|---|---|
| HAM_256BIT_12_14x5_29x6_DELTA | `ham_256bit_12_14x5_29x6_delta_payload.mem` | 14895 | `ham_256bit_12_14x5_29x6_delta_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |
| HAM_256BIT_12_61x4_DELTA | `ham_256bit_12_61x4_delta_payload.mem` | 10571 | `ham_256bit_12_61x4_delta_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |

## Prüfsummen

| Modus | Quelle `.ham` | sha256 `.ham` | sha256 Nutzlast `.mem` | sha256 Sollpixel `.mem` | sha256 Palette `.mem` |
|---|---|---|---|---|---|
| HAM_256BIT_12_14x5_29x6_DELTA | `ham_256bit_12_14x5_29x6_delta.ham` (60392 B) | `d4bf8f1d3893af6d6a1efa356e37e8ec370f0f53e3dbab672c474d5a7d631a6c` | `51a07465de87f02671514a4b4bee430660d6b87572102c9e8d19f1d8f79e45a0` | `a262c92886559de6ace5814fc3e6b321f38a305ca1ca45bf47c0246ca0eeda9b` | `9b2d7fe5ba9d96ad6feae4a249bb69f53597ab941ffbfb29816df0e93be7aeb2` |
| HAM_256BIT_12_61x4_DELTA | `ham_256bit_12_61x4_delta.ham` (43091 B) | `a5c60afbea3018468fc34459ac2b92af4f2786b1f465013574aff3dc663733e4` | `60018d18de60bf52cc8e4bbf42da881d427baddebd4b47f5e959de84ae68118f` | `1a1de6b0d99fd440d58109aa44acfffd2439b7f2a5e08d40d25bf60beeb02521` | `9b2d7fe5ba9d96ad6feae4a249bb69f53597ab941ffbfb29816df0e93be7aeb2` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM_256BIT_12_14x5_29x6_DELTA | `49122C8B` `22C8B22C` `8B22CE10` `C2C530B1` | `2C42C530` `528F0000` | `302030` `203020` `302030` `203020` | `303428` |
| HAM_256BIT_12_61x4_DELTA | `49162252` `52562525` `25352653` `52651652` | `25365253` `63470000` | `302030` `34242C` `302828` `2C2C24` | `303028` |

## Bezug zum Container

- `.ham`-Kopf: 20 Byte (11 fest + 5 Zeichen Formatname + 3 Byte Schrittweite +
  1 Byte Offset), danach 768 Byte Palette, danach die Nutzlast.
- Die `payload.mem` ist **exakt** der Nutzlastbereich ab Byte 788, nur als
  32-Bit-Wörter gruppiert.
- Palettenbytes im Container sind RGB-Tripel; `palette.mem` gibt dieselben 256
  Einträge als RRGGBB aus. Das Auslesen der Palette aus dem Container ist damit
  gegenprüfbar.
- Formatregeln (Modusbit 0 = Anker, Kanalstufen, Turbo ×4, Sättigung, kein
  Zeilenreset) stehen in `../README.md` und `../../HAM-DATEIFORMAT.md`.

## Stand

Reine Software-Referenz. Ein FPGA-Build oder Hardwaretest gegen diese Dateien ist
noch nicht erfolgt; die Dateien sind die Grundlage für den nächsten HDL-Abgleich.
