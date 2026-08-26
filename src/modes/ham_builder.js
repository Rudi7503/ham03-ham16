// src/modes/ham_builder.js

import { HAM_CONFIGS } from '../codecs/configs.js';
import { rgbToHex, hexToRgb } from '../codecs/utils.js';
import { encodePaletted, decodePaletted, packPaletted } from '../core/module_paletted.js';
import { encodeHam12_16, decodeHam12_16, packHam12_16 } from '../core/module_ham12_16.js';
import { debugRoundtripHam12_16, debugRoundtripPaletted } from '../core/debugger.js';
import { computeDetailedAnalysis, errorBins, getImageHistogram } from '../core/analysis.js';
import { applySmartBandwidthFilter } from '../core/feedback.js';
import { setZoomMode, centerOnCoordinate, setupCanvasEvents, viewState } from '../ui/canvas-view.js';

let lockedSlots = new Set();
let latestErrorOverlayData = null;
let lastShiftCount = 0;
let optRegion = { x: 0, y: 0, width: 0, height: 0 };
let isRegionModeActive = false;
let isDrawingRegion = false;
let startX = 0, startY = 0;
let selectedTargetSlot = null;

function updateProgress(phase, current, total) {
    let pBar = document.getElementById('progress');
    let sText = document.getElementById('status-text');
    let pct = total > 0 ? Math.floor((current / total) * 100) : 0;
    if (pBar) pBar.value = pct;
    if (sText) sText.innerText = `${phase}: ${pct}%`;
}

