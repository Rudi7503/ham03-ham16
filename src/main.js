// src/main.js

import { initHamBuilderMode } from './modes/ham_builder.js';
import { initSpriteStudioMode } from './modes/sprite_studio.js';
import { initViewerMode } from './modes/viewer.js';
import { unpackHam12_16, decodeHam12_16 } from './core/module_ham12_16.js';
import { unpackPaletted, decodePaletted } from './core/module_paletted.js';
import { resizeImage } from './core/resample.js';
import { testImagePixels } from './testimages.js';
import { closeErrorWindow } from './ui/error_window.js';

// Zentraler Application State
const appState = {
    originalImageData: null,
    decodedImageData: null,
    modifiedImageData: null,
    errorViewData: null,
    viewMode: "original", // 'original' | 'modified' | 'error'
    commandSource: null,  // Bild, zu dem latestCommandArray gehört (für lokalen Re-Encode)
    showModified: false,
    currentImgW: 0,
    currentImgH: 0,
    currentFormat: "HAM_32BIT_63436343",
    globalPaletteRAM: new Uint8Array(256 * 3),
    latestCommandArray: null,
    currentImgFileName: "image",
    activeMode: "builder" // Merkt sich, in welchem Tab wir sind
};

const fileImg = document.getElementById('file-img');
const fileBin = document.getElementById('file-bin');
const appContainer = document.getElementById('app-container');

// ==========================================
// MODUS-ROUTER
// ==========================================
function loadCurrentMode() {
    appContainer.innerHTML = ""; // Container leeren

    if (appState.activeMode !== "builder") closeErrorWindow(); // Fenster gehört zum Builder

    if (appState.activeMode === "builder") {
        initHamBuilderMode(appState, appContainer);
    } else if (appState.activeMode === "sprite") {
        initSpriteStudioMode(appState, appContainer);
    } else if (appState.activeMode === "viewer") {
        initViewerMode(appState, appContainer);
    }
}

// Tab-Styling + Moduswechsel an einer Stelle
function syncTabUI(mode) {
    document.querySelectorAll('.btn-tab').forEach(b => {
        const isActive = b.getAttribute('data-mode') === mode;
        b.classList.toggle('active', isActive);
        b.style.background = isActive ? '#17a2b8' : '#444';
    });
}

function selectMode(mode) {
    appState.activeMode = mode;
    syncTabUI(mode);
    loadCurrentMode();
}

// Tab-Klicks abfangen
document.querySelectorAll('.btn-tab').forEach(btn => {
    btn.addEventListener('click', () => selectMode(btn.getAttribute('data-mode')));
});

// ==========================================
// BILD IN DEN STATE ÜBERNEHMEN (Datei & Testbilder)
// ==========================================
function applyLoadedImage(imageData, fileName) {
    appState.currentImgW = imageData.width;
    appState.currentImgH = imageData.height;
    appState.currentImgFileName = fileName;
    appState.originalImageData = imageData;
    appState.decodedImageData = null;
    appState.modifiedImageData = null;
    appState.errorViewData = null;
    appState.viewMode = "original";
    appState.commandSource = null;
    appState.showModified = false;
    appState.latestCommandArray = null;
    appState.globalPaletteRAM.fill(0); // RAM reset
    updateScaleControls();
}

// ==========================================
// GLOBALE DATEI-LOADER
// ==========================================

// 1. Neues Originalbild laden
fileImg.addEventListener('change', (e) => {
    let file = e.target.files[0]; 
    if (!file) return;
    let baseName = file.name.replace(/\.[^/.]+$/, ""); 
    
    let reader = new FileReader();
    reader.onload = function(ev) {
        let img = new Image();
        img.onload = function() {
            // Dummy Canvas zum extrahieren der Pixeldaten
            let tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            let ctx = tempCanvas.getContext('2d', { willReadFrequently: true });
            
            ctx.fillStyle = '#000000'; 
            ctx.fillRect(0, 0, img.width, img.height);
            ctx.drawImage(img, 0, 0);
            
            applyLoadedImage(ctx.getImageData(0, 0, img.width, img.height), baseName);
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
        // Version 4 hat das Modusbit umgedreht (0 = Anker, 1 = Delta). Ältere
        // Dateien würden still falsch dekodieren, deshalb klar abweisen.
        let version = u8[4];
        if (version !== 4) {
            alert(`Diese .ham-Datei hat Formatversion ${version}, das Programm erwartet Version 4.\n`
                + `Seit Version 4 bedeutet das Modusbit 0 = Anker und 1 = Delta (vorher umgekehrt); `
                + `ältere Dateien sind daher nicht mehr lesbar. Bitte die Quelle neu encodieren und speichern.`);
            return;
        }
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
        appState.errorViewData = null;
        appState.viewMode = "original";
        appState.commandSource = null;
        appState.showModified = false;
        
        loadCurrentMode();
        updateScaleControls();
        
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
            if (offInp) {
                offInp.value = offset;
                // Change-Event auslösen, damit der Builder die Palette (Farbfelder +
                // Statusleiste) mit dem korrekten Offset neu rendert.
                offInp.dispatchEvent(new Event('change'));
            }
        }, 150);
    };
    reader.readAsArrayBuffer(file);
});

