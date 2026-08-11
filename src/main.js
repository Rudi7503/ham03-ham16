// src/main.js

import { setZoomMode, updateView, centerOnCoordinate, redrawCanvasWithHighlight, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { encodeStream } from './core/engine-stream.js';
import { decodeStream } from './core/decoder.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { computeDetailedAnalysis, runSimulationWithStrategy, errorBins } from './core/analysis.js';
import { simulateBuilderEncode } from './core/builder.js';
import { hexToRgb, rgbToHex, clamp, get_rgb_dist, get_yuv_dist, get_yuv_dist_weight } from './codecs/utils.js';

// --- GLOBALE STATES ---
let currentImgW = 0, currentImgH = 0, totalPixels = 0;
let originalColorsCount = 0;
let originalImageData = null;
let decodedImageData = null;
let currentFormat = "HAM12"; 
let latestPackedData = null;
let latestCommandArray = null;

let globalPaletteRAM = new Uint8Array(256 * 3);
let userSegments = []; 
let editingSegmentIndex = -1;
let currentBuilderSlot = 0;

// --- DOM ELEMENTE ---
const formatSelect = document.getElementById('format');
const hamStepGroup = document.getElementById('ham-step-group');

const hamStepR = document.getElementById('ham-step-r');
const hamStepG = document.getElementById('ham-step-g');
const hamStepB = document.getElementById('ham-step-b');

const encodeStrategySelect = document.getElementById('encode-strategy');
const encodeMetricSelect = document.getElementById('encode-metric');

const paletteBox = document.getElementById('palette-box');
const palBankSelect = document.getElementById('pal-bank-select');
const paletteContainer = document.getElementById('palette-pickers-container');

const btnLoad = document.getElementById('btn-load');
const btnEncode = document.getElementById('btn-encode');
const btnSave = document.getElementById('btn-save');
const btnBuilder = document.getElementById('btn-builder');
const btnAnalysis = document.getElementById('btn-analysis');
const fileImg = document.getElementById('file-img');

const canvasOriginal = document.getElementById('canvas-original');
const ctxOriginal = canvasOriginal.getContext('2d', { willReadFrequently: true });
const canvasDecoded = document.getElementById('canvas-decoded');
const ctxDecoded = canvasDecoded.getContext('2d', { willReadFrequently: true });

const segStartPxInput = document.getElementById('seg-start-px');
const segEndPxInput = document.getElementById('seg-end-px');

const segStepR = document.getElementById('seg-step-r');
const segStepG = document.getElementById('seg-step-g');
const segStepB = document.getElementById('seg-step-b');

const segBankInput = document.getElementById('seg-bank');
const streamListDiv = document.getElementById('stream-list');
const btnAddSegment = document.getElementById('btn-add-segment');

const btnAutoStep = document.getElementById('btn-auto-step');
const autoMinInput = document.getElementById('auto-min-step');
const autoMaxInput = document.getElementById('auto-max-step');

// --- HILFSFUNKTION FÜR SCHRITTWEITEN ---
function getEffectiveSegments() {
    if (userSegments.length > 0) return userSegments;
    return [{
        absEnd: totalPixels,
        waitPixels: totalPixels,
        bank: palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0,
        step: {
            r: hamStepR ? (parseInt(hamStepR.value) || 4) : 4,
            g: hamStepG ? (parseInt(hamStepG.value) || 4) : 4,
            b: hamStepB ? (parseInt(hamStepB.value) || 4) : 4
        }
    }];
}

// --- INIT UI ---
setupCanvasEvents(() => ({ w: currentImgW, h: currentImgH }));

['fit', '1x', '2x', '4x', '8x'].forEach(mode => {
    let btn = document.getElementById(`btn-zoom-${mode}`);
    if (btn) btn.addEventListener('click', () => setZoomMode(mode, currentImgW, currentImgH));
});

function updateStatusTextDimAndColors(decColorCount, stats = null) {
    let statText = stats ? ` | Anker: ${stats.anchorCount} | Deltas: ${stats.deltaCount} (Turbo: ${stats.turboCount})` : "";
    let dimTextEl = document.getElementById('img-dim-text');
    if (dimTextEl) {
        dimTextEl.innerText = `Größe: ${currentImgW}x${currentImgH} px | Farben: ${originalColorsCount} / ${decColorCount}${statText}`;
    }
}

// Verbesserte phasenbasierte Fortschrittsanzeige
let lastPhase = "";
let phaseStartTime = 0;

function updateProgressDetail(phase, current, total) {
    if (phase !== lastPhase) {
        lastPhase = phase;
        phaseStartTime = Date.now();
    }
    
    if (current > 0 && current % 10 === 0 || current === total || total <= 1) {
        let elapsed = (Date.now() - phaseStartTime) / 1000;
        let eta = 0;
        if (current > 0) {
            let speed = current / elapsed;
            eta = (total - current) / speed;
        }
        
        let progressEl = document.getElementById('progress');
        if(progressEl) progressEl.value = total > 0 ? (current / total) * 100 : 100;
        
        let statusTextEl = document.getElementById('status-text');
        if (statusTextEl) {
            let etaText = (current === 0 || !isFinite(eta)) ? "..." : Math.round(eta) + "s";
            if (total <= 1) etaText = "Verarbeite...";
            statusTextEl.innerText = `[${phase}] - ${current}/${total} | ETA: ${etaText}`;
        }
    }
}

function refreshDecodedImage() {
    if (!latestCommandArray || !currentImgW) return;
    let config = HAM_CONFIGS[currentFormat];
    let decodedPixels = decodeStream(latestCommandArray, currentImgW, currentImgH, globalPaletteRAM, getEffectiveSegments(), config);
    ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);
    decodedImageData = ctxDecoded.getImageData(0, 0, currentImgW, currentImgH);
    triggerCanvasHighlight();
}

