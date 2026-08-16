import { setZoomMode, updateView, centerOnCoordinate, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { encodeStream, unpackBinaryToCommands } from './core/engine-stream.js';
import { decodeStream } from './core/decoder.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { computeDetailedAnalysis, runSimulationWithStrategy, errorBins } from './core/analysis.js';
import { simulateBuilderEncode } from './core/builder.js';
import { hexToRgb, rgbToHex, countUniqueColors, get_yuv_dist, get_yuv_dist_weight, get_yuv_dist_weight_heavy, get_rgb_dist, get_rgb_abs_dist, get_redmean_dist, get_oklab_dist } from './codecs/utils.js';


// Test-Hook für die Konsole
window.DEBUG_CANVAS = () => {
    console.log("Decoded ImageData:", decodedImageData);
    console.log("Erste 20 Pixel (RGBA):", decodedImageData ? Array.from(decodedImageData.data.slice(0, 20)) : "Kein Bild");
};
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

const btnEncode = document.getElementById('btn-encode');
const btnSave = document.getElementById('btn-save');
const btnBuilder = document.getElementById('btn-builder');
const btnAnalysis = document.getElementById('btn-analysis');

const fileImg = document.getElementById('file-img');
const fileBin = document.getElementById('file-bin');

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
    
    btnEncode.disabled = true; if(btnSave) btnSave.disabled = true; 
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

    btnEncode.disabled = false; if(btnSave) btnSave.disabled = false; 
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

// --- DER NEUE AUTO-BUILDER (TOURNAMENT + RATIO) ---
let btnBuildAuto = document.getElementById('btn-builder-auto');
if (btnBuildAuto) btnBuildAuto.addEventListener('click', async () => {
    if (!currentImgW) { alert("Bitte lade zuerst ein Bild!"); return; }
    
    let currentOffset = palOffsetInput ? (parseInt(palOffsetInput.value) || 0) : 0;
    let config = HAM_CONFIGS[currentFormat];
    let slotsPerBank = (config && config.slotsPerBank) ? config.slotsPerBank : 16;

    let modeSelect = document.getElementById('builder-mode-select');
    let mode = modeSelect ? modeSelect.value : 'ratio_half';

    let avgSlotsCount = slotsPerBank;
    let maxSlotsCount = 0;

    if (mode === 'only_avg') {
        avgSlotsCount = slotsPerBank;
        maxSlotsCount = 0;
    } else if (mode === 'only_max') {
        avgSlotsCount = 0;
        maxSlotsCount = slotsPerBank;
    } else if (mode === 'ratio_1_3') {
        avgSlotsCount = Math.round(slotsPerBank * 0.25);
        maxSlotsCount = slotsPerBank - avgSlotsCount;
    } else if (mode === 'ratio_half') {
        avgSlotsCount = Math.floor(slotsPerBank / 2);
        maxSlotsCount = slotsPerBank - avgSlotsCount;
    } else if (mode === 'ratio_3_1') {
        avgSlotsCount = Math.round(slotsPerBank * 0.75);
        maxSlotsCount = slotsPerBank - avgSlotsCount;
    }

    let statusEl = document.getElementById('builder-status');
    
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

    let bestDecodedCache = null;
    let slotIdxPointer = 0;

    for (let i = 0; i < avgSlotsCount; i++) {
        let absoluteSlot = (currentOffset + slotIdxPointer) % 256;
        if (statusEl) statusEl.innerText = `[Durchschnitt] Analysiere Slot ${slotIdxPointer}...`;
        await new Promise(r => setTimeout(r, 10)); 

        let encodeResult = await encodeStream(
            originalImageData.data, currentImgW, currentImgH, currentFormat, 
            getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
            null, 0, totalPixels
        );
        
        let decodedPixels = decodeStream(encodeResult.commandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);

        let errorMap = new Map();
        let histMap = new Map();

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
            
            errorMap.set(hex, (errorMap.get(hex) || 0) + err); 
        }

        let candidates = [];
        let sortedByImpact = Array.from(histMap.keys()).map(hex => ({hex, impact: errorMap.get(hex)})).sort((a,b) => b.impact - a.impact);
        if(sortedByImpact.length > 0) candidates.push(sortedByImpact[0].hex);
        
        let sortedByCount = Array.from(histMap.keys())
            .filter(hex => (errorMap.get(hex) / histMap.get(hex)) > 1.5)
            .map(hex => ({hex, count: histMap.get(hex)}))
            .sort((a,b) => b.count - a.count);
            
        if(sortedByCount.length > 0 && sortedByCount[0].hex !== candidates[0]) {
            candidates.push(sortedByCount[0].hex);
        }
        if (candidates.length === 0) candidates.push(sortedByImpact[0]?.hex || "#000000");

        let bestCandidateHex = candidates[0];
        let bestGlobalScore = Infinity;
        
        for (let c = 0; c < candidates.length; c++) {
            let hex = candidates[c];
            let [tr, tg, tb] = hexToRgb(hex);
            globalPaletteRAM[absoluteSlot * 3] = tr;
            globalPaletteRAM[absoluteSlot * 3 + 1] = tg;
            globalPaletteRAM[absoluteSlot * 3 + 2] = tb;
            
            let testEncode = await encodeStream(
                originalImageData.data, currentImgW, currentImgH, currentFormat, 
                getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
                null, 0, totalPixels
            );
            let testDecoded = decodeStream(testEncode.commandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);
            
            let currentScore = 0;
            for (let p = 0; p < totalPixels; p++) {
                let idx = p * 4;
                let r1 = originalImageData.data[idx], g1 = originalImageData.data[idx+1], b1 = originalImageData.data[idx+2];
                let r2 = testDecoded[idx], g2 = testDecoded[idx+1], b2 = testDecoded[idx+2];
                currentScore += get_yuv_dist(r1, g1, b1, r2, g2, b2);
            }
            
            if (currentScore < bestGlobalScore) {
                bestGlobalScore = currentScore;
                bestCandidateHex = hex;
                bestDecodedCache = testDecoded;
            }
        }

        let [wr, wg, wb] = hexToRgb(bestCandidateHex);
        globalPaletteRAM[absoluteSlot * 3] = wr;
        globalPaletteRAM[absoluteSlot * 3 + 1] = wg;
        globalPaletteRAM[absoluteSlot * 3 + 2] = wb;
        
        currentBuilderSlot = slotIdxPointer;
        updatePalettePickers();
        refreshBuilderUI();
        if (bestDecodedCache) ctxDecoded.putImageData(new ImageData(bestDecodedCache, currentImgW, currentImgH), 0, 0);
        
        slotIdxPointer++;
    }

    for (let i = 0; i < maxSlotsCount; i++) {
        let absoluteSlot = (currentOffset + slotIdxPointer) % 256;
        if (statusEl) statusEl.innerText = `[Einzelfehler] Analysiere Slot ${slotIdxPointer} (Max-MSE)...`;
        await new Promise(r => setTimeout(r, 10)); 

        let encodeResult = await encodeStream(
            originalImageData.data, currentImgW, currentImgH, currentFormat, 
            getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
            null, 0, totalPixels
        );
        let decodedPixels = decodeStream(encodeResult.commandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);

        let maxPixelErrors = [];
        for (let p = 0; p < totalPixels; p++) {
            let idx = p * 4;
            let r1 = originalImageData.data[idx], g1 = originalImageData.data[idx+1], b1 = originalImageData.data[idx+2];
            let r2 = decodedPixels[idx], g2 = decodedPixels[idx+1], b2 = decodedPixels[idx+2];
            
            let err = get_yuv_dist(r1, g1, b1, r2, g2, b2);
            maxPixelErrors.push({ r: r1, g: g1, b: b1, err });
        }

        maxPixelErrors.sort((a, b) => b.err - a.err);

        let worstColorHex = "#000000";
        if (maxPixelErrors.length > 0) {
            worstColorHex = rgbToHex(maxPixelErrors[0].r, maxPixelErrors[0].g, maxPixelErrors[0].b);
        }

        let [tr, tg, tb] = hexToRgb(worstColorHex);
        globalPaletteRAM[absoluteSlot * 3] = tr;
        globalPaletteRAM[absoluteSlot * 3 + 1] = tg;
        globalPaletteRAM[absoluteSlot * 3 + 2] = tb;

        let testEncode = await encodeStream(
            originalImageData.data, currentImgW, currentImgH, currentFormat, 
            getGlobalSegment(), globalPaletteRAM, strategy, bMetric, max_depth, 
            null, 0, totalPixels
        );
        let testDecoded = decodeStream(testEncode.commandArray, currentImgW, currentImgH, globalPaletteRAM, getGlobalSegment(), config);

        currentBuilderSlot = slotIdxPointer;
        updatePalettePickers();
        refreshBuilderUI();
        bestDecodedCache = testDecoded;
        if (bestDecodedCache) ctxDecoded.putImageData(new ImageData(bestDecodedCache, currentImgW, currentImgH), 0, 0);
        
        slotIdxPointer++;
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
    
    if (statusEl) statusEl.innerText = `Palette ab Offset ${currentOffset} nach gewähltem Verhältnis optimiert!`;
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

// ============================================================================
// HILFSFUNKTION: HAM-DATEI ERZEUGEN (V3 MIT ENDIANNESS)
// ============================================================================
function generateHamFile(isLittleEndian) {
    let formatBytes = new TextEncoder().encode(currentFormat);
    let step = getGlobalSegment()[0].step;
    let offset = getGlobalSegment()[0].offset;

    // Header V3 Layout:
    // 0-3: Magic ("HAM!")
    // 4: Version (3)
    // 5: Endian-Flag (0 = Little Endian, 1 = Big Endian)
    // 6-7: Width (16-Bit)
    // 8-9: Height (16-Bit)
    // 10: Format-String-Länge
    let headerSize = 11 + formatBytes.length + 4 + 768; 
    let buffer = new ArrayBuffer(headerSize + latestPackedData.length);
    let view = new DataView(buffer);
    let u8 = new Uint8Array(buffer);
    
    u8.set([72, 65, 77, 33], 0);          
    view.setUint8(4, 3); 
    view.setUint8(5, isLittleEndian ? 0 : 1); 
    
    // Width & Height mit spezifischer Endianness für das Zielsystem schreiben
    view.setUint16(6, currentImgW, isLittleEndian); 
    view.setUint16(8, currentImgH, isLittleEndian); 
    view.setUint8(10, formatBytes.length); 
    
    let pointer = 11;
    
    u8.set(formatBytes, pointer);
    pointer += formatBytes.length;
    
    view.setUint8(pointer++, step.r);
    view.setUint8(pointer++, step.g);
    view.setUint8(pointer++, step.b);
    view.setUint8(pointer++, offset);
    
    u8.set(globalPaletteRAM, pointer);
    pointer += 768;
    
    // Payload (Pixeldaten): Der JS-Encoder schreibt die Bit-Sequenzen nativ 
    // als Big-Endian Stream. Diese bleiben intakt, da Retro-Systeme den 
    // Stream meist genau so (High-Byte first) auslesen.
    u8.set(latestPackedData, pointer);
    
    return new Blob([buffer], { type: 'application/octet-stream' });
}

// ============================================================================
// BILD/DATEN SPEICHERN (MIT BENUTZERDEFINIERTEM NAMEN)
// ============================================================================
if (btnSave) btnSave.addEventListener('click', () => {
    if (!latestPackedData) {
        alert("Es gibt keine kodierten Daten zum Speichern. Bitte zuerst kodieren!");
        return;
    }
    
    let defaultName = `ship_${currentFormat.toLowerCase()}`;
    let customName = prompt("Bitte Dateinamen eingeben (ohne Endung):", defaultName);
    if (!customName) return;

    let triggerDownload = (blob, suffix) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${customName}_${suffix}.ham`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Little-Endian Version speichern
    let blobLE = generateHamFile(true);
    triggerDownload(blobLE, "LE");

    // Big-Endian Version speichern
    setTimeout(() => {
        let blobBE = generateHamFile(false);
        triggerDownload(blobBE, "BE");
    }, 300);
});

// ============================================================================
// LADE-FUNKTION FÜR CODIERTE DATEN (SMARTER V3 LOADER)
// ============================================================================
if (fileBin) fileBin.addEventListener('change', (e) => {
    let file = e.target.files[0];
    if (!file) return;
    let reader = new FileReader();
    reader.onload = function(ev) {
        let buffer = ev.target.result;
        let u8 = new Uint8Array(buffer);
        let view = new DataView(buffer);

        try {
            console.log("=== HAM LADE-ROUTINE ===", file.name);

            // Signatur prüfen
            if (u8.length < 14 || u8[0] !== 72 || u8[1] !== 65 || u8[2] !== 77 || u8[3] !== 33) {
                throw new Error("Keine gültige HAM! Signatur.");
            }
            
            let version = view.getUint8(4);
            let isLittleEndian = true;
            let pointer = 5;
            let w, h, formatLen;

            // Dynamisches Header-Parsing basierend auf der Version
            if (version === 3) {
                isLittleEndian = view.getUint8(5) === 0;
                w = view.getUint16(6, isLittleEndian);
                h = view.getUint16(8, isLittleEndian);
                formatLen = view.getUint8(10);
                pointer = 11;
            } else if (version === 2) {
                w = view.getUint16(5, true); // V2 war fix LE
                h = view.getUint16(7, true);
                formatLen = view.getUint8(9);
                pointer = 10;
            } else {
                throw new Error(`Nicht unterstützte Dateiversion: v${version}. Bitte neu codieren!`);
            }

            let formatBytes = u8.slice(pointer, pointer + formatLen);
            let fmt = new TextDecoder().decode(formatBytes);
            pointer += formatLen;
            
            let sR = view.getUint8(pointer++);
            let sG = view.getUint8(pointer++);
            let sB = view.getUint8(pointer++);
            let pOff = view.getUint8(pointer++);
            
            let palSlice = u8.slice(pointer, pointer + 768);
            globalPaletteRAM.fill(0); 
            globalPaletteRAM.set(palSlice);
            pointer += 768;
            
            let payload = u8.slice(pointer);
            
            let endianText = isLittleEndian ? "Little-Endian" : "Big-Endian";
            console.log(`[Erfolg] Header (v${version}): ${w}x${h}, Format: ${fmt}, ${endianText}, Steps: R${sR}/G${sG}/B${sB}, Offset: ${pOff}`);

            currentImgW = w;
            currentImgH = h;
            currentFormat = fmt;
            totalPixels = w * h;
            latestPackedData = payload;

            // UI Synchronisieren
            if (hamStepR) hamStepR.value = sR;
            if (hamStepG) hamStepG.value = sG;
            if (hamStepB) hamStepB.value = sB;
            if (palOffsetInput) palOffsetInput.value = pOff;
            if (formatSelect) formatSelect.value = fmt;

            handleFormatChange();
            updatePalettePickers();

            canvasOriginal.width = w;
            canvasOriginal.height = h;
            ctxOriginal.clearRect(0, 0, w, h);
            canvasDecoded.width = w;
            canvasDecoded.height = h;
            ctxDecoded.clearRect(0, 0, w, h);
            
            latestCommandArray = unpackBinaryToCommands(latestPackedData, currentFormat, totalPixels);

            let loadedSegment = [{
                absEnd: totalPixels,
                waitPixels: totalPixels,
                offset: pOff,
                step: { r: sR, g: sG, b: sB }
            }];

            let config = HAM_CONFIGS[currentFormat];
            let decodedPixels = decodeStream(latestCommandArray, w, h, globalPaletteRAM, loadedSegment, config);
            
            decodedImageData = new ImageData(decodedPixels, w, h);
            ctxDecoded.putImageData(decodedImageData, 0, 0);
            
            let set = new Set();
            for (let i = 0; i < decodedPixels.length; i += 4) { 
                set.add((decodedPixels[i] << 16) | (decodedPixels[i+1] << 8) | decodedPixels[i+2]); 
            }
            
            updateStatusTextDimAndColors(set.size);
            let statusText = document.getElementById('status-text');
            if(statusText) statusText.innerText = `HAM v${version} geladen: ${fmt} (${w}x${h}) [${endianText}]!`;
            setZoomMode('fit', w, h);
            
            if (btnAnalysis) btnAnalysis.disabled = false;
            if (btnSave) btnSave.disabled = false;
            if (btnBuilder) btnBuilder.disabled = false;
            
        } catch (error) {
            console.error("Ladefehler:", error);
            alert("Fehler: " + error.message);
        }
    };
    reader.readAsArrayBuffer(file);
});