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
| HAM03 | `ham03.ham` (62228 B) | `04c0526b00553717ed3955f55c83733a913e3840f62c71282015be0335f07e41` | `c96093d1476671ee93f4dbbf81898f44a51d388a9d653356a05a9536f155dbb2` | `9260c872ab27ff2a77d36eaccada22caeded16e2d83b34ff7199921ab0ba01e5` | `d07ba655c82d1481d65a182e9bf499d267755d0867cdd7785bcee2ff206d834a` |
| HAM04 | `ham04.ham` (82708 B) | `eca49a707eaf95824661bd0379fcddc0aab14570742cfdaa0ada6f1643e3b6b4` | `b352742ec9cf39f10ccdda87603fa3c7a783693862ab91cc4f9673777cbf78f4` | `1c692b19b92133fd9c19b5ec11dee73dfde22ec0618248025c363b5830065b1e` | `63096575cb3ecd0698f6f051d2321bd027028a5b4e5f12e21205fe08c2514be4` |
| HAM05 | `ham05.ham` (103188 B) | `0a72bda99e8d369b53f790960c1aacfdb840fd0f5003c4b7e80261539fdc0e5f` | `87d555f7f4355b1ac469ba0e0c1c81e6afd7dc12e90a97a30c4f39e8653babc2` | `4ca410a62a0d817213fd06e7758c143b8af4a590b885f91b476632cf4be49522` | `55ea490c1aff8360915ecc550a78d24cdab8319ab48b0fdf8e45111e8a9a83b8` |
| HAM06 | `ham06.ham` (123668 B) | `4b24b0e9fd6a1c9aaa8d2e0017549db626da0835c6bfb6718f39341d784f94c2` | `d9095f1325e6d54751ae73dd3d923e9b92ee3f6e1abac9a23391655e95551e2d` | `7848b7c7e3c545f25b6eb386efba30e16222a009aa2d6aaa718a76147b283ba5` | `ff21eb0b01dd9115a65f4ee38ac0fafc76c47adfdd6311db3bc0f3a5239bd3e5` |
| HAM08 | `ham08.ham` (164628 B) | `cb968bc0357b871e8b38e7054a713a28e4e6db6e155bdd2adae44f5fd22576cf` | `3da9c6a705b05677bcc28f843eb0476f2b019c1f2b1b27a0450a089604275088` | `4826b49fcf878c97626f441164e78d03df16fac832eb69b662c9549cda215c7c` | `a3ddd12d033bc1cdba4de47c592fb2a07f4aa3e1d80289c61d7b84af91dd283d` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM03 | `1FFF75D7` `79E79E5D` `E79E79E7` `9E79E7D7` | `252EBAEB` `AEBAEBAE` | `000000` `080808` `101010` `181818` | `655854` |
| HAM04 | `48CADADB` `DADADADA` `CBDADACB` `DADADADA` | `ADADAE9D` `ADADADAD` | `2E2D28` `262520` `2E1D18` `262510` | `615660` |
| HAM05 | `45AB2ACA` `B29D6D1B` `46D1B46D` `195693B4` | `739CE739` `CF195655` | `201E1C` `242218` `281E1C` `242218` | `5C5A5B` |
| HAM06 | `4AA92B92` `B9124924` `92492492` `49249249` | `B92B92B9` `2B425AE4` | `24231F` `281F1B` `242317` `281F1B` | `595F56` |
| HAM08 | `50505050` `5050A9A6` `99A699A6` `99A699A6` | `99A65B5B` `A55B5B5B` | `1F211E` `1F211E` `1F211E` `1F211E` | `585D5B` |

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