// --- PALETTEN & FORMAT UI ---
function updateBankPickers() {
    if (!paletteContainer) return;
    paletteContainer.innerHTML = "";
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let slotsPerBank = config.slotsPerBank || 8;
    let currentBank = palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0;
    let startSlot = currentBank * slotsPerBank;

    for(let i = 0; i < slotsPerBank; i++) {
        let slotIdx = startSlot + i;
        let r = globalPaletteRAM[slotIdx * 3], g = globalPaletteRAM[slotIdx * 3 + 1], b = globalPaletteRAM[slotIdx * 3 + 2];
        
        let input = document.createElement('input');
        input.type = 'color'; 
        input.className = 'palette-picker';
        input.value = rgbToHex(r, g, b);
        input.title = `Slot ${slotIdx}`;
        input.addEventListener('input', (e) => {
            let [nr, ng, nb] = hexToRgb(e.target.value);
            globalPaletteRAM[slotIdx * 3] = nr; 
            globalPaletteRAM[slotIdx * 3 + 1] = ng; 
            globalPaletteRAM[slotIdx * 3 + 2] = nb;
            refreshDecodedImage();
        });
        paletteContainer.appendChild(input);
    }
}

function populateBankDropdown() {
    if (!palBankSelect) return;
    palBankSelect.innerHTML = "";
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let slotsPerBank = config.slotsPerBank || 8;
    let maxBänke = slotsPerBank > 0 ? Math.floor(256 / slotsPerBank) : 1;

    for(let b = 0; b < maxBänke; b++) {
        let opt = document.createElement('option');
        opt.value = b;
        opt.innerText = `Bank ${b} (${b * slotsPerBank}-${(b + 1) * slotsPerBank - 1})`;
        palBankSelect.appendChild(opt);
    }
    if (segBankInput) segBankInput.max = Math.max(0, maxBänke - 1);
    updateBankPickers();
}

function handleFormatChange() {
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let isPalFormat = config.isPaletted;

    if (paletteBox) paletteBox.style.display = isPalFormat ? 'block' : 'none';
    if (hamStepGroup) hamStepGroup.style.display = 'flex'; 
    if (hamStepR) hamStepR.disabled = false; 
    if (hamStepG) hamStepG.disabled = false; 
    if (hamStepB) hamStepB.disabled = false;
    
    if (segStepR) segStepR.disabled = false; 
    if (segStepG) segStepG.disabled = false; 
    if (segStepB) segStepB.disabled = false;
    
    if (segBankInput) segBankInput.disabled = !isPalFormat;

    if(isPalFormat) populateBankDropdown();
}

function handleStrategyVisibility() {
    let strat = encodeStrategySelect ? encodeStrategySelect.value : "";
    let hypGroup = document.getElementById('hybrid-group');
    if (hypGroup) {
        hypGroup.style.display = strat.startsWith('hybrid') ? 'flex' : 'none';
    }
}

if (formatSelect) formatSelect.addEventListener('change', handleFormatChange);
if (encodeStrategySelect) encodeStrategySelect.addEventListener('change', handleStrategyVisibility);
handleStrategyVisibility();

if (palBankSelect) palBankSelect.addEventListener('change', () => { if (segBankInput) segBankInput.value = palBankSelect.value; updateBankPickers(); });
if (segBankInput) segBankInput.addEventListener('input', () => { if (palBankSelect) palBankSelect.value = segBankInput.value; updateBankPickers(); });

// --- BILD LADEN ---
function countUniqueColors(imgData) {
    let set = new Set();
    for (let i = 0; i < imgData.length; i += 4) { 
        set.add((imgData[i] << 16) | (imgData[i+1] << 8) | imgData[i+2]); 
    }
    return set.size;
}

