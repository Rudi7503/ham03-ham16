// src/modes/ham_builder.js

import { HAM_CONFIGS } from '../codecs/configs.js';
import { rgbToHex, hexToRgb } from '../codecs/utils.js';
import { encodePaletted, decodePaletted, packPaletted } from '../core/module_paletted.js';
import { encodeHam12_16, decodeHam12_16, packHam12_16 } from '../core/module_ham12_16.js';
import { debugRoundtripHam12_16, debugRoundtripPaletted } from '../core/debugger.js';
import { computeDetailedAnalysis, errorBins } from '../core/analysis.js';
import { generateSmartTarget } from '../core/smart_target.js';
import { setZoomMode, centerOnCoordinate, setupCanvasEvents } from '../ui/canvas-view.js';
import { encodeDXT1, decodeDXT1 } from '../core/module_dxt1.js';
import { initPaletteBuilderUI } from '../ui/palette_builder.js';

let lockedSlots = new Set();
let optRegion = { x: 0, y: 0, width: 0, height: 0 };
let isRegionModeActive = false;
let isDrawingRegion = false;
let startX = 0, startY = 0;

function updateProgress(phase, current, total) {
    let pBar = document.getElementById('progress');
    let sText = document.getElementById('status-text');
    let pct = total > 0 ? Math.floor((current / total) * 100) : 0;
    if (pBar) pBar.value = pct;
    if (sText) sText.innerText = `${phase}: ${pct}%`;
}

