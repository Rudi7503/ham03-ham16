import { setZoomMode, updateView, centerOnCoordinate, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { encodeStream } from './core/engine-stream.js';
import { decodeStream } from './core/decoder.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { computeDetailedAnalysis, runSimulationWithStrategy, errorBins } from './core/analysis.js';
import { simulateBuilderEncode } from './core/builder.js';
import { hexToRgb, rgbToHex, countUniqueColors, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_rgb_dist, get_rgb_abs_dist, get_redmean_dist, get_oklab_dist } from './codecs/utils.js';

// --- GLOBALE STATES ---
let currentImgW = 0, currentImgH = 0, totalPixels = 0;
let originalColorsCount = 0;
let originalImageData = null;
let decodedImageData = null;
let currentFormat = "HAM12"; 
let latestPackedData = null;
let latestCommandArray = null;

let globalPaletteRAM = new Uint8Array(256 * 3);
let currentBuilderSlot = 0; // RELATIV ZUM OFFSET!

let encodeHistory = [];

// --- DOM ELEMENTE ---
const formatSelect = document.getElementById('format');
const hamStepGroup = document.getElementById('ham-step-group');
const hamStepR = document.getElementById('ham-step-r');
const hamStepG = document.getElementById('ham-step-g');
const hamStepB = document.getElementById('ham-step-b');

const encodeStrategySelect = document.getElementById('encode-strategy');
const encodeMetricSelect = document.getElementById('encode-metric');

const paletteBox = document.getElementById('palette-box');
const palOffsetInput = document.getElementById('pal-offset-input');
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

const btnAutoStep = document.getElementById('btn-auto-step');
const historyListDiv = document.getElementById('history-list');

// --- HILFSFUNKTION: GLOBALER STEP ---
function getGlobalSegment() {
    return [{
        absEnd: totalPixels,
        waitPixels: totalPixels,
        offset: palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0,
        step: {
            r: hamStepR ? (parseInt(hamStepR.value) || 4) : 4,
            g: hamStepG ? (parseInt(hamStepG.value) || 4) : 4,
            b: hamStepB ? (parseInt(hamStepB.value) || 4) : 4
        }
    }];
}

// --- INIT UI ---
setupCanvasEvents(
    () => ({ w: currentImgW, h: currentImgH }),
    () => ({
        original: originalImageData, 
        decoded: decodedImageData
    })
);

['fit', '1x', '2x', '4x', '8x', '16x', '32x'].forEach(mode => {
    let btn = document.getElementById(`btn-zoom-${mode}`);
    if (btn) btn.addEventListener('click', () => setZoomMode(mode, currentImgW, currentImgH));
});

function updateStatusTextDimAndColors(decColorCount, stats = null) {
    let statText = stats ? ` | Anker: ${stats.anchorCount} | Deltas: ${stats.deltaCount} (Turbo: ${stats.turboCount})` : "";
    let dimTextEl = document.getElementById('img-dim-text');
    if (dimTextEl) {
        dimTextEl.innerText = `Größe: ${currentImgW}x${currentImgH} px | Farben: ${originalColorsCount} / ${decColorCount} | Modus: ${currentFormat}${statText}`;
    }
}

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
    let decodedPixels = decodeStream(latestCommandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);
    ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);
    decodedImageData = ctxDecoded.getImageData(0, 0, currentImgW, currentImgH);
}

// --- HISTORY LOGIK ---
function renderHistory() {
    if (!historyListDiv) return;
    if (encodeHistory.length === 0) { 
        historyListDiv.innerHTML = "<i>Noch keine Einträge.</i>"; 
        return; 
    }
    
    let html = "";
    encodeHistory.forEach((h, idx) => {
        html += `<div class="stream-tag" onclick="loadHistoryItem(${idx})" title="Klicken zum Wiederherstellen">
            [#${idx + 1}] ${h.format} | ${h.strategy} | S:[${h.step.r},${h.step.g},${h.step.b}] | ${h.time}ms
        </div>`;
    });
    historyListDiv.innerHTML = html;
}