export function initHamBuilderMode(appState, containerEl) {
    if (!appState.originalImageData) {
        containerEl.innerHTML = `<div style="color:#aaa; padding:20px; font-family:sans-serif;">Bitte zuerst oben ein Bild laden.</div>`;
        return;
    }

    // 1. KOMPLETTE UI INJIZIEREN (Original Top-Bar Struktur)
    containerEl.innerHTML = `
        <style>
            #top-bar { background-color: #1e2124; padding: 12px 20px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); display: flex; flex-wrap: wrap; gap: 10px; align-items: center; z-index: 10; border-bottom: 2px solid #444; }
            .control-group { display: flex; align-items: center; gap: 5px; }
            label { font-weight: bold; font-size: 11px; color: #ccc; }
            select, input[type="range"], input[type="number"] { padding: 4px; border-radius: 4px; font-size: 11px; background: #fff; color: #000; }
            input[type="number"] { width: 45px; text-align: center; }
            button, .btn-label { padding: 6px 10px; font-size: 12px; font-weight: bold; border: none; border-radius: 4px; cursor: pointer; transition: background 0.2s; display: inline-block; box-sizing: border-box; }
            #btn-encode { background-color: #28a745; color: white; } #btn-encode:hover { background-color: #218838; }
            #btn-save { background-color: #ffc107; color: black; } #btn-save:hover { background-color: #e0a800; }
            #btn-debug-roundtrip { background-color: #dc3545; color: white; } #btn-debug-roundtrip:hover { background-color: #c82333; }
            #btn-builder { background-color: #17a2b8; color: white; } #btn-builder:hover { background-color: #138496; }
            #btn-auto-step { background-color: #e83e8c; color: white; padding: 4px 6px; font-size: 11px; } #btn-auto-step:hover { background-color: #d63384; }
            #btn-analysis { background-color: #6f42c1; color: white; } #btn-analysis:hover { background-color: #5a32a3; }
            #btn-encode:disabled, #btn-save:disabled, #btn-builder:disabled, #btn-analysis:disabled, #btn-debug-roundtrip:disabled { background-color: #555; cursor: not-allowed; color: #888; }
            .btn-zoom { background-color: #6c757d; color: white; } .btn-zoom.active { background-color: #17a2b8; }
            #palette-box { display: flex; background: #111; padding: 3px 6px; border-radius: 4px; border: 1px solid #444; align-items: center; gap: 6px; }
            #palette-pickers-container { display: flex; gap: 2px; flex-wrap: wrap; max-width: 260px; max-height: 120px; overflow-y: auto; }
            .palette-picker { width: 18px; height: 18px; border: none; cursor: pointer; padding: 0; background: none; }
            .status-container { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 260px; border-left: 2px solid #555; padding-left: 10px; }
            progress { width: 100%; height: 6px; } 
            .status-row { display: flex; justify-content: space-between; font-size: 11px; color: #aaa; }
            #image-area { display: flex; flex: 1; overflow: hidden; background-color: #000; }
            .view-pane { flex: 1; position: relative; overflow: hidden; cursor: grab; }
            #pane-left { border-right: 2px solid #444; }
            .pane-label { position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.7); padding: 5px 10px; border-radius: 4px; font-weight: bold; font-size: 12px; z-index: 100; pointer-events: none; }
            .divider { width: 2px; height: 25px; background-color: #555; margin: 0 2px; }
        </style>
        
        <div style="display:flex; flex-direction:column; width:100%; height:100%;">
            <!-- Builder Toolbar (Original Structure) -->
            <div id="top-bar">
                <div class="control-group">
                    <button id="btn-encode">2. Codieren</button>
                    <button id="btn-save" disabled>3. Speichern</button>
                    <button id="btn-debug-roundtrip" title="Codiere, Packe, Entpacke und vergleiche die Befehle">4. Debug Vergleichen</button>
                </div>
                
                <div class="divider"></div>
                <div class="control-group">
                    <label>Farboptimierung:</label>
                    <button id="btn-draw-region" title="Rechteck auf dem Bild ziehen">Ausschnitt wählen</button>
                    <button id="btn-reset-region" title="Wieder das ganze Bild nutzen">Ganzes Bild</button>
                    <div id="region-info" style="font-size: 0.85em; color: #888; margin-top: 5px;">Bereich: Ganzes Bild</div>
                </div>

                <div class="divider"></div>
                <div class="control-group">
                    <label>Format:</label>
                    <select id="format">
                        <option value="HAM_32BIT_44444444">HAM 32-Bit 44444444 (4/4/4/4/4/4/4/4)  4.0 Bit/pixel</option>
                        <option value="HAM_32BIT_53535353">HAM 32-Bit 53535353 (5/3/5/3/5/3/5/3)  4.0 Bit/pixel</option>
                        <option value="HAM_32BIT_63436343" selected>HAM 32-Bit 63436343 (6/3/4/3/6/3/4/3)  4.0 Bit/pixel</option>
                        <option value="HAM_32BIT_6446444">HAM 32-Bit 6446444  (6/4/4/6/4/4/4)   4.6 Bit/pixel</option>
                        <option value="HAM_32BIT_5454545">HAM 32-Bit 5454545  (5/4/5/4/5/4/5)    4.6 Bit/pixel</option>
                        <option value="HAM_32BIT_6454544">HAM 32-Bit 6454544  (6/4/5/4/5/4/4)    4.6 Bit/pixel</option>
                        <option value="HAM_32BIT_655655">HAM 32-Bit 655655   (6/5/5/6/5/5)      5.3 Bit/pixel</option>
                        <option value="HAM_32BIT_844844">HAM 32-Bit 844844   (8/4/4/8/4/4)      5.3 Bit/pixel</option>
                        <option value="HAM_32BIT_846554">HAM 32-Bit 846554   (8/4/6/5/5/4)      5.3 Bit/pixel</option>
                        <option value="HAM_32BIT_646565">HAM 32-Bit 646565   (6/4/6/5/6/5)      5.3 Bit/pixel</option>
                        <option value="HAM_32BIT_86666">HAM 32-Bit 86666    (8/6/6/6/6)        6.4 Bit/pixel</option>
                        <option value="HAM_32BIT_85865">HAM 32-Bit 85856    (8/5/8/6/5)        6.4 Bit/pixel</option>
                        <option value="HAM_32BIT_8888">HAM 32-Bit 8888     (8/8/8/8)          8.0 Bit/pixel</option>
                        <option value="HAM12">HAM12</option>
                        <option value="HAM16">HAM16</option>
                    </select>
                </div>

                <div class="control-group">
                    <label>Strategie:</label>
                    <select id="encode-strategy">
                        <option value="greedy" selected>Greedy (Schnell)</option>
                        <option value="lookahead_chunk">Chunk-Lookahead (Branch & Bound)</option>
                        <option value="anchor_only">Nur Anker</option>
                        <option value="delta_only">Nur Delta</option>
                    </select>
                </div>
                
                <div class="control-group" style="background:#111; padding:2px 8px; border-radius:4px; border:1px solid #007bff;">
                    <label style="color:#4dabf7;" title="Smart Bandwidth Feedback">Feedback Loop:</label>
                    <label title="Anzahl der Durchläufe (1 = Standard-Codierung ohne Feedback)">Iter:</label>
                    <input type="number" id="feedback-iter" min="1" max="10" value="1" style="width:35px;">
                    <label title="Höherer Wert = Es wird WENIGER gefiltert (mehr Pixel bleiben geschützt)">
                        Toleranz: <input type="number" id="filter-tolerance" step="0.5" min="0.5" max="15.0" value="6.5" style="width:45px;">
                    </label>
                    <label title="Zeigt das modifizierte Originalbild (Target für den Encoder) im Decoder-Canvas an">
                        <input type="checkbox" id="chk-error-overlay" style="vertical-align: middle;"> Zeige mod. Original
                    </label>
                </div>
                
                <div class="control-group">
                    <label>Metrik:</label>
                    <select id="encode-metric">
                        <option value="oklab">Oklab (Perzeptuell Perfekt)</option>
                        <option value="redmean">Redmean (Schnell & Wahrnehmung)</option>
                        <option value="yuv_weight_heavy">YUV (Gewichtet Stark)</option>
                        <option value="yuv_weight" selected>YUV (Gewichtet)</option>
                        <option value="yuv">YUV (Standard)</option>
                        <option value="rgb">RGB</option>
                        <option value="rgb_ABS">RGB (ABS)</option>
                    </select>
                </div>
                
                <div class="control-group">
                    <label for="lookahead-threshold" title="MSE-Schwellenwert: Blöcke unter diesem Wert überspringen den Lookahead">Lookahead Threshold:</label>
                    <input type="number" id="lookahead-threshold" value="15" min="0" max="100" step="1" style="width: 50px;">
                </div>

                <div class="control-group" id="ham-step-group">
                    <label>Schritt:</label>
                    <div style="display:flex; gap:2px;">
                        <input type="number" id="ham-step-r" min="1" max="128" value="4" style="width:35px; color:#ff6b6b; font-weight:bold;" title="Rot">
                        <input type="number" id="ham-step-g" min="1" max="128" value="4" style="width:35px; color:#28a745; font-weight:bold;" title="Grün">
                        <input type="number" id="ham-step-b" min="1" max="128" value="4" style="width:35px; color:#4dabf7; font-weight:bold;" title="Blau">
                    </div>
                    <div style="display:flex; align-items:center; gap:2px; background:#111; padding:2px 4px; border-radius:4px; border:1px solid #444;">
                        <label style="font-size:10px;">Min:</label>
                        <input type="number" id="auto-min-step" min="1" max="128" value="4" style="width:30px;">
                        <label style="font-size:10px;">Max:</label>
                        <input type="number" id="auto-max-step" min="1" max="128" value="16" style="width:30px;">
                    </div>
                    <button id="btn-auto-step" title="Teste Schrittweitenbereich">Auto</button>
                </div>

                <div id="palette-box">
                    <label title="Startindex im 256er RAM (0-255)">Offset:</label>
                    <input type="number" id="pal-offset-input" min="0" max="255" value="0" style="width:40px;">
                    <div id="palette-pickers-container"></div>
                    <button id="btn-builder">Build Set</button>
                </div>

                <div class="divider"></div>
                <div class="control-group">
                    <button id="btn-zoom-fit" class="btn-zoom active">Fit</button>
                    <button id="btn-zoom-1x" class="btn-zoom">1x</button>
                    <button id="btn-zoom-2x" class="btn-zoom">2x</button>
                    <button id="btn-zoom-4x" class="btn-zoom">4x</button>
                    <button id="btn-zoom-8x" class="btn-zoom">8x</button>
                    <button id="btn-zoom-16x" class="btn-zoom">16x</button>
                    <button id="btn-zoom-32x" class="btn-zoom">32x</button>
                </div>
                
                <div class="control-group">
                    <button id="btn-analysis">Fehler-Analyse</button>
                    <div id="avg-mse-display" style="display:none;">⌀ RGB: 0.0 | ⌀ YUV: 0.0</div>
                </div>

                <div class="status-container">
                    <div class="status-row">
                        <span id="img-dim-text">Größe: - | Farben: - | Modus: -</span>
                        <span id="mouse-pos-text">X: - | Y: - | Px: -</span>
                    </div>
                    <progress id="progress" value="0" max="100"></progress>
                    <div class="status-row"><span id="status-text">Warte auf Bild...</span></div>
                </div>
            </div>

            <!-- Image Area -->
            <div id="image-area">
                <div class="view-pane" id="pane-left"><div class="pane-label">ORIGINAL</div><canvas id="canvas-original"></canvas></div>
                <div class="view-pane" id="pane-right"><div class="pane-label" id="decoded-label">DEKODIERT</div><canvas id="canvas-decoded"></canvas></div>
            </div>
        </div>

        <!-- Modals -->
        <div id="analysis-modal" style="display:none; position:absolute; top:10%; left:10%; background:#1e2124; padding:20px; border:1px solid #444; border-radius:8px; z-index:1000; width:800px; color:#fff; box-shadow:0 10px 30px rgba(0,0,0,0.8);">
            <h3>Fehler- & Histogramm-Analyse</h3>
            <div id="analysis-top5" style="background:#111; padding:8px; max-height:200px; overflow-y:auto; margin-bottom:10px;"></div>
            <div id="analysis-histogram-body" style="background:#111; padding:8px; max-height:250px; overflow-y:auto;"></div>
            <button id="btn-analysis-close" style="margin-top:10px; padding:5px 10px;">Schließen</button>
        </div>

        <div id="auto-step-modal" style="display:none; position:absolute; top:15%; left:15%; background:#1e2124; padding:20px; border:1px solid #444; border-radius:8px; z-index:1000; width:600px; color:#fff; box-shadow:0 10px 30px rgba(0,0,0,0.8);">
            <h3>Auto-Schrittweiten-Analyse</h3>
            <div id="auto-step-status" style="margin-bottom:10px; color:#ffc107;">Berechne...</div>
            <table style="width:100%; text-align:left; font-size:11px; border-collapse:collapse;">
                <thead><tr style="background:#333;"><th>Schritt (±)</th><th>⌀ RGB</th><th>⌀ YUV</th><th>Aktion</th></tr></thead>
                <tbody id="auto-step-body"></tbody>
            </table>
            <button id="btn-auto-step-close" style="margin-top:10px; padding:5px 10px;">Schließen</button>
        </div>
        
        <div id="builder-modal" style="display:none; position:absolute; top:5%; left:5%; background:#1e2124; padding:20px; border:1px solid #444; border-radius:8px; z-index:1000; width:850px; color:#fff; box-shadow:0 10px 30px rgba(0,0,0,0.8);">
            <h3>Optimierer</h3>
            <div id="builder-status" style="color:#aaa; font-size:12px; margin-bottom:5px;"></div>
            <div id="builder-palette-preview" style="display:flex; flex-wrap:wrap; gap:3px; background:#000; padding:6px; border-radius:4px; max-height:75px; overflow-y:auto;"></div>
            <div style="display:flex; gap:15px; margin-top:10px;">
                <div style="flex:2;" id="builder-mse-list"></div>
                <div style="flex:1;" id="builder-hist-list"></div>
            </div>
            <div style="margin-top:15px; display:flex; justify-content:space-between;">
                <button id="btn-builder-cancel" style="padding:5px 10px;">Schließen</button>
                <div style="display:flex; gap:5px;">
                    <button id="btn-sort-slots" style="background:#17a2b8; color:#fff; padding:5px 10px;">Slots sortieren</button>
                    <button id="btn-builder-auto" style="background:#28a745; color:#fff; padding:5px 10px;">Auto-Füllen</button>
                </div>
            </div>
        </div>
    `;

    // 2. CANVAS SETUP & BILD RENDERN
    const canvasOrig = document.getElementById('canvas-original');
    const canvasDec = document.getElementById('canvas-decoded');
    const ctxOrig = canvasOrig.getContext('2d');
    const ctxDec = canvasDec.getContext('2d');

    canvasOrig.width = appState.currentImgW; canvasOrig.height = appState.currentImgH;
    canvasDec.width = appState.currentImgW; canvasDec.height = appState.currentImgH;
    ctxOrig.putImageData(appState.originalImageData, 0, 0);

    if (appState.decodedImageData) {
        ctxDec.putImageData(appState.decodedImageData, 0, 0);
    }
    
    document.getElementById('img-dim-text').innerText = `Größe: ${appState.currentImgW}x${appState.currentImgH} px | Modus: ${appState.currentFormat}`;

    // Zoom & Pan Logik verbinden
    setupCanvasEvents(
        () => ({ w: appState.currentImgW, h: appState.currentImgH }),
        () => ({ original: appState.originalImageData, decoded: appState.decodedImageData })
    );

    ['fit', '1x', '2x', '4x', '8x', '16x', '32x'].forEach(mode => {
        let btn = document.getElementById(`btn-zoom-${mode}`);
        if (btn) btn.addEventListener('click', () => setZoomMode(mode, appState.currentImgW, appState.currentImgH));
    });
    
    setTimeout(() => setZoomMode('fit', appState.currentImgW, appState.currentImgH), 100);

    // 3. ROI (REGION OF INTEREST)
    optRegion = { x: 0, y: 0, width: appState.currentImgW, height: appState.currentImgH };
    const btnDrawRegion = document.getElementById('btn-draw-region');
    const btnResetRegion = document.getElementById('btn-reset-region');
    
    btnDrawRegion.addEventListener('click', () => { isRegionModeActive = true; canvasOrig.style.cursor = 'crosshair'; });
    btnResetRegion.addEventListener('click', () => {
        isRegionModeActive = false; canvasOrig.style.cursor = 'grab';
        optRegion = { x: 0, y: 0, width: appState.currentImgW, height: appState.currentImgH };
        document.getElementById('region-info').innerText = 'Bereich: Ganzes Bild';
        ctxOrig.putImageData(appState.originalImageData, 0, 0);
    });

    canvasOrig.addEventListener('mousedown', (e) => {
        if (!isRegionModeActive) return;
        e.stopPropagation(); isDrawingRegion = true;
        let rect = canvasOrig.getBoundingClientRect();
        startX = Math.floor((e.clientX - rect.left) * (canvasOrig.width / rect.width));
        startY = Math.floor((e.clientY - rect.top) * (canvasOrig.height / rect.height));
    });
    canvasOrig.addEventListener('mousemove', (e) => {
        if (!isDrawingRegion) return; e.stopPropagation();
        let rect = canvasOrig.getBoundingClientRect();
        let curX = Math.floor((e.clientX - rect.left) * (canvasOrig.width / rect.width));
        let curY = Math.floor((e.clientY - rect.top) * (canvasOrig.height / rect.height));
        ctxOrig.putImageData(appState.originalImageData, 0, 0);
        ctxOrig.strokeStyle = "rgba(255,0,0,0.8)"; ctxOrig.lineWidth = 2; ctxOrig.setLineDash([5,5]);
        ctxOrig.strokeRect(startX, startY, curX - startX, curY - startY);
    });
    canvasOrig.addEventListener('mouseup', (e) => {
        if (!isDrawingRegion) return; e.stopPropagation();
        isDrawingRegion = false; isRegionModeActive = false; canvasOrig.style.cursor = 'grab';
        let rect = canvasOrig.getBoundingClientRect();
        let endX = Math.floor((e.clientX - rect.left) * (canvasOrig.width / rect.width));
        let endY = Math.floor((e.clientY - rect.top) * (canvasOrig.height / rect.height));
        optRegion.x = Math.max(0, Math.min(startX, endX)); optRegion.y = Math.max(0, Math.min(startY, endY));
        optRegion.width = Math.min(appState.currentImgW - optRegion.x, Math.abs(endX - startX));
        optRegion.height = Math.min(appState.currentImgH - optRegion.y, Math.abs(endY - startY));
        document.getElementById('region-info').innerText = `Bereich: X:${optRegion.x} Y:${optRegion.y} B:${optRegion.width} H:${optRegion.height}`;
        ctxOrig.putImageData(appState.originalImageData, 0, 0);
        ctxOrig.strokeRect(optRegion.x, optRegion.y, optRegion.width, optRegion.height);
    });

    // 4. FORMAT-WECHSEL & UI-LOGIK
    function handleFormatChange() {
        let fmtSelect = document.getElementById('format');
        appState.currentFormat = fmtSelect ? fmtSelect.value : "HAM_32BIT_63436343";
        let config = HAM_CONFIGS[appState.currentFormat];
        let isPalFormat = config && config.isPaletted;
        
        document.getElementById('img-dim-text').innerText = `Größe: ${appState.currentImgW}x${appState.currentImgH} px | Modus: ${appState.currentFormat}`;

        let paletteBox = document.getElementById('palette-box');
        if (paletteBox) paletteBox.style.display = isPalFormat ? 'flex' : 'none';
        
        let btnBuilder = document.getElementById('btn-builder');
        if (btnBuilder) btnBuilder.disabled = !isPalFormat || !appState.originalImageData;
        
        renderPaletteWithLocks(appState);
    }
    
    document.getElementById('format').value = appState.currentFormat;
    document.getElementById('format').addEventListener('change', handleFormatChange);
    document.getElementById('pal-offset-input').addEventListener('change', handleFormatChange);
    
    handleFormatChange(); // Init

    // 5. HAUPT-ENCODER & SPEICHER-LOGIK
    const btnEncode = document.getElementById('btn-encode');
    const btnSave = document.getElementById('btn-save');
    const chkErrorOverlay = document.getElementById('chk-error-overlay');
    
    chkErrorOverlay.addEventListener('change', (e) => {
        if (!appState.decodedImageData) return;
        ctxDec.putImageData(e.target.checked && latestErrorOverlayData ? latestErrorOverlayData : appState.decodedImageData, 0, 0);
    });

    async function triggerEncode() {
        let format = appState.currentFormat;
        let step = { 
            r: parseInt(document.getElementById('ham-step-r').value) || 8,
            g: parseInt(document.getElementById('ham-step-g').value) || 8,
            b: parseInt(document.getElementById('ham-step-b').value) || 8 
        };
        let strategy = document.getElementById('encode-strategy').value;
        let metric = document.getElementById('encode-metric').value;
        let iter = parseInt(document.getElementById('feedback-iter').value) || 1;
        let threshold = parseFloat(document.getElementById('lookahead-threshold').value) || 15.0;
        let tolerance = parseFloat(document.getElementById('filter-tolerance').value) || 2.5;
        let offset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        let is16BitClass = (format === "HAM12" || format === "HAM16");
        let config = HAM_CONFIGS[format];
        appState.globalPaletteRAM[0] = 0; appState.globalPaletteRAM[1] = 0; appState.globalPaletteRAM[2] = 0;

        let currentTargetData = new Uint8ClampedArray(appState.originalImageData.data);
        let decodedPixels = null;
        latestErrorOverlayData = null;

        for (let i = 1; i <= iter; i++) {
            updateProgress(iter > 1 ? `[Iter ${i}/${iter}] Starte Codierung...` : `Starte Codierung...`, 0, 100);

            if (is16BitClass) {
                appState.latestCommandArray = await encodeHam12_16(currentTargetData, appState.currentImgW, appState.currentImgH, format, step, strategy, metric, 1, updateProgress, 0, 0);
                appState.latestPackedData = packHam12_16(appState.latestCommandArray, format);
                decodedPixels = decodeHam12_16(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step);
            } else {
                let encodeRes = await encodePaletted(currentTargetData, appState.currentImgW, appState.currentImgH, format, step, appState.globalPaletteRAM, offset, strategy, metric, updateProgress, 0, 0, threshold);
                appState.latestCommandArray = encodeRes.commands;
                appState.latestPackedData = packPaletted(appState.latestCommandArray, format);
                decodedPixels = decodePaletted(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step, appState.globalPaletteRAM, offset);
            }

            appState.decodedImageData = new ImageData(decodedPixels, appState.currentImgW, appState.currentImgH);
            ctxDec.putImageData((chkErrorOverlay.checked && latestErrorOverlayData) ? latestErrorOverlayData : appState.decodedImageData, 0, 0);

            if (i < iter) {
                updateProgress(`[Iter ${i}/${iter}] Berechne Smart Target...`, 50, 100);
                await new Promise(r => setTimeout(r, 10));
                let filterResult = applySmartBandwidthFilter(appState.originalImageData.data, decodedPixels, appState.currentImgW, appState.currentImgH, step, config, format, tolerance);
                currentTargetData = filterResult.target;
                lastShiftCount = filterResult.shiftCount;
            }
        }

        if (iter > 1) {
            let filterResult = applySmartBandwidthFilter(appState.originalImageData.data, decodedPixels, appState.currentImgW, appState.currentImgH, step, config, format, tolerance);
            latestErrorOverlayData = new ImageData(filterResult.target, appState.currentImgW, appState.currentImgH);
            if (chkErrorOverlay.checked) ctxDec.putImageData(latestErrorOverlayData, 0, 0);
        }

        updateProgress("Fertig", 100, 100);
        btnSave.disabled = false;
        if(document.getElementById('btn-debug-roundtrip')) document.getElementById('btn-debug-roundtrip').disabled = false;
    }

    btnEncode.addEventListener('click', async () => {
        btnEncode.disabled = true; btnSave.disabled = true;
        await triggerEncode();
        btnEncode.disabled = false;
    });

    btnSave.addEventListener('click', () => {
        if (!appState.latestPackedData) return;
        let fmt = appState.currentFormat;
        let customName = prompt("Bitte Dateinamen eingeben (ohne Endung):", `${appState.currentImgFileName}_${fmt.toLowerCase()}`);
        if (!customName) return;

        let fmtBytes = new TextEncoder().encode(fmt);
        let step = { 
            r: parseInt(document.getElementById('ham-step-r').value) || 8,
            g: parseInt(document.getElementById('ham-step-g').value) || 8,
            b: parseInt(document.getElementById('ham-step-b').value) || 8 
        };
        let offset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        let buffer = new ArrayBuffer(11 + fmtBytes.length + 4 + 768 + appState.latestPackedData.length);
        let view = new DataView(buffer);
        let u8 = new Uint8Array(buffer);
        
        u8.set([72, 65, 77, 33], 0); 
        view.setUint8(4, 3);
        view.setUint8(5, 0);
        view.setUint16(6, appState.currentImgW, true);
        view.setUint16(8, appState.currentImgH, true);
        view.setUint8(10, fmtBytes.length);
        
        let p = 11;
        u8.set(fmtBytes, p); p += fmtBytes.length;
        view.setUint8(p++, step.r); view.setUint8(p++, step.g); view.setUint8(p++, step.b); view.setUint8(p++, offset);
        
        u8.set(appState.globalPaletteRAM, p); p += 768;
        u8.set(appState.latestPackedData, p);

        const url = URL.createObjectURL(new Blob([buffer]));
        const a = document.createElement('a');
        a.href = url; a.download = `${customName}.ham`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // 6. DEBUG ROUNDTRIP
    const btnDebug = document.getElementById('btn-debug-roundtrip');
    btnDebug.addEventListener('click', async () => {
        let fmt = appState.currentFormat;
        let step = { r: parseInt(document.getElementById('ham-step-r').value), g: parseInt(document.getElementById('ham-step-g').value), b: parseInt(document.getElementById('ham-step-b').value) };
        let strat = document.getElementById('encode-strategy').value;
        let met = document.getElementById('encode-metric').value;
        let off = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        if (fmt === "HAM12" || fmt === "HAM16") await debugRoundtripHam12_16(appState.originalImageData.data, appState.currentImgW, appState.currentImgH, fmt, step, strat, met);
        else await debugRoundtripPaletted(appState.originalImageData.data, appState.currentImgW, appState.currentImgH, fmt, step, appState.globalPaletteRAM, off, strat, met);
    });

    // 7. BUILDER MODAL (AUTO-FILL & ANALYSE)
    const builderModal = document.getElementById('builder-modal');
    document.getElementById('btn-builder').addEventListener('click', () => {
        builderModal.style.display = 'block';
        let config = HAM_CONFIGS[appState.currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;
        let currentOffset = parseInt(document.getElementById('pal-offset-input')?.value || 0);
        
        // Vorschaubereich generieren
        let preview = document.getElementById('builder-palette-preview');
        preview.innerHTML = "";
        for (let i = 0; i < slots; i++) {
            let absSlot = (currentOffset + i) % 256;
            let r = appState.globalPaletteRAM[absSlot*3], g = appState.globalPaletteRAM[absSlot*3+1], b = appState.globalPaletteRAM[absSlot*3+2];
            let div = document.createElement('div');
            div.style.cssText = `width:20px; height:20px; border:1px solid #444; background:rgb(${r},${g},${b}); cursor:pointer; color:#fff; font-size:10px; display:flex; align-items:center; justify-content:center;`;
            div.innerText = i;
            div.onclick = () => { selectedTargetSlot = { index: i, absSlot: absSlot }; document.getElementById('builder-status').innerText = `Slot ${i} gewählt. Klicke auf Histogramm zum Füllen.`; };
            preview.appendChild(div);
        }
        
        // Histogramm generieren
        let histList = document.getElementById('builder-hist-list');
        let histData = getImageHistogram(appState.originalImageData, appState.currentImgW, appState.currentImgH, {r:8,g:8,b:8}, 15, appState.globalPaletteRAM, currentOffset, optRegion);
        histList.innerHTML = histData.map(e => `<div style="background:rgb(${e.r},${e.g},${e.b}); padding:4px; margin-bottom:2px; font-size:10px; cursor:pointer;" onclick="window.applyColorToSlot(${e.r},${e.g},${e.b})">RGB(${e.r},${e.g},${e.b}) - ${e.count}x</div>`).join('');
    });

    window.applyColorToSlot = async (r, g, b) => {
        if (!selectedTargetSlot) return alert("Bitte oben zuerst einen Slot auswählen!");
        if (selectedTargetSlot.absSlot % 256 === 0) return alert("Slot 0 ist immer schwarz!");
        appState.globalPaletteRAM[selectedTargetSlot.absSlot * 3] = r;
        appState.globalPaletteRAM[selectedTargetSlot.absSlot * 3 + 1] = g;
        appState.globalPaletteRAM[selectedTargetSlot.absSlot * 3 + 2] = b;
        await triggerEncode();
        document.getElementById('btn-builder').click(); // Refresh Modal
        renderPaletteWithLocks(appState);
    };

    document.getElementById('btn-builder-cancel').addEventListener('click', () => builderModal.style.display = 'none');
}

function renderPaletteWithLocks(appState) {
    const paletteContainer = document.getElementById('palette-pickers-container');
    if (!paletteContainer) return;
    paletteContainer.innerHTML = "";

    let config = HAM_CONFIGS[appState.currentFormat] || HAM_CONFIGS["HAM_32BIT_63436343"];
    let slotsPerBank = config.slotsPerBank || 8;
    let currentOffset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

    for (let i = 0; i < slotsPerBank; i++) {
        let absSlot = (currentOffset + i) % 256;
        let r = appState.globalPaletteRAM[absSlot * 3];
        let g = appState.globalPaletteRAM[absSlot * 3 + 1];
        let b = appState.globalPaletteRAM[absSlot * 3 + 2];
        let isLocked = lockedSlots.has(absSlot);

        let wrapper = document.createElement('div');
        wrapper.style.cssText = "position:relative; display:inline-block; width:100%; height:26px;";

        let input = document.createElement('input');
        input.type = 'color'; input.className = 'palette-picker';
        input.value = rgbToHex(r, g, b);
        input.style.width = "100%"; input.style.height = "100%";

        let lockIcon = document.createElement('div');
        lockIcon.style.cssText = "position:absolute; top:2px; right:2px; font-size:9px; background:rgba(0,0,0,0.6); color:#fff; padding:1px 2px; border-radius:2px; pointer-events:none;";
        lockIcon.innerText = isLocked ? "🔒" : "";

        wrapper.addEventListener('click', (e) => {
            if (e.target !== input) {
                if (isLocked) lockedSlots.delete(absSlot); else lockedSlots.add(absSlot);
                renderPaletteWithLocks(appState);
            }
        });

        input.addEventListener('input', (e) => {
            if (isLocked) { alert("Slot ist gesperrt!"); input.value = rgbToHex(r, g, b); return; }
            let [nr, ng, nb] = hexToRgb(e.target.value);
            appState.globalPaletteRAM[absSlot * 3] = nr; appState.globalPaletteRAM[absSlot * 3 + 1] = ng; appState.globalPaletteRAM[absSlot * 3 + 2] = nb;
        });

        wrapper.appendChild(input);
        wrapper.appendChild(lockIcon);
        paletteContainer.appendChild(wrapper);
    }
}