if (btnLoad) btnLoad.addEventListener('click', () => { if(fileImg) fileImg.click(); });
if (fileImg) fileImg.addEventListener('change', (e) => {
    let file = e.target.files[0]; 
    if (!file) return;
    let reader = new FileReader();
    reader.onload = function(ev) {
        let img = new Image();
        img.onload = function() {
            currentImgW = img.width; 
            currentImgH = img.height; 
            totalPixels = currentImgW * currentImgH;
            
            canvasOriginal.width = currentImgW; 
            canvasOriginal.height = currentImgH;
            ctxOriginal.drawImage(img, 0, 0);
            
            originalImageData = ctxOriginal.getImageData(0, 0, currentImgW, currentImgH);
            originalColorsCount = countUniqueColors(originalImageData.data);

            updateStatusTextDimAndColors(0);
            canvasDecoded.width = currentImgW; 
            canvasDecoded.height = currentImgH;
            ctxDecoded.clearRect(0, 0, currentImgW, currentImgH);
            decodedImageData = null;
            latestCommandArray = null;
            
            editingSegmentIndex = -1;
            
            let startInp = document.getElementById('seg-start-px');
            let endInp = document.getElementById('seg-end-px');
            if (startInp) startInp.value = 0; 
            if (endInp) endInp.value = totalPixels; 
            
            userSegments = [];
            if (btnAddSegment) btnAddSegment.innerText = "Hinzufügen";
            
            updateStreamUI(); 
            handleFormatChange();

            if (btnEncode) btnEncode.disabled = false; 
            if (btnBuilder) btnBuilder.disabled = false; 
            if (btnSave) btnSave.disabled = true; 
            if (btnAnalysis) btnAnalysis.disabled = false;

            let mseDisp = document.getElementById('avg-mse-display');
            if(mseDisp) mseDisp.style.display = 'none';
            
            let statusText = document.getElementById('status-text');
            if(statusText) statusText.innerText = "Bild geladen.";
            
            setZoomMode('fit', currentImgW, currentImgH);
        }
        img.src = ev.target.result;
    }
    reader.readAsDataURL(file);
});

// --- SEGMENT STREAM LOGIK ---
function triggerCanvasHighlight() {
    if (!originalImageData || !currentImgW) return;
    
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    
    let sPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let ePx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    redrawCanvasWithHighlight(originalImageData, decodedImageData, currentImgW, currentImgH, sPx, ePx, totalPixels);
}

if (btnAddSegment) btnAddSegment.addEventListener('click', () => {
    if (!totalPixels) return;
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    
    let startPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let endPx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    let step = { 
        r: segStepR ? (parseInt(segStepR.value) || 4) : 4, 
        g: segStepG ? (parseInt(segStepG.value) || 4) : 4, 
        b: segStepB ? (parseInt(segStepB.value) || 4) : 4 
    };
    let bank = segBankInput ? (parseInt(segBankInput.value) || 0) : 0;

    if (endPx <= 0 || endPx > totalPixels) { alert("Ungültiges End-Pixel!"); return; }

    if (editingSegmentIndex >= 0) {
        userSegments[editingSegmentIndex].absEnd = endPx;
        userSegments[editingSegmentIndex].bank = bank;
        userSegments[editingSegmentIndex].step = step;
        editingSegmentIndex = -1;
        btnAddSegment.innerText = "Hinzufügen";
    } else {
        let existIdx = userSegments.findIndex(s => s.absEnd === endPx);
        if (existIdx >= 0) {
            userSegments[existIdx].bank = bank;
            userSegments[existIdx].step = step;
        } else {
            userSegments.push({ absEnd: endPx, waitPixels: 0, bank: bank, step: step });
        }
    }

    userSegments.sort((a, b) => a.absEnd - b.absEnd);
    for(let i = 0; i < userSegments.length; i++) {
        let pEnd = i === 0 ? 0 : userSegments[i - 1].absEnd;
        userSegments[i].waitPixels = userSegments[i].absEnd - pEnd;
    }

    let lastEnd = userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0;
    if (startInput) startInput.value = lastEnd;
    if (endInput) endInput.value = totalPixels;
    
    updateStreamUI(); 
    triggerCanvasHighlight();
});

window.editSegment = function(idx) {
    editingSegmentIndex = idx;
    let s = userSegments[idx];
    let prevEnd = idx === 0 ? 0 : userSegments[idx - 1].absEnd;
    
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    if (startInput) startInput.value = prevEnd;
    if (endInput) endInput.value = s.absEnd;
    if (segBankInput) segBankInput.value = s.bank;
    
    if (segStepR) segStepR.value = s.step.r; 
    if (segStepG) segStepG.value = s.step.g; 
    if (segStepB) segStepB.value = s.step.b;
    
    if (palBankSelect) palBankSelect.value = s.bank;
    updateBankPickers();
    if (btnAddSegment) btnAddSegment.innerText = "Aktualisieren";
    triggerCanvasHighlight();
};

