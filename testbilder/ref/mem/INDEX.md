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
| HAM03 | `ham03_payload.mem` | 7680 | `ham03_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |
| HAM04 | `ham04_payload.mem` | 10240 | `ham04_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |
| HAM05 | `ham05_payload.mem` | 12800 | `ham05_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |
| HAM06 | `ham06_payload.mem` | 15360 | `ham06_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |
| HAM08 | `ham08_payload.mem` | 20480 | `ham08_expected.mem` | 81920 | 320×256 | 4/4/4 | 0 |

## Prüfsummen

| Modus | Quelle `.ham` | sha256 `.ham` | sha256 Nutzlast `.mem` | sha256 Sollpixel `.mem` | sha256 Palette `.mem` |
|---|---|---|---|---|---|
| HAM03 | `ham03.ham` (31508 B) | `2b35d222f2a80222a6a88a15effef9ace463ed10b50e824cdeeb868702941182` | `8cba286a4fe465d44c888576faae321fb25cdda42ae29444fe5dc413dcc2796c` | `f7d510a088436dc2a175d81bf672a153247dd0b346e0b44521000c89c9baf644` | `d07ba655c82d1481d65a182e9bf499d267755d0867cdd7785bcee2ff206d834a` |
| HAM04 | `ham04.ham` (41748 B) | `8fb819fbec600d1c31226ba3b4cacc2cfaf11a0962159a9fe69e6c324540d535` | `67623e04bc5a1d2d8eb8570b78efcfd15c24a58aab28f69a0495529dd922898b` | `c88cf73ee02b45e625b3317ab315b49824a8ad9a19702c8c5e66df8b0eec20fe` | `63096575cb3ecd0698f6f051d2321bd027028a5b4e5f12e21205fe08c2514be4` |
| HAM05 | `ham05.ham` (51988 B) | `e3e865201d213601958552e3b3efb6eca53d791ffa4226b80304a629ee447beb` | `495f3b2d97fab003bd3a52d350f960961494afde536f729956dc7d7987e9b50b` | `5d261b00fa28b505c6791c591ec39fb9b3fce21400f74622ea71cc669b9e180f` | `55ea490c1aff8360915ecc550a78d24cdab8319ab48b0fdf8e45111e8a9a83b8` |
| HAM06 | `ham06.ham` (62228 B) | `c75fc9e95e0ed9f0f281ddcccbfe062ece4316774dcbf0a87dc5b6127d5079ef` | `25f7a5bc87522fd04dbe295a8b765d4355d8bbd1a37322896bc5f1e0fc070d4c` | `8f4a90592d45180069faa2ea4747534b25bc8c1704a3ca7249106c20551cab3c` | `ff21eb0b01dd9115a65f4ee38ac0fafc76c47adfdd6311db3bc0f3a5239bd3e5` |
| HAM08 | `ham08.ham` (82708 B) | `624a499f8709715945f0b7bc77f7c01ff25b3a0602c80427641e5142d8c437d6` | `276b65377cfce1c83af7ea8fceabe975cf7a6b6147ca8657000d5b5dbcd79b81` | `2b8769962314b74b56ebca2a165d3550733baf28662a86f02dc5e939af042705` | `a3ddd12d033bc1cdba4de47c592fb2a07f4aa3e1d80289c61d7b84af91dd283d` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM03 | `72D96CB7` `6BAEBF5D` `75D75D75` `D75D77BA` | `EBADDE5D` `E7BAEBAF` | `732019` `6B1811` `632009` `5B2801` | `283828` |
| HAM04 | `44444444` `44444444` `44EDADBC` `BDACBDAD` | `FAD9EDAA` `DE94444F` | `2E2D28` `2E2D28` `2E2D28` `2E2D28` | `363530` |
| HAM05 | `2C212AD6` `52ADA37A` `4E93ACAD` `1294A529` | `2ACAB795` `655BCAA5` | `36332C` `322F28` `2E2B24` `2A2F20` | `36332C` |
| HAM06 | `2E2AA592` `B92BAA5B` `23B0B2CB` `2CB2CBB2` | `24AD92B9` `2BB64AEF` | `322F2A` `2E2B26` `322722` `2E2B26` | `30332B` |
| HAM08 | `58A599A6` `99A699A6` `A9479AA6` `99383838` | `A9A689B6` `585858BE` | `2A2C2A` `2E2826` `2A2C22` `2E2826` | `32342E` |

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
