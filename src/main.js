// src/main.js

import { setZoomMode, updateView, centerOnCoordinate, redrawCanvasWithHighlight, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { encodeStream } from './core/engine-stream.js';
import { decodeStream } from './core/decoder.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { computeDetailedAnalysis, runSimulationWithStrategy, errorBins } from './core/analysis.js';
import { simulateBuilderEncode } from './core/builder.js';
import { hexToRgb, rgbToHex, clamp } from './codecs/utils.js';

// --- GLOBALE STATES ---
let currentImgW = 0, currentImgH = 0, totalPixels = 0;
let originalColorsCount = 0;
let originalImageData = null;
let decodedImageData = null;
let currentFormat = "HAM12"; 
let latestPackedData = null;

let globalPaletteRAM = new Uint8Array(256 * 3);
let userSegments = []; 
let editingSegmentIndex = -1;
let currentBuilderSlot = 1;

// --- DOM ELEMENTE ---
const formatSelect = document.getElementById('format');
const hamStepGroup = document.getElementById('ham-step-group');
const hamStepInput = document.getElementById('ham-step');
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
const segStepInput = document.getElementById('seg-step');
const segBankInput = document.getElementById('seg-bank');
const streamListDiv = document.getElementById('stream-list');
const btnAddSegment = document.getElementById('btn-add-segment');

const btnAutoStep = document.getElementById('btn-auto-step');
const autoMinInput = document.getElementById('auto-min-step');
const autoMaxInput = document.getElementById('auto-max-step');

// --- INIT UI ---
setupCanvasEvents(() => ({ w: currentImgW, h: currentImgH }));

function updateStatusTextDimAndColors(decColorCount, stats = null) {
    let statText = "";
    if (stats) {
        statText = ` | Anker: ${stats.anchorCount} | Deltas: ${stats.deltaCount} (Turbo: ${stats.turboCount})`;
    }
    document.getElementById('img-dim-text').innerText = 
        `Größe: ${currentImgW}x${currentImgH} px | Farben: ${originalColorsCount} / ${decColorCount}${statText}`;
}

function updateProgress(prefix, current, total, startTime) {
    if (current > 0 && current % 10 === 0 || current === total) {
        let elapsed = ((Date.now() - startTime) / 1000 / current) * (total - current);
        document.getElementById('progress').value = (current / total) * 100;
        document.getElementById('status-text').innerText = 
            `${prefix} - Pixel ${current}/${total} | ETA: ${Math.round(elapsed)}s`;
    }
}

// --- PALETTEN & FORMAT UI ---
function updateBankPickers() {
    paletteContainer.innerHTML = "";
    let f = formatSelect.value;
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let slotsPerBank = config.slotsPerBank || 8;
    let currentBank = parseInt(palBankSelect.value) || 0;
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
        });
        paletteContainer.appendChild(input);
    }
}

function populateBankDropdown() {
    palBankSelect.innerHTML = "";
    let f = formatSelect.value;
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let slotsPerBank = config.slotsPerBank || 8;
    let maxBänke = slotsPerBank > 0 ? Math.floor(256 / slotsPerBank) : 1;

    for(let b = 0; b < maxBänke; b++) {
        let opt = document.createElement('option');
        opt.value = b;
        opt.innerText = `Bank ${b} (${b * slotsPerBank}-${(b + 1) * slotsPerBank - 1})`;
        palBankSelect.appendChild(opt);
    }
    segBankInput.max = Math.max(0, maxBänke - 1);
    updateBankPickers();
}

function handleFormatChange() {
    let f = formatSelect.value;
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let isPalFormat = config.isPaletted;

    paletteBox.style.display = isPalFormat ? 'block' : 'none';
    hamStepGroup.style.display = 'flex'; 
    hamStepInput.disabled = false;
    segStepInput.disabled = false;
    segBankInput.disabled = !isPalFormat;

    if(isPalFormat) populateBankDropdown();
}

formatSelect.addEventListener('change', handleFormatChange);
palBankSelect.addEventListener('change', () => { segBankInput.value = palBankSelect.value; updateBankPickers(); });
segBankInput.addEventListener('input', () => { palBankSelect.value = segBankInput.value; updateBankPickers(); });

