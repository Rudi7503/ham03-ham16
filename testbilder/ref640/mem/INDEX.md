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
| HAM03 | `ham03.ham` (62228 B) | `db081a1de238426acafe37aa93489d9a1fca44467966ae24c039bb2abc369ef9` | `47911d0b41612a65026440c396e0d0f532ff6941e6e30c2d48ab7d2687af7938` | `d3a793855f9ec83b901ed74e80dc43680f061336e7cacaa92a0365f854c53e30` | `9f9ebedc7a1c58a88839fcc0cda5ea80c533bfc61687104c5f0bd36ab6079287` |
| HAM04 | `ham04.ham` (82708 B) | `0a4a4c96d1abf88d55aff2996ca8e78d3db082bc477ff294a052eb2f22f1df9e` | `e64266bcb152b065dd235109460b85ecfeb86c45390bd753d1d0983b1aa2d48b` | `650991831bf217c37900c65cd2f9bca4bd9c9cf1c6a5b1f22c059271b5597613` | `f70f92a6a2a3ae914423e740603fdd7ad08ae1bb46ee4282ef9bf7e384f5c9c6` |
| HAM05 | `ham05.ham` (103188 B) | `9f288e9bc06d02c00fc350c3ebec02d6073195c78b3c60dee96805086eb33e1c` | `5785ff32089b4abc241770b24f1a57d9c709401b1a74c7474bb807f526deb1a5` | `647972ecd39f7d852165107fcc6aa71384fb07d1c884666c495e5f79088b0c01` | `61e6b144d4cebd4b89cac3ba06ab2ad5d83e33ef844f5208e9a3b9067d239275` |
| HAM06 | `ham06.ham` (123668 B) | `9820392aa1de10e6cdee8b9d22163eaf93da94d7513c7412b1572b1a8ae17807` | `abafe6b0af71be8d250e4b1d4ed5bec2355cfd4204a82969d971a8969d5b0a15` | `71cfca3ab974aa08d926f92908da3ad1f1508cfc34dded2cd69688f5569423d1` | `594c71559978a69e179818e15609bb10054f6123b613f0523d997522aedf0f9e` |
| HAM08 | `ham08.ham` (164628 B) | `cb968bc0357b871e8b38e7054a713a28e4e6db6e155bdd2adae44f5fd22576cf` | `3da9c6a705b05677bcc28f843eb0476f2b019c1f2b1b27a0450a089604275088` | `4826b49fcf878c97626f441164e78d03df16fac832eb69b662c9549cda215c7c` | `a3ddd12d033bc1cdba4de47c592fb2a07f4aa3e1d80289c61d7b84af91dd283d` |

## Ankerwerte zum Abgleich

Erste und letzte Wörter der Nutzlast sowie erste Pixel — damit lässt sich eine
fehlerhafte Wort- oder Pixelreihenfolge sofort erkennen (Big-Endian-Falle:
`0x067FC244` statt `0x44C27F06`).

| Modus | erste Wörter | letzte Wörter | erste Pixel RRGGBB | letzter Pixel |
|---|---|---|---|---|
| HAM03 | `1FFF75D7` `79E79E5D` `E79E79E7` `9E79E7D7` | `5D75D75D` `75D75D75` | `000000` `080808` `101010` `181818` | `5C614D` |
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
