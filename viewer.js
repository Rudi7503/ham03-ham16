// Importiere deine bestehenden Decoder-Module aus dem Projekt
import { unpackHam12_16, decodeHam12_16 } from './src/core/module_ham12_16.js';
import { unpackPaletted, decodePaletted } from './src/core/module_paletted.js';

const fileInput = document.getElementById('file-input');
const canvas = document.getElementById('viewer-canvas');
const ctx = canvas.getContext('2d');
const metaBox = document.getElementById('metadata-box');

fileInput.addEventListener('change', (e) => {
    let file = e.target.files[0];
    if (!file) return;

    let reader = new FileReader();
    reader.onload = function(ev) {
        let buffer = ev.target.result;
        let u8 = new Uint8Array(buffer);
        let view = new DataView(buffer);
        
        // 1. Magic Bytes prüfen ("HAM!")
        if (u8[0] !== 72 || u8[1] !== 65 || u8[2] !== 77 || u8[3] !== 33) {
            alert("Fehler: Das ist keine gültige .ham Datei!");
            return;
        }

        // 2. Header auslesen (Metadaten)
        let isLE = view.getUint8(5) === 0; // Endianness
        let imgW = view.getUint16(6, isLE);
        let imgH = view.getUint16(8, isLE);
        let fLen = view.getUint8(10);
        
        let p = 11;
        let format = new TextDecoder().decode(u8.slice(p, p + fLen)); 
        p += fLen;
        
        let step = {
            r: view.getUint8(p++),
            g: view.getUint8(p++),
            b: view.getUint8(p++)
        };
        let offset = view.getUint8(p++);
        
        let paletteRAM = u8.slice(p, p + 768); 
        p += 768;
        
        let packedData = u8.slice(p);
        let totalPixels = imgW * imgH;

        // 3. UI mit Metadaten füllen
        document.getElementById('meta-format').innerText = format;
        document.getElementById('meta-dim').innerText = `${imgW} x ${imgH} px`;
        document.getElementById('meta-step').innerText = `±${step.r}, ±${step.g}, ±${step.b}`;
        document.getElementById('meta-offset').innerText = offset;
        document.getElementById('meta-size').innerText = `${(file.size / 1024).toFixed(2)} KB`;
        metaBox.style.display = 'block';

        // 4. Decodieren
        let commandArray, pixels;
        
        if (format === "HAM12" || format === "HAM16") {
            commandArray = unpackHam12_16(packedData, format, totalPixels);
            pixels = decodeHam12_16(commandArray, imgW, imgH, step);
        } else {
            commandArray = unpackPaletted(packedData, format, totalPixels);
            pixels = decodePaletted(commandArray, imgW, imgH, step, paletteRAM, offset);
        }

        // 5. Auf dem Canvas zeichnen
        canvas.width = imgW;
        canvas.height = imgH;
        
        let imgData = new ImageData(pixels, imgW, imgH);
        ctx.putImageData(imgData, 0, 0);
    };
    
    reader.readAsArrayBuffer(file);
});