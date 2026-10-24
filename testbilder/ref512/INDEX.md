# Referenzsatz 640×512 (Interlace) — mit Zeilenankern

Erzeugt mit `make_ref_512.mjs`. Geprüft mit `test_ref512.mjs` und
`test_ref_mem.mjs testbilder/ref512`.

## Herkunft

- **Encoder:** Code ab `48890d1`, erweitert um `forceRowAnchors` (am Zeilenanfang
  ist nur ein Anker erlaubt).
- **Quellbild:** dieselbe 1120×1120-JPEG wie bei den früheren Sätzen.
- **Skalierung:** `resizeImage` (Lanczos), x/y **unabhängig**: x = 0,5714, y = 0,4571.
  Kein Beschnitt, keine Ränder, anisotrop. Eingabe: `input_640x512.rgb`
  (983040 Byte, sha256 `61ac312a2e920fabe944706a03b186201b7b0fc2245869dccb8048e3e2abc020`).
- **Zeilenanker:** jede der 512 Zeilen beginnt mit einem Anker. Damit ist jede Zeile
  unabhängig dekodierbar — Voraussetzung für Zeilensprung im Betrieb (Interlace)
  ohne Bildpuffer.
- **Paletten:** aus dem 640×256-Satz übernommen (`../ref640/ham0X.ham`), dort bereits
  nachoptimiert; für 640×512 nicht erneut optimiert.
- **Schrittweite** 4/4/4 · **Offset** 0 · Strategie `greedy` · Metrik `yuv_weight`

## Kosten der Zeilenanker (gemessen, 640×512)

| Modus | MSE ohne Ankerzwang | mit Zeilenankern | Delta |
|---|---|---|---|
| HAM03 | 35,82 | 43,94 | **+22,7 %** |
| HAM04 | 15,36 | 15,46 | +0,6 % |
| HAM05 | 5,56 | 5,58 | +0,4 % |
| HAM06 | 3,54 | 3,54 | +0,08 % |
| HAM08 | 1,41 | 1,41 | +0,04 % |

Die Dateigröße ändert sich nicht (feste Bitrate). HAM03 verliert deutlich, weil nur
vier Palettenplätze zur Verfügung stehen und die Zeile mit ±8 pro Schritt lange
braucht, um vom erzwungenen Anker zur eigentlichen Farbe zurückzukommen.

## Dateien

| Modus | `.ham` | Bytes | Nutzlast | Wörter | Zeilen mit Anker |
|---|---|---|---|---|---|
| HAM03 | `ham03.ham` | 123668 | 122880 | 30720 | 512/512 |
| HAM04 | `ham04.ham` | 164628 | 163840 | 40960 | 512/512 |
| HAM05 | `ham05.ham` | 205588 | 204800 | 51200 | 512/512 |
| HAM06 | `ham06.ham` | 246548 | 245760 | 61440 | 512/512 |
| HAM08 | `ham08.ham` | 328468 | 327680 | 81920 | 512/512 |

## Prüfsummen

| Modus | sha256 `.ham` | sha256 Raster | sha256 Palette | Reproduktion |
|---|---|---|---|---|
| HAM03 | `0a2480a907c70846dbd14edd962ef9644fb5a6db4da9c26520243dbbd6673c11` | `dbc4ba110ac0073fec3168629968ad1044bff8c4764961b04d7a01ef524c605d` | `a9f0f2872cfdb508a1262348fde44a8b8cf85fb9ada25cff2b8ee8bb04747335` | byte-exakt |
| HAM04 | `dd0550068c63f9047bf264fae67662e181162fe589602c7416d4ddd8935c54e3` | `34ff772f57968f89350a687ffb23ef2af029c885c5c1f364aecb053df5c26764` | `4a75790fbbe0c55cb511d9db3261dc51e51d57de6d1dd23ba2ccf1f02c65de14` | byte-exakt |
| HAM05 | `f6d3d65814609d9a31fa066285121016d68aa6d49eaa7d5aaa4a67668f6e1d89` | `05e0b77fb37f85232befcf3586a92382fbe8a63d94fae2676fec56f2f0bed951` | `1463332a4b357030bfbacf26a7c742a9940f136c356b6f1f5b8c3e0358431e70` | byte-exakt |
| HAM06 | `012033ff7c5693cf1c4f08d4cbaf92eeecfe45a7cbdb4135291ab39f719da727` | `7b12a5b7fdbee36902b9d0acd2e42823d30345404dbfdb7f64987d10126075fe` | `fa64343bf54b45b932887700c71e8d57196bbcb0e9a9571949745ab3b84d61ae` | byte-exakt |
| HAM08 | `5afab9c29a477e14cb67d5375d6d43b30ee885b730435b5f09b0a4c1288ea28a` | `2c3e1e65bf174e2ab1b07637bfaa61ff6d505e2caa071c3f68054aebcbdd1347` | `e526fe316aa6bdbb6f174d73257c1382bf76ae4fe798a711cc2d38c928909607` | byte-exakt |

## Testbench-Dateien

In `mem/`: Nutzlast als 32-Bit-Wörter (8 Hexziffern, Byte0 in Bits 31:24),
Sollpixel als 24 Bit RRGGBB je Pixel (zeilenweise von oben links),
Palette als 256 Zeilen RRGGBB. Erzeugt mit `make_ref_mem.mjs testbilder/ref512`.

## Stand

Reine Software-Referenz. FPGA-Build und Hardwaretest stehen aus.