window.loadHistoryItem = function(idx) {
    let h = encodeHistory[idx];
    if (!h) return;
    
    currentFormat = h.format;
    if (formatSelect) formatSelect.value = h.format;
    if (encodeStrategySelect) encodeStrategySelect.value = h.strategy;
    if (encodeMetricSelect) encodeMetricSelect.value = h.metric;
    if (hamStepR) hamStepR.value = h.step.r;
    if (hamStepG) hamStepG.value = h.step.g;
    if (hamStepB) hamStepB.value = h.step.b;
    if (palOffsetInput) palOffsetInput.value = h.offset;
    handleFormatChange();
    
    globalPaletteRAM.set(h.palette);
    updatePalettePickers();
    
    latestPackedData = h.packedData;
    latestCommandArray = h.commandArray;
    
    ctxDecoded.putImageData(h.decodedImageData, 0, 0);
    decodedImageData = h.decodedImageData;
    
    let set = new Set();
    let dData = decodedImageData.data;
    for (let i = 0; i < dData.length; i += 4) { 
        set.add((dData[i] << 16) | (dData[i+1] << 8) | dData[i+2]); 
    }
    
    updateStatusTextDimAndColors(set.size, h.stats);
    let statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.innerText = `✅ Verlauf [#${idx + 1}] geladen!`;
    
    if (btnSave) btnSave.disabled = false; 
    if (btnAnalysis) btnAnalysis.disabled = false;
};

// --- PALETTEN & FORMAT UI ---
function updatePalettePickers() {
    if (!paletteContainer) return;
    paletteContainer.innerHTML = "";
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f] || HAM_CONFIGS["HAM12"];
    let slotsPerBank = (config && config.slotsPerBank) ? config.slotsPerBank : (f === "HAM8" ? 64 : 16);
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;

    for(let i = 0; i < slotsPerBank; i++) {
        let absoluteSlot = (currentOffset + i) % 256;
        let r = globalPaletteRAM[absoluteSlot * 3], g = globalPaletteRAM[absoluteSlot * 3 + 1], b = globalPaletteRAM[absoluteSlot * 3 + 2];
        
        let input = document.createElement('input');
        input.type = 'color'; 
        input.className = 'palette-picker';
        input.value = rgbToHex(r, g, b);
        input.title = `Slot ${i} (RAM: ${absoluteSlot})`;
        input.addEventListener('input', (e) => {
            let [nr, ng, nb] = hexToRgb(e.target.value);
            globalPaletteRAM[absoluteSlot * 3] = nr; 
            globalPaletteRAM[absoluteSlot * 3 + 1] = ng; 
            globalPaletteRAM[absoluteSlot * 3 + 2] = nb;
            refreshDecodedImage();
        });
        paletteContainer.appendChild(input);
    }
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
    
    if(isPalFormat) updatePalettePickers();
    
    if (decodedImageData) {
        let set = new Set();
        let dData = decodedImageData.data;
        for (let i = 0; i < dData.length; i += 4) { 
            set.add((dData[i] << 16) | (dData[i+1] << 8) | dData[i+2]); 
        }
        updateStatusTextDimAndColors(set.size);
    }
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
if (palOffsetInput) {
    palOffsetInput.addEventListener('change', () => { updatePalettePickers(); });
    palOffsetInput.addEventListener('input', () => { updatePalettePickers(); });
}

// --- BILD LADEN ---
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
            
            let tempCanvas = document.createElement('canvas');
            tempCanvas.width = currentImgW;
            tempCanvas.height = currentImgH;
            let tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
            
            tempCtx.fillStyle = '#000000';
            tempCtx.fillRect(0, 0, currentImgW, currentImgH);
            tempCtx.drawImage(img, 0, 0);
            
            originalImageData = tempCtx.getImageData(0, 0, currentImgW, currentImgH);
            ctxOriginal.putImageData(originalImageData, 0, 0);

            let set = new Set();
            for (let i = 0; i < originalImageData.data.length; i += 4) { 
                set.add((originalImageData.data[i] << 16) | (originalImageData.data[i+1] << 8) | originalImageData.data[i+2]); 
            }
            originalColorsCount = set.size;

            updateStatusTextDimAndColors(0);
            canvasDecoded.width = currentImgW; 
            canvasDecoded.height = currentImgH;
            ctxDecoded.clearRect(0, 0, currentImgW, currentImgH);
            decodedImageData = null;
            latestCommandArray = null;
            
            renderHistory(); 
            handleFormatChange();

            if (btnEncode) btnEncode.disabled = false; 
            if (btnBuilder) btnBuilder.disabled = false; 
            if (btnSave) btnSave.disabled = true; 
            if (btnAnalysis) btnAnalysis.disabled = false;

            let mseDisp = document.getElementById('avg-mse-display');
            if(mseDisp) mseDisp.style.display = 'none';
            
            let statusText = document.getElementById('status-text');
            if(statusText) statusText.innerText = "Bild geladen (Alpha entfernt).";
            
            setZoomMode('fit', currentImgW, currentImgH);
        }
        img.src = ev.target.result;
    }
    reader.readAsDataURL(file);
});

