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
| HAM03 | `ham03_payload.mem` | 15360 | `ham03_expected.mem` | 163840 | 640×256 | 4/4/4 | 0 |
| HAM04 | `ham04_payload.mem` | 20480 | `ham04_expected.mem` | 163840 | 640×256 | 4/4/4 | 0 |
| HAM05 | `ham05_payload.mem` | 25600 | `ham05_expected.mem` | 163840 | 640×256 | 4/4/4 | 0 |
| HAM06 | `ham06_payload.mem` | 30720 | `ham06_expected.mem` | 163840 | 640×256 | 4/4/4 | 0 |
| HAM08 | `ham08_payload.mem` | 40960 | `ham08_expected.mem` | 163840 | 640×256 | 4/4/4 | 0 |

## Prüfsummen

| Modus | Quelle `.ham` | sha256 `.ham` | sha256 Nutzlast `.mem` | sha256 Sollpixel `.mem` | sha256 Palette `.mem` |
|---|---|---|---|---|---|
| HAM03 | `ham03.ham` (62228 B) | `42bad22d4c5e6e47df5e38a32a8cc5d955ae2851ff9430f280ec71280779735c` | `6eee6cc6fb13f3482d2e6688137995024fd9ee2028c2f9eb739b38f02a8b527a` | `11c0f80a628adaf803511ad523c0c3d94d07e87cc3386de1562f9180f6971246` | `d07ba655c82d1481d65a182e9bf499d267755d0867cdd7785bcee2ff206d834a` |
| HAM04 | `ham04.ham` (82708 B) | `2e6943c9c5b04d93e921aaebb580c6a5cb0997a643460ad212af9ca36cf9be29` | `95b374d7f5fc35711f23855b509782325bb2eb2e4b4b453bcad8e8b92e1823b5` | `9b8b9ff58a8c3339b660982bc62d14874afb84eb8e7c862d9266f577994d5b50` | `63096575cb3ecd0698f6f051d2321bd027028a5b4e5f12e21205fe08c2514be4` |
| HAM05 | `ham05.ham` (103188 B) | `1b098af77c1589ce607e208239ab8c8c4033316c04c14df77a5ae2864f362815` | `7f223898a7aeb1aa1bd214c4aa733417d33cd3ad4c91adce7efb1aaf2d53e88b` | `3ef7cf5855509935491e2f110402bb20587f3ca4400faab62d7aa1a266e5ea79` | `55ea490c1aff8360915ecc550a78d24cdab8319ab48b0fdf8e45111e8a9a83b8` |
| HAM06 | `ham06.ham` (123668 B) | `aa4409bc235244e0c9963768848f9a2e8c79bf2d7a61c11e297ec6a040c4073e` | `8c4cf0edaf6387673eacaae109a5913171cb61064010a4c060c5589735982e2b` | `207dc454089cd77df98cb11dfa6aac1e8dd56c4279883816880f9d17cba7408b` | `ff21eb0b01dd9115a65f4ee38ac0fafc76c47adfdd6311db3bc0f3a5239bd3e5` |
| HAM08 | `ham08.ham` (164628 B) | `c31162d6bf158be9d27173f873c228ba6a6ce956e9d98f95847b9a9c3c09c4d6` | `331308f3284cdcaed46be84c8969b411a1b9d0652d628c7e19d3523676aff448` | `c8b68d552be045e9df757f157643763a9731809b4e6382355045db611fc88798` | `a3ddd12d033bc1cdba4de47c592fb2a07f4aa3e1d80289c61d7b84af91dd283d` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM03 | `76DB2EF2` `EF3CB76D` `6EF74F74` `F74FADD7` | `5D75D75D` `75D75D75` | `732019` `6B2811` `633009` `5B3801` | `282828` |
| HAM04 | `4FEDADAD` `ADADADAD` `ADADADAD` `BED9EA8D` | `DADADADA` `9DADADAD` | `2E2D28` `363530` `3E3D28` `463530` | `2E1D28` |
| HAM05 | `0C217A4A` `B2ACAB3A` `4E9385E9` `3A4E93B0` | `5956558C` `AB68CAB2` | `473F36` `433B32` `3F372E` `433B32` | `28261C` |
| HAM06 | `062B0104` `10410410` `41B0106C` `06D06C06` | `4AE4AE4A` `A5AA3B23` | `41392F` `3D352B` `413927` `41392F` | `2C1F1F` |
| HAM08 | `031111AA` `02020202` `02020202` `02020204` | `A698A699` `A699A699` | `40382E` `3F362C` `3F362C` `433A30` | `2B251C` |

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
