// src/ui/palette_builder.js

import { HAM_CONFIGS } from '../codecs/configs.js';
import { rgbToHex } from '../codecs/utils.js';
import { computeDetailedAnalysis, getImageHistogram } from '../core/analysis.js';
import { runOptimizationWithProxy, runManualRefinementWithProxy, requestOptimizationAbort } from '../core/palette_optimizer.js';

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

    // Auswahl für das manuelle Nachoptimieren. Der Proxy ist hier NICHT der
    // Standard: er ist ~7x schneller, zieht die Palette aber auf die
    // verkleinerten Farbstatistiken und kann die Vollbild-Qualität senken
    // (gemessen +0.60 MSE bei nur 2x Verkleinerung). Bei einer Verfeinerung
    // einer schon guten Palette fällt das ins Gewicht.
    async function askRefineMode(bigImage) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:10000; display:flex; justify-content:center; align-items:center;";
            const box = document.createElement('div');
            box.style.cssText = "background:#1e2124; padding:25px; border-radius:8px; border:1px solid #555; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); max-width: 500px;";
            box.innerHTML = `
                <h3 style="margin-top:0; color:#ffc107; font-family:sans-serif;">Nachoptimieren: Genauigkeit wählen</h3>
                <p style="color:#ccc; font-size:13px; margin-bottom:20px; font-family:sans-serif; line-height:1.4;">
                    Die Vektor-Suche läuft so lange in Durchgängen, bis ein Durchgang kaum noch etwas bringt.
                    ${bigImage ? 'Auf diesem Bild kostet ein Vollbild-Durchgang grob eine Minute pro Megapixel.' : ''}
                </p>
                <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;">
                    <button id="btn-rf-full" style="background:#28a745; color:#fff; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold; text-align:left;">
                        🎯 Vollbild — genau (empfohlen) <span style="font-weight:normal; font-size:11px; display:block; opacity:0.85;">Rechnet auf dem echten Bild. Kein Qualitätsrisiko, aber langsam. Abbrechbar.</span>
                    </button>
                    <button id="btn-rf-proxy" style="background:#ffc107; color:#000; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold; text-align:left;">
                        ⚡ Proxy — ca. 7x schneller <span style="font-weight:normal; font-size:11px; display:block; opacity:0.85;">⚠️ Kann die Endqualität senken (gemessen +0.60 MSE), weil die Palette auf die verkleinerten Farbstatistiken gezogen wird.</span>
                    </button>
                </div>
                <div>
                    <button id="btn-rf-cancel" style="background:#555; color:#fff; border:none; padding:8px 20px; border-radius:4px; cursor:pointer;">Abbrechen</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            const done = (useProxy) => {
                document.body.removeChild(overlay);
                resolve(useProxy);
            };
            document.getElementById('btn-rf-full').onclick = () => done(false);
            document.getElementById('btn-rf-proxy').onclick = () => done(true);
            document.getElementById('btn-rf-cancel').onclick = () => done(null);
        });
    }

    // NEU: Auswahl-Dialog für die drei Intensitätsstufen
    async function askAutoFillMode() {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:10000; display:flex; justify-content:center; align-items:center;";
            const box = document.createElement('div');
            box.style.cssText = "background:#1e2124; padding:25px; border-radius:8px; border:1px solid #555; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5); max-width: 450px;";
            box.innerHTML = `
                <h3 style="margin-top:0; color:#ffc107; font-family:sans-serif;">Auto-Füllen: Intensität wählen</h3>
                <p style="color:#ccc; font-size:13px; margin-bottom:20px; font-family:sans-serif; line-height:1.4;">
                    Wähle aus, wie intensiv die Palette optimiert werden soll:
                </p>
                <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px;">
                    <button id="btn-af-fast" style="background:#17a2b8; color:#fff; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold; text-align:left;">
                        ⚡ Sehr schnelles Füllen <span style="font-weight:normal; font-size:11px; display:block; opacity:0.8;">Nur Stufe 0.5 (Histogramm + Eradication, keine Battles)</span>
                    </button>
                    <button id="btn-af-norm" style="background:#ffc107; color:#000; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold; text-align:left;">
                        ⚖️ Normal <span style="font-weight:normal; font-size:11px; display:block; opacity:0.8;">Bis Stufe 1 (Inkl. Kandidaten-Battle)</span>
                    </button>
                    <button id="btn-af-slow" style="background:#28a745; color:#fff; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold; text-align:left;">
                        🐢 Langsam Optimum suchen <span style="font-weight:normal; font-size:11px; display:block; opacity:0.8;">Komplette Pipeline (Battles + Vektor-Zyklen)</span>
                    </button>
                </div>
                <div>
                    <label style="display:flex; align-items:center; justify-content:center; gap:8px; color:#ccc; font-size:12px; font-family:sans-serif; margin-bottom:16px; cursor:pointer;">
                        <input type="checkbox" id="af-proxy" ${(appState.currentImgW > 320 || appState.currentImgH > 320) ? 'checked' : ''}>
                        Auf Vorschaubild optimieren (viel schneller; Palette wird danach aufs Bild angewendet)
                    </label>
                    ${(Math.max(appState.currentImgW, appState.currentImgH) > 512)
                        ? `<div style="color:#ffc107; font-size:11px; font-family:sans-serif; margin:-8px 0 14px 0;">⚠️ Bild ist größer als 512 px — Proxy wird automatisch erzwungen (Vollbild würde mehrere Minuten dauern).</div>`
                        : ''}
                </div>
                <div>
                    <button id="btn-af-cancel" style="background:#555; color:#fff; border:none; padding:8px 20px; border-radius:4px; cursor:pointer;">Abbrechen</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const done = (intensity) => {
                const useProxy = document.getElementById('af-proxy').checked;
                document.body.removeChild(overlay);
                resolve(intensity ? { intensity, useProxy } : null);
            };
            document.getElementById('btn-af-fast').onclick = () => done('sehr_schnell');
            document.getElementById('btn-af-norm').onclick = () => done('normal');
            document.getElementById('btn-af-slow').onclick = () => done('langsam');
            document.getElementById('btn-af-cancel').onclick = () => done(null);
        });
    }

    const liveUpdateUI = () => {
        renderPaletteWithLocks(appState);
        let slotDivs = document.querySelectorAll('.builder-slot');
        if (slotDivs.length > 0) {
            let currentOffset = getCurrentOffset();

            let usage = new Array(slotDivs.length).fill(0);
            if (appState.latestCommandArray) {
                for (let cmd of appState.latestCommandArray) {
                    if (cmd && cmd.isAnchor && cmd.anchorIdx !== undefined && cmd.anchorIdx >= 0 && cmd.anchorIdx < slotDivs.length) {
                        usage[cmd.anchorIdx]++;
                    }
                }
            }

            let usageLabels = document.querySelectorAll('.builder-usage');

            slotDivs.forEach((slot, i) => {
                let absSlot = (currentOffset + i) % 256;
                let r = appState.globalPaletteRAM[absSlot*3];
                let g = appState.globalPaletteRAM[absSlot*3+1];
                let b = appState.globalPaletteRAM[absSlot*3+2];
                slot.style.backgroundColor = rgbToHex(r, g, b);
                slot.title = `Slot ${i} (Abs: ${absSlot})\nRGB(${r}, ${g}, ${b})\nVerwendung: ${usage[i]}x`;

                if (usageLabels[i]) {
                    usageLabels[i].innerText = `${usage[i]}x`;
                    usageLabels[i].style.color = usage[i] > 0 ? '#4dabf7' : '#777';
                }
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
                usageLabel.className = 'builder-usage';
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

        const maxSide = Math.max(appState.currentImgW, appState.currentImgH);
        const useProxy = await askRefineMode(maxSide > 512);
        if (useProxy === null) return;   // abgebrochen

        let statusDiv = document.getElementById('builder-status');

        let abortBtn = document.getElementById('palette-abort-btn');
        if (abortBtn) abortBtn.remove();
        abortBtn = document.createElement('button');
        abortBtn.id = 'palette-abort-btn';
        abortBtn.textContent = '⏹️ Nachoptimierung abbrechen';
        abortBtn.style.cssText = 'position:fixed; right:16px; bottom:16px; z-index:10001; background:#dc3545; color:#fff; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:bold; box-shadow:0 4px 14px rgba(0,0,0,0.55); font-family:sans-serif; font-size:13px;';
        abortBtn.onclick = () => {
            requestOptimizationAbort();
            abortBtn.disabled = true;
            abortBtn.style.background = '#6c757d';
            abortBtn.style.cursor = 'default';
            abortBtn.textContent = '⏹️ Abbruch angefordert... (Durchgangsende)';
        };
        document.body.appendChild(abortBtn);

        let changeLog;
        try {
            changeLog = await runManualRefinementWithProxy(
                appState, getOptRegion(), getStep(), getMetric(), getCurrentOffset(), getLockedSlots(),
                (msg) => { if (statusDiv) statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ ${msg}</span>`; },
                triggerEncode,
                liveUpdateUI,
                useProxy
            );
        } finally {
            abortBtn.remove();
        }

        const refineAborted = Array.isArray(changeLog) &&
            changeLog.some(l => String(l).includes('Nachoptimierung abgebrochen'));
        if (statusDiv) statusDiv.innerHTML = refineAborted
            ? `<span style='color:#dc3545; font-weight:bold;'>⏹️ Nachoptimierung abgebrochen — Palette auf dem zuletzt erreichten Stand.</span>`
            : `<span style='color:#28a745; font-weight:bold;'>✅ Nachoptimierung beendet!</span>`;
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
        
        // Abfrage: Intensität ('sehr_schnell'|'normal'|'langsam') + Proxy-Option
        let choice = await askAutoFillMode();
        if (!choice) return; // Abgebrochen
        let intensityMode = choice.intensity;
        let useProxy = choice.useProxy;
        
        let statusDiv = document.getElementById('builder-status');
        let currentOffset = getCurrentOffset();
        let step = getStep();
        let metric = getMetric();

        appState.globalPaletteRAM[0] = 0; appState.globalPaletteRAM[1] = 0; appState.globalPaletteRAM[2] = 0;

        // Auto-Budget (#4): Abbrechen-Button, solange die Optimierung läuft.
        // Bewusst außerhalb von #builder-status, weil updateOptProgress dessen
        // innerHTML bei jedem Fortschritt überschreibt.
        let abortBtn = document.getElementById('palette-abort-btn');
        if (abortBtn) abortBtn.remove();
        abortBtn = document.createElement('button');
        abortBtn.id = 'palette-abort-btn';
        abortBtn.textContent = '⏹️ Optimierung abbrechen';
        abortBtn.style.cssText = 'position:fixed; right:16px; bottom:16px; z-index:10001; background:#dc3545; color:#fff; border:none; padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:bold; box-shadow:0 4px 14px rgba(0,0,0,0.55); font-family:sans-serif; font-size:13px;';
        abortBtn.onclick = () => {
            requestOptimizationAbort();
            abortBtn.disabled = true;
            abortBtn.style.background = '#6c757d';
            abortBtn.style.cursor = 'default';
            abortBtn.textContent = '⏹️ Abbruch angefordert... (Stufengrenze)';
        };
        document.body.appendChild(abortBtn);

        // Proxy-Optimierung: bei großen Bildern auf einem Vorschaubild rechnen
        // und die fertige Palette auf das Original anwenden.
        let changeLog;
        try {
            changeLog = await runOptimizationWithProxy(
                appState, getOptRegion(), step, metric, currentOffset, getLockedSlots(), 
                (msg) => { if (statusDiv) statusDiv.innerHTML = `<span style='color:#ffc107; font-weight:bold;'>⏳ ${msg}</span>`; },
                triggerEncode,
                liveUpdateUI,
                intensityMode,
                useProxy
            );
        } finally {
            abortBtn.remove();
        }

        const wasAborted = Array.isArray(changeLog) &&
            changeLog.some(l => String(l).includes('Optimierung abgebrochen'));
        if (statusDiv) statusDiv.innerHTML = wasAborted
            ? `<span style='color:#dc3545; font-weight:bold;'>⏹️ Optimierung abgebrochen — Palette auf dem zuletzt erreichten Stand.</span>`
            : `<span style='color:#28a745; font-weight:bold;'>✅ Optimierung beendet!</span>`;
        selectedTargetSlot = { index: 1, absSlot: (currentOffset + 1) % 256 };
        
        btnBuilder.click(); 
        renderPaletteWithLocks(appState);

        let mseListDiv = document.getElementById('builder-mse-list');
        if (mseListDiv && changeLog && changeLog.length > 0) {
            mseListDiv.innerHTML = `<div style="background:#16181a; border:1px solid #444; border-radius:4px; padding:10px; width:100%; overflow-y:auto; max-height:280px;">
                <ul style="font-size:11px; color:#ccc; padding-left:15px; margin:0; line-height: 1.4;">
                    ${changeLog.map(log => `<li style="margin-bottom:4px; list-style:none;">${log}</li>`).join('')}
                </ul>
            </div>`;
        }
    });
}