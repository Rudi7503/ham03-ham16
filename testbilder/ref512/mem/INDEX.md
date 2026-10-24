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
| HAM03 | `ham03_payload.mem` | 30720 | `ham03_expected.mem` | 327680 | 640×512 | 4/4/4 | 0 |
| HAM04 | `ham04_payload.mem` | 40960 | `ham04_expected.mem` | 327680 | 640×512 | 4/4/4 | 0 |
| HAM05 | `ham05_payload.mem` | 51200 | `ham05_expected.mem` | 327680 | 640×512 | 4/4/4 | 0 |
| HAM06 | `ham06_payload.mem` | 61440 | `ham06_expected.mem` | 327680 | 640×512 | 4/4/4 | 0 |
| HAM08 | `ham08_payload.mem` | 81920 | `ham08_expected.mem` | 327680 | 640×512 | 4/4/4 | 0 |

## Prüfsummen

| Modus | Quelle `.ham` | sha256 `.ham` | sha256 Nutzlast `.mem` | sha256 Sollpixel `.mem` | sha256 Palette `.mem` |
|---|---|---|---|---|---|
| HAM03 | `ham03.ham` (123668 B) | `0a2480a907c70846dbd14edd962ef9644fb5a6db4da9c26520243dbbd6673c11` | `971db2312939d9b3621fb0dae6fa206691d1e1716e65732f1eba975234951a20` | `fc0c9541091ebfcb12678f8dfc8c06dae38b30e8a8a507f025daf4eff2c723da` | `9f9ebedc7a1c58a88839fcc0cda5ea80c533bfc61687104c5f0bd36ab6079287` |
| HAM04 | `ham04.ham` (164628 B) | `dd0550068c63f9047bf264fae67662e181162fe589602c7416d4ddd8935c54e3` | `48c44681d65b9c0b1048cbf2dd5cceef118adde6d8d296a16260e5850842e989` | `ed5fe87f697c88f3d3427b08af27761320ebbc1176d11c25567d566a14702ede` | `f70f92a6a2a3ae914423e740603fdd7ad08ae1bb46ee4282ef9bf7e384f5c9c6` |
| HAM05 | `ham05.ham` (205588 B) | `f6d3d65814609d9a31fa066285121016d68aa6d49eaa7d5aaa4a67668f6e1d89` | `205c9f0488e4cef73bec1833ef30ae9b63435e4c1ba552ea42fe5d96a52de1c9` | `e9466b84d573f1b92b6a38145cec9b0f91d6e33846ced9e18ae249b3d511bd12` | `61e6b144d4cebd4b89cac3ba06ab2ad5d83e33ef844f5208e9a3b9067d239275` |
| HAM06 | `ham06.ham` (246548 B) | `012033ff7c5693cf1c4f08d4cbaf92eeecfe45a7cbdb4135291ab39f719da727` | `5abe55a90508b9e439f53d7933e585421e18892a5f6ac406aa315d9715012eae` | `d04a1e14c26ad3b97931e3219b39a7bb9043e3b5caf9d738d002fa5f757924d8` | `594c71559978a69e179818e15609bb10054f6123b613f0523d997522aedf0f9e` |
| HAM08 | `ham08.ham` (328468 B) | `5afab9c29a477e14cb67d5375d6d43b30ee885b730435b5f09b0a4c1288ea28a` | `60ac586ebcfc1d8763d01bc46d224bbbe7018b9c6d9486c85ac346e21b6b3fac` | `146971fbd97fcb746638a942559dc0240f3d6e7636f3c6945466305cbf41b6bf` | `a3ddd12d033bc1cdba4de47c592fb2a07f4aa3e1d80289c61d7b84af91dd283d` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM03 | `1FFF75D7` `79E79E5D` `E5DE79E7` `9E79E79F` | `EBAEBAEB` `AEBAEBAE` | `000000` `080808` `101010` `181818` | `645955` |
| HAM04 | `488EDA9F` `DADADADA` `CBDADADA` `DADADADA` | `F8DBCADA` `F9CADADA` | `2E2D28` `262520` `1E1D18` `262510` | `585F52` |
| HAM05 | `45AB2ACA` `74ACED1B` `46D1B469` `3A4E93B4` | `739CE739` `CE78CAB2` | `201E1C` `242218` `281E1C` `242218` | `585E57` |
| HAM06 | `4A2B2B92` `B4924924` `92492492` `49249249` | `B92B92B9` `2B92B923` | `24231F` `201F1B` `242317` `281F1B` | `595B5E` |
| HAM08 | `5050A5A9` `5050A9A6` `99A699A6` `99A699A6` | `A799A55B` `5B5B5B5B` | `1F211E` `1F211E` `231D1A` `272116` | `585D5B` |

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