// --- KERN-ENCODER & DECODER ---
if (btnEncode) btnEncode.addEventListener('click', async () => {
    if (!currentImgW || !currentImgH) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    currentFormat = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[currentFormat];
    
    if (config && config.isPaletted && globalPaletteRAM[0] === 0 && globalPaletteRAM[1] === 0 && globalPaletteRAM[2] === 0) {
        globalPaletteRAM[0] = originalImageData.data[0];
        globalPaletteRAM[1] = originalImageData.data[1];
        globalPaletteRAM[2] = originalImageData.data[2];
        updatePalettePickers();
    }

    let decLabel = document.getElementById('decoded-label');
    if (decLabel) decLabel.innerText = `DEKODIERT (${currentFormat})`;
    
    btnLoad.disabled = true; btnEncode.disabled = true; if(btnSave) btnSave.disabled = true; 
    if(btnBuilder) btnBuilder.disabled = true; if(btnAnalysis) btnAnalysis.disabled = true;

    let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
    let metric = encodeMetricSelect ? encodeMetricSelect.value : "oklab";
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
    
    let hypPercentInp = document.getElementById('hybrid-percent');
    let hybridPercent = hypPercentInp ? (parseFloat(hypPercentInp.value) || 5.0) : 5.0;

    let encodeResult = await encodeStream(
        originalImageData.data, currentImgW, currentImgH, currentFormat, 
        getGlobalSegment(), globalPaletteRAM, strategy, metric, max_depth, 
        (phase, current, total) => updateProgressDetail(phase, current, total),
        0, 0, hybridPercent
    );

    latestPackedData = encodeResult.packedData;
    latestCommandArray = encodeResult.commandArray;
    let stats = encodeResult.stats;

    updateProgressDetail("Phase 4: Dekodierung & Rendering", 0, 1);
    await new Promise(r => setTimeout(r, 20));
    
    let decStart = Date.now();
    let decodedPixels = decodeStream(latestCommandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);
    
    decodedImageData = new ImageData(decodedPixels, currentImgW, currentImgH);
    ctxDecoded.putImageData(decodedImageData, 0, 0);
    
    let decTime = Date.now() - decStart;

    let set = new Set();
    for (let i = 0; i < decodedPixels.length; i += 4) { 
        set.add((decodedPixels[i] << 16) | (decodedPixels[i+1] << 8) | decodedPixels[i+2]); 
    }

    updateStatusTextDimAndColors(set.size, stats);
    let progressEl = document.getElementById('progress');
    if(progressEl) progressEl.value = 100; 
    
    let statusEl = document.getElementById('status-text');
    if(statusEl) statusEl.innerText = `✅ Fertig! (Modus: ${currentFormat}, Renderzeit: ${decTime}ms)`;
    
    encodeHistory.push({
        format: currentFormat,
        strategy: strategy,
        metric: metric,
        step: { ...getGlobalSegment()[0].step },
        offset: getGlobalSegment()[0].offset,
        palette: new Uint8Array(globalPaletteRAM),
        packedData: latestPackedData,
        commandArray: latestCommandArray,
        decodedImageData: decodedImageData,
        stats: stats,
        time: decTime
    });
    
    if (encodeHistory.length > 10) encodeHistory.shift();
    renderHistory();

    btnLoad.disabled = false; btnEncode.disabled = false; if(btnSave) btnSave.disabled = false; 
    if(btnBuilder) btnBuilder.disabled = false; if(btnAnalysis) btnAnalysis.disabled = false;
});

