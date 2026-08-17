import { setZoomMode, updateView, centerOnCoordinate, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { hexToRgb, rgbToHex } from './codecs/utils.js';
import { encodeHam12_16, decodeHam12_16, packHam12_16, unpackHam12_16 } from './core/module_ham12_16.js';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './core/module_paletted.js';
import { debugRoundtripHam12_16, debugRoundtripPaletted } from './core/debugger.js';
import { computeDetailedAnalysis, autoFillPaletteFromImage, errorBins } from './core/analysis.js';

let currentImgW = 0, currentImgH = 0, totalPixels = 0;
let originalImageData = null, decodedImageData = null;
let currentFormat = "HAM_32Bit_44444444"; 
let latestPackedData = null, latestCommandArray = null;
let globalPaletteRAM = new Uint8Array(256 * 3);
let currentImgFileName = "image";

const formatSelect = document.getElementById('format');
const encodeStrategySelect = document.getElementById('encode-strategy');
const encodeMetricSelect = document.getElementById('encode-metric');
const hypPercentInp = document.getElementById('hybrid-percent');

const hamStepR = document.getElementById('ham-step-r');
const hamStepG = document.getElementById('ham-step-g');
const hamStepB = document.getElementById('ham-step-b');
const palOffsetInput = document.getElementById('pal-offset-input');
const paletteContainer = document.getElementById('palette-pickers-container');

const btnEncode = document.getElementById('btn-encode');
const btnSave = document.getElementById('btn-save');
const btnDebugRoundtrip = document.getElementById('btn-debug-roundtrip');
const btnBuilder = document.getElementById('btn-builder');
const btnAnalysis = document.getElementById('btn-analysis');
const fileImg = document.getElementById('file-img');
const fileBin = document.getElementById('file-bin');

const canvasOriginal = document.getElementById('canvas-original');
const ctxOriginal = canvasOriginal.getContext('2d', { willReadFrequently: true });
const canvasDecoded = document.getElementById('canvas-decoded');
const ctxDecoded = canvasDecoded.getContext('2d', { willReadFrequently: true });

function getGlobalStep() {
    return { r: parseInt(hamStepR.value) || 4, g: parseInt(hamStepG.value) || 4, b: parseInt(hamStepB.value) || 4 };
}

function getGlobalOffset() {
    return parseInt(palOffsetInput.value) || 0;
}

function updateStatusTextDimAndColors() {
    let dimTextEl = document.getElementById('img-dim-text');
    if (dimTextEl) dimTextEl.innerText = `Größe: ${currentImgW}x${currentImgH} px | Modus: ${currentFormat}`;
}

function updateProgress(phase, current, total) {
    let pBar = document.getElementById('progress');
    let sText = document.getElementById('status-text');
    let pct = total > 0 ? Math.floor((current / total) * 100) : 0;
    if (pBar) pBar.value = pct;
    if (sText) sText.innerText = `${phase}: ${pct}%`;
}

// Hilfsfunktion: Führt die automatische Neu-Codierung im Hintergrund aus und zeigt Status
async function triggerAutoReencode() {
    if (!originalImageData) return;
    
    let statusDiv = document.getElementById('builder-instruction') || document.getElementById('builder-status');
    if (statusDiv) {
        statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ Bild wird neu codiert und analysiert...</span>`;
    }

    let step = getGlobalStep();
    let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
    let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
    let hybridPercent = hypPercentInp ? (parseFloat(hypPercentInp.value) || 5.0) : 5.0;

    let offset = getGlobalOffset();
    latestCommandArray = await encodePaletted(
        originalImageData.data, currentImgW, currentImgH, currentFormat, step, globalPaletteRAM, offset, 
        strategy, metric, max_depth, null, 0, 0, hybridPercent
    );
    latestPackedData = packPaletted(latestCommandArray, currentFormat);
    let pixels = decodePaletted(latestCommandArray, currentImgW, currentImgH, step, globalPaletteRAM, offset);
    decodedImageData = new ImageData(pixels, currentImgW, currentImgH);
    ctxDecoded.putImageData(decodedImageData, 0, 0);
    btnSave.disabled = false;
}

function handleFormatChange() {
    currentFormat = formatSelect.value;
    let config = HAM_CONFIGS[currentFormat];
    let isPalFormat = config && config.isPaletted;
    
    let paletteBox = document.getElementById('palette-box');
    if (paletteBox) paletteBox.style.display = isPalFormat ? 'block' : 'none';
    if (btnBuilder) btnBuilder.disabled = !isPalFormat || !originalImageData;
    
    if (isPalFormat && paletteContainer) {
        paletteContainer.innerHTML = "";
        let slotsPerBank = config.slotsPerBank || 8;
        let currentOffset = getGlobalOffset();
        for(let i = 0; i < slotsPerBank; i++) {
            let absSlot = (currentOffset + i) % 256;
            let r = globalPaletteRAM[absSlot * 3], g = globalPaletteRAM[absSlot * 3 + 1], b = globalPaletteRAM[absSlot * 3 + 2];
            
            let input = document.createElement('input');
            input.type = 'color'; input.className = 'palette-picker';
            input.value = rgbToHex(r, g, b);
            input.title = `Slot ${i} (RAM: ${absSlot})`;
            input.addEventListener('input', async (e) => {
                let [nr, ng, nb] = hexToRgb(e.target.value);
                globalPaletteRAM[absSlot * 3] = nr; 
                globalPaletteRAM[absSlot * 3 + 1] = ng; 
                globalPaletteRAM[absSlot * 3 + 2] = nb;
                await triggerAutoReencode();
            });
            paletteContainer.appendChild(input);
        }
    }
}

if (formatSelect) formatSelect.addEventListener('change', handleFormatChange);
if (palOffsetInput) {
    palOffsetInput.addEventListener('change', handleFormatChange);
    palOffsetInput.addEventListener('input', handleFormatChange);
}

setupCanvasEvents(
    () => ({ w: currentImgW, h: currentImgH }),
    () => ({ original: originalImageData, decoded: decodedImageData })
);

['fit', '1x', '2x', '4x', '8x', '16x', '32x'].forEach(mode => {
    let btn = document.getElementById(`btn-zoom-${mode}`);
    if (btn) btn.addEventListener('click', () => setZoomMode(mode, currentImgW, currentImgH));
});

if (fileImg) fileImg.addEventListener('change', (e) => {
    let file = e.target.files[0]; 
    if (!file) return;
    currentImgFileName = file.name.replace(/\.[^/.]+$/, ""); 
    
    let reader = new FileReader();
    reader.onload = function(ev) {
        let img = new Image();
        img.onload = function() {
            currentImgW = img.width; currentImgH = img.height; totalPixels = currentImgW * currentImgH;
            canvasOriginal.width = currentImgW; canvasOriginal.height = currentImgH;
            
            ctxOriginal.fillStyle = '#000000'; 
            ctxOriginal.fillRect(0, 0, currentImgW, currentImgH);
            ctxOriginal.drawImage(img, 0, 0);
            
            originalImageData = ctxOriginal.getImageData(0, 0, currentImgW, currentImgH);
            
            canvasDecoded.width = currentImgW; canvasDecoded.height = currentImgH;
            ctxDecoded.clearRect(0, 0, currentImgW, currentImgH);
            
            handleFormatChange();
            updateStatusTextDimAndColors();
            setZoomMode('fit', currentImgW, currentImgH);
            
            btnEncode.disabled = false; btnSave.disabled = true; btnDebugRoundtrip.disabled = false;
            if (btnAnalysis) btnAnalysis.disabled = false;
        }
        img.src = ev.target.result;
    }
    reader.readAsDataURL(file);
});

if (btnEncode) btnEncode.addEventListener('click', async () => {
    if (!currentImgW) return;
    btnEncode.disabled = true; btnSave.disabled = true; btnDebugRoundtrip.disabled = true;
    
    currentFormat = formatSelect.value;
    let step = getGlobalStep();
    let is16BitClass = (currentFormat === "HAM12" || currentFormat === "HAM16");
    
    let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
    let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
    let hybridPercent = hypPercentInp ? (parseFloat(hypPercentInp.value) || 5.0) : 5.0;

    if (is16BitClass) {
        latestCommandArray = await encodeHam12_16(originalImageData.data, currentImgW, currentImgH, currentFormat, step, strategy, metric, max_depth, updateProgress, 0, 0, hybridPercent);
        latestPackedData = packHam12_16(latestCommandArray, currentFormat);
        let pixels = decodeHam12_16(latestCommandArray, currentImgW, currentImgH, step);
        decodedImageData = new ImageData(pixels, currentImgW, currentImgH);
    } else {
        let offset = getGlobalOffset();
        latestCommandArray = await encodePaletted(originalImageData.data, currentImgW, currentImgH, currentFormat, step, globalPaletteRAM, offset, strategy, metric, max_depth, updateProgress, 0, 0, hybridPercent);
        latestPackedData = packPaletted(latestCommandArray, currentFormat);
        let pixels = decodePaletted(latestCommandArray, currentImgW, currentImgH, step, globalPaletteRAM, offset);
        decodedImageData = new ImageData(pixels, currentImgW, currentImgH);
    }

    updateProgress("Fertig", 100, 100);
    ctxDecoded.putImageData(decodedImageData, 0, 0);
    updateStatusTextDimAndColors();
    
    btnEncode.disabled = false; btnSave.disabled = false; btnDebugRoundtrip.disabled = false;
});

if (btnSave) btnSave.addEventListener('click', () => {
    if (!latestPackedData) return;
    let customName = prompt("Bitte Dateinamen eingeben (ohne Endung):", `${currentImgFileName}_${currentFormat.toLowerCase()}`);
    if (!customName) return;

    let fmtBytes = new TextEncoder().encode(currentFormat);
    let step = getGlobalStep();
    let buffer = new ArrayBuffer(11 + fmtBytes.length + 4 + 768 + latestPackedData.length);
    let view = new DataView(buffer);
    let u8 = new Uint8Array(buffer);
    
    u8.set([72, 65, 77, 33], 0); 
    view.setUint8(4, 3);
    view.setUint8(5, 0); // Little Endian
    view.setUint16(6, currentImgW, true);
    view.setUint16(8, currentImgH, true);
    view.setUint8(10, fmtBytes.length);
    
    let p = 11;
    u8.set(fmtBytes, p); p += fmtBytes.length;
    view.setUint8(p++, step.r); view.setUint8(p++, step.g); view.setUint8(p++, step.b); view.setUint8(p++, getGlobalOffset());
    
    u8.set(globalPaletteRAM, p); p += 768;
    u8.set(latestPackedData, p);

    const url = URL.createObjectURL(new Blob([buffer]));
    const a = document.createElement('a');
    a.href = url; a.download = `${customName}.ham`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

if (fileBin) fileBin.addEventListener('change', (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = function(ev) {
        let u8 = new Uint8Array(ev.target.result);
        let view = new DataView(ev.target.result);
        let isLE = view.getUint8(5) === 0;
        
        currentImgW = view.getUint16(6, isLE);
        currentImgH = view.getUint16(8, isLE);
        let fLen = view.getUint8(10);
        
        let p = 11;
        currentFormat = new TextDecoder().decode(u8.slice(p, p + fLen)); p += fLen;
        
        hamStepR.value = view.getUint8(p++); hamStepG.value = view.getUint8(p++); hamStepB.value = view.getUint8(p++);
        palOffsetInput.value = view.getUint8(p++);
        
        globalPaletteRAM.set(u8.slice(p, p + 768)); p += 768;
        latestPackedData = u8.slice(p);
        totalPixels = currentImgW * currentImgH;
        formatSelect.value = currentFormat;
        
        canvasOriginal.width = currentImgW; canvasOriginal.height = currentImgH;
        canvasDecoded.width = currentImgW; canvasDecoded.height = currentImgH;
        ctxOriginal.clearRect(0, 0, currentImgW, currentImgH);

        let step = getGlobalStep();
        if (currentFormat === "HAM12" || currentFormat === "HAM16") {
            latestCommandArray = unpackHam12_16(latestPackedData, currentFormat, totalPixels);
            let pixels = decodeHam12_16(latestCommandArray, currentImgW, currentImgH, step);
            decodedImageData = new ImageData(pixels, currentImgW, currentImgH);
        } else {
            let offset = getGlobalOffset();
            latestCommandArray = unpackPaletted(latestPackedData, currentFormat, totalPixels);
            let pixels = decodePaletted(latestCommandArray, currentImgW, currentImgH, step, globalPaletteRAM, offset);
            decodedImageData = new ImageData(pixels, currentImgW, currentImgH);
        }
        
        ctxDecoded.putImageData(decodedImageData, 0, 0);
        handleFormatChange();
        updateStatusTextDimAndColors();
        setZoomMode('fit', currentImgW, currentImgH);
        
        btnEncode.disabled = false; btnSave.disabled = false; btnDebugRoundtrip.disabled = true;
    };
    reader.readAsArrayBuffer(file);
});

if (btnDebugRoundtrip) btnDebugRoundtrip.addEventListener('click', async () => {
    if (!originalImageData) return;
    btnDebugRoundtrip.disabled = true; btnDebugRoundtrip.innerText = "Prüfe...";
    
    let fmt = formatSelect.value;
    let is16 = (fmt === "HAM12" || fmt === "HAM16");
    let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
    let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
    
    if (is16) await debugRoundtripHam12_16(originalImageData.data, currentImgW, currentImgH, fmt, getGlobalStep(), strategy, metric);
    else await debugRoundtripPaletted(originalImageData.data, currentImgW, currentImgH, fmt, getGlobalStep(), globalPaletteRAM, getGlobalOffset(), strategy, metric);
    
    btnDebugRoundtrip.disabled = false; btnDebugRoundtrip.innerText = "4. Debug Vergleichen";
});

// ============================================================================
// MODAL & BUILDER LOGIC (Exklusive Slot-Zuweisung & automatischer Sprung)
// ============================================================================
const builderModal = document.getElementById('builder-modal');
const btnBuilderCancel = document.getElementById('btn-builder-cancel');
const btnBuilderAuto = document.getElementById('btn-builder-auto');
const autoStepModal = document.getElementById('auto-step-modal');
const btnAutoStepClose = document.getElementById('btn-auto-step-close');
const analysisModal = document.getElementById('analysis-modal');
const btnAnalysisClose = document.getElementById('btn-analysis-close');

let selectedTargetSlot = null;

function generateTop10Html(top10Array) {
    return top10Array.length > 0 
        ? top10Array.map((e, idx) => `
            <div class="top10-cluster-item" data-r="${e.r2}" data-g="${e.g2}" data-b="${e.b2}" style="font-size:10px; margin-bottom:3px; padding:4px 6px; background:#111; border-radius:3px; border:1px solid #333; cursor:pointer; display:flex; align-items:center; justify-content:space-between;" title="Klicken, um Soll-Farbe in den gewählten Slot zu schreiben">
                <div style="display:flex; align-items:center; gap:6px; pointer-events:none;">
                    <span style="color:#888; font-weight:bold;">#${idx+1}</span>
                    <div style="width:12px; height:12px; background:rgb(${e.r1},${e.g1},${e.b1}); border:1px solid #668; border-radius:2px;" title="Ist"></div>
                    <span>➡</span>
                    <div style="width:12px; height:12px; background:rgb(${e.r2},${e.g2},${e.b2}); border:1px solid #688; border-radius:2px;" title="Soll"></div>
                    <span style="color:#ccc;">RGB(${e.r2},${e.g2},${e.b2})</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px; pointer-events:none;">
                    <span style="color:#4dabf7;">${e.count}x Px</span>
                    <span style="color:#ff6b6b; font-weight:bold;">MSE: ${e.mse.toFixed(1)}</span>
                </div>
            </div>`).join('')
        : '<div style="font-size:11px; color:#aaa; padding:10px;">Keine Abweichungen gefunden.</div>';
}

function generateHistogramHtml(histArray) {
    return histArray.length > 0
        ? histArray.map((e, idx) => `
            <div class="hist-color-item" data-r="${e.r}" data-g="${e.g}" data-b="${e.b}" style="font-size:10px; margin-bottom:3px; display:flex; align-items:center; justify-content:space-between; padding:3px 6px; background:#181a1c; border-radius:3px; border:1px solid #333; cursor:pointer;" title="Klicken, um Farbe in den gewählten Slot zu schreiben">
                <div style="display:flex; align-items:center; gap:6px; pointer-events:none;">
                    <span style="color:#888; width:15px; font-weight:bold;">#${idx+1}</span>
                    <div style="width:12px; height:12px; background:rgb(${e.r},${e.g},${e.b}); border:1px solid #888; border-radius:2px;"></div>
                    <span style="color:#ccc;">RGB(${e.r},${e.g},${e.b})</span>
                </div>
                <span style="color:#4dabf7; font-weight:bold; pointer-events:none;">${e.count}x</span>
            </div>
        `).join('')
        : '<div style="font-size:11px; color:#aaa; padding:10px;">Keine Daten.</div>';
}

if (btnBuilder && builderModal) {
    btnBuilder.addEventListener('click', () => {
        if (!originalImageData) { alert("Bitte zuerst ein Bild laden."); return; }
        builderModal.style.display = 'flex';
        
        let fmtSpan = document.getElementById('b-fmt');
        let offsetSpan = document.getElementById('b-bank-title');
        let statusDiv = document.getElementById('builder-status');
        let previewContainer = document.getElementById('builder-palette-preview');
        let mseListDiv = document.getElementById('builder-mse-list');
        let histListDiv = document.getElementById('builder-hist-list');
        
        if (fmtSpan) fmtSpan.innerText = currentFormat;
        let currentOffset = getGlobalOffset();
        let step = getGlobalStep();
        let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
        if (offsetSpan) offsetSpan.innerText = `Offset ${currentOffset}`;
        
        let config = HAM_CONFIGS[currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;
        
        if (!selectedTargetSlot) {
            selectedTargetSlot = { index: 0, absSlot: currentOffset % 256 };
        }
        
        if (statusDiv) statusDiv.innerHTML = `Bank aktiv (${slots} Slots). <span id='builder-instruction' style='color:#ffc107; font-weight:bold;'>Aktiv: Slot ${selectedTargetSlot.index}. Klicke einen Eintrag zum Zuweisen.</span>`;
        
        if (previewContainer) {
            previewContainer.innerHTML = "";
            for (let i = 0; i < slots; i++) {
                let absSlot = (currentOffset + i) % 256;
                let r = globalPaletteRAM[absSlot * 3], g = globalPaletteRAM[absSlot * 3 + 1], b = globalPaletteRAM[absSlot * 3 + 2];
                
                let slotDiv = document.createElement('div');
                slotDiv.className = 'builder-slot';
                slotDiv.style.backgroundColor = rgbToHex(r, g, b);
                slotDiv.title = `Slot ${i} (RAM ${absSlot}): RGB(${r},${g},${b})`;
                slotDiv.innerText = i;
                
                if (selectedTargetSlot && selectedTargetSlot.index === i) {
                    slotDiv.style.border = '2px solid #ffc107';
                }
                
                slotDiv.addEventListener('click', () => {
                    document.querySelectorAll('.builder-slot').forEach(s => s.style.border = '1px solid #444');
                    slotDiv.style.border = '2px solid #ffc107';
                    selectedTargetSlot = { index: i, absSlot: absSlot };
                    let instr = document.getElementById('builder-instruction');
                    if (instr) instr.innerHTML = `Slot ${i} ausgewählt. <span style='color:#4dabf7;'>Klicke nun auf einen Eintrag!</span>`;
                });
                previewContainer.appendChild(slotDiv);
            }
        }
        
        if (mseListDiv && mseListDiv.previousElementSibling) mseListDiv.previousElementSibling.innerText = "Top 10 Fehler-Cluster";
        if (histListDiv && histListDiv.previousElementSibling) histListDiv.previousElementSibling.innerText = "Top 10 Bild-Histogramm";
        
        async function applyColorToSelectedSlot(r, g, b) {
            if (!selectedTargetSlot) {
                alert("Bitte zuerst einen Slot auswählen!");
                return;
            }
            
           // Exakt diesen Slot im RAM überschreiben
            let absSlot = selectedTargetSlot.absSlot;
            globalPaletteRAM[absSlot * 3] = r;
            globalPaletteRAM[absSlot * 3 + 1] = g;
            globalPaletteRAM[absSlot * 3 + 2] = b;
            
            await triggerAutoReencode();
            
            // Nächsten Slot berechnen (Strict + 1)
            let nextIdx = selectedTargetSlot.index + 1;
            if (nextIdx >= slots) nextIdx = 0; // Wrap-around
            
            let nextAbsSlot = (currentOffset + nextIdx) % 256;
            selectedTargetSlot = { index: nextIdx, absSlot: nextAbsSlot };
            
            // Re-render ohne das komplette Modal zuzumachen, falls möglich
            btnBuilder.click(); 
            handleFormatChange();
        }

        if (mseListDiv && decodedImageData && originalImageData) {
            let stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric);
            mseListDiv.innerHTML = generateTop10Html(stats.global.top10);
            
            mseListDiv.onclick = null;
            mseListDiv.addEventListener('click', async (ev) => {
                let item = ev.target.closest('.top10-cluster-item');
                if (!item) return;
                await applyColorToSelectedSlot(
                    parseInt(item.dataset.r),
                    parseInt(item.dataset.g),
                    parseInt(item.dataset.b)
                );
            });
        } else if (mseListDiv) {
            mseListDiv.innerHTML = '<div style="font-size:11px; color:#aaa;">Bitte zuerst Bild codieren für Fehleranalyse.</div>';
        }

        if (histListDiv && originalImageData) {
            import('./core/analysis.js').then(module => {
                let histData = module.getImageHistogram(originalImageData, currentImgW, currentImgH, step, 10, globalPaletteRAM, currentOffset);
                histListDiv.innerHTML = generateHistogramHtml(histData);
                
                histListDiv.onclick = null;
                histListDiv.addEventListener('click', async (ev) => {
                    let item = ev.target.closest('.hist-color-item');
                    if (!item) return;
                    await applyColorToSelectedSlot(
                        parseInt(item.dataset.r),
                        parseInt(item.dataset.g),
                        parseInt(item.dataset.b)
                    );
                });
            });
        }
    });
}

if (btnBuilderCancel && builderModal) {
    btnBuilderCancel.addEventListener('click', () => {
        builderModal.style.display = 'none';
        handleFormatChange();
    });
}

if (btnBuilderAuto) {
    btnBuilderAuto.addEventListener('click', async () => {
        if (!originalImageData) return;
        let config = HAM_CONFIGS[currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;
        let currentOffset = getGlobalOffset();
        let step = getGlobalStep();
        
        autoFillPaletteFromImage(originalImageData, currentImgW, currentImgH, globalPaletteRAM, currentOffset, slots, step);
        await triggerAutoReencode();
        
        alert(`Palette für ${slots} Slots intelligent befüllt und Bild neu codiert!`);
        btnBuilder.click(); 
        handleFormatChange();
    });
}

if (btnAnalysis && analysisModal) {
    btnAnalysis.addEventListener('click', () => {
        if (!decodedImageData || !originalImageData) { alert("Bitte zuerst das Bild codieren."); return; }
        analysisModal.style.display = 'flex';
        
        let step = getGlobalStep();
        let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
        let stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric);
        
        let top5Div = document.getElementById('analysis-top5');
        if (top5Div) {
            if (top5Div.previousElementSibling) top5Div.previousElementSibling.innerText = "Gesamtbild: Top 10 Fehler-Cluster";
            top5Div.innerHTML = generateTop10Html(stats.global.top10);
        }

        let histBody = document.getElementById('analysis-histogram-body');
        if (histBody) {
            let rows = [];
            let rgbBins = stats.histogram.rgbBins;
            let yuvBins = stats.histogram.yuvBins;
            
            for (let b = 0; b <= errorBins.length; b++) {
                let rangeLabel = b === 0 ? `<= ${errorBins[0]}` : b === errorBins.length ? `> ${errorBins[errorBins.length-1]}` : `${errorBins[b-1]} - ${errorBins[b]}`;
                let rgbCount = rgbBins[b] || 0;
                let yuvCount = yuvBins[b] || 0;
                let rgbPct = ((rgbCount / totalPixels) * 100).toFixed(2);
                let yuvPct = ((yuvCount / totalPixels) * 100).toFixed(2);
                rows.push(`<tr><td>${rangeLabel}</td><td>${rgbCount}</td><td>${rgbPct}%</td><td>${yuvCount}</td><td>${yuvPct}%</td></tr>`);
            }
            histBody.innerHTML = rows.join('');
        }
    });
}

if (btnAnalysisClose && analysisModal) btnAnalysisClose.addEventListener('click', () => analysisModal.style.display = 'none');
if (btnAutoStepClose && autoStepModal) btnAutoStepClose.addEventListener('click', () => autoStepModal.style.display = 'none');

window.addEventListener('click', (e) => {
    if (e.target === builderModal) { builderModal.style.display = 'none'; handleFormatChange(); }
    if (e.target === autoStepModal) autoStepModal.style.display = 'none';
    if (e.target === analysisModal) analysisModal.style.display = 'none';
});