// --- BILD LADEN ---
function countUniqueColors(imgData) {
    let set = new Set();
    for (let i = 0; i < imgData.length; i += 4) { 
        set.add((imgData[i] << 16) | (imgData[i+1] << 8) | imgData[i+2]); 
    }
    return set.size;
}

btnLoad.addEventListener('click', () => fileImg.click());
fileImg.addEventListener('change', (e) => {
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
            
            editingSegmentIndex = -1;
            segStartPxInput.value = 0; 
            segEndPxInput.value = totalPixels; 
            userSegments = [];
            btnAddSegment.innerText = "Hinzufügen";
            
            updateStreamUI(); 
            handleFormatChange();

            btnEncode.disabled = false; btnBuilder.disabled = false; btnSave.disabled = true; btnAnalysis.disabled = false;
            let mseDisp = document.getElementById('avg-mse-display');
            if(mseDisp) mseDisp.style.display = 'none';
            document.getElementById('status-text').innerText = "Bild geladen.";
            setZoomMode('fit', currentImgW, currentImgH);
        }
        img.src = ev.target.result;
    }
    reader.readAsDataURL(file);
});

// --- SEGMENT STREAM LOGIK ---
function triggerCanvasHighlight() {
    let sPx = parseInt(segStartPxInput.value) || 0;
    let ePx = parseInt(segEndPxInput.value) || totalPixels;
    redrawCanvasWithHighlight(originalImageData, decodedImageData, currentImgW, currentImgH, sPx, ePx, totalPixels);
}

btnAddSegment.addEventListener('click', () => {
    if (!totalPixels) return;
    let startPx = parseInt(segStartPxInput.value) || 0;
    let endPx = parseInt(segEndPxInput.value) || totalPixels;
    let step = parseInt(segStepInput.value) || 4;
    let bank = parseInt(segBankInput.value) || 0;

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
    segStartPxInput.value = lastEnd;
    segEndPxInput.value = totalPixels;
    
    updateStreamUI(); 
    triggerCanvasHighlight();
});

window.editSegment = function(idx) {
    editingSegmentIndex = idx;
    let s = userSegments[idx];
    let prevEnd = idx === 0 ? 0 : userSegments[idx - 1].absEnd;
    segStartPxInput.value = prevEnd;
    segEndPxInput.value = s.absEnd;
    segBankInput.value = s.bank;
    segStepInput.value = s.step;
    palBankSelect.value = s.bank;
    updateBankPickers();
    btnAddSegment.innerText = "Aktualisieren";
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
    btnAddSegment.innerText = "Hinzufügen";
    
    let lastEnd = userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0;
    segStartPxInput.value = lastEnd;
    segEndPxInput.value = totalPixels;
    updateStreamUI(); 
    triggerCanvasHighlight();
};

document.getElementById('btn-clear-segments').addEventListener('click', () => {
    userSegments = []; 
    editingSegmentIndex = -1;
    btnAddSegment.innerText = "Hinzufügen";
    segStartPxInput.value = 0; 
    segEndPxInput.value = totalPixels;
    updateStreamUI(); 
    triggerCanvasHighlight();
});

segEndPxInput.addEventListener('input', triggerCanvasHighlight);

function updateStreamUI() {
    if (userSegments.length === 0) { 
        streamListDiv.innerHTML = "<i>Keine Segmente.</i>"; 
        return; 
    }
    let html = "";
    userSegments.forEach((s, idx) => {
        let prevEnd = idx === 0 ? 0 : userSegments[idx - 1].absEnd;
        html += `<div style="display:flex; justify-content:space-between; margin-bottom:2px; background:#eee; padding:2px 4px;">
            <span>[#${idx + 1}] ${prevEnd}&rarr;${s.absEnd} (B:${s.bank}, S:${s.step})</span>
            <span><a href="#" onclick="editSegment(${idx})">✏️</a> <a href="#" onclick="deleteSegment(event, ${idx})">❌</a></span>
        </div>`;
    });
    streamListDiv.innerHTML = html;
}

