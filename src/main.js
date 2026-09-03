// src/main.js

// src/main.js

import { initHamBuilderMode } from './modes/ham_builder.js';
import { initSpriteStudioMode } from './modes/sprite_studio.js'; // NEU
import { initViewerMode } from './modes/viewer.js';             // NEU
import { unpackHam12_16, decodeHam12_16 } from './core/module_ham12_16.js';
import { unpackPaletted, decodePaletted } from './core/module_paletted.js';

// Zentraler Application State
const appState = {
    originalImageData: null,
    decodedImageData: null,
    modifiedImageData: null,
    showModified: false,
    currentImgW: 0,
    currentImgH: 0,
    currentFormat: "HAM_32BIT_63436343",
    globalPaletteRAM: new Uint8Array(256 * 3),
    latestCommandArray: null,
    currentImgFileName: "image",
    activeMode: "builder" // NEU: Merkt sich, in welchem Tab wir sind
};

const fileImg = document.getElementById('file-img');
const fileBin = document.getElementById('file-bin');
const appContainer = document.getElementById('app-container');

// ==========================================
// MODUS-ROUTER
// ==========================================
function loadCurrentMode() {
    appContainer.innerHTML = ""; // Container leeren
    
    if (appState.activeMode === "builder") {
        initHamBuilderMode(appState, appContainer);
    } else if (appState.activeMode === "sprite") {
        initSpriteStudioMode(appState, appContainer);
    } else if (appState.activeMode === "viewer") {
        initViewerMode(appState, appContainer);
    }
}

// Tab-Klicks abfangen
document.querySelectorAll('.btn-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
        // UI-Styling der Tabs anpassen
        document.querySelectorAll('.btn-tab').forEach(b => { b.style.background = '#444'; b.classList.remove('active'); });
        e.target.style.background = '#17a2b8';
        e.target.classList.add('active');
        
        // Modus im State speichern und Modul laden
        appState.activeMode = e.target.getAttribute('data-mode');
        loadCurrentMode();
    });
});

// ... hier bleibt der restliche Datei-Lade-Code (fileImg.addEventListener etc.) exakt gleich! ...

// ==========================================
// GLOBALE DATEI-LOADER
// ==========================================

// 1. Neues Originalbild laden
fileImg.addEventListener('change', (e) => {
    let file = e.target.files[0]; 
    if (!file) return;
    appState.currentImgFileName = file.name.replace(/\.[^/.]+$/, ""); 
    
    let reader = new FileReader();
    reader.onload = function(ev) {
        let img = new Image();
        img.onload = function() {
            appState.currentImgW = img.width; 
            appState.currentImgH = img.height;
            
            // Dummy Canvas zum extrahieren der Pixeldaten
            let tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            let ctx = tempCanvas.getContext('2d', { willReadFrequently: true });
            
            ctx.fillStyle = '#000000'; 
            ctx.fillRect(0, 0, img.width, img.height);
            ctx.drawImage(img, 0, 0);
            
            appState.originalImageData = ctx.getImageData(0, 0, img.width, img.height);
            appState.decodedImageData = null; 
            appState.modifiedImageData = null;
            appState.showModified = false;
            
            appState.globalPaletteRAM.fill(0); // RAM reset
            
            loadCurrentMode();
        }
        img.src = ev.target.result;
    }
    reader.readAsDataURL(file);
});

// 2. Gepackte .ham Datei laden
fileBin.addEventListener('change', (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    
    reader.onload = function(ev) {
        let u8 = new Uint8Array(ev.target.result);
        let view = new DataView(ev.target.result);
        let isLE = view.getUint8(5) === 0;
        
        appState.currentImgW = view.getUint16(6, isLE);
        appState.currentImgH = view.getUint16(8, isLE);
        let fLen = view.getUint8(10);
        
        let p = 11;
        appState.currentFormat = new TextDecoder().decode(u8.slice(p, p + fLen)); p += fLen;
        
        let step = { r: view.getUint8(p++), g: view.getUint8(p++), b: view.getUint8(p++) };
        let offset = view.getUint8(p++);
        
        appState.globalPaletteRAM.set(u8.slice(p, p + 768)); p += 768;
        appState.globalPaletteRAM[0] = 0; appState.globalPaletteRAM[1] = 0; appState.globalPaletteRAM[2] = 0; // Slot 0 = Schwarz
        
        let packedData = u8.slice(p);
        let totalPixels = appState.currentImgW * appState.currentImgH;
        
        // Entpacken & Decodieren
        if (appState.currentFormat === "HAM12" || appState.currentFormat === "HAM16") {
            appState.latestCommandArray = unpackHam12_16(packedData, appState.currentFormat, totalPixels);
            let pixels = decodeHam12_16(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step);
            appState.decodedImageData = new ImageData(pixels, appState.currentImgW, appState.currentImgH);
        } else {
            appState.latestCommandArray = unpackPaletted(packedData, appState.currentFormat, totalPixels);
            let pixels = decodePaletted(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step, appState.globalPaletteRAM, offset);
            appState.decodedImageData = new ImageData(pixels, appState.currentImgW, appState.currentImgH);
        }
        
        // Wenn kein Originalbild da ist, erzeuge einen Dummy, damit der Builder starten kann
        if (!appState.originalImageData) {
            appState.originalImageData = new ImageData(appState.currentImgW, appState.currentImgH);
        }
        
        appState.modifiedImageData = null;
        appState.showModified = false;
        
        loadCurrentMode();
        
        // UI-Felder im Builder nachträglich synchronisieren
        setTimeout(() => {
            let fmtSelect = document.getElementById('format');
            if (fmtSelect) fmtSelect.value = appState.currentFormat;
            
            let rInp = document.getElementById('ham-step-r');
            if (rInp) {
                rInp.value = step.r;
                document.getElementById('ham-step-g').value = step.g;
                document.getElementById('ham-step-b').value = step.b;
            }
            let offInp = document.getElementById('pal-offset-input');
            if(offInp) offInp.value = offset;
        }, 150);
    };
    reader.readAsArrayBuffer(file);
});

// App-Start: Zeigt initial den "Bitte Bild laden"-Screen
loadCurrentMode();