window.deleteSegment = function(e, idx) {
    e.stopPropagation();
    userSegments.splice(idx, 1);
    for(let i = 0; i < userSegments.length; i++) {
        let pEnd = i === 0 ? 0 : userSegments[i - 1].absEnd;
        userSegments[i].waitPixels = userSegments[i].absEnd - pEnd;
    }
    editingSegmentIndex = -1;
    if (btnAddSegment) btnAddSegment.innerText = "Hinzufügen";
    
    let lastEnd = userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0;
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    if (startInput) startInput.value = lastEnd;
    if (endInput) endInput.value = totalPixels;
    
    updateStreamUI(); 
    triggerCanvasHighlight();
};

let btnClearSegs = document.getElementById('btn-clear-segments');
if (btnClearSegs) btnClearSegs.addEventListener('click', () => {
    userSegments = []; 
    editingSegmentIndex = -1;
    if (btnAddSegment) btnAddSegment.innerText = "Hinzufügen";
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    if (startInput) startInput.value = 0; 
    if (endInput) endInput.value = totalPixels;
    updateStreamUI(); 
    triggerCanvasHighlight();
});

let segEndInputEl = document.getElementById('seg-end-px');
if (segEndInputEl) segEndInputEl.addEventListener('input', triggerCanvasHighlight);

function updateStreamUI() {
    if (!streamListDiv) return;
    if (userSegments.length === 0) { 
        streamListDiv.innerHTML = "<i>Keine Segmente.</i>"; 
        return; 
    }
    let html = "";
    userSegments.forEach((s, idx) => {
        let prevEnd = idx === 0 ? 0 : userSegments[idx - 1].absEnd;
        html += `<div style="display:flex; justify-content:space-between; margin-bottom:2px; background:#eee; padding:2px 4px;">
            <span>[#${idx + 1}] ${prevEnd}&rarr;${s.absEnd} (B:${s.bank}, S:[${s.step.r},${s.step.g},${s.step.b}])</span>
            <span><a href="#" onclick="editSegment(${idx})">✏️</a> <a href="#" onclick="deleteSegment(event, ${idx})">❌</a></span>
        </div>`;
    });
    streamListDiv.innerHTML = html;
}

// --- KERN-ENCODER & DECODER ---
if (btnEncode) btnEncode.addEventListener('click', async () => {
    if (!currentImgW || !currentImgH) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    currentFormat = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[currentFormat];
    
    if (config && config.isPaletted && globalPaletteRAM[0] === 0 && globalPaletteRAM[1] === 0 && globalPaletteRAM[2] === 0) {
        globalPaletteRAM[0] = originalImageData.data[0];
        globalPaletteRAM[1] = originalImageData.data[1];
        globalPaletteRAM[2] = originalImageData.data[2];
        updateBankPickers();
    }

    let decLabel = document.getElementById('decoded-label');
    if (decLabel) decLabel.innerText = `DEKODIERT (${currentFormat})`;
    
    btnLoad.disabled = true; btnEncode.disabled = true; if(btnSave) btnSave.disabled = true; 
    if(btnBuilder) btnBuilder.disabled = true; if(btnAnalysis) btnAnalysis.disabled = true;

    let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
    let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
    
    let hypPercentInp = document.getElementById('hybrid-percent');
    let hybridPercent = hypPercentInp ? (parseFloat(hypPercentInp.value) || 5.0) : 5.0;

    let encodeResult = await encodeStream(
        originalImageData.data, currentImgW, currentImgH, currentFormat, 
        getEffectiveSegments(), globalPaletteRAM, strategy, metric, max_depth, 
        (phase, current, total) => updateProgressDetail(phase, current, total),
        0, 0, hybridPercent
    );

    latestPackedData = encodeResult.packedData;
    latestCommandArray = encodeResult.commandArray;
    let stats = encodeResult.stats;

    updateProgressDetail("Phase 4: Dekodierung & Rendering", 0, 1);
    await new Promise(r => setTimeout(r, 20));
    
    let decStart = Date.now();
    let decodedPixels = decodeStream(latestCommandArray, currentImgW, currentImgH, globalPaletteRAM, getEffectiveSegments(), config);
    
    ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);
    decodedImageData = ctxDecoded.getImageData(0, 0, currentImgW, currentImgH);
    
    let decTime = Date.now() - decStart;

    updateStatusTextDimAndColors(countUniqueColors(decodedPixels), stats);
    let progressEl = document.getElementById('progress');
    if(progressEl) progressEl.value = 100; 
    
    let statusEl = document.getElementById('status-text');
    if(statusEl) statusEl.innerText = `✅ Fertig! (Modus: ${currentFormat}, Renderzeit: ${decTime}ms)`;
    triggerCanvasHighlight();

    btnLoad.disabled = false; btnEncode.disabled = false; if(btnSave) btnSave.disabled = false; 
    if(btnBuilder) btnBuilder.disabled = false; if(btnAnalysis) btnAnalysis.disabled = false;
});