// --- KERN-ENCODER & DECODER ---
btnEncode.addEventListener('click', async () => {
    if (!currentImgW || !currentImgH) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    currentFormat = formatSelect.value;
    document.getElementById('decoded-label').innerText = `DEKODIERT (${currentFormat})`;
    
    btnLoad.disabled = true; btnEncode.disabled = true; btnSave.disabled = true; 
    btnBuilder.disabled = true; btnAnalysis.disabled = true;

    let config = HAM_CONFIGS[currentFormat];
    let strategy = encodeStrategySelect.value;
    let metric = encodeMetricSelect.value;
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
    
    let startTime = Date.now();

    let encodeResult = await encodeStream(
        originalImageData.data, currentImgW, currentImgH, currentFormat, 
        userSegments, globalPaletteRAM, strategy, metric, max_depth, 
        (current, total) => updateProgress("[1/2] Encode", current, total, startTime)
    );

    latestPackedData = encodeResult.packedData;
    let commandArray = encodeResult.commandArray;
    let stats = encodeResult.stats;

    let decodedPixels = decodeStream(commandArray, currentImgW, currentImgH, globalPaletteRAM, userSegments, config);
    
    ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);
    decodedImageData = ctxDecoded.getImageData(0, 0, currentImgW, currentImgH);
    
    updateStatusTextDimAndColors(countUniqueColors(decodedPixels), stats);
    document.getElementById('progress').value = 100; 
    document.getElementById('status-text').innerText = `Fertig. Modus: ${currentFormat}`;
    triggerCanvasHighlight();

    btnLoad.disabled = false; btnEncode.disabled = false; btnSave.disabled = false; 
    btnBuilder.disabled = false; btnAnalysis.disabled = false;
});

// --- ANALYSIS MODAL ---
window.splitAtPixel = function(pixelIdx) {
    let targetPx = Math.max(0, pixelIdx - 1);
    document.getElementById('analysis-modal').style.display = 'none';
    
    let start = 0;
    for(let i = 0; i < userSegments.length; i++) {
        if (targetPx < userSegments[i].absEnd) { start = i === 0 ? 0 : userSegments[i - 1].absEnd; break; }
    }
    if (targetPx >= (userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0)) {
        start = userSegments.length > 0 ? userSegments[userSegments.length - 1].absEnd : 0;
    }
    
    editingSegmentIndex = -1;
    btnAddSegment.innerText = "Hinzufügen";
    segStartPxInput.value = start;
    segEndPxInput.value = targetPx;
    triggerCanvasHighlight();
}
window.centerOnCoordinate = function(x, y) { centerOnCoordinate(x, y, currentImgW, currentImgH); }

btnAnalysis.addEventListener('click', () => {
    if(!latestPackedData || !currentImgW) { alert("Bitte lade und codiere zuerst ein Bild."); return; }
    
    let sPx = parseInt(segStartPxInput.value) || 0;
    let ePx = parseInt(segEndPxInput.value) || totalPixels;
    
    const stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, sPx, ePx);
    
    document.getElementById('ana-seg-start').innerText = sPx;
    document.getElementById('ana-seg-end').innerText = ePx;
    
    let avgMseDisplay = document.getElementById('avg-mse-display');
    avgMseDisplay.innerText = `⌀ RGB: ${stats.global.avgRgb.toFixed(2)} | ⌀ YUV: ${stats.global.avgYuv.toFixed(2)}`;
    avgMseDisplay.style.display = 'inline';
    
    document.getElementById('ana-seg-avg').innerHTML = `<b>⌀ RGB MSE:</b> ${stats.segment.avgRgb.toFixed(2)} &nbsp;|&nbsp; <b>⌀ YUV MSE:</b> ${stats.segment.avgYuv.toFixed(2)}`;

    let renderTop5 = (list) => list.map((e, i) => `<div>#${i + 1}: Px ${e.pixelIdx} (${e.details}) | MSE: ${Math.round(e.mse)} 
        | <a href="#" onclick="centerOnCoordinate(${e.x}, ${e.y})">Zentrieren</a>
        | <a href="#" style="color:red;" onclick="splitAtPixel(${e.pixelIdx})">Trennen</a></div>`).join('');

    document.getElementById('analysis-seg-top5').innerHTML = renderTop5(stats.segment.top5) || "<i>Keine Fehler.</i>";
    document.getElementById('analysis-top5').innerHTML = renderTop5(stats.global.top5);

    let tableHtml = "";
    for(let i = 0; i <= errorBins.length; i++) {
        let label = i === errorBins.length ? `> ${errorBins[errorBins.length - 1]}` : (i === 0 ? `0` : `${errorBins[i - 1] + 1} - ${errorBins[i]}`);
        tableHtml += `<tr><td>${label}</td><td>${stats.histogram.rgbBins[i]}</td><td>${((stats.histogram.rgbBins[i] / totalPixels) * 100).toFixed(2)}%</td><td>${stats.histogram.yuvBins[i]}</td><td>${((stats.histogram.yuvBins[i] / totalPixels) * 100).toFixed(2)}%</td></tr>`;
    }
    document.getElementById('analysis-histogram-body').innerHTML = tableHtml;

    document.getElementById('analysis-modal').style.display = 'block';
});