// --- ANALYSIS MODAL ---
window.centerOnCoordinate = function(x, y) { centerOnCoordinate(x, y, currentImgW, currentImgH); }

if (btnAnalysis) btnAnalysis.addEventListener('click', () => {
    if(!latestPackedData || !currentImgW) { alert("Bitte lade und codiere zuerst ein Bild."); return; }
    
    const stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels);
    
    let avgMseDisplay = document.getElementById('avg-mse-display');
    if (avgMseDisplay) {
        avgMseDisplay.innerText = `⌀ RGB: ${stats.global.avgRgb.toFixed(2)} | ⌀ Metrik: ${stats.global.avgYuv.toFixed(2)}`;
        avgMseDisplay.style.display = 'inline';
    }

    let renderTop5 = (list) => list.map((e, i) => `<div>#${i + 1}: Px ${e.pixelIdx} (${e.details}) | MSE: ${Math.round(e.mse)} 
        | <a href="#" onclick="centerOnCoordinate(${e.x}, ${e.y})">Zentrieren</a></div>`).join('');

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
    
    currentBuilderSlot = 0;

    let modal = document.getElementById('builder-modal');
    if (modal) modal.style.display = 'block';
    refreshBuilderUI();
});

function refreshBuilderUI() {
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;
    let bankTitle = document.getElementById('b-bank-title');
    if (bankTitle) bankTitle.innerText = `Offset ${currentOffset}`;
    
    let f = formatSelect ? formatSelect.value : "HAM12";
    let config = HAM_CONFIGS[f];
    if (!config) return;
    
    let slotsPerBank = config.slotsPerBank ? config.slotsPerBank : (f === "HAM8" ? 64 : 16);
    
    let previewContainer = document.getElementById('builder-palette-preview');
    if (!previewContainer) return;
    
    previewContainer.innerHTML = "";
    
    for (let i = 0; i < slotsPerBank; i++) {
        let absoluteSlot = (currentOffset + i) % 256;
        let r = globalPaletteRAM[absoluteSlot * 3], g = globalPaletteRAM[absoluteSlot * 3 + 1], b = globalPaletteRAM[absoluteSlot * 3 + 2];
        let slotDiv = document.createElement('div');
        slotDiv.className = 'builder-slot';
        slotDiv.style.width = '24px';
        slotDiv.style.height = '24px';
        slotDiv.style.backgroundColor = rgbToHex(r, g, b);
        
        if (i === currentBuilderSlot) {
            slotDiv.style.border = '3px solid #007bff';
        } else {
            slotDiv.style.border = '1px solid #000';
        }
        
        slotDiv.style.cursor = 'pointer';
        slotDiv.title = `Slot ${i} (RAM: ${absoluteSlot})`;
        slotDiv.addEventListener('click', () => {
            currentBuilderSlot = i;
            refreshBuilderUI();
        });
        previewContainer.appendChild(slotDiv);
    }
    runBuilderAnalysis();
}

function runBuilderAnalysis() {
    let stepVal = { 
        r: hamStepR ? (parseInt(hamStepR.value) || 4) : 4, 
        g: hamStepG ? (parseInt(hamStepG.value) || 4) : 4, 
        b: hamStepB ? (parseInt(hamStepB.value) || 4) : 4 
    };

    let bMetric = encodeMetricSelect ? encodeMetricSelect.value : 'oklab';
    
    let metricLabel = document.getElementById('builder-current-metric-label');
    if (metricLabel && encodeMetricSelect) {
        let selectedText = encodeMetricSelect.options[encodeMetricSelect.selectedIndex].text;
        metricLabel.innerHTML = `Metrik: <b style="color:#ffc107;">${selectedText}</b>`;
    }

    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;
    
    let results = simulateBuilderEncode(
        0, totalPixels, originalImageData.data, currentImgW, 
        Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]), 
        currentBuilderSlot, stepVal, currentFormat, bMetric, currentOffset
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
        let absoluteSlot = (currentOffset + currentBuilderSlot) % 256;
        statusEl.innerText = `Analysiere Slot ${currentBuilderSlot} (RAM: ${absoluteSlot})`;
    }
}

window.assignColorToSlot = function(hex) {
    let [r, g, b] = hexToRgb(hex);
    
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;
    let absoluteSlot = (currentOffset + currentBuilderSlot) % 256;
    
    globalPaletteRAM[absoluteSlot * 3] = r;
    globalPaletteRAM[absoluteSlot * 3 + 1] = g;
    globalPaletteRAM[absoluteSlot * 3 + 2] = b;
    
    let config = HAM_CONFIGS[currentFormat];
    let slotsPerBank = (config && config.slotsPerBank) ? config.slotsPerBank : (currentFormat === "HAM8" ? 64 : 16);
    
    if (currentBuilderSlot < slotsPerBank - 1) {
        currentBuilderSlot++;
    }
    
    updatePalettePickers();
    refreshBuilderUI();
    refreshDecodedImage();
}

let btnBuildCancel = document.getElementById('btn-builder-cancel');
if (btnBuildCancel) btnBuildCancel.addEventListener('click', () => {
    let modal = document.getElementById('builder-modal');
    if (modal) modal.style.display = 'none';
});

let btnBuildAuto = document.getElementById('btn-builder-auto');
if (btnBuildAuto) btnBuildAuto.addEventListener('click', async () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;
    let config = HAM_CONFIGS[currentFormat];
    let slotsPerBank = (config && config.slotsPerBank) ? config.slotsPerBank : 16;

    let statusEl = document.getElementById('builder-status');
    
    // Bank komplett leeren für den Neufart
    for (let i = 0; i < slotsPerBank; i++) {
        let absoluteSlot = (currentOffset + i) % 256;
        globalPaletteRAM[absoluteSlot * 3] = 0;
        globalPaletteRAM[absoluteSlot * 3 + 1] = 0;
        globalPaletteRAM[absoluteSlot * 3 + 2] = 0;
    }
    updatePalettePickers();
    refreshBuilderUI();

    let strategy = encodeStrategySelect ? encodeStrategySelect.value : 'both';
    let bMetric = encodeMetricSelect ? encodeMetricSelect.value : 'oklab';
    let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;

    for (let i = 0; i < slotsPerBank; i++) {
        let absoluteSlot = (currentOffset + i) % 256;
        if (statusEl) statusEl.innerText = `Fülle Slot ${i} (RAM: ${absoluteSlot})...`;
        await new Promise(r => setTimeout(r, 10)); 

        let encodeResult = await encodeStream(
            originalImageData.data, currentImgW, currentImgH, currentFormat, 
            getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
            null, 0, totalPixels
        );
        
        let decodedPixels = decodeStream(encodeResult.commandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);
        ctxDecoded.putImageData(new ImageData(decodedPixels, currentImgW, currentImgH), 0, 0);

        let errorMap = new Map();
        let histMap = new Map();

        // Fehler akkumulieren
        for (let p = 0; p < totalPixels; p++) {
            let idx = p * 4;
            let r1 = originalImageData.data[idx], g1 = originalImageData.data[idx+1], b1 = originalImageData.data[idx+2];
            let r2 = decodedPixels[idx], g2 = decodedPixels[idx+1], b2 = decodedPixels[idx+2];
            
            let hex = rgbToHex(r1, g1, b1);
            histMap.set(hex, (histMap.get(hex) || 0) + 1);
            
            let err = 0;
            if (bMetric === 'oklab') err = get_oklab_dist(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'redmean') err = get_redmean_dist(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'yuv_weight_heavy') err = get_yuv_dist_weight_heavy(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'yuv_weight') err = get_yuv_dist_weight(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'yuv') err = get_yuv_dist(r1, g1, b1, r2, g2, b2);
            else if (bMetric === 'rgb') err = get_rgb_dist(r1, g1, b1, r2, g2, b2);
            else err = get_rgb_abs_dist(r1, g1, b1, r2, g2, b2);
            
            errorMap.set(hex, (errorMap.get(hex) || 0) + err); // totalError ist hier die SUMME aller Fehler
        }

        let bestHex = "#000000";
        let maxImpact = -1;

        // KORREKTUR: impact-Berechnung repariert
        for (let [hex, count] of histMap.entries()) {
            let totalError = errorMap.get(hex); // Echte Summe der Fehler = Echter Einfluss auf den globalen MSE
            let avgError = totalError / count;  // Durchschnittlicher Fehler pro Pixel dieser Farbe
            
            let impact = totalError; // Kein Quadrat mehr!
            
            // Nimmt nur Farben auf, die im Schnitt einen spürbaren Fehler haben
            if (impact > maxImpact && avgError > 1.5) {
                maxImpact = impact;
                bestHex = hex;
            }
        }

        // KORREKTUR: Duplikat-Erkennung im Fallback
        if (maxImpact === -1 && histMap.size > 0) {
            let maxCount = -1;
            for (let [hex, count] of histMap.entries()) {
                let [r,g,b] = hexToRgb(hex);
                let isDup = false;
                // Prüfen, ob die Farbe in den bisherigen Slots schon existiert
                for (let s = 0; s < i; s++) {
                    let aSlot = (currentOffset + s) % 256;
                    if (globalPaletteRAM[aSlot*3] === r && globalPaletteRAM[aSlot*3+1] === g && globalPaletteRAM[aSlot*3+2] === b) {
                        isDup = true; break;
                    }
                }
                
                if (!isDup && count > maxCount) { 
                    maxCount = count; 
                    bestHex = hex; 
                }
            }
            
            // Wenn wirklich alle Farben des Bildes schon in der Palette sind, nimm einfach die häufigste
            if (maxCount === -1) {
                let mC = -1;
                for (let [hex, count] of histMap.entries()) {
                    if (count > mC) { mC = count; bestHex = hex; }
                }
            }
        }

        let [wr, wg, wb] = hexToRgb(bestHex);
        globalPaletteRAM[absoluteSlot * 3] = wr;
        globalPaletteRAM[absoluteSlot * 3 + 1] = wg;
        globalPaletteRAM[absoluteSlot * 3 + 2] = wb;
        
        currentBuilderSlot = i;
        updatePalettePickers();
        refreshBuilderUI();
    }

    if (statusEl) statusEl.innerText = "Erstelle finales Bild...";
    await new Promise(r => setTimeout(r, 20));

    let finalEncode = await encodeStream(
        originalImageData.data, currentImgW, currentImgH, currentFormat, 
        getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
        null, 0, totalPixels
    );
    
    latestCommandArray = finalEncode.commandArray;
    refreshDecodedImage();
    
    if (statusEl) statusEl.innerText = `Offset ab ${currentOffset} erfolgreich vollständig belegt!`;
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
    
    let strategy = 'both'; 
    let max_depth = 1; 
    let metric = encodeMetricSelect ? encodeMetricSelect.value : 'oklab';

    let pal = Array.from({length: 256}, (_, i) => [globalPaletteRAM[i * 3], globalPaletteRAM[i * 3 + 1], globalPaletteRAM[i * 3 + 2]]);
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;

    async function evaluateStep(r, g, b) {
        return await runSimulationWithStrategy(0, totalPixels, originalImageData.data, currentImgW, pal, {r, g, b}, strategy, metric, max_depth, currentFormat, currentOffset);
    }

    let bestScore = Infinity;
    let bestStep = { r: minStep, g: minStep, b: minStep };
    let initialStats = null;

    for (let s = minStep; s <= maxStep; s++) {
        if (statusEl) statusEl.innerText = `Phase 1: Suche einheitliche Schrittweite ${s} von ${maxStep}...`;
        await new Promise(res => setTimeout(res, 10));

        let res = await evaluateStep(s, s, s);
        
        if (res.score < bestScore) {
            bestScore = res.score;
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
                if (resMinus.score < bestScore) {
                    bestScore = resMinus.score;
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
                if (resPlus.score < bestScore) {
                    bestScore = resPlus.score;
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
        recEl.innerText = `🏆 Koordinatenabstieg beendet! Bestes Ergebnis: RGB [${bestStep.r}, ${bestStep.g}, ${bestStep.b}]`;
    }
    if (statusEl) statusEl.innerText = "Berechnung abgeschlossen.";
});

window.applyAutoStep = function(r, g, b) {
    if (hamStepR) hamStepR.value = r; 
    if (hamStepG) hamStepG.value = g; 
    if (hamStepB) hamStepB.value = b;
    
    let modal = document.getElementById('auto-step-modal');
    if (modal) modal.style.display = 'none';
};

let btnAutoClose = document.getElementById('auto-step-close');
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