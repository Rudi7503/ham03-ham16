// src/ui/palette_builder.js

import { HAM_CONFIGS } from '../codecs/configs.js';
import { rgbToHex } from '../codecs/utils.js';
import { computeDetailedAnalysis, getImageHistogram } from '../core/analysis.js';
import { runHybridOptimization, runManualRefinement } from '../core/palette_optimizer.js';

let selectedTargetSlot = null;

export function initPaletteBuilderUI(appState, deps) {
    const { 
        getOptRegion, getLockedSlots, getStep, getMetric, getCurrentOffset,
        triggerEncode, renderPaletteWithLocks, centerOnCoordinate, 
        generateTop10Html, generateHistogramHtml 
    } = deps;

    const builderModal = document.getElementById('builder-modal');
    const btnBuilder = document.getElementById('btn-builder');
    const btnCancel = document.getElementById('btn-builder-cancel');
    const btnSort = document.getElementById('btn-sort-slots');
    const btnRefine = document.getElementById('btn-refine-slots');
    const btnAuto = document.getElementById('btn-builder-auto');

    if (!builderModal || !btnBuilder) return;

    async function askAutoFillMode() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:10000; display:flex; justify-content:center; align-items:center;";
            const box = document.createElement('div');
            box.style.cssText = "background:#1e2124; padding:25px; border-radius:8px; border:1px solid #555; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); max-width: 500px;";
            box.innerHTML = `
                <h3 style="margin-top:0; color:#ffc107; font-family:sans-serif;">Auto-Füllen: Modus wählen</h3>
                <p style="color:#ccc; font-size:14px; margin-bottom:20px; font-family:sans-serif; line-height:1.4;">
                    Soll nach Durchlauf 1 (Reines Battle) ein 2. Durchlauf zur Feinoptimierung (Hill Climbing) gestartet werden?<br>
                    <span style="font-size:12px; color:#888;">(Der 2. Durchlauf drückt den MSE noch weiter, dauert aber länger)</span>
                </p>
                <div style="display:flex; justify-content:center; gap:12px;">
                    <button id="btn-af-1" style="background:#17a2b8; color:#fff; border:none; padding:8px 15px; border-radius:4px; cursor:pointer; font-weight:bold;">Nein (Nur Durchlauf 1)</button>
                    <button id="btn-af-2" style="background:#28a745; color:#fff; border:none; padding:8px 15px; border-radius:4px; cursor:pointer; font-weight:bold;">Ja (Mit Durchlauf 2)</button>
                    <button id="btn-af-0" style="background:#555; color:#fff; border:none; padding:8px 15px; border-radius:4px; cursor:pointer; font-weight:bold;">Abbrechen</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            document.getElementById('btn-af-1').onclick = () => { document.body.removeChild(overlay); resolve(1); };
            document.getElementById('btn-af-2').onclick = () => { document.body.removeChild(overlay); resolve(2); };
            document.getElementById('btn-af-0').onclick = () => { document.body.removeChild(overlay); resolve(0); };
        });
    }

    const liveUpdateUI = () => {
        renderPaletteWithLocks(appState);
        let slots = document.querySelectorAll('.builder-slot');
        if (slots.length > 0) {
            let currentOffset = getCurrentOffset();
            slots.forEach((slot, i) => {
                let absSlot = (currentOffset + i) % 256;
                let r = appState.globalPaletteRAM[absSlot*3];
                let g = appState.globalPaletteRAM[absSlot*3+1];
                let b = appState.globalPaletteRAM[absSlot*3+2];
                slot.style.backgroundColor = rgbToHex(r, g, b);
                slot.title = `Slot ${i} (Abs: ${absSlot})\nRGB(${r}, ${g}, ${b})`;
            });
        }
    };

    async function applyColorToSelectedSlot(r, g, b) {
        let currentOffset = getCurrentOffset();
        let config = HAM_CONFIGS[appState.currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;

        if (!selectedTargetSlot) selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        
        let absSlot = selectedTargetSlot.absSlot;
        if (absSlot % 256 === 0) return alert("Slot 0 kann nicht überschrieben werden.");

        appState.globalPaletteRAM[absSlot * 3] = r;
        appState.globalPaletteRAM[absSlot * 3 + 1] = g;
        appState.globalPaletteRAM[absSlot * 3 + 2] = b;
        
        await triggerEncode();
        
        let nextIdx = selectedTargetSlot.index + 1;
        if (nextIdx >= slots) nextIdx = 1;
        selectedTargetSlot = { index: nextIdx, absSlot: (currentOffset + nextIdx) % 256 };
        
        btnBuilder.click();
        renderPaletteWithLocks(appState);
    }

    btnBuilder.addEventListener('click', () => {
        builderModal.style.display = 'block';
        
        let currentOffset = getCurrentOffset();
        let step = getStep();
        let metric = getMetric();
        let optRegion = getOptRegion();
        let config = HAM_CONFIGS[appState.currentFormat];
        let slots = config ? (config.slotsPerBank || 8) : 8;
        
        if (document.getElementById('b-fmt')) document.getElementById('b-fmt').innerText = appState.currentFormat;
        if (document.getElementById('b-bank-title')) document.getElementById('b-bank-title').innerText = `Offset ${currentOffset}`;
        
        if (!selectedTargetSlot) selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        
        let statusDiv = document.getElementById('builder-status');
        if (statusDiv) statusDiv.innerHTML = `Bank aktiv (${slots} Slots). <span id='builder-instruction' style='color:#ffc107; font-weight:bold;'>Aktiv: Slot ${selectedTargetSlot.index}. Klicke einen Eintrag zum Zuweisen.</span>`;
        
        let previewContainer = document.getElementById('builder-palette-preview');
        if (previewContainer) {
            previewContainer.innerHTML = "";
            let anchorUsage = new Array(slots).fill(0);
            if (appState.latestCommandArray) {
                for (let cmd of appState.latestCommandArray) {
                    if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined && cmd.anchorIdx >= 0 && cmd.anchorIdx < slots) {
                        anchorUsage[cmd.anchorIdx]++;
                    }
                }
            }

            for (let i = 0; i < slots; i++) {
                let absSlot = (currentOffset + i) % 256;
                let r = appState.globalPaletteRAM[absSlot*3], g = appState.globalPaletteRAM[absSlot*3+1], b = appState.globalPaletteRAM[absSlot*3+2];
                let usageCount = anchorUsage[i];
                
                let slotWrapper = document.createElement('div');
                slotWrapper.style.cssText = "display:flex; flex-direction:column; align-items:center; font-size:9px; gap:2px;";

                let slotDiv = document.createElement('div');
                slotDiv.className = 'builder-slot';
                slotDiv.style.backgroundColor = rgbToHex(r, g, b);
                slotDiv.innerText = i;
                slotDiv.title = `Slot ${i} (Abs: ${absSlot})\nRGB(${r}, ${g}, ${b})\nVerwendung: ${usageCount}x`;
                
                if (selectedTargetSlot && selectedTargetSlot.index === i) slotDiv.style.border = '2px solid #ffc107';

                let usageLabel = document.createElement('span');
                usageLabel.style.color = usageCount > 0 ? '#4dabf7' : '#777';
                usageLabel.innerText = `${usageCount}x`;

                slotDiv.addEventListener('click', () => {
                    if (i === 0) return alert("Slot 0 ist fest auf Schwarz reserviert.");
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

        let mseListDiv = document.getElementById('builder-mse-list');
        if (mseListDiv && appState.decodedImageData && appState.originalImageData) {
            let totalPixels = appState.currentImgW * appState.currentImgH;
            let stats = computeDetailedAnalysis(appState.originalImageData.data, appState.decodedImageData.data, appState.currentImgW, appState.currentImgH, 0, totalPixels, step, metric, config, optRegion);
            
            let avgMetricMse = stats.global.avgYuv.toFixed(2);
            let avgRgbMse = stats.global.avgRgb.toFixed(2);
            let allErrors = [];
            for (let b in stats.global.byBitDepth) allErrors.push(...stats.global.byBitDepth[b]);
            if (allErrors.length === 0) allErrors = [...stats.global.top10];
            allErrors.sort((a, b) => b.mse - a.mse);
            
            let pureMaxMse = allErrors.length > 0 ? Math.round(allErrors[0].mse).toLocaleString('de-DE') : "0";
            let weightedMaxMse = stats.global.top10.length > 0 ? Math.round(stats.global.top10[0].mse).toLocaleString('de-DE') : "0";
            
            if (statusDiv) {
                statusDiv.innerHTML = `Bank aktiv (${slots} Slots) | <span style="color:#ffc107;">⌀ MSE: ${avgMetricMse} (RGB: ${avgRgbMse}) | Max MSE: ${weightedMaxMse} (Rein: ${pureMaxMse})</span><br>` +
                                      `<span id='builder-instruction' style='color:#ffc107; font-weight:bold;'>Aktiv: Slot ${selectedTargetSlot.index}. Klicke einen Eintrag zum Zuweisen.</span>`;
            }

            let bitDepths = Object.keys(stats.global.byBitDepth).sort((a,b) => parseInt(a) - parseInt(b));
            let html = "";
            
            if (bitDepths.length > 0) {
                for (let b of bitDepths) {
                    let hint = b === "3" ? "(3-bit nur Delta)" : (b === "4" ? "(4-bit Ebene)" : `(${b}-bit Ebene)`);
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
                centerOnCoordinate(parseInt(item.dataset.x), parseInt(item.dataset.y), appState.currentImgW, appState.currentImgH);
                await applyColorToSelectedSlot(parseInt(item.dataset.r), parseInt(item.dataset.g), parseInt(item.dataset.b));
            };
        } else if (mseListDiv) {
            mseListDiv.innerHTML = '<div style="font-size:11px; color:#aaa;">Bitte zuerst Bild codieren für Fehleranalyse.</div>';
        }

        let histListDiv = document.getElementById('builder-hist-list');
        if (histListDiv && appState.originalImageData) {
            let histData = getImageHistogram(appState.originalImageData, appState.currentImgW, appState.currentImgH, step, 10, appState.globalPaletteRAM, currentOffset, optRegion);
            histListDiv.innerHTML = generateHistogramHtml(histData);
            
            histListDiv.onclick = async (ev) => {
                let item = ev.target.closest('.hist-color-item');
                if (!item) return;
                await applyColorToSelectedSlot(parseInt(item.dataset.r), parseInt(item.dataset.g), parseInt(item.dataset.b));
            };
        }
    });

    btnCancel?.addEventListener('click', () => { 
        builderModal.style.display = 'none'; 
        document.getElementById('format').dispatchEvent(new Event('change')); 
    });

    btnSort?.addEventListener('click', async () => {
        if (!appState.originalImageData || !appState.latestCommandArray) return alert("Bitte zuerst das Bild codieren.");
        let config = HAM_CONFIGS[appState.currentFormat];
        if (!config || !config.isPaletted) return;

        let currentOffset = getCurrentOffset();
        let totalAnchorUsage = new Array(256).fill(0);
        let imgW = appState.currentImgW;
        let optRegion = getOptRegion();

        for (let i = 0; i < appState.latestCommandArray.length; i++) {
            let cmd = appState.latestCommandArray[i];
            if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined) {
                let x = i % imgW, y = Math.floor(i / imgW);
                if (x >= optRegion.x && x < optRegion.x + optRegion.width && y >= optRegion.y && y < optRegion.y + optRegion.height) {
                    totalAnchorUsage[(currentOffset + cmd.anchorIdx) % 256]++;
                }
            }
        }

        let formatsInUse = config.isMixed ? [...new Set(config.sequence)] : [appState.currentFormat];
        let capacities = [...new Set(formatsInUse.map(f => HAM_CONFIGS[f]?.slotsPerBank || 8))].sort((a,b) => a - b);
        let sortGroups = [];
        let lastEnd = -1;
        
        for (let cap of capacities) {
            if (cap === 0) continue;
            let start = lastEnd + 1, end = cap - 1;
            if (start <= end) { sortGroups.push({ start, end }); lastEnd = end; }
        }

        if (sortGroups.length === 0) return;
        let maxSlotsPerBank = capacities[capacities.length - 1];

        for (let bankStart = 0; bankStart < 256; bankStart += maxSlotsPerBank) {
            for (let group of sortGroups) {
                let groupSlots = [];
                for (let i = group.start; i <= group.end; i++) {
                    let absSlot = (bankStart + i) % 256;
                    groupSlots.push({
                        absSlot, isFixed: (i === 0),
                        r: appState.globalPaletteRAM[absSlot * 3],
                        g: appState.globalPaletteRAM[absSlot * 3 + 1],
                        b: appState.globalPaletteRAM[absSlot * 3 + 2],
                        usage: totalAnchorUsage[absSlot]
                    });
                }
                
                let fixedSlots = groupSlots.filter(s => s.isFixed);
                let sortableSlots = groupSlots.filter(s => !s.isFixed).sort((a, b) => b.usage - a.usage);
                let newOrder = [...fixedSlots, ...sortableSlots];
                
                for (let idx = 0; idx < newOrder.length; idx++) {
                    let targetAbsSlot = (bankStart + group.start + idx) % 256;
                    appState.globalPaletteRAM[targetAbsSlot * 3]     = newOrder[idx].r;
                    appState.globalPaletteRAM[targetAbsSlot * 3 + 1] = newOrder[idx].g;
                    appState.globalPaletteRAM[targetAbsSlot * 3 + 2] = newOrder[idx].b;
                }
            }
        }
        await triggerEncode();
        btnBuilder.click();
        renderPaletteWithLocks(appState);
    });

    btnRefine?.addEventListener('click', async () => {
        if (!appState.originalImageData || !appState.decodedImageData) return alert("Bitte zuerst codieren.");
        let statusDiv = document.getElementById('builder-status');
        
        let changeLog = await runManualRefinement(
            appState, getOptRegion(), getStep(), getMetric(), getCurrentOffset(), getLockedSlots(),
            (msg) => { if (statusDiv) statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ ${msg}</span>`; },
            triggerEncode,
            liveUpdateUI
        );

        if (statusDiv) statusDiv.innerHTML = `<span style='color:#28a745; font-weight:bold;'>✅ Nachoptimierung beendet!</span>`;
        btnBuilder.click();
        renderPaletteWithLocks(appState);

        let mseListDiv = document.getElementById('builder-mse-list');
        if (mseListDiv && changeLog.length > 0) {
            mseListDiv.innerHTML = `<div style="background:#16181a; border:1px solid #444; border-radius:4px; padding:10px; width:100%; overflow-y:auto; max-height:280px;">
                <ul style="font-size:11px; color:#ccc; padding-left:15px; margin:0; line-height: 1.4;">
                    ${changeLog.map(log => `<li style="margin-bottom:4px; list-style:none;">${log}</li>`).join('')}
                </ul>
            </div>`;
        }
    });

    btnAuto?.addEventListener('click', async () => {
        if (!appState.originalImageData || !appState.decodedImageData) return alert("Bitte zuerst das Bild codieren.");
        
        let mode = await askAutoFillMode();
        if (mode === 0) return; 
        
        let run2ndPass = (mode === 2);
        
        let statusDiv = document.getElementById('builder-status');
        let currentOffset = getCurrentOffset();
        let step = getStep();
        let metric = getMetric();

        appState.globalPaletteRAM[0] = 0; appState.globalPaletteRAM[1] = 0; appState.globalPaletteRAM[2] = 0;

        let changeLog = await runHybridOptimization(
            appState, getOptRegion(), step, metric, currentOffset, getLockedSlots(), 
            (msg) => { if (statusDiv) statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ ${msg}</span>`; },
            triggerEncode,
            liveUpdateUI,
            run2ndPass
        );

        if (statusDiv) statusDiv.innerHTML = `<span style='color:#28a745; font-weight:bold;'>✅ Optimierung beendet!</span>`;
        selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        
        btnBuilder.click(); 
        renderPaletteWithLocks(appState);

        let mseListDiv = document.getElementById('builder-mse-list');
        if (mseListDiv && changeLog.length > 0) {
            mseListDiv.innerHTML = `<div style="background:#16181a; border:1px solid #444; border-radius:4px; padding:10px; width:100%; overflow-y:auto; max-height:280px;">
                <ul style="font-size:11px; color:#ccc; padding-left:15px; margin:0; line-height: 1.4;">
                    ${changeLog.map(log => `<li style="margin-bottom:4px; list-style:none;">${log}</li>`).join('')}
                </ul>
            </div>`;
        }
    });
}