document.getElementById('btn-analysis-close').addEventListener('click', () => {
    document.getElementById('analysis-modal').style.display = 'none';
});

// --- BUILDER MODAL LOGIK ---
btnBuilder.addEventListener('click', () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    let f = formatSelect.value;
    let config = HAM_CONFIGS[f];
    if (!config.isPaletted) {
        alert("Der Paletten-Builder ist nur für palettenbasierte Formate verfügbar!");
        return;
    }
    
    document.getElementById('b-fmt').innerText = f;
    document.getElementById('builder-modal').style.display = 'block';
    refreshBuilderUI();
});

function refreshBuilderUI() {
    let bankIdx = parseInt(palBankSelect.value) || 0;
    document.getElementById('b-bank-title').innerText = `Bank ${bankIdx}`;
    
    let f = formatSelect.value;
    let config = HAM_CONFIGS[f];
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
        slotDiv.style.border = '1px solid #000';
        slotDiv.style.cursor = 'pointer';
        slotDiv.title = `Slot ${slotIdx}`;
        slotDiv.addEventListener('click', () => {
            currentBuilderSlot = slotIdx;
            runBuilderAnalysis();
        });
        previewContainer.appendChild(slotDiv);
    }
    runBuilderAnalysis();
}

function runBuilderAnalysis() {
    let sPx = parseInt(segStartPxInput.value) || 0;
    let ePx = parseInt(segEndPxInput.value) || totalPixels;
    let stepVal = parseInt(hamStepInput.value) || 4;

    let results = simulateBuilderEncode(
        sPx, ePx, originalImageData.data, currentImgW, 
        Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]), 
        currentBuilderSlot, stepVal, currentFormat
    );

    document.getElementById('builder-mse-list').innerHTML = results.topMse.map((e, idx) => 
        `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span>#${idx + 1}: <span style="display:inline-block;width:12px;height:12px;background:${e.hex};border:1px solid #000;"></span> ${e.hex} (MSE: ${Math.round(e.val)})</span>
            <button onclick="assignColorToSlot('${e.hex}')">Übernehmen</button>
         </div>`).join('') || "<i>Keine Fehler.</i>";

    document.getElementById('builder-hist-list').innerHTML = results.topHist.map((e, idx) => 
        `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span>#${idx + 1}: <span style="display:inline-block;width:12px;height:12px;background:${e.hex};border:1px solid #000;"></span> ${e.hex} (${e.count}x)</span>
            <button onclick="assignColorToSlot('${e.hex}')">Übernehmen</button>
         </div>`).join('') || "<i>Keine Farben.</i>";
    
    document.getElementById('builder-status').innerText = `Analysiert Slot ${currentBuilderSlot} (Segment Px ${sPx} bis ${ePx})`;
}

window.assignColorToSlot = function(hex) {
    let [r, g, b] = hexToRgb(hex);
    globalPaletteRAM[currentBuilderSlot * 3] = r;
    globalPaletteRAM[currentBuilderSlot * 3 + 1] = g;
    globalPaletteRAM[currentBuilderSlot * 3 + 2] = b;
    updateBankPickers();
    refreshBuilderUI();
}

document.getElementById('btn-builder-cancel').addEventListener('click', () => {
    document.getElementById('builder-modal').style.display = 'none';
});