// --- ANALYSIS MODAL ---
window.splitAtPixel = function(pixelIdx) {
    let targetPx = Math.max(0, pixelIdx - 1);
    let modal = document.getElementById('analysis-modal');
    if (modal) modal.style.display = 'none';
    
    let start = 0;
    for(let i = 0; i < userSegments.length; i++) {
        if (targetPx < userSegments[i].absEnd) { start = i === 0 ? 0 : userSegments[i - 1].absEnd; break; }
    }
    if (targetPx >= (userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0)) {
        start = userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0;
    }
    
    editingSegmentIndex = -1;
    if (btnAddSegment) btnAddSegment.innerText = "Hinzufügen";
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    if (startInput) startInput.value = start;
    if (endInput) endInput.value = targetPx;
    triggerCanvasHighlight();
}
window.centerOnCoordinate = function(x, y) { centerOnCoordinate(x, y, currentImgW, currentImgH); }

if (btnAnalysis) btnAnalysis.addEventListener('click', () => {
    if(!latestPackedData || !currentImgW) { alert("Bitte lade und codiere zuerst ein Bild."); return; }
    
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    let sPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let ePx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    const stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, sPx, ePx);
    
    let anaStart = document.getElementById('ana-seg-start');
    if (anaStart) anaStart.innerText = sPx;
    let anaEnd = document.getElementById('ana-seg-end');
    if (anaEnd) anaEnd.innerText = ePx;
    
    let avgMseDisplay = document.getElementById('avg-mse-display');
    if (avgMseDisplay) {
        avgMseDisplay.innerText = `⌀ RGB: ${stats.global.avgRgb.toFixed(2)} | ⌀ YUV: ${stats.global.avgYuv.toFixed(2)}`;
        avgMseDisplay.style.display = 'inline';
    }
    
    let anaSegAvg = document.getElementById('ana-seg-avg');
    if (anaSegAvg) anaSegAvg.innerHTML = `<b>⌀ RGB MSE:</b> ${stats.segment.avgRgb.toFixed(2)} &nbsp;|&nbsp; <b>⌀ YUV MSE:</b> ${stats.segment.avgYuv.toFixed(2)}`;

    let renderTop5 = (list) => list.map((e, i) => `<div>#${i + 1}: Px ${e.pixelIdx} (${e.details}) | MSE: ${Math.round(e.mse)} 
        | <a href="#" onclick="centerOnCoordinate(${e.x}, ${e.y})">Zentrieren</a>
        | <a href="#" style="color:red;" onclick="splitAtPixel(${e.pixelIdx})">Trennen</a></div>`).join('');

    let anaSegTop5 = document.getElementById('analysis-seg-top5');
    if (anaSegTop5) anaSegTop5.innerHTML = renderTop5(stats.segment.top5) || "<i>Keine Fehler.</i>";
    
    let anaTop5 = document.getElementById('analysis-top5');
    if (anaTop5) anaTop5.innerHTML = renderTop5(stats.global.top5);

    let tableHtml = "";
    for(let i = 0; i <= errorBins.length; i++) {
        let label = i === errorBins.length ? `> ${errorBins[errorBins.length - 1]}` : (i === 0 ? `0` : `${errorBins[i - 1] + 1} - ${errorBins[i]}`);
        tableHtml += `<tr><td>${label}</td><td>${stats.histogram.rgbBins[i]}</td><td>${((stats.histogram.rgbBins[i] / totalPixels) * 100).toFixed(2)}%</td><td>${stats.histogram.yuvBins[i]}</td><td>${((stats.histogram.yuvBins[i] / totalPixels) * 100).toFixed(2)}%</td></tr>`;
    }
    let histBody = document.getElementById('analysis-histogram-body');
    if (histBody) histBody.innerHTML = tableHtml;

    let modal = document.getElementById('analysis-modal');
    if (modal) modal.style.display = 'block';
});

let btnAnaClose = document.getElementById('btn-analysis-close');
if (btnAnaClose) btnAnaClose.addEventListener('click', () => {
    let modal = document.getElementById('analysis-modal');
    if (modal) modal.style.display = 'none';
});

// --- BUILDER MODAL LOGIK ---
let builderMetricSelect = document.getElementById('builder-metric');
if (builderMetricSelect) builderMetricSelect.addEventListener('change', runBuilderAnalysis);

if (btnBuilder) btnBuilder.addEventListener('click', () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f];
    if (!config || !config.isPaletted) {
        alert("Der Paletten-Builder ist nur für palettenbasierte Formate verfügbar!");
        return;
    }
    
    let bFmt = document.getElementById('b-fmt');
    if (bFmt) bFmt.innerText = f;
    
    let bankIdx = palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0;
    currentBuilderSlot = bankIdx * config.slotsPerBank;

    let modal = document.getElementById('builder-modal');
    if (modal) modal.style.display = 'block';
    refreshBuilderUI();
});