// ==========================================
// BILD AUF STANDARDGRÖSSEN SKALIEREN
// ==========================================

const scalePreset = document.getElementById('scale-preset');
const scaleWInput = document.getElementById('scale-w');
const scaleHInput = document.getElementById('scale-h');
const scaleMethod = document.getElementById('scale-method');
const btnScale = document.getElementById('btn-scale');

// Hält Eingabefelder und Knopf mit dem geladenen Bild synchron.
function updateScaleControls() {
    if (!scaleWInput || !scaleHInput || !btnScale) return;
    const hasImage = !!appState.originalImageData && appState.originalImageData.width > 0;
    btnScale.disabled = !hasImage;
    if (hasImage) {
        scaleWInput.value = appState.originalImageData.width;
        scaleHInput.value = appState.originalImageData.height;
    }
}

// Skaliert das Originalbild auf die Zielgröße. Bewusst gestreckt (ohne
// Seitenverhältnis): die Zielformate sind feste Rastergrößen, Letterbox-Ränder
// wären verschenkte Bildfläche. Danach ist das Ergebnis das neue Original,
// Palette und Codierung werden zurückgesetzt.
//
// Skaliert wird mit src/core/resample.js statt mit canvas.drawImage: die
// Canvas-Filter sind nicht spezifiziert und je nach Browser unterschiedlich,
// außerdem nicht prüfbar. Die Verfahren dort sind gemessen (test_resize.mjs).
function scaleOriginalImage(targetW, targetH) {
    const src = appState.originalImageData;
    if (!src || !src.width || !src.height) { alert('Bitte zuerst ein Bild laden.'); return; }
    if (!Number.isFinite(targetW) || !Number.isFinite(targetH) || targetW < 1 || targetH < 1) {
        alert('Breite und Höhe müssen ganze Zahlen größer als 0 sein.');
        return;
    }
    if (targetW > 8192 || targetH > 8192) { alert('Maximal 8192 Pixel je Seite.'); return; }

    const method = scaleMethod ? scaleMethod.value : 'lanczos';
    const pixels = resizeImage(src.data, src.width, src.height, targetW, targetH, method);

    const from = `${src.width}x${src.height}`;
    applyLoadedImage(new ImageData(pixels, targetW, targetH), appState.currentImgFileName);
    loadCurrentMode();
    console.log(`Bild skaliert (${method}): ${from} -> ${targetW}x${targetH}`);
}

if (scalePreset && scaleWInput && scaleHInput && btnScale) {
    scalePreset.addEventListener('change', () => {
        const m = /^(\d+)x(\d+)$/.exec(scalePreset.value || '');
        if (m) { scaleWInput.value = m[1]; scaleHInput.value = m[2]; }
    });
    btnScale.addEventListener('click', () => {
        scaleOriginalImage(parseInt(scaleWInput.value, 10), parseInt(scaleHInput.value, 10));
    });
    for (const el of [scaleWInput, scaleHInput]) {
        el.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                scaleOriginalImage(parseInt(scaleWInput.value, 10), parseInt(scaleHInput.value, 10));
            }
        });
    }
    updateScaleControls();
}

// ==========================================
// TESTBILDER (prozedural erzeugt)
// ==========================================
const testimgOverlay = document.getElementById('testimg-overlay');
let testImgType = null;

function openTestImageMenu() {
    testImgType = null;
    // Auswahl zurücksetzen
    document.querySelectorAll('#testimg-type-row button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#testimg-size-row button').forEach(b => b.classList.remove('active'));
    document.getElementById('testimg-size-title').style.display = 'none';
    document.getElementById('testimg-size-row').style.display = 'none';
    testimgOverlay.style.display = 'flex';
}

function closeTestImageMenu() {
    testimgOverlay.style.display = 'none';
}

document.getElementById('btn-test-images')?.addEventListener('click', openTestImageMenu);
document.getElementById('testimg-cancel')?.addEventListener('click', closeTestImageMenu);
testimgOverlay?.addEventListener('click', (e) => { if (e.target === testimgOverlay) closeTestImageMenu(); });

// Stil wählen → Größen-Auswahl einblenden
document.querySelectorAll('#testimg-type-row button').forEach(btn => {
    btn.addEventListener('click', () => {
        testImgType = btn.dataset.type;
        document.querySelectorAll('#testimg-type-row button').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('testimg-size-title').style.display = 'block';
        document.getElementById('testimg-size-row').style.display = 'flex';
    });
});

// Größe wählen → Bild erzeugen und als neues Original im Builder laden
document.querySelectorAll('#testimg-size-row button').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!testImgType) return;
        const size = parseInt(btn.dataset.size, 10);
        const pixels = testImagePixels(testImgType, size);
        const imageData = new ImageData(pixels, size, size);
        closeTestImageMenu();
        applyLoadedImage(imageData, `${testImgType}-${size}px`);
        selectMode('builder'); // Testbilder sind für den Builder gedacht
    });
});

// App-Start: Zeigt initial den "Bitte Bild laden"-Screen
loadCurrentMode();