document.getElementById('btn-builder-auto').addEventListener('click', () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let sPx = parseInt(segStartPxInput.value) || 0;
    let ePx = parseInt(segEndPxInput.value) || totalPixels;
    let stepVal = parseInt(hamStepInput.value) || 4;

    let bankIdx = parseInt(palBankSelect.value) || 0;
    let config = HAM_CONFIGS[currentFormat];
    let slotsPerBank = config.slotsPerBank;
    let startSlot = bankIdx * slotsPerBank;

    document.getElementById('builder-status').innerText = "Fülle Bank automatisch... Bitte warten!";

    setTimeout(() => {
        for (let i = 0; i < slotsPerBank; i++) {
            let currentSlot = startSlot + i;
            let results = simulateBuilderEncode(
                sPx, ePx, originalImageData.data, currentImgW, 
                Array.from({length: 256}, (_, idx) => [globalPaletteRAM[idx * 3], globalPaletteRAM[idx * 3 + 1], globalPaletteRAM[idx * 3 + 2]]), 
                currentSlot, stepVal, currentFormat
            );

            let bestHex = "#000000";
            if (results.topMse.length > 0) bestHex = results.topMse[0].hex;
            else if (results.topHist.length > 0) bestHex = results.topHist[0].hex;

            let [r, g, b] = hexToRgb(bestHex);
            globalPaletteRAM[currentSlot * 3] = r;
            globalPaletteRAM[currentSlot * 3 + 1] = g;
            globalPaletteRAM[currentSlot * 3 + 2] = b;
        }
        
        updateBankPickers();
        refreshBuilderUI();
        document.getElementById('builder-status').innerText = `Bank ${bankIdx} erfolgreich optimiert!`;
    }, 50);
});

// --- AUTO SCHRITTWEITEN LOGIK ---
btnAutoStep.addEventListener('click', () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let minStep = parseInt(autoMinInput.value) || 1;
    let maxStep = parseInt(autoMaxInput.value) || 16;
    if (minStep > maxStep) { alert("Min muss kleiner/gleich Max sein!"); return; }

    document.getElementById('auto-step-modal').style.display = 'block';
    document.getElementById('auto-step-status').innerText = `Berechne Schrittweiten von ${minStep} bis ${maxStep}...`;
    let tbody = document.getElementById('auto-step-body');
    tbody.innerHTML = "";

    let sPx = parseInt(segStartPxInput.value) || 0;
    let ePx = parseInt(segEndPxInput.value) || totalPixels;
    
    let strategy = encodeStrategySelect.value;
    let metric = encodeMetricSelect.value;
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;

    setTimeout(async () => {
        let results = [];
        let pal = Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]);

        for (let s = minStep; s <= maxStep; s++) {
            let res = await runSimulationWithStrategy(sPx, ePx, originalImageData.data, currentImgW, pal, s, strategy, metric, max_depth, currentFormat);
            results.push({ step: s, ...res });
        }

        results.sort((a, b) => a.avgYuv - b.avgYuv);

        results.forEach(r => {
            let tr = document.createElement('tr');
            tr.innerHTML = `
                <td>± ${r.step}</td>
                <td>${r.avgRgb.toFixed(2)}</td>
                <td>${r.avgYuv.toFixed(2)}</td>
                <td>${Math.round(r.maxYuv)}</td>
                <td><button onclick="applyAutoStep(${r.step})">Anwenden</button></td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('auto-step-recommendation').innerText = `🏆 Empfehlung: Schrittweite ±${results[0].step} (YUV: ${results[0].avgYuv.toFixed(2)})`;
        document.getElementById('auto-step-status').innerText = "Berechnung abgeschlossen.";
    }, 50);
});

window.applyAutoStep = function(stepVal) {
    hamStepInput.value = stepVal;
    segStepInput.value = stepVal;
    
    if (editingSegmentIndex >= 0) {
        userSegments[editingSegmentIndex].step = stepVal;
        updateStreamUI();
    }
    
    document.getElementById('auto-step-modal').style.display = 'none';
};

document.getElementById('btn-auto-step-close').addEventListener('click', () => {
    document.getElementById('auto-step-modal').style.display = 'none';
});

// --- BILD/DATEN SPEICHERN ---
btnSave.addEventListener('click', () => {
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