function generateTop10Html(top10Array) {
    return top10Array.length > 0 ? top10Array.map((e, idx) => {
        let sollR = e.r1, sollG = e.g1, sollB = e.b1;
        let istR = e.r2, istG = e.g2, istB = e.b2;
        let formattedMse = Math.round(e.mse).toLocaleString('de-DE');
        let typeBadge = e.sortType ? `<span style="font-size:9px; background:#222; padding:2px 4px; border-radius:3px; color:#aaa; margin-right:4px; border:1px solid #444;">${e.sortType}</span>` : '';
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
                <span style="color:#4dabf7;">X:${e.x} Y:${e.y}</span>
                <span style="color:#ff6b6b; font-weight:bold;">MSE: ${formattedMse}</span>
            </div>
        </div>`;
    }).join('') : '<div style="font-size:11px; color:#aaa; padding:10px;">Keine Abweichungen gefunden.</div>';
}

function generateHistogramHtml(histArray) {
    return histArray.length > 0 ? histArray.map((e, idx) => `
        <div class="hist-color-item" data-r="${e.r}" data-g="${e.g}" data-b="${e.b}" style="font-size:10px; margin-bottom:3px; display:flex; align-items:center; justify-content:space-between; padding:3px 6px; background:#181a1c; border-radius:3px; border:1px solid #333; cursor:pointer;">
            <div style="display:flex; align-items:center; gap:6px; pointer-events:none;">
                <span style="color:#888; width:15px; font-weight:bold;">#${idx+1}</span>
                <div style="width:12px; height:12px; background:rgb(${e.r},${e.g},${e.b}); border:1px solid #888; border-radius:2px;"></div>
                <span style="color:#ccc;">RGB(${e.r},${e.g},${e.b})</span>
            </div>
            <span style="color:#4dabf7; font-weight:bold; pointer-events:none;">${e.count}x</span>
        </div>
    `).join('') : '<div style="font-size:11px; color:#aaa; padding:10px;">Keine Daten.</div>';
}

export function initHamBuilderMode(appState, containerEl) {
    if (!appState.originalImageData) {
        containerEl.innerHTML = `<div style="color:#aaa; padding:20px; font-family:sans-serif;">Bitte zuerst oben ein Bild laden.</div>`;
        return;
    }

    // 1. UI INJIZIEREN
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
            #btn-reset-palette { background-color: #6c757d; color: white; padding: 4px 8px; font-size: 11px; } #btn-reset-palette:hover { background-color: #5a6268; }
            #btn-auto-step { background-color: #e83e8c; color: white; padding: 4px 6px; font-size: 11px; } #btn-auto-step:hover { background-color: #d63384; }
            #btn-analysis { background-color: #6f42c1; color: white; } #btn-analysis:hover { background-color: #5a32a3; }
            #btn-encode:disabled, #btn-save:disabled, #btn-builder:disabled, #btn-analysis:disabled, #btn-debug-roundtrip:disabled { background-color: #555; cursor: not-allowed; color: #888; }
            .btn-zoom { background-color: #6c757d; color: white; } .btn-zoom.active { background-color: #17a2b8; }
            .target-sw { background-color: #333; color: #aaa; padding: 5px 10px; font-size: 12px; font-weight: bold; border: none; border-radius: 0; cursor: pointer; }
            .target-sw.active { background-color: #17a2b8; color: #fff; }
            .target-sw:disabled { background-color: #222; color: #555; cursor: not-allowed; }
            #btn-modify-image { background-color: #e83e8c; color: white; } #btn-modify-image:hover:not(:disabled) { background-color: #d63384; }
            #btn-replace-original { background-color: #fd7e14; color: white; padding: 4px 8px; font-size: 11px; } #btn-replace-original:hover:not(:disabled) { background-color: #e96b02; }
            #btn-modify-image:disabled, #btn-replace-original:disabled { background-color: #555; color: #888; cursor: not-allowed; }
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

            /* Modals & Tabellen */
            .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: transparent; pointer-events: none; z-index: 1000; }
            .modal-content { background: #1e2124; padding: 20px; border-radius: 8px; width: 750px; max-height: 90vh; overflow-y: auto; color: white; border: 1px solid #444; pointer-events: auto; position: absolute; top: 80px; left: 100px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); cursor: default; }
            .modal-content h3 { margin-top: 0; user-select: none; }
            .builder-slot { width:20px; height:20px; border:1px solid #444; border-radius:3px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:bold; }
            table.analysis-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
            table.analysis-table th, table.analysis-table td { border: 1px solid #444; padding: 4px 6px; text-align: center; }
            table.analysis-table th { background: #2b2f33; }
        </style>
        
        <div style="display:flex; flex-direction:column; width:100%; height:100%;">
            <!-- Builder Toolbar -->
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
                        <option value="HAM_32BIT_86666">HAM 32-Bit 86666    (8/6/6/6/6)        6.4 Bit/pixel</option>
                        <option value="HAM_32BIT_8888">HAM 32-Bit 8888     (8/8/8/8)          8.0 Bit/pixel</option>
                        <option value="HAM12">HAM12</option>
                        <option value="HAM16">HAM16</option>
                        <option value="DXT1">DXT1 (4.0 Bit/px, 4x4 Blocks)</option>
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
                
                <div class="control-group" id="smart-target-group" style="background:#111; padding:2px 8px; border-radius:4px; border:1px solid #007bff;">
                    <label style="color:#4dabf7;">Smart Target:</label>
                    <button id="btn-modify-image" title="Originalbild wavelet-basiert modifizieren, damit der HAM-Codec es artefaktfrei codiert">Originalbild modifizieren</button>
                    <div id="target-switch" style="display:inline-flex; border:1px solid #444; border-radius:4px; overflow:hidden;">
                        <button id="sw-original" class="target-sw active" title="Linke Anzeige: Originalbild">Original</button>
                        <button id="sw-modified" class="target-sw" disabled title="Linke Anzeige: modifiziertes Bild">Modifiziert</button>
                    </div>
                    <button id="btn-replace-original" disabled title="Modifiziertes Bild als neues Original übernehmen (ermöglicht mehrfaches Modifizieren)">Mod. übernehmen</button>
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

                <div class="control-group" id="ham-step-group">
                    <label>Schritt:</label>
                    <div style="display:flex; gap:2px;">
                        <input type="number" id="ham-step-r" min="1" max="128" value="4" style="width:35px; color:#ff6b6b; font-weight:bold;" title="Rot">
                        <input type="number" id="ham-step-g" min="1" max="128" value="4" style="width:35px; color:#28a745; font-weight:bold;" title="Grün">
                        <input type="number" id="ham-step-b" min="1" max="128" value="4" style="width:35px; color:#4dabf7; font-weight:bold;" title="Blau">
                    </div>
                </div>

                <div id="palette-box">
                    <label title="Startindex im 256er RAM (0-255)">Offset:</label>
                    <input type="number" id="pal-offset-input" min="0" max="255" value="0" style="width:40px;">
                    <div id="palette-pickers-container"></div>
                    <button id="btn-builder">Build Set</button>
                    <button id="btn-reset-palette" title="Alle ungesperrten Farben der Bank auf Schwarz (0,0,0) zurücksetzen">Reset</button>
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
                <div class="view-pane" id="pane-left"><div class="pane-label" id="source-label">ORIGINAL</div><canvas id="canvas-original"></canvas></div>
                <div class="view-pane" id="pane-right"><div class="pane-label" id="decoded-label">DEKODIERT</div><canvas id="canvas-decoded"></canvas></div>
            </div>
        </div>

        <!-- Fehler-Analyse Modal -->
        <div id="analysis-modal" class="modal-overlay">
           <div class="modal-content" style="width: 850px;">
              <h3>Fehler- & Histogramm-Analyse</h3>
              <h4 style="margin:10px 0 5px 0; color:#ffc107;">Gesamtbild: Top 10 Max MSE Abweichungen</h4>
              <div id="analysis-top5" style="background:#111; padding:8px; border-radius:4px; font-size:12px; max-height:200px; overflow-y:auto;"></div>
              
              <h4 style="margin:15px 0 5px 0; color:#4dabf7;">Fehler-Histogramm (Gesamtbild)</h4>
              <div style="max-height: 300px; overflow-y: auto;">
                  <table class="analysis-table">
                      <thead><tr><th>Intervall</th><th>RGB MSE Count</th><th>RGB %</th><th>Metrik MSE Count</th><th>Metrik %</th></tr></thead>
                      <tbody id="analysis-histogram-body"></tbody>
                  </table>
              </div>
              <div style="margin-top:20px; text-align:right;"><button id="btn-analysis-close" style="background:#555; color:#fff; padding:5px 10px;">Schließen</button></div>
           </div>
        </div>

        <!-- Builder Modal -->
        <div id="builder-modal" class="modal-overlay">
           <div class="modal-content" style="width: 900px;">
              <h3>Optimierer ab <span id="b-bank-title" style="color:#4dabf7;">Offset 0</span> (<span id="b-fmt"></span>)</h3>
              <div id="builder-status" style="color:#aaa; font-size:13px;">Initialisiere...</div>
              <div style="font-size:11px; color:#aaa; margin-top:6px;">Klicke auf einen Slot, um die Farbe direkt zu wählen:</div>
              <div id="builder-palette-preview" style="display:flex; flex-wrap:wrap; gap:3px; margin:6px 0; background:#000; padding:6px; border-radius:4px; max-height:75px; overflow-y:auto;"></div>

              <div style="display:flex; gap:15px; margin-top:12px;">
                  <div style="flex:2; display:flex; flex-direction:column;">
                      <h4 style="margin:0 0 6px 0; color:#ff6b6b; font-size:13px;">Top 10 Fehler (Nach Bit-Tiefe separiert)</h4>
                      <div id="builder-mse-list" style="display:flex; gap:10px; overflow-x:auto; padding-bottom:5px;"></div>
                  </div>
                  <div style="flex:1; display:flex; flex-direction:column;">
                      <h4 style="margin:0 0 6px 0; color:#4dabf7; font-size:13px;">Top 10 Bild-Histogramm</h4>
                      <div id="builder-hist-list"></div>
                  </div>
              </div>
              
              <div style="margin-top:15px; display:flex; justify-content:space-between; align-items:center;">
                  <button id="btn-builder-cancel" style="background:#555; color:#fff; padding:5px 10px;">Schließen / Übernehmen</button>
                  <div style="display:flex; align-items:center; gap:8px;">
                      <button id="btn-sort-slots" style="background:#17a2b8; color:#fff; padding:5px 10px;">Slots sortieren</button>
                      <button id="btn-refine-slots" style="background:#6f42c1; color:#fff; padding:5px 10px;">Manuell nachoptimieren</button>
                      <button id="btn-builder-auto" style="background:#28a745; color:#fff; padding:5px 10px;">Auto-Füllen</button>
                  </div>
              </div>
           </div>
        </div>
    `;

    // 2. CANVAS SETUP & BILD RENDERN
    const canvasOrig = document.getElementById('canvas-original');
    const canvasDec = document.getElementById('canvas-decoded');
    const ctxOrig = canvasOrig.getContext('2d');
    const ctxDec = canvasDec.getContext('2d');

    // Aktuell angezeigte Quelle (Original oder Smart Target) bestimmen.
    function getShownSourceImageData() {
        return (appState.showModified && appState.modifiedImageData)
            ? appState.modifiedImageData
            : appState.originalImageData;
    }
    function getShownSourceData() {
        return getShownSourceImageData().data;
    }
    function renderSourcePane() {
        const data = getShownSourceImageData();
        if (data) ctxOrig.putImageData(data, 0, 0);
        updateToggleUI();
    }
    function updateToggleUI() {
        const hasMod = !!appState.modifiedImageData;
        const showMod = appState.showModified && hasMod;
        const swOrig = document.getElementById('sw-original');
        const swMod = document.getElementById('sw-modified');
        const btnRep = document.getElementById('btn-replace-original');
        const lbl = document.getElementById('source-label');
        if (swOrig) swOrig.classList.toggle('active', !showMod);
        if (swMod) { swMod.classList.toggle('active', showMod); swMod.disabled = !hasMod; }
        if (btnRep) btnRep.disabled = !hasMod;
        if (lbl) lbl.innerText = showMod ? 'SMART TARGET' : 'ORIGINAL';
    }

    canvasOrig.width = appState.currentImgW; canvasOrig.height = appState.currentImgH;
    canvasDec.width = appState.currentImgW; canvasDec.height = appState.currentImgH;
    renderSourcePane();

    if (appState.decodedImageData) {
        ctxDec.putImageData(appState.decodedImageData, 0, 0);
    }
    
    document.getElementById('img-dim-text').innerText = `Größe: ${appState.currentImgW}x${appState.currentImgH} px | Modus: ${appState.currentFormat}`;

    setupCanvasEvents(
        () => ({ w: appState.currentImgW, h: appState.currentImgH }),
        () => ({ original: getShownSourceImageData(), decoded: appState.decodedImageData })
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
        ctxOrig.putImageData(getShownSourceImageData(), 0, 0);
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
        ctxOrig.putImageData(getShownSourceImageData(), 0, 0);
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
        if (optRegion.width === 0) optRegion.width = 1;
        if (optRegion.height === 0) optRegion.height = 1;
        document.getElementById('region-info').innerText = `Bereich: X:${optRegion.x} Y:${optRegion.y} B:${optRegion.width} H:${optRegion.height}`;
        ctxOrig.putImageData(getShownSourceImageData(), 0, 0);
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
        
        let smartGroup = document.getElementById('smart-target-group');
        if (smartGroup) smartGroup.style.display = isPalFormat ? 'flex' : 'none';
        let btnModify = document.getElementById('btn-modify-image');
        if (btnModify) btnModify.disabled = !isPalFormat || !appState.originalImageData;
        
        renderPaletteWithLocks(appState);
    }
    
    document.getElementById('format').value = appState.currentFormat;
    document.getElementById('format').addEventListener('change', handleFormatChange);
    document.getElementById('pal-offset-input').addEventListener('change', handleFormatChange);

    // RESET PALETTE BUTTON LOGIK
    document.getElementById('btn-reset-palette')?.addEventListener('click', async () => {
        if (!confirm("Möchtest du alle ungesperrten Farben dieser Bank auf Schwarz (0,0,0) zurücksetzen?")) return;
        let config = HAM_CONFIGS[appState.currentFormat] || HAM_CONFIGS["HAM_32BIT_63436343"];
        let slotsPerBank = config.slotsPerBank || 8;
        let currentOffset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        for (let i = 0; i < slotsPerBank; i++) {
            let absSlot = (currentOffset + i) % 256;
            if (absSlot === 0 || lockedSlots.has(absSlot)) continue; // Slot 0 und gesperrte Slots überspringen
            appState.globalPaletteRAM[absSlot * 3]     = 0;
            appState.globalPaletteRAM[absSlot * 3 + 1] = 0;
            appState.globalPaletteRAM[absSlot * 3 + 2] = 0;
        }

        renderPaletteWithLocks(appState);
        await triggerEncode();
    });
    
    handleFormatChange();

    // 5. HAUPT-ENCODER LOGIK
    const btnEncode = document.getElementById('btn-encode');
    const btnSave = document.getElementById('btn-save');

    async function triggerEncode() {
        let format = appState.currentFormat;
        let step = { 
            r: parseInt(document.getElementById('ham-step-r').value) || 8,
            g: parseInt(document.getElementById('ham-step-g').value) || 8,
            b: parseInt(document.getElementById('ham-step-b').value) || 8 
        };
        let strategy = document.getElementById('encode-strategy').value;
        let metric = document.getElementById('encode-metric').value;
        let offset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        let is16BitClass = (format === "HAM12" || format === "HAM16");
        appState.globalPaletteRAM[0] = 0; appState.globalPaletteRAM[1] = 0; appState.globalPaletteRAM[2] = 0;

        // Codiert wird die aktuell angezeigte Quelle (Original oder Smart Target).
        let sourceData = getShownSourceData();
        let decodedPixels = null;

        updateProgress("Starte Codierung...", 0, 100);

        if (format === "DXT1") {
            appState.latestPackedData = encodeDXT1(sourceData, appState.currentImgW, appState.currentImgH);
            decodedPixels = decodeDXT1(appState.latestPackedData, appState.currentImgW, appState.currentImgH);
            appState.latestCommandArray = [];
        } else if (is16BitClass) {
            appState.latestCommandArray = await encodeHam12_16(sourceData, appState.currentImgW, appState.currentImgH, format, step, strategy, metric, 1, updateProgress, 0, 0);
            appState.latestPackedData = packHam12_16(appState.latestCommandArray, format);
            decodedPixels = decodeHam12_16(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step);
        } else {
            let encodeRes = await encodePaletted(sourceData, appState.currentImgW, appState.currentImgH, format, step, appState.globalPaletteRAM, offset, strategy, metric, updateProgress, 0, 0, 15.0);
            appState.latestCommandArray = encodeRes.commands;
            appState.latestPackedData = packPaletted(appState.latestCommandArray, format);
            decodedPixels = decodePaletted(appState.latestCommandArray, appState.currentImgW, appState.currentImgH, step, appState.globalPaletteRAM, offset);
        }

        appState.decodedImageData = new ImageData(decodedPixels, appState.currentImgW, appState.currentImgH);
        ctxDec.putImageData(appState.decodedImageData, 0, 0);

        updateProgress("Fertig", 100, 100);
        btnSave.disabled = false;
        if(document.getElementById('btn-debug-roundtrip')) document.getElementById('btn-debug-roundtrip').disabled = false;
        
        // UI aktualisieren, falls sich RAM geändert hat
        renderPaletteWithLocks(appState);
    }

    btnEncode.addEventListener('click', async () => {
        btnEncode.disabled = true; btnSave.disabled = true;
        await triggerEncode();
        btnEncode.disabled = false;
    });

    // 5b. SMART TARGET (Wavelet-Feedback-Loop) LOGIK
    const btnModify = document.getElementById('btn-modify-image');
    const swOrig = document.getElementById('sw-original');
    const swMod = document.getElementById('sw-modified');
    const btnReplace = document.getElementById('btn-replace-original');

    function originalIsDummy() {
        if (!appState.originalImageData) return true;
        const d = appState.originalImageData.data;
        for (let i = 0; i < d.length; i++) { if (d[i] !== 0) return false; }
        return true;
    }

    btnModify.addEventListener('click', async () => {
        if (originalIsDummy()) {
            alert("Für die Bild-Modifikation musst du zuerst ein echtes Originalbild (.png/.jpg) laden!");
            return;
        }
        let format = appState.currentFormat;
        let config = HAM_CONFIGS[format];
        if (!config || !config.isPaletted) return;
        let step = {
            r: parseInt(document.getElementById('ham-step-r').value) || 8,
            g: parseInt(document.getElementById('ham-step-g').value) || 8,
            b: parseInt(document.getElementById('ham-step-b').value) || 8
        };
        let metric = document.getElementById('encode-metric').value;
        let strategy = document.getElementById('encode-strategy').value;
        let offset = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        btnModify.disabled = true; btnEncode.disabled = true; btnSave.disabled = true;
        try {
            const { target, log } = await generateSmartTarget({
                sourceData: getShownSourceData(),
                width: appState.currentImgW,
                height: appState.currentImgH,
                step, metric, format,
                paletteRAM: appState.globalPaletteRAM,
                offset, strategy,
                onProgress: updateProgress
            });
            appState.modifiedImageData = new ImageData(new Uint8ClampedArray(target), appState.currentImgW, appState.currentImgH);
            appState.showModified = true;
            renderSourcePane();
            const summary = log.length > 0 ? log[log.length - 1] : 'fertig';
            updateProgress(`Smart Target: ${summary}`, 100, 100);
            // Modifiziertes Bild direkt codieren, damit der Effekt sichtbar wird.
            await triggerEncode();
        } finally {
            btnModify.disabled = false;
            btnEncode.disabled = false;
        }
    });

    swOrig.addEventListener('click', () => {
        appState.showModified = false;
        renderSourcePane();
    });

    swMod.addEventListener('click', () => {
        if (!appState.modifiedImageData) return;
        appState.showModified = true;
        renderSourcePane();
    });

    btnReplace.addEventListener('click', () => {
        if (!appState.modifiedImageData) return;
        if (!confirm("Modifiziertes Bild als neues Original übernehmen? (Das bisherige Original wird ersetzt)")) return;
        appState.originalImageData = appState.modifiedImageData;
        appState.modifiedImageData = null;
        appState.showModified = false;
        renderSourcePane();
        updateProgress("Modifiziertes Bild als neues Original übernommen", 100, 100);
    });

    btnSave.addEventListener('click', () => {
        if (!appState.latestPackedData) return;
        let fmt = appState.currentFormat;
        let customName = prompt("Bitte Dateinamen eingeben (ohne Endung):", `${appState.currentImgFileName}_${fmt.toLowerCase()}`);
        if (!customName) return;

        let fmtBytes = new TextEncoder().encode(fmt);
        let step = { r: parseInt(document.getElementById('ham-step-r').value)||8, g: parseInt(document.getElementById('ham-step-g').value)||8, b: parseInt(document.getElementById('ham-step-b').value)||8 };
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

    const btnDebug = document.getElementById('btn-debug-roundtrip');
    btnDebug.addEventListener('click', async () => {
        if (appState.originalImageData.data.every(val => val === 0)) {
            alert("Für den Debug-Vergleich musst du zuerst ein echtes Originalbild (.png/.jpg) laden!");
            return;
        }
        let fmt = appState.currentFormat;
        let step = { r: parseInt(document.getElementById('ham-step-r').value), g: parseInt(document.getElementById('ham-step-g').value), b: parseInt(document.getElementById('ham-step-b').value) };
        let strat = document.getElementById('encode-strategy').value;
        let met = document.getElementById('encode-metric').value;
        let off = parseInt(document.getElementById('pal-offset-input')?.value || 0);

        if (fmt === "HAM12" || fmt === "HAM16") await debugRoundtripHam12_16(appState.originalImageData.data, appState.currentImgW, appState.currentImgH, fmt, step, strat, met);
        else await debugRoundtripPaletted(appState.originalImageData.data, appState.currentImgW, appState.currentImgH, fmt, step, appState.globalPaletteRAM, off, strat, met);
    });

    // --- FEHLER-ANALYSE LOGIK ---
    const btnAnalysis = document.getElementById('btn-analysis');
    const analysisModal = document.getElementById('analysis-modal');
    if (btnAnalysis && analysisModal) {
        btnAnalysis.addEventListener('click', () => {
            if (!appState.decodedImageData || !appState.originalImageData) return alert("Bitte zuerst codieren.");
            if (appState.originalImageData.data.every(v => v === 0)) return alert("Die Fehleranalyse benötigt das echte Originalbild!");

            analysisModal.style.display = 'block'; 
            let step = { r: parseInt(document.getElementById('ham-step-r').value)||8, g: parseInt(document.getElementById('ham-step-g').value)||8, b: parseInt(document.getElementById('ham-step-b').value)||8 };
            let metric = document.getElementById('encode-metric').value;
            let config = HAM_CONFIGS[appState.currentFormat];
            let totalPixels = appState.currentImgW * appState.currentImgH;
            
            let stats = computeDetailedAnalysis(appState.originalImageData.data, appState.decodedImageData.data, appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion);
            
            let top5Div = document.getElementById('analysis-top5');
            if (top5Div) {
                top5Div.innerHTML = generateTop10Html(stats.global.top10);
                top5Div.onclick = (ev) => {
                    let item = ev.target.closest('.top10-cluster-item');
                    if (!item) return;
                    centerOnCoordinate(parseInt(item.dataset.x), parseInt(item.dataset.y), appState.currentImgW, appState.currentImgH);
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
        document.getElementById('btn-analysis-close').addEventListener('click', () => analysisModal.style.display = 'none');
    }

    // 6. TOP-BAR PALETTE RENDER LOGIK (Mit Hover-Tooltip)
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
            wrapper.style.cssText = "position:relative; display:inline-block; width:18px; height:18px; margin-right:2px; margin-bottom:2px;";
            wrapper.title = `Bank-Slot ${i} (Abs: ${absSlot})\nRGB(${r}, ${g}, ${b})${isLocked ? ' [Gesperrt]' : ''}`;

            let input = document.createElement('input');
            input.type = 'color'; input.className = 'palette-picker';
            input.value = rgbToHex(r, g, b);
            input.style.width = "100%"; input.style.height = "100%";
            if (absSlot === 0) input.disabled = true;

            let lockIcon = document.createElement('div');
            lockIcon.style.cssText = "position:absolute; top:1px; right:1px; font-size:9px; background:rgba(0,0,0,0.6); color:#fff; padding:1px 2px; border-radius:2px; pointer-events:none;";
            lockIcon.innerText = isLocked ? "🔒" : "";

            wrapper.addEventListener('click', (e) => {
                if (e.target !== input) {
                    if (absSlot === 0) return;
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

    // 7. EXTERNALISIERTES PALETTE BUILDER MODAL INITIALISIEREN
    initPaletteBuilderUI(appState, {
        getOptRegion: () => optRegion,
        getLockedSlots: () => lockedSlots,
        getStep: () => ({ 
            r: parseInt(document.getElementById('ham-step-r').value)||8, 
            g: parseInt(document.getElementById('ham-step-g').value)||8, 
            b: parseInt(document.getElementById('ham-step-b').value)||8 
        }),
        getMetric: () => document.getElementById('encode-metric').value,
        getCurrentOffset: () => parseInt(document.getElementById('pal-offset-input')?.value || 0),
        triggerEncode: triggerEncode,
        renderPaletteWithLocks: renderPaletteWithLocks,
        centerOnCoordinate: centerOnCoordinate,
        generateTop10Html: generateTop10Html,
        generateHistogramHtml: generateHistogramHtml
    });
}