function refreshBuilderUI() {
    let bankIdx = palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0;
    let bankTitle = document.getElementById('b-bank-title');
    if (bankTitle) bankTitle.innerText = `Bank ${bankIdx}`;
    
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f];
    if (!config) return;
    
    let slotsPerBank = config.slotsPerBank;
    let startSlot = bankIdx * slotsPerBank;
    
    let previewContainer = document.getElementById('builder-palette-preview');
    if (!previewContainer) return;
    
    previewContainer.innerHTML = "";
    
    for (let i = 0; i < slotsPerBank; i++) {
        let slotIdx = startSlot + i;
        let r = globalPaletteRAM[slotIdx * 3], g = globalPaletteRAM[slotIdx * 3 + 1], b = globalPaletteRAM[slotIdx * 3 + 2];
        let slotDiv = document.createElement('div');
        slotDiv.className = 'builder-slot';
        slotDiv.style.width = '24px';
        slotDiv.style.height = '24px';
        slotDiv.style.backgroundColor = rgbToHex(r, g, b);
        
        if (slotIdx === currentBuilderSlot) {
            slotDiv.style.border = '3px solid #007bff';
        } else {
            slotDiv.style.border = '1px solid #000';
        }
        
        slotDiv.style.cursor = 'pointer';
        slotDiv.title = `Slot ${slotIdx}`;
        slotDiv.addEventListener('click', () => {
            currentBuilderSlot = slotIdx;
            refreshBuilderUI();
        });
        previewContainer.appendChild(slotDiv);
    }
    runBuilderAnalysis();
}

function runBuilderAnalysis() {
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    let sPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let ePx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    let stepVal = { 
        r: hamStepR ? (parseInt(hamStepR.value) || 4) : 4, 
        g: hamStepG ? (parseInt(hamStepG.value) || 4) : 4, 
        b: hamStepB ? (parseInt(hamStepB.value) || 4) : 4 
    };

    let bMetric = builderMetricSelect ? builderMetricSelect.value : 'yuv_weight';

    let results = simulateBuilderEncode(
        sPx, ePx, originalImageData.data, currentImgW, 
        Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]), 
        currentBuilderSlot, stepVal, currentFormat, bMetric
    );

    let mseListEl = document.getElementById('builder-mse-list');
    if (mseListEl) {
        mseListEl.innerHTML = results.topMse.map((e, idx) => 
            `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span>#${idx + 1}: <span style="display:inline-block;width:12px;height:12px;background:${e.hex};border:1px solid #000;"></span> ${e.hex} (MSE: ${Math.round(e.val)})</span>
                <button onclick="assignColorToSlot('${e.hex}')">Übernehmen</button>
             </div>`).join('') || "<i>Keine Fehler.</i>";
    }

    let histListEl = document.getElementById('builder-hist-list');
    if (histListEl) {
        histListEl.innerHTML = results.topHist.map((e, idx) => 
            `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span>#${idx + 1}: <span style="display:inline-block;width:12px;height:12px;background:${e.hex};border:1px solid #000;"></span> ${e.hex} (${e.count}x)</span>
                <button onclick="assignColorToSlot('${e.hex}')">Übernehmen</button>
             </div>`).join('') || "<i>Keine Farben.</i>";
    }
    
    let statusEl = document.getElementById('builder-status');
    if (statusEl) {
        statusEl.innerText = `Analysiert Slot ${currentBuilderSlot} (Segment Px ${sPx} bis ${ePx})`;
    }
}

window.assignColorToSlot = function(hex) {
    let [r, g, b] = hexToRgb(hex);
    globalPaletteRAM[currentBuilderSlot * 3] = r;
    globalPaletteRAM[currentBuilderSlot * 3 + 1] = g;
    globalPaletteRAM[currentBuilderSlot * 3 + 2] = b;
    
    let bankIdx = palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0;
    let config = HAM_CONFIGS[currentFormat];
    let maxSlot = (bankIdx * config.slotsPerBank) + config.slotsPerBank - 1;
    if (currentBuilderSlot < maxSlot) {
        currentBuilderSlot++;
    }
    
    updateBankPickers();
    refreshBuilderUI();
    refreshDecodedImage();
}

let btnBuildCancel = document.getElementById('btn-builder-cancel');
if (btnBuildCancel) btnBuildCancel.addEventListener('click', () => {
    let modal = document.getElementById('builder-modal');
    if (modal) modal.style.display = 'none';
});

// CLOSED-LOOP ITERATIVE PALETTE OPTIMIZER
let btnBuildAuto = document.getElementById('btn-builder-auto');
if (btnBuildAuto) btnBuildAuto.addEventListener('click', async () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    let sPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let ePx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    let bankIdx = palBankSelect ? (parseInt(palBankSelect.value) || 0) : 0;
    let config = HAM_CONFIGS[currentFormat];
    let slotsPerBank = config.slotsPerBank;
    let startSlot = bankIdx * slotsPerBank;

    let statusEl = document.getElementById('builder-status');
    
    for (let i = 0; i < slotsPerBank; i++) {
        let currentSlot = startSlot + i;
        globalPaletteRAM[currentSlot * 3] = 0;
        globalPaletteRAM[currentSlot * 3 + 1] = 0;
        globalPaletteRAM[currentSlot * 3 + 2] = 0;
    }
    updateBankPickers();
    refreshBuilderUI();

    let strategy = encodeStrategySelect ? encodeStrategySelect.value : 'both';
    let bMetric = builderMetricSelect ? builderMetricSelect.value : 'yuv_weight';
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;

    for (let i = 0; i < slotsPerBank; i++) {
        let currentSlot = startSlot + i;
        if (statusEl) statusEl.innerText = `Optimiere Slot ${currentSlot} (${i + 1}/${slotsPerBank}) durch echten Codec...`;
        await new Promise(r => setTimeout(r, 20)); 

        let encodeResult = await encodeStream(
            originalImageData.data, currentImgW, currentImgH, currentFormat, 
            getEffectiveSegments(), globalPaletteRAM, strategy, bMetric, max_depth, 
            null, sPx, ePx
        );
        
        let decodedPixels = decodeStream(encodeResult.commandArray, currentImgW, currentImgH, globalPaletteRAM, getEffectiveSegments(), config);
        
        ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);
        triggerCanvasHighlight();
        await new Promise(r => setTimeout(r, 10));

        let errorMap = new Map();
        let histMap = new Map();
        let end = Math.min(totalPixels, ePx);

        for (let p = sPx; p < end; p++) {
            let idx = p * 4;
            let r1 = originalImageData.data[idx], g1 = originalImageData.data[idx+1], b1 = originalImageData.data[idx+2];
            let r2 = decodedPixels[idx], g2 = decodedPixels[idx+1], b2 = decodedPixels[idx+2];
            
            let hex = rgbToHex(r1, g1, b1);
            histMap.set(hex, (histMap.get(hex) || 0) + 1);
            
            let err = 0;
            if (bMetric === 'yuv_weight') err = get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'yuv') err = get_yuv_dist(r1, g1, b1, r2, g2, b2);
            else err = get_rgb_dist(r1, g1, b1, r2, g2, b2);
            
            errorMap.set(hex, (errorMap.get(hex) || 0) + err);
        }

        let worstHex = "#000000";
        let maxScore = -1;

        for (let [hex, count] of histMap.entries()) {
            let avgErr = errorMap.get(hex) / count;
            let totalError = errorMap.get(hex); 
            if (avgErr > 2 && totalError > maxScore) {
                maxScore = totalError;
                worstHex = hex;
            }
        }

        if (maxScore === -1 && histMap.size > 0) {
            let maxCount = -1;
            for (let [hex, count] of histMap.entries()) {
                if (count > maxCount) { maxCount = count; worstHex = hex; }
            }
        }

        let [wr, wg, wb] = hexToRgb(worstHex);
        globalPaletteRAM[currentSlot * 3] = wr;
        globalPaletteRAM[currentSlot * 3 + 1] = wg;
        globalPaletteRAM[currentSlot * 3 + 2] = wb;
        
        currentBuilderSlot = currentSlot;
        updateBankPickers();
        refreshBuilderUI();
    }

    if (statusEl) statusEl.innerText = "Erstelle finales Bild...";
    await new Promise(r => setTimeout(r, 20));

    let finalEncode = await encodeStream(
        originalImageData.data, currentImgW, currentImgH, currentFormat, 
        getEffectiveSegments(), globalPaletteRAM, strategy, bMetric, max_depth, 
        null, 0, totalPixels
    );
    
    latestCommandArray = finalEncode.commandArray;
    refreshDecodedImage();
    
    if (statusEl) statusEl.innerText = `Bank ${bankIdx} erfolgreich iterativ optimiert!`;
});

// --- AUTO SCHRITTWEITEN LOGIK ---
if (btnAutoStep) btnAutoStep.addEventListener('click', async () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let minInput = document.getElementById('auto-min-step');
    let maxInput = document.getElementById('auto-max-step');
    let minStep = minInput ? (parseInt(minInput.value) || 1) : 1;
    let maxStep = maxInput ? (parseInt(maxInput.value) || 16) : 16;

    if (minStep > maxStep) { alert("Min muss kleiner/gleich Max sein!"); return; }

    let modal = document.getElementById('auto-step-modal');
    if (modal) modal.style.display = 'block';
    
    let statusEl = document.getElementById('auto-step-status');
    let tbody = document.getElementById('auto-step-body');
    if (tbody) tbody.innerHTML = "";
    
    let recEl = document.getElementById('auto-step-recommendation');
    if (recEl) recEl.innerText = "";

    let startInput = document.getElementById('seg-start-px');
    let endInput = document.getElementById('seg-end-px');
    let sPx = startInput ? (parseInt(startInput.value) || 0) : 0;
    let ePx = endInput ? (parseInt(endInput.value) || totalPixels) : totalPixels;
    
    let strategy = encodeStrategySelect ? encodeStrategySelect.value : 'both';
    let metric = encodeMetricSelect ? encodeMetricSelect.value : 'yuv_weight';
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;

    let pal = Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]);

    async function evaluateStep(r, g, b) {
        return await runSimulationWithStrategy(sPx, ePx, originalImageData.data, currentImgW, pal, {r, g, b}, strategy, metric, max_depth, currentFormat);
    }

    let bestUniformYuv = Infinity;
    let bestStep = { r: minStep, g: minStep, b: minStep };
    let initialStats = null;

    for (let s = minStep; s <= maxStep; s++) {
        if (statusEl) statusEl.innerText = `Phase 1: Suche einheitliche Schrittweite ${s} von ${maxStep}...`;
        await new Promise(res => setTimeout(res, 10));

        let res = await evaluateStep(s, s, s);
        if (res.avgYuv < bestUniformYuv) {
            bestUniformYuv = res.avgYuv;
            bestStep = { r: s, g: s, b: s };
            initialStats = res;
        }
    }

    if (tbody && initialStats) {
        tbody.innerHTML += `<tr>
            <td>Basis: [${bestStep.r}, ${bestStep.g}, ${bestStep.b}]</td>
            <td>${initialStats.avgRgb.toFixed(2)}</td>
            <td>${initialStats.avgYuv.toFixed(2)}</td>
            <td>${Math.round(initialStats.maxYuv)}</td>
            <td><button onclick="applyAutoStep(${bestStep.r}, ${bestStep.g}, ${bestStep.b})">Anwenden</button></td>
        </tr>`;
    }

    let channels = ['r', 'g', 'b'];
    let bestYuv = bestUniformYuv;
    let finalStats = initialStats;

    for (let ch of channels) {
        let improved = true;
        while (improved) {
            improved = false;
            let currentVal = bestStep[ch];

            if (statusEl) statusEl.innerText = `Phase 2: Optimiere Kanal [${ch.toUpperCase()}] um ${currentVal}...`;
            await new Promise(res => setTimeout(res, 10));

            if (currentVal > 1) {
                let testMinus = { ...bestStep };
                testMinus[ch] = currentVal - 1;
                let resMinus = await evaluateStep(testMinus.r, testMinus.g, testMinus.b);
                if (resMinus.avgYuv < bestYuv) {
                    bestYuv = resMinus.avgYuv;
                    bestStep = testMinus;
                    finalStats = resMinus;
                    improved = true;
                    continue;
                }
            }

            if (!improved && currentVal < 128) {
                let testPlus = { ...bestStep };
                testPlus[ch] = currentVal + 1;
                let resPlus = await evaluateStep(testPlus.r, testPlus.g, testPlus.b);
                if (resPlus.avgYuv < bestYuv) {
                    bestYuv = resPlus.avgYuv;
                    bestStep = testPlus;
                    finalStats = resPlus;
                    improved = true;
                }
            }
        }
    }

    if (tbody && finalStats) {
        tbody.innerHTML += `<tr style="background: rgba(40,167,69,0.2);">
            <td><strong>Optimal: [${bestStep.r}, ${bestStep.g}, ${bestStep.b}]</strong></td>
            <td>${finalStats.avgRgb.toFixed(2)}</td>
            <td>${finalStats.avgYuv.toFixed(2)}</td>
            <td>${Math.round(finalStats.maxYuv)}</td>
            <td><button onclick="applyAutoStep(${bestStep.r}, ${bestStep.g}, ${bestStep.b})">Anwenden</button></td>
        </tr>`;
    }

    if (recEl) {
        recEl.innerText = `🏆 Koordinatenabstieg beendet! Bestes Ergebnis: RGB [${bestStep.r}, ${bestStep.g}, ${bestStep.b}] (YUV: ${bestYuv.toFixed(2)})`;
    }
    if (statusEl) statusEl.innerText = "Berechnung abgeschlossen.";
});

window.applyAutoStep = function(r, g, b) {
    if (hamStepR) hamStepR.value = r; 
    if (hamStepG) hamStepG.value = g; 
    if (hamStepB) hamStepB.value = b;
    
    if (segStepR) segStepR.value = r; 
    if (segStepG) segStepG.value = g; 
    if (segStepB) segStepB.value = b;
    
    if (editingSegmentIndex >= 0) {
        userSegments[editingSegmentIndex].step = { r, g, b };
        updateStreamUI();
    }
    
    let modal = document.getElementById('auto-step-modal');
    if (modal) modal.style.display = 'none';
};

let btnAutoClose = document.getElementById('btn-auto-step-close');
if (btnAutoClose) btnAutoClose.addEventListener('click', () => {
    let modal = document.getElementById('auto-step-modal');
    if (modal) modal.style.display = 'none';
});

// --- BILD/DATEN SPEICHERN ---
if (btnSave) btnSave.addEventListener('click', () => {
    if (!latestPackedData) {
        alert("Es gibt keine kodierten Daten zum Speichern. Bitte zuerst kodieren!");
        return;
    }
    
    const blob = new Blob([latestPackedData], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    a.href = url;
    a.download = `ham_encoded_${currentFormat.toLowerCase()}.bin`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});