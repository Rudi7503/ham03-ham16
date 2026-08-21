import { setZoomMode, updateView, centerOnCoordinate, setupCanvasEvents, viewState } from './ui/canvas-view.js';
import { HAM_CONFIGS } from './codecs/configs.js';
import { hexToRgb, rgbToHex } from './codecs/utils.js';
import { encodeHam12_16, decodeHam12_16, packHam12_16, unpackHam12_16 } from './core/module_ham12_16.js';
import { encodePaletted, decodePaletted, packPaletted, unpackPaletted } from './core/module_paletted.js';
import { debugRoundtripHam12_16, debugRoundtripPaletted } from './core/debugger.js';
import { computeDetailedAnalysis, errorBins } from './core/analysis.js';

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

const btnAutoStep = document.getElementById('btn-auto-step');
const autoMinStepInp = document.getElementById('auto-min-step');
const autoMaxStepInp = document.getElementById('auto-max-step');
const autoStepBody = document.getElementById('auto-step-body');
const autoStepStatus = document.getElementById('auto-step-status');

// ==========================================
// GLOBALE VARIABLEN FÜR ROI (REGION OF INTEREST)
// ==========================================
let optRegion = { x: 0, y: 0, width: 0, height: 0 };
let isDrawingRegion = false;
let isRegionModeActive = false;
let startX = 0, startY = 0;

function resetOptRegion(imgW, imgH) {
    optRegion = { x: 0, y: 0, width: imgW, height: imgH };
    updateRegionLabel();
}

function updateRegionLabel() {
    let lbl = document.getElementById("region-info");
    if (!lbl) return;
    if (originalImageData && optRegion.width === originalImageData.width && optRegion.height === originalImageData.height) {
        lbl.innerText = "Bereich: Ganzes Bild";
    } else {
        lbl.innerText = `Bereich: X:${optRegion.x}, Y:${optRegion.y}, B:${optRegion.width}, H:${optRegion.height}`;
    }
}

// ==========================================
// INITIALISIERUNG DER CANVAS-EVENTS FÜR ROI
// ==========================================
function initRegionEvents() {
    let sourceCanvas = document.getElementById('canvas-original');
    if (!sourceCanvas) return;

    document.getElementById('btn-draw-region').addEventListener('click', () => {
        isRegionModeActive = true;
        sourceCanvas.style.cursor = 'crosshair';
    });

    document.getElementById('btn-reset-region').addEventListener('click', () => {
        isRegionModeActive = false;
        sourceCanvas.style.cursor = 'default';
        if (originalImageData) {
            resetOptRegion(originalImageData.width, originalImageData.height);
            let ctx = sourceCanvas.getContext('2d');
            ctx.putImageData(originalImageData, 0, 0);
        }
    });

    sourceCanvas.addEventListener('mousedown', (e) => {
        if (!isRegionModeActive) return;
        e.stopPropagation();
        isDrawingRegion = true;
        let rect = sourceCanvas.getBoundingClientRect();
        let scaleX = sourceCanvas.width / rect.width;
        let scaleY = sourceCanvas.height / rect.height;
        startX = Math.floor((e.clientX - rect.left) * scaleX);
        startY = Math.floor((e.clientY - rect.top) * scaleY);
    });

    sourceCanvas.addEventListener('mousemove', (e) => {
        if (!isDrawingRegion) return;
        e.stopPropagation();
        let rect = sourceCanvas.getBoundingClientRect();
        let scaleX = sourceCanvas.width / rect.width;
        let scaleY = sourceCanvas.height / rect.height;
        let curX = Math.floor((e.clientX - rect.left) * scaleX);
        let curY = Math.floor((e.clientY - rect.top) * scaleY);

        let ctx = sourceCanvas.getContext('2d');
        if (originalImageData) {
            ctx.putImageData(originalImageData, 0, 0);
        }
        
        ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(startX, startY, curX - startX, curY - startY);
    });

    sourceCanvas.addEventListener('mouseup', (e) => {
        if (!isDrawingRegion) return;
        e.stopPropagation();
        isDrawingRegion = false;
        isRegionModeActive = false;
        sourceCanvas.style.cursor = 'default';

        let rect = sourceCanvas.getBoundingClientRect();
        let scaleX = sourceCanvas.width / rect.width;
        let scaleY = sourceCanvas.height / rect.height;
        let endX = Math.floor((e.clientX - rect.left) * scaleX);
        let endY = Math.floor((e.clientY - rect.top) * scaleY);

        optRegion.x = Math.max(0, Math.min(startX, endX));
        optRegion.y = Math.max(0, Math.min(startY, endY));
        optRegion.width = Math.min(originalImageData.width - optRegion.x, Math.abs(endX - startX));
        optRegion.height = Math.min(originalImageData.height - optRegion.y, Math.abs(endY - startY));

        if (optRegion.width === 0) optRegion.width = 1;
        if (optRegion.height === 0) optRegion.height = 1;

        updateRegionLabel();
        
        let ctx = sourceCanvas.getContext('2d');
        if (originalImageData) {
            ctx.putImageData(originalImageData, 0, 0); 
        }
        ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(optRegion.x, optRegion.y, optRegion.width, optRegion.height);
    });
}
initRegionEvents();

// ==========================================
// DYNAMISCHE PALETTEN-SORTIERUNG MIT ROI-FILTER
// ==========================================
async function sortPaletteSlotsByUsage() {
    if (!originalImageData || !latestCommandArray) {
        alert("Bitte zuerst das Bild codieren.");
        return;
    }
    let config = HAM_CONFIGS[currentFormat];
    if (!config || !config.isPaletted) return;

    let currentOffset = getGlobalOffset();
    let totalAnchorUsage = new Array(256).fill(0);
    let imgW = originalImageData.width;

    for (let i = 0; i < latestCommandArray.length; i++) {
        let cmd = latestCommandArray[i];
        if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined) {
            let x = i % imgW;
            let y = Math.floor(i / imgW);
            
            if (x >= optRegion.x && x < optRegion.x + optRegion.width &&
                y >= optRegion.y && y < optRegion.y + optRegion.height) {
                
                let absSlot = (currentOffset + cmd.anchorIdx) % 256;
                totalAnchorUsage[absSlot]++;
            }
        }
    }

    let formatsInUse = config.isMixed ? [...new Set(config.sequence)] : [currentFormat];
    let capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a,b) => a - b);
    
    let sortGroups = [];
    let lastEnd = -1;
    
    for (let cap of capacities) {
        if (cap === 0) continue;
        let start = lastEnd + 1;
        let end = cap - 1;
        if (start <= end) {
            sortGroups.push({ start: start, end: end });
            lastEnd = end;
        }
    }

    if (sortGroups.length === 0) return;
    let maxSlotsPerBank = capacities[capacities.length - 1];

    for (let bankStart = 0; bankStart < 256; bankStart += maxSlotsPerBank) {
        for (let group of sortGroups) {
            let groupSlots = [];
            for (let i = group.start; i <= group.end; i++) {
                let absSlot = (bankStart + i) % 256;
                groupSlots.push({
                    absSlot: absSlot,
                    isFixed: (i === 0),
                    r: globalPaletteRAM[absSlot * 3],
                    g: globalPaletteRAM[absSlot * 3 + 1],
                    b: globalPaletteRAM[absSlot * 3 + 2],
                    usage: totalAnchorUsage[absSlot]
                });
            }
            
            let fixedSlots = groupSlots.filter(s => s.isFixed);
            let sortableSlots = groupSlots.filter(s => !s.isFixed);
            
            sortableSlots.sort((a, b) => b.usage - a.usage);
            let newOrder = [...fixedSlots, ...sortableSlots];
            
            for (let idx = 0; idx < newOrder.length; idx++) {
                let targetAbsSlot = (bankStart + group.start + idx) % 256;
                globalPaletteRAM[targetAbsSlot * 3]     = newOrder[idx].r;
                globalPaletteRAM[targetAbsSlot * 3 + 1] = newOrder[idx].g;
                globalPaletteRAM[targetAbsSlot * 3 + 2] = newOrder[idx].b;
            }
        }
    }

    await triggerAutoReencode(); 
    handleFormatChange();        
    
    let bModal = document.getElementById('builder-modal');
    if (bModal && bModal.style.display === 'block') btnBuilder.click();
}

function getGlobalStep() {
    return { r: parseInt(hamStepR.value) || 4, g: parseInt(hamStepG.value) || 4, b: parseInt(hamStepB.value) || 4 };
}

function getGlobalOffset() {
    return parseInt(palOffsetInput.value) || 0;
}

function ensureSlotZeroBlack() {
    globalPaletteRAM[0] = 0;
    globalPaletteRAM[1] = 0;
    globalPaletteRAM[2] = 0;
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

async function triggerAutoReencode() {
    if (!originalImageData) return;
    ensureSlotZeroBlack();
    
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
    
    ensureSlotZeroBlack();

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
            if (absSlot === 0) {
                input.disabled = true;
                input.title = "Slot 0 ist fest auf Schwarz (0,0,0) reserviert.";
            }
            input.addEventListener('input', async (e) => {
                if (absSlot === 0) return;
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
            
            resetOptRegion(currentImgW, currentImgH);
            
            canvasDecoded.width = currentImgW; canvasDecoded.height = currentImgH;
            ctxDecoded.clearRect(0, 0, currentImgW, currentImgH);
            
            ensureSlotZeroBlack();
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

    ensureSlotZeroBlack();

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
        
        ensureSlotZeroBlack();

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
// DRAG & DROP FÜR MODALS
// ============================================================================
let isDraggingModal = false;
let dragOffsetX = 0, dragOffsetY = 0;
let currentDraggedElement = null;

function setupDraggable(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const header = content ? content.querySelector('h3') : null;

    if (header && content) {
        header.addEventListener('mousedown', (e) => {
            isDraggingModal = true;
            currentDraggedElement = content;
            let rect = content.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            
            content.style.position = 'absolute';
            content.style.left = rect.left + 'px';
            content.style.top = rect.top + 'px';
            content.style.margin = '0';
            e.preventDefault();
        });
    }
}
setupDraggable('builder-modal');
setupDraggable('auto-step-modal');
setupDraggable('analysis-modal');

window.addEventListener('mousemove', (e) => {
    if (!isDraggingModal || !currentDraggedElement) return;
    let newX = e.clientX - dragOffsetX;
    let newY = e.clientY - dragOffsetY;
    currentDraggedElement.style.left = newX + 'px';
    currentDraggedElement.style.top = newY + 'px';
});
window.addEventListener('mouseup', () => {
    isDraggingModal = false;
    currentDraggedElement = null;
});

// ============================================================================
// MODAL & BUILDER LOGIC
// ============================================================================
const builderModal = document.getElementById('builder-modal');
const btnBuilderCancel = document.getElementById('btn-builder-cancel');
const btnBuilderAuto = document.getElementById('btn-builder-auto');
const btnSortSlots = document.getElementById('btn-sort-slots');
const btnResetSlots = document.getElementById('btn-reset-slots');
const autoStepModal = document.getElementById('auto-step-modal');
const btnAutoStepClose = document.getElementById('btn-auto-step-close');
const analysisModal = document.getElementById('analysis-modal');
const btnAnalysisClose = document.getElementById('btn-analysis-close');

let selectedTargetSlot = null;

function generateTop10Html(top10Array) {
    return top10Array.length > 0 
        ? top10Array.map((e, idx) => {
            let sollR = e.r1, sollG = e.g1, sollB = e.b1;
            let istR = e.r2, istG = e.g2, istB = e.b2;
            let formattedMse = Math.round(e.mse).toLocaleString('de-DE');
            
            let typeBadge = e.sortType ? `<span style="font-size:9px; background:#222; padding:2px 4px; border-radius:3px; color:#aaa; margin-right:4px; border:1px solid #444;" title="Warum dieser Fehler angezeigt wird">${e.sortType}</span>` : '';

            return `
            <div class="top10-cluster-item" data-r="${sollR}" data-g="${sollG}" data-b="${sollB}" data-x="${e.x}" data-y="${e.y}" style="font-size:10px; margin-bottom:3px; padding:4px 6px; background:#111; border-radius:3px; border:1px solid #333; cursor:pointer; display:flex; align-items:center; justify-content:space-between;" title="Klicken zum Zentrieren & Zuweisen">
                <div style="display:flex; align-items:center; gap:6px; pointer-events:none;">
                    <span style="color:#888; font-weight:bold; width:15px;">#${idx+1}</span>
                    ${typeBadge}
                    <div style="width:12px; height:12px; background:rgb(${istR},${istG},${istB}); border:1px solid #668; border-radius:2px;" title="Ist (Decodiert)"></div>
                    <span>➡</span>
                    <div style="width:12px; height:12px; background:rgb(${sollR},${sollG},${sollB}); border:1px solid #688; border-radius:2px;" title="Soll (Original)"></div>
                </div>
                <div style="display:flex; align-items:center; gap:6px; pointer-events:none;">
                    <span style="color:#4dabf7;">X:${e.x} Y:${e.y} (${e.count}x)</span>
                    <span style="color:#ff6b6b; font-weight:bold;">MSE: ${formattedMse}</span>
                </div>
            </div>`;
        }).join('')
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

if (btnSortSlots) btnSortSlots.addEventListener('click', sortPaletteSlotsByUsage);

if (btnBuilder && builderModal) {
    btnBuilder.addEventListener('click', () => {
        if (!originalImageData) { alert("Bitte zuerst ein Bild laden."); return; }
        builderModal.style.display = 'block'; 
        
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
            selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        }
        
        if (statusDiv) statusDiv.innerHTML = `Bank aktiv (${slots} Slots). <span id='builder-instruction' style='color:#ffc107; font-weight:bold;'>Aktiv: Slot ${selectedTargetSlot.index}. Klicke einen Eintrag zum Zuweisen.</span>`;
        
        if (previewContainer) {
            previewContainer.innerHTML = "";
            let anchorUsage = new Array(slots).fill(0);
            if (latestCommandArray) {
                for (let cmd of latestCommandArray) {
                    if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined) {
                        if (cmd.anchorIdx >= 0 && cmd.anchorIdx < slots) anchorUsage[cmd.anchorIdx]++;
                    }
                }
            }

            for (let i = 0; i < slots; i++) {
                let absSlot = (currentOffset + i) % 256;
                let r = globalPaletteRAM[absSlot * 3], g = globalPaletteRAM[absSlot * 3 + 1], b = globalPaletteRAM[absSlot * 3 + 2];
                let usageCount = anchorUsage[i];
                
                let slotWrapper = document.createElement('div');
                slotWrapper.style.cssText = "display:flex; flex-direction:column; align-items:center; font-size:9px; gap:2px;";

                let slotDiv = document.createElement('div');
                slotDiv.className = 'builder-slot';
                slotDiv.style.backgroundColor = rgbToHex(r, g, b);
                slotDiv.title = `Slot ${i} (RAM ${absSlot}): RGB(${r},${g},${b}) | Genutzt: ${usageCount}x`;
                slotDiv.innerText = i;
                
                if (selectedTargetSlot && selectedTargetSlot.index === i) {
                    slotDiv.style.border = '2px solid #ffc107';
                }

                let usageLabel = document.createElement('span');
                usageLabel.style.color = usageCount > 0 ? '#4dabf7' : '#777';
                usageLabel.innerText = `${usageCount}x`;

                slotDiv.addEventListener('click', () => {
                    if (i === 0) {
                        alert("Slot 0 ist fest auf Schwarz reserviert und kann nicht überschrieben werden.");
                        return;
                    }
                    document.querySelectorAll('.builder-slot').forEach(s => s.style.border = '1px solid #444');
                    slotDiv.style.border = '2px solid #ffc107';
                    selectedTargetSlot = { index: i, absSlot: absSlot };
                    let instr = document.getElementById('builder-instruction');
                    if (instr) instr.innerHTML = `Slot ${i} ausgewählt. <span style='color:#4dabf7;'>Klicke nun auf einen Eintrag!</span>`;
                });
                
                slotWrapper.appendChild(slotDiv);
                slotWrapper.appendChild(usageLabel);
                previewContainer.appendChild(slotWrapper);
            }
        }
        
        async function applyColorToSelectedSlot(r, g, b) {
            if (!selectedTargetSlot) {
                selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
            }
            
            let absSlot = selectedTargetSlot.absSlot;
            if (absSlot % 256 === 0) {
                alert("Slot 0 kann nicht überschrieben werden.");
                return;
            }

            globalPaletteRAM[absSlot * 3] = r;
            globalPaletteRAM[absSlot * 3 + 1] = g;
            globalPaletteRAM[absSlot * 3 + 2] = b;
            
            await triggerAutoReencode();
            
            let nextIdx = selectedTargetSlot.index + 1;
            if (nextIdx >= slots) nextIdx = 1;
            let nextAbsSlot = (currentOffset + nextIdx) % 256;
            selectedTargetSlot = { index: nextIdx, absSlot: nextAbsSlot };
            
            btnBuilder.click();
            handleFormatChange();
        }

        if (mseListDiv && decodedImageData && originalImageData) {
            let stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
            
            let avgMetricMse = stats.global.avgYuv.toFixed(2);
            let avgRgbMse = stats.global.avgRgb.toFixed(2);
            
            let allErrors = [];
            for (let b in stats.global.byBitDepth) {
                allErrors.push(...stats.global.byBitDepth[b]);
            }
            if (allErrors.length === 0) allErrors = [...stats.global.top10];
            
            allErrors.sort((a, b) => b.mse - a.mse);
            let pureMaxMse = allErrors.length > 0 ? Math.round(allErrors[0].mse) : 0;
            let weightedMaxMse = stats.global.top10.length > 0 ? Math.round(stats.global.top10[0].mse) : 0;
            
            if (statusDiv) {
                statusDiv.innerHTML = `Bank aktiv (${slots} Slots) | <span style="color:#ffc107;">⌀ MSE: ${avgMetricMse} (RGB: ${avgRgbMse}) | Max MSE (Gewichtet): ${weightedMaxMse} | Max MSE (Rein): ${pureMaxMse}</span><br>` +
                                      `<span id='builder-instruction' style='color:#ffc107; font-weight:bold;'>Aktiv: Slot ${selectedTargetSlot.index}. Klicke einen Eintrag zum Zuweisen.</span>`;
            }
            
            let bitDepths = Object.keys(stats.global.byBitDepth).sort((a,b) => parseInt(a) - parseInt(b));
            let html = "";
            
            if (bitDepths.length > 0) {
                for (let b of bitDepths) {
                    let hint = "";
                    if (b === "3") hint = "(Slots 0-3)";
                    else if (b === "4") hint = "(Slots 0-7)";
                    else if (b === "5") hint = "(Slots 0-15)";
                    else if (b === "6") hint = "(Slots 0-31)";
                    else if (b === "8") hint = "(Slots 0-127)";
                    else hint = `(Slots nach Bit-Tiefe ${b})`;

                    html += `
                    <div style="flex: 1; min-width: 220px; background:#16181a; border:1px solid #444; border-radius:4px; padding:6px; display:flex; flex-direction:column; max-height: 280px; overflow-y: auto;">
                        <div style="background:#222; padding:4px; font-weight:bold; color:#ffc107; font-size:11px; text-align:center; margin-bottom:6px; border-radius:3px; border:1px solid #444;">${b}-Bit ${hint}</div>
                        ${generateTop10Html(stats.global.byBitDepth[b])}
                    </div>`;
                }
            } else {
                html = `<div style="flex:1;">${generateTop10Html(stats.global.top10)}</div>`;
            }
            mseListDiv.innerHTML = html;
            
            mseListDiv.onclick = async (ev) => {
                let item = ev.target.closest('.top10-cluster-item');
                if (!item) return;

                let targetX = parseInt(item.dataset.x);
                let targetY = parseInt(item.dataset.y);
                if (!isNaN(targetX) && !isNaN(targetY)) {
                    centerOnCoordinate(targetX, targetY, currentImgW, currentImgH);
                }

                await applyColorToSelectedSlot(
                    parseInt(item.dataset.r),
                    parseInt(item.dataset.g),
                    parseInt(item.dataset.b)
                );
            };
        } else if (mseListDiv) {
            mseListDiv.innerHTML = '<div style="font-size:11px; color:#aaa;">Bitte zuerst Bild codieren für Fehleranalyse.</div>';
        }

        if (histListDiv && originalImageData) {
            import('./core/analysis.js').then(module => {
                let histData = module.getImageHistogram(originalImageData, currentImgW, currentImgH, step, 10, globalPaletteRAM, currentOffset, optRegion);
                histListDiv.innerHTML = generateHistogramHtml(histData);
                
                histListDiv.onclick = async (ev) => {
                    let item = ev.target.closest('.hist-color-item');
                    if (!item) return;
                    await applyColorToSelectedSlot(
                        parseInt(item.dataset.r),
                        parseInt(item.dataset.g),
                        parseInt(item.dataset.b)
                    );
                };
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

// ============================================================================
// AUTO-FILL & NACHOPTIMIERUNG (Ausschließlich mit triggerAutoReencode)
// ============================================================================
if (btnBuilderAuto) {
    btnBuilderAuto.addEventListener('click', async () => {
        if (!originalImageData || !decodedImageData) { alert("Bitte zuerst das Bild codieren."); return; }
        
        let config = HAM_CONFIGS[currentFormat];
        let currentOffset = getGlobalOffset();
        let step = getGlobalStep();
        let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";

        ensureSlotZeroBlack();

        let formatsInUse = config.isMixed ? [...new Set(config.sequence)] : [currentFormat];
        let capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a,b) => a - b);
        
        let sortGroups = [];
        let lastEnd = -1;
        for (let cap of capacities) {
            if (cap === 0) continue;
            let start = lastEnd + 1;
            let end = cap - 1;
            if (start <= end) {
                sortGroups.push({ start: start, end: end });
                lastEnd = end;
            }
        }
        sortGroups.reverse(); // Bottom-Up

        let statusDiv = document.getElementById('builder-instruction') || document.getElementById('builder-status');
        const analysisModule = await import('./core/analysis.js');

        // SCHRITT 1: Leere Slots von unten nach oben befüllen
        for (let group of sortGroups) {
            let targetBits = 8;
            if (group.end <= 3) targetBits = 3;
            else if (group.end <= 7) targetBits = 4;
            else if (group.end <= 15) targetBits = 5;
            else if (group.end <= 31) targetBits = 6;

            for (let i = group.end; i >= group.start; i--) {
                if (i === 0) continue;

                let absSlot = (currentOffset + i) % 256;
                let r = globalPaletteRAM[absSlot * 3];
                let g = globalPaletteRAM[absSlot * 3 + 1];
                let b = globalPaletteRAM[absSlot * 3 + 2];
                
                if (r !== 0 || g !== 0 || b !== 0) continue; // Belegt überspringen

                if (statusDiv) {
                    statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ Fülle Slot ${i} (${targetBits}-Bit Pool)...</span>`;
                }
                
                let stats = analysisModule.computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
                let bitPool = stats.global.byBitDepth[targetBits] || stats.global.top10;
                
                let candMenge = null;
                for (let err of bitPool) {
                    if (!candMenge && err.sortType === "⚖️ Menge") {
                        candMenge = { r: err.r1, g: err.g1, b: err.b1 };
                        break;
                    }
                }
                if (!candMenge && bitPool.length > 0) candMenge = { r: bitPool[0].r1, g: bitPool[0].g1, b: bitPool[0].b1 };
                if (!candMenge) continue;

                // Direkt in den RAM und echtes Reencode triggern
                globalPaletteRAM[absSlot * 3] = candMenge.r;
                globalPaletteRAM[absSlot * 3 + 1] = candMenge.g;
                globalPaletteRAM[absSlot * 3 + 2] = candMenge.b;

                selectedTargetSlot = { index: i, absSlot: absSlot };
                await triggerAutoReencode(); 
                handleFormatChange();      
                btnBuilder.click();        
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        // SCHRITT 2: Nachoptimierung der Wackelkandidaten über echtes Reencode (Battle)
        if (statusDiv) {
            statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ Starte Wackelkandidaten-Nachoptimierung...</span>`;
        }

        // Nutzung der Slots ermitteln
        let totalAnchorUsage = new Array(256).fill(0);
        if (latestCommandArray) {
            let imgW = originalImageData.width;
            for (let i = 0; i < latestCommandArray.length; i++) {
                let cmd = latestCommandArray[i];
                if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined) {
                    let x = i % imgW;
                    let y = Math.floor(i / imgW);
                    if (x >= optRegion.x && x < optRegion.x + optRegion.width &&
                        y >= optRegion.y && y < optRegion.y + optRegion.height) {
                        let absSlot = (currentOffset + cmd.anchorIdx) % 256;
                        totalAnchorUsage[absSlot]++;
                    }
                }
            }
        }

        for (let group of sortGroups) {
            let targetBits = 8;
            let numWeakSlots = 1;
            
            if (group.end <= 3) { targetBits = 3; numWeakSlots = 1; }
            else if (group.end <= 7) { targetBits = 4; numWeakSlots = 2; }
            else if (group.end <= 15) { targetBits = 5; numWeakSlots = 4; }
            else if (group.end <= 31) { targetBits = 6; numWeakSlots = 8; }
            else { targetBits = 8; numWeakSlots = 16; }

            let groupSlots = [];
            for (let i = group.start; i <= group.end; i++) {
                if (i === 0) continue;
                let absSlot = (currentOffset + i) % 256;
                groupSlots.push({ index: i, absSlot: absSlot, usage: totalAnchorUsage[absSlot] });
            }

            groupSlots.sort((a, b) => a.usage - b.usage);
            let weakSlots = groupSlots.slice(0, numWeakSlots);

            for (let slotInfo of weakSlots) {
                let absSlot = slotInfo.absSlot;

                if (statusDiv) {
                    statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ Optimiere Wackelkandidat Slot ${slotInfo.index}...</span>`;
                }

                let stats = analysisModule.computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
                let bitPool = stats.global.byBitDepth[targetBits] || stats.global.top10;

                let candMenge = null;
                let candSpitze = null;
                for (let err of bitPool) {
                    if (!candMenge && err.sortType === "⚖️ Menge") candMenge = { r: err.r1, g: err.g1, b: err.b1 };
                    if (!candSpitze && err.sortType === "🔥 Spitze") candSpitze = { r: err.r1, g: err.g1, b: err.b1 };
                }
                if (!candMenge) continue;
                if (!candSpitze) candSpitze = candMenge;

                // Wir messen die echte Bildqualität (avgYuv) nach echtem Reencode per Direktvergleich:
                let baseDecodedData = new Uint8ClampedArray(decodedImageData.data);
                let baseAvgYuv = stats.global.avgYuv;

                // Test B: Mit Menge
                let backupR = globalPaletteRAM[absSlot*3], backupG = globalPaletteRAM[absSlot*3+1], backupB = globalPaletteRAM[absSlot*3+2];
                
                globalPaletteRAM[absSlot * 3] = candMenge.r; 
                globalPaletteRAM[absSlot * 3 + 1] = candMenge.g; 
                globalPaletteRAM[absSlot * 3 + 2] = candMenge.b;
                await triggerAutoReencode();
                let statsMenge = analysisModule.computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
                let scoreMenge = statsMenge.global.avgYuv;

                // Test C: Mit Spitze
                globalPaletteRAM[absSlot * 3] = candSpitze.r; 
                globalPaletteRAM[absSlot * 3 + 1] = candSpitze.g; 
                globalPaletteRAM[absSlot * 3 + 2] = candSpitze.b;
                await triggerAutoReencode();
                let statsSpitze = analysisModule.computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
                let scoreSpitze = statsSpitze.global.avgYuv;

                // Finde das absolute Optimum im echten Reencode
                let bestScore = Math.min(baseAvgYuv, scoreMenge, scoreSpitze);

                if (bestScore === baseAvgYuv) {
                    // Original behalten
                    globalPaletteRAM[absSlot * 3] = backupR; 
                    globalPaletteRAM[absSlot * 3 + 1] = backupG; 
                    globalPaletteRAM[absSlot * 3 + 2] = backupB;
                    await triggerAutoReencode();
                } else if (bestScore === scoreMenge) {
                    // Menge gewinnt (RAM ist schon gesetzt)
                } else {
                    // Spitze gewinnt
                    globalPaletteRAM[absSlot * 3] = candSpitze.r; 
                    globalPaletteRAM[absSlot * 3 + 1] = candSpitze.g; 
                    globalPaletteRAM[absSlot * 3 + 2] = candSpitze.b;
                    await triggerAutoReencode();
                }

                selectedTargetSlot = { index: slotInfo.index, absSlot: absSlot };
                handleFormatChange();      
                btnBuilder.click();        
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        if (statusDiv) {
            statusDiv.innerHTML = `<span style='color:#28a745; font-weight:bold;'>✅ Auto-Füllen & Nachoptimierung beendet!</span>`;
        }
        
        selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        btnBuilder.click(); 
    });
}
if (btnAnalysis && analysisModal) {
    btnAnalysis.addEventListener('click', () => {
        if (!decodedImageData || !originalImageData) { alert("Bitte zuerst das Bild codieren."); return; }
        analysisModal.style.display = 'block'; 
        
        let config = HAM_CONFIGS[currentFormat];
        let step = getGlobalStep();
        let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
        let stats = computeDetailedAnalysis(originalImageData.data, decodedImageData.data, currentImgW, currentImgH, 0, totalPixels, step, metric, config, optRegion);
        
        let top5Div = document.getElementById('analysis-top5');
        if (top5Div) {
            top5Div.innerHTML = generateTop10Html(stats.global.top10);

            top5Div.onclick = (ev) => {
                let item = ev.target.closest('.top10-cluster-item');
                if (!item) return;
                let targetX = parseInt(item.dataset.x);
                let targetY = parseInt(item.dataset.y);
                if (!isNaN(targetX) && !isNaN(targetY)) {
                    centerOnCoordinate(targetX, targetY, currentImgW, currentImgH);
                }
            };
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

if (btnResetSlots) {
    btnResetSlots.addEventListener('click', async () => {
        if (!originalImageData) return;
        if (!confirm("Möchtest du wirklich alle anpassbaren Slots dieser Bank auf Schwarz (0, 0, 0) zurücksetzen?")) return;

        let config = HAM_CONFIGS[currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;
        let currentOffset = getGlobalOffset();

        ensureSlotZeroBlack();

        for (let i = 1; i < slots; i++) {
            let absSlot = (currentOffset + i) % 256;
            globalPaletteRAM[absSlot * 3] = 0;
            globalPaletteRAM[absSlot * 3 + 1] = 0;
            globalPaletteRAM[absSlot * 3 + 2] = 0;
        }

        await triggerAutoReencode();
        handleFormatChange();
        
        let bModal = document.getElementById('builder-modal');
        if (bModal && bModal.style.display === 'block') {
            btnBuilder.click(); 
        }
    });
}

// ============================================================================
// AUTO-STEP OPTIMIERUNG (Mit ROI-Filter)
// ============================================================================
if (btnAutoStep && autoStepModal) {
    btnAutoStep.addEventListener('click', async () => {
        if (!originalImageData) { alert("Bitte zuerst ein Bild laden."); return; }
        
        autoStepModal.style.display = 'block';
        if(autoStepBody) autoStepBody.innerHTML = '';
        if(autoStepStatus) autoStepStatus.innerText = 'Berechne optimale Schrittweiten... (Dies kann einen Moment dauern)';
        
        let minStep = parseInt(autoMinStepInp.value) || 1;
        let maxStep = parseInt(autoMaxStepInp.value) || 16;
        let strategy = encodeStrategySelect ? encodeStrategySelect.value : "both";
        let metric = encodeMetricSelect ? encodeMetricSelect.value : "yuv_weight";
        let max_depth = strategy.startsWith('lookahead_') ? parseInt(strategy.split('_')[1]) : 1;
        let currentOffset = getGlobalOffset();

        import('./core/analysis.js').then(async (module) => {
            let results = [];

            for (let s = minStep; s <= maxStep; s++) {
                let testStep = { r: s, g: s, b: s };
                
                let sim = await module.runSimulationWithStrategy(
                    0, totalPixels, originalImageData.data, currentImgW, 
                    globalPaletteRAM, testStep, strategy, metric, max_depth, 
                    currentFormat, currentOffset, optRegion
                );
                
                results.push({ step: s, ...sim });
                
                if(autoStepStatus) autoStepStatus.innerText = `Analysiere Schrittweite ${s} von ${maxStep}...`;
                await new Promise(r => setTimeout(r, 10)); 
            }

            results.sort((a, b) => a.score - b.score);
            
            let html = '';
            results.forEach((r, idx) => {
                let isBest = idx === 0;
                let rowStyle = isBest ? 'background-color: rgba(40, 167, 69, 0.2); font-weight: bold;' : '';
                let btnHtml = `<button class="btn-apply-step" data-step="${r.step}" style="background:#007bff; color:#fff; border:none; padding:2px 6px; border-radius:3px; cursor:pointer;">Übernehmen</button>`;
                
                html += `<tr style="${rowStyle}">
                    <td>± ${r.step} ${isBest ? '⭐' : ''}</td>
                    <td>${r.avgRgb.toFixed(2)}</td>
                    <td>${r.avgYuv.toFixed(2)}</td>
                    <td>${r.maxYuv.toFixed(2)}</td>
                    <td>${btnHtml}</td>
                </tr>`;
            });
            
            if(autoStepBody) autoStepBody.innerHTML = html;
            
            let regionText = (optRegion.width === currentImgW) ? "Ganzes Bild" : "Ausschnitt aktiv";
            if(autoStepStatus) autoStepStatus.innerText = `Analyse abgeschlossen. Bereich: ±${minStep} bis ±${maxStep}. (${regionText})`;
            
            document.querySelectorAll('.btn-apply-step').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    let chosenStep = e.target.getAttribute('data-step');
                    hamStepR.value = chosenStep;
                    hamStepG.value = chosenStep;
                    hamStepB.value = chosenStep;
                    
                    autoStepModal.style.display = 'none';
                    triggerAutoReencode();
                });
            });
        });
    });
}