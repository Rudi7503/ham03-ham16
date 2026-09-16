// src/ui/error_window.js
//
// Eigenes, verschiebbares Fenster für das Fehlerbild (|Original − Decodiert|).
//
// Funktionen:
//   * Feld "Max. Abweichung": alle Fehler unterhalb dieser Abweichung werden im
//     Fehlerbild auf 0,0,0 gesetzt (reine Anzeige-/Navigationsfilterung).
//   * Navigation: vorheriger/nächster Fehler (Rasterfolge) und
//     vorheriger/nächster höchster Fehler (nach Abweichung sortiert).
//   * Nach dem Anspringen:
//       - Fehler auf 0 setzen (ignorieren)
//       - Wert setzen: Liste ALLER an dieser Position erreichbaren Werte
//         (Anker + Deltas), sortiert nach Nähe zum Original → Klick setzt den
//         Wert ins modifizierte Bild und macht einen LOKALEN Re-Encode
//         (nur ab der Änderung bis zum Resync, danach Original-Befehlsrest).
//       - Lokaler Wavelet-Filter (3×3-Region) + lokaler Re-Encode.

import { describeCommand, computeAccAtPixel, listReachableValues } from '../core/module_paletted.js';
import { applyLocalWaveletDamping } from '../core/smart_target.js';
import { performLocalEdit, updateErrorRange, canLocalEdit } from '../core/local_edit.js';

const BTN = 'background:#333; color:#fff; border:1px solid #555; border-radius:4px; padding:4px 8px; font-size:11px; font-weight:bold; cursor:pointer;';
const BTN_ACT = 'background:#17a2b8; color:#fff; border:1px solid #4dabf7; border-radius:4px; padding:4px 8px; font-size:11px; font-weight:bold; cursor:pointer;';

// Einmalige Instanz: Der Builder wird bei jedem Bild-/Formatwechsel neu
// aufgebaut — es darf dabei KEIN zweites Fenster (und keine doppelten Listener)
// entstehen. Bei erneutem initErrorWindow() werden nur die Deps getauscht.
let singleton = null;

export function initErrorWindow(appState, deps = {}) {
    if (singleton) {
        singleton.updateDeps(deps);
        return singleton;
    }
    const D = {
        getStep: () => ({ r: 4, g: 4, b: 4 }),
        getMetric: () => 'yuv_weight',
        getOffset: () => 0,
        getFormat: () => appState.currentFormat,
        setStatus: () => {},
        onLocalUpdate: () => {},
        onViewSync: () => {},        // (scale, x, y) → Hauptansichten mitziehen
        requestFullEncode: null,
        ...deps
    };

    let panel = null, canvas = null, ctx = null, marker = null, infoEl = null, valuesEl = null,
        hintEl = null, wrapEl = null, countEl = null, thrInput = null, regionEl = null, regionInfoEl = null;

    let currentPx = -1;
    let zoom = 'fit';
    let displayThreshold = 0;
    const ignored = new Set();
    let raster = [];                 // Pixelindizes mit sichtbarem Fehler (Rasterfolge)
    let ranked = [];                 // {i, m} absteigend nach Abweichung
    let displayImageData = null;     // Anzeige-Puffer (Cache)
    let lastZoomApplied = null;      // für "bei Zoomwechsel auf Fehler zentrieren"
    let tailMode = 'source';         // 'source' = Folgepixel neu optimieren | 'olddecode' = alte Farben behalten
    let thresholdTimer = null;
    let region = null;               // {x0,y0,x1,y1} Arbeits-Ausschnitt (Bildkoordinaten)
    let selecting = false;           // Ausschnitt wird gerade aufgezogen
    let selStart = null;
    let lastNavMode = 'raster';      // 'raster' | 'rank' (für Auto-Weiterspringen)
    let rankCursor = 0;
    let autoAdvance = true;          // nach einer Änderung automatisch zum nächsten Fehler
    let lastValues = null;           // zuletzt angezeigte Werte-Liste (für Klick-Handler)
    let lastW = -1, lastH = -1, lastFormat = null; // Zustandsreset bei neuem Bild/Format

    // ---------------------------------------------------------------- DOM ----
    function ensureDom() {
        if (panel) return;

        panel = document.createElement('div');
        panel.id = 'errwin';
        panel.style.cssText = 'position:fixed; right:16px; top:64px; width:600px; max-width:48vw; max-height:92vh; overflow:auto;' +
            'z-index:3000; background:#1e2124; border:1px solid #555; border-radius:8px; box-shadow:0 12px 34px rgba(0,0,0,.6);' +
            'display:none; font-family:Arial,sans-serif; color:#ddd;';

        const zoomBtns = ['fit', '1', '2', '4', '8', '16']
            .map(z => `<button class="errwin-zoom" data-zoom="${z}" style="${BTN}">${z === 'fit' ? 'Fit' : z + 'x'}</button>`)
            .join('');

        panel.innerHTML = `
            <div id="errwin-bar" style="cursor:move; padding:8px 10px; background:#2b2f33; border-bottom:1px solid #444; border-radius:8px 8px 0 0; display:flex; justify-content:space-between; align-items:center; user-select:none;">
                <b style="color:#c084fc;">Fehlerbild&nbsp;|&nbsp;Original − Decodiert</b>
                <span style="display:flex; gap:8px; align-items:center;">
                    <span id="errwin-count" style="font-size:11px; color:#888;"></span>
                    <button id="errwin-collapse" title="Fenster einklappen (Bildfläche freigeben)" style="background:#555; color:#fff; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">—</button>
                    <button id="errwin-close" title="Schließen" style="background:#555; color:#fff; border:none; border-radius:4px; padding:2px 9px; cursor:pointer;">×</button>
                </span>
            </div>
            <div id="errwin-body" style="padding:10px;">
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px;">
                    <label title="Alle Fehler unterhalb dieser Abweichung werden im Fehlerbild auf 0,0,0 gesetzt">Max. Abweichung:</label>
                    <input id="errwin-threshold" type="number" min="0" max="255" value="0" style="width:58px;">
                    <span style="color:#888;">(0 = alles anzeigen)</span>
                    <button id="errwin-ignore-reset" style="${BTN}">Ignorierte zurücksetzen <span id="errwin-ign-count">(0)</span></button>
                </div>
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px; margin-top:6px;">
                    <span>Zoom:</span>${zoomBtns}
                    <span style="margin-left:8px;">Ausschnitt:</span>
                    <button id="errwin-region-pick" style="${BTN}" title="Bereich im Fehlerbild aufziehen — Navigation und Bearbeitung beschränken sich darauf">Ausschnitt wählen</button>
                    <button id="errwin-region-clear" style="${BTN}" title="Ausschnitt aufheben (ganzes Bild)">Ganzes Bild</button>
                    <span id="errwin-region-info" style="color:#888;">ganzes Bild</span>
                </div>
                <div id="errwin-wrap" style="margin-top:6px; height:300px; display:flex; overflow:auto; background:#000; border:1px solid #333; border-radius:4px;">
                    <div id="errwin-inner" style="position:relative; margin:auto; flex:0 0 auto;">
                        <canvas id="errwin-canvas" style="image-rendering:pixelated; display:block;"></canvas>
                        <div id="errwin-region" style="position:absolute; left:0; top:0; width:0; height:0; border:1px dashed #f0f; pointer-events:none; display:none;"></div>
                        <div id="errwin-marker" style="position:absolute; left:0; top:0; width:0; height:0; border:1px solid #ff0; pointer-events:none; display:none;"></div>
                    </div>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                    <button id="errwin-prev" style="${BTN}" title="Vorheriger Pixel mit Fehler (Rasterfolge)">◀ Fehler</button>
                    <button id="errwin-next" style="${BTN}" title="Nächster Pixel mit Fehler (Rasterfolge)">Fehler ▶</button>
                    <button id="errwin-prevmax" style="${BTN}" title="Nächsthöherer Fehler (nach Abweichung sortiert)">◀ höchster</button>
                    <button id="errwin-nextmax" style="${BTN}" title="Nächstniedrigerer Fehler (nach Abweichung sortiert)">höchster ▶</button>
                    <button id="errwin-ignore" style="${BTN}" title="Diesen Fehler im Fehlerbild auf 0,0,0 setzen">Fehler auf 0 (ignorieren)</button>
                </div>
                <div id="errwin-info" style="margin-top:6px; font-size:12px; color:#4dabf7; min-height:16px;"></div>
                <div style="margin-top:8px; font-size:12px; color:#ccc;">Erreichbare Werte an dieser Position (nach Nähe zum Original sortiert) — Klick setzt den Wert ins modifizierte Bild und macht einen lokalen Re-Encode:</div>
                <div id="errwin-values" style="margin-top:4px; max-height:190px; overflow-y:auto; background:#111; border:1px solid #333; border-radius:4px; padding:4px; font-size:11px;"></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
                    <button id="errwin-wavelet" style="${BTN}" title="Wavelet-Dämpfung auf die 3×3-Region anwenden + lokaler Re-Encode">Lokaler Wavelet-Filter (3×3)</button>
                    <button id="errwin-wavelet-region" style="${BTN}" title="Wavelet-Filter auf alle Fehler im Arbeits-Ausschnitt anwenden (je 3×3 + lokaler Re-Encode)">Wavelet auf Ausschnitt (alle Fehler)</button>
                    <button id="errwin-full" style="${BTN}" title="Komplettes Bild neu codieren (Fallback)">Vollständig neu codieren</button>
                    <label style="color:#adb5bd; margin-left:6px;" title="Ziel der Nachcodierung bis zum Resync">Folgepixel:</label>
                    <select id="errwin-tail" style="font-size:11px;" title="Original: Folgepixel werden neu optimiert (Farben können sich bis zum nächsten Anker ändern) · altes Decode: Farben bleiben wie vorher, nur die Kommandos werden neu">
                        <option value="source" selected>Original (neu optimieren)</option>
                        <option value="olddecode">altes Decode (unverändert)</option>
                    </select>
                </div>
                <div id="errwin-hint" style="margin-top:6px; font-size:11px; color:#888; min-height:14px;"></div>
            </div>`;
        document.body.appendChild(panel);

        canvas = panel.querySelector('#errwin-canvas');
        ctx = canvas.getContext('2d');
        marker = panel.querySelector('#errwin-marker');
        infoEl = panel.querySelector('#errwin-info');
        valuesEl = panel.querySelector('#errwin-values');
        hintEl = panel.querySelector('#errwin-hint');
        wrapEl = panel.querySelector('#errwin-wrap');
        countEl = panel.querySelector('#errwin-count');
        thrInput = panel.querySelector('#errwin-threshold');
        regionEl = panel.querySelector('#errwin-region');
        regionInfoEl = panel.querySelector('#errwin-region-info');

        // ---------------------------------------------------------- Dragging --
        const bar = panel.querySelector('#errwin-bar');
        let drag = null;
        bar.addEventListener('mousedown', (e) => {
            if (e.target.id === 'errwin-close' || e.target.id === 'errwin-collapse') return;
            panel.style.right = 'auto'; // sonst kollidiert right mit dem gesetzten left
            drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.dx)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
        });
        window.addEventListener('mouseup', () => { drag = null; });

        // ------------------------------------------------------------ Events --
        panel.querySelector('#errwin-close').addEventListener('click', close);
        panel.querySelector('#errwin-collapse').addEventListener('click', () => {
            const body = panel.querySelector('#errwin-body');
            const collapsed = body.style.display === 'none';
            body.style.display = collapsed ? 'block' : 'none';
            panel.style.height = 'auto';
            panel.style.maxHeight = collapsed ? '92vh' : 'none';
            if (!collapsed) hint('Fenster eingeklappt — Bildfläche ist frei zum Anklicken.');
        });
        panel.querySelector('#errwin-ignore-reset').addEventListener('click', () => {
            ignored.clear();
            markDirty('Ignorierte zurückgesetzt');
        });
        panel.querySelectorAll('.errwin-zoom').forEach(b => {
            b.addEventListener('click', () => {
                zoom = b.dataset.zoom;
                panel.querySelectorAll('.errwin-zoom').forEach(x => x.style.cssText = x === b ? BTN_ACT : BTN);
                applyZoom();
                syncMainView(); // nur hier: Zoom-Buttons ziehen die Hauptansichten mit
            });
        });

        // ------------------------------------------------- Ausschnitt wählen --
        panel.querySelector('#errwin-region-pick').addEventListener('click', () => {
            selecting = true;
            canvas.style.cursor = 'crosshair';
            hint('Bereich im Fehlerbild mit gedrückter Maustaste aufziehen …');
        });
        panel.querySelector('#errwin-region-clear').addEventListener('click', () => {
            region = null;
            selecting = false;
            canvas.style.cursor = 'default';
            updateRegionOverlay();
            updateRegionInfo();
            markDirty('Ausschnitt aufgehoben — ganzes Bild');
        });

        canvas.addEventListener('mousedown', (e) => {
            if (!selecting) return;
            const p = imageCoordsFromEvent(e);
            if (!p) return;
            selStart = p;
            e.preventDefault();
            e.stopPropagation();
        });
        canvas.addEventListener('mousemove', (e) => {
            if (!selecting || !selStart) return;
            const p = imageCoordsFromEvent(e);
            if (!p) return;
            previewRegion(selStart, p);
            e.preventDefault();
        });
        canvas.addEventListener('mouseup', (e) => {
            if (!selecting || !selStart) return;
            const p = imageCoordsFromEvent(e);
            if (p) {
                const { w } = imageSize();
                const x0 = Math.min(selStart.x, p.x), x1 = Math.max(selStart.x, p.x);
                const y0 = Math.min(selStart.y, p.y), y1 = Math.max(selStart.y, p.y);
                region = { x0, y0, x1, y1 };
                hint(`Ausschnitt: X ${x0}–${x1}, Y ${y0}–${y1} (${x1 - x0 + 1}×${y1 - y0 + 1} px) — Navigation/Bearbeitung nur hier`);
            }
            selecting = false;
            selStart = null;
            canvas.style.cursor = 'default';
            updateRegionOverlay();
            updateRegionInfo();
            rebuildLists();
            render();
            e.preventDefault();
        });
        panel.querySelector('.errwin-zoom').style.cssText = BTN_ACT;

        thrInput.addEventListener('input', () => {
            displayThreshold = Math.max(0, Math.min(255, parseInt(thrInput.value) || 0));
            clearTimeout(thresholdTimer);
            thresholdTimer = setTimeout(() => markDirty(`Max. Abweichung = ${displayThreshold}`), 150);
        });

        panel.querySelector('#errwin-prev').addEventListener('click', () => navRaster(-1));
        panel.querySelector('#errwin-next').addEventListener('click', () => navRaster(+1));
        panel.querySelector('#errwin-prevmax').addEventListener('click', () => navRank(-1));
        panel.querySelector('#errwin-nextmax').addEventListener('click', () => navRank(+1));
        panel.querySelector('#errwin-ignore').addEventListener('click', ignoreCurrent);
        panel.querySelector('#errwin-wavelet').addEventListener('click', applyWavelet);
        panel.querySelector('#errwin-wavelet-region').addEventListener('click', applyWaveletToRegion);
        panel.querySelector('#errwin-tail').addEventListener('change', (e) => {
            tailMode = e.target.value === 'olddecode' ? 'olddecode' : 'source';
            hint(tailMode === 'source'
                ? 'Folgepixel werden neu optimiert (Richtung Original) — Farben können sich bis zum nächsten Anker ändern.'
                : 'Folgepixel behalten ihre bisherigen Farben — nur die Kommandos werden neu erzeugt.');
        });
        panel.querySelector('#errwin-full').addEventListener('click', async () => {
            if (typeof D.requestFullEncode !== 'function') return;
            hint('Vollständiges Neu-Codieren läuft …');
            await D.requestFullEncode();
            refresh();
        });

        valuesEl.addEventListener('click', (e) => {
            const row = e.target.closest('.errwin-val');
            if (!row || !lastValues) return;
            const v = lastValues[parseInt(row.dataset.idx, 10)];
            if (!v) return;
            applyValue(v);
        });
    }

    // ------------------------------------------------------------ Helfer ----
    function hint(msg) { if (hintEl) hintEl.textContent = msg || ''; }

    function markDirty(msg) {
        rebuildLists();
        render();
        if (msg) hint(msg);
    }

    function imageSize() {
        const ed = appState.errorViewData;
        if (ed) return { w: ed.width, h: ed.height };
        return { w: appState.currentImgW, h: appState.currentImgH };
    }

    function currentError(px) {
        const ed = appState.errorViewData;
        if (!ed || px < 0 || px * 4 >= ed.data.length) return { dr: 0, dg: 0, db: 0, m: 0 };
        const o = px * 4;
        const dr = ed.data[o], dg = ed.data[o + 1], db = ed.data[o + 2];
        return { dr, dg, db, m: Math.max(dr, dg, db) };
    }

    // ------------------------------------------------- Ausschnitt-Helfer ----
    function inRegion(px) {
        if (!region) return true;
        const { w } = imageSize();
        const x = px % w, y = Math.floor(px / w);
        return x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1;
    }

    function imageCoordsFromEvent(e) {
        const { w, h } = imageSize();
        if (!w || !h) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const z = zoomFactor();
        const x = Math.max(0, Math.min(w - 1, Math.floor((e.clientX - rect.left) / z)));
        const y = Math.max(0, Math.min(h - 1, Math.floor((e.clientY - rect.top) / z)));
        return { x, y };
    }

    function previewRegion(a, b) {
        paintRegionRect({
            x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
            x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y)
        });
    }

    function paintRegionRect(rect) {
        if (!regionEl) return;
        const z = zoomFactor();
        regionEl.style.display = 'block';
        regionEl.style.left = Math.round(rect.x0 * z) + 'px';
        regionEl.style.top = Math.round(rect.y0 * z) + 'px';
        regionEl.style.width = Math.max(1, Math.round((rect.x1 - rect.x0 + 1) * z)) + 'px';
        regionEl.style.height = Math.max(1, Math.round((rect.y1 - rect.y0 + 1) * z)) + 'px';
    }

    function updateRegionOverlay() {
        if (!regionEl) return;
        if (!region || selecting) { if (!selecting) regionEl.style.display = 'none'; return; }
        paintRegionRect(region);
    }

    function updateRegionInfo() {
        if (!regionInfoEl) return;
        if (!region) { regionInfoEl.textContent = 'ganzes Bild'; return; }
        regionInfoEl.textContent = `X ${region.x0}–${region.x1}, Y ${region.y0}–${region.y1} (${region.x1 - region.x0 + 1}×${region.y1 - region.y0 + 1})`;
    }

    function rebuildLists() {
        raster = [];
        ranked = [];
        const ed = appState.errorViewData;
        if (!ed) return;
        const s = ed.data;
        const n = ed.width * ed.height;
        const w = ed.width;
        const entries = [];
        for (let i = 0; i < n; i++) {
            if (ignored.has(i)) continue;
            if (region) { // nur Fehler innerhalb des Arbeits-Ausschnitts
                const x = i % w, y = Math.floor(i / w);
                if (x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) continue;
            }
            const o = i * 4;
            const m = Math.max(s[o], s[o + 1], s[o + 2]);
            if (m <= 0) continue;
            if (displayThreshold > 0 && m < displayThreshold) continue;
            raster.push(i);
            entries.push({ i, m });
        }
        entries.sort((a, b) => b.m - a.m);
        ranked = entries;
        if (countEl) {
            countEl.textContent = `${raster.length} Fehler${ignored.size ? `, ${ignored.size} ignoriert` : ''}`;
        }
        const ignBtn = panel.querySelector('#errwin-ign-count');
        if (ignBtn) ignBtn.textContent = `(${ignored.size})`;
    }

    // ---------------------------------------------------------- Anzeige -----
    function render() {
        if (!panel || panel.style.display === 'none') return;
        const ed = appState.errorViewData;
        const { w, h } = imageSize();

        if (!ed || !w || !h || ed.width !== w || ed.height !== h) {
            if (canvas) { canvas.width = 1; canvas.height = 1; }
            if (infoEl) infoEl.textContent = 'Kein Fehlerbild vorhanden — bitte „2. Codieren“ drücken.';
            if (valuesEl) valuesEl.innerHTML = '';
            if (marker) marker.style.display = 'none';
            if (regionEl) regionEl.style.display = 'none';
            if (countEl) countEl.textContent = '';
            return;
        }

        if (!displayImageData || displayImageData.width !== w || displayImageData.height !== h) {
            displayImageData = ctx.createImageData(w, h);
        }
        const src = ed.data, dst = displayImageData.data;
        for (let i = 0; i < w * h; i++) {
            const o = i * 4;
            let dr = src[o], dg = src[o + 1], db = src[o + 2];
            if (ignored.has(i) || (displayThreshold > 0 && Math.max(dr, dg, db) < displayThreshold)) {
                dr = 0; dg = 0; db = 0;
            }
            dst[o] = dr; dst[o + 1] = dg; dst[o + 2] = db; dst[o + 3] = 255;
        }
        canvas.width = w;
        canvas.height = h;
        ctx.putImageData(displayImageData, 0, 0);
        applyZoom();
        updateMarker();
        updateInfo();
    }

    function zoomFactor() {
        const { w, h } = imageSize();
        if (!w || !h) return 1;
        if (zoom === 'fit') {
            // Verfügbaren Platz im Wrapper messen (feste Wrapper-Höhe, daher stabil).
            // Der Abzug deckt Scrollbalken/Rahmen ab, damit wirklich alles hineinpasst.
            const availW = Math.max(40, (wrapEl ? wrapEl.clientWidth : 560) - 20);
            const availH = Math.max(40, (wrapEl ? wrapEl.clientHeight : 300) - 20);
            return Math.max(0.02, Math.min(availW / w, availH / h));
        }
        return parseInt(zoom) || 1;
    }

    // Scrollt so, dass der aktuell angesprungene Fehler mittig sichtbar ist.
    function centerOnCurrentPixel() {
        if (!wrapEl || currentPx < 0) return;
        const { w } = imageSize();
        if (!w) return;
        const z = zoomFactor();
        const cx = (currentPx % w) * z + z / 2;
        const cy = Math.floor(currentPx / w) * z + z / 2;
        wrapEl.scrollLeft = Math.max(0, cx - wrapEl.clientWidth / 2);
        wrapEl.scrollTop = Math.max(0, cy - wrapEl.clientHeight / 2);
    }

    // Hauptansichten (Original/Smart Target/Fehlerbild + Dekodiert) auf dieselbe
    // Zoomstufe ziehen. Wird NUR von den Zoom-Buttons aufgerufen — Klicks und
    // Fehler-Navigation dürfen die Hauptansicht nicht verschieben.
    function syncMainView() {
        if (typeof D.onViewSync !== 'function') return;
        const { w, h } = imageSize();
        if (!w || !h) return;
        if (currentPx >= 0) {
            D.onViewSync(zoomFactor(), currentPx % w, Math.floor(currentPx / w));
        } else {
            D.onViewSync(zoomFactor(), w / 2, h / 2);
        }
    }

    function applyZoom() {
        const { w, h } = imageSize();
        const z = zoomFactor();
        canvas.style.width = Math.max(1, Math.round(w * z)) + 'px';
        canvas.style.height = Math.max(1, Math.round(h * z)) + 'px';
        // Bei geänderter Zoomstufe das EIGENE Canvas auf den Fehler zentrieren.
        // Die Hauptansichten werden hier NICHT angefasst (das passiert nur über
        // die Zoom-Buttons, siehe pushZoomToMainViews()).
        if (zoom !== lastZoomApplied) {
            lastZoomApplied = zoom;
            centerOnCurrentPixel();
        }
        updateMarker(); // Marker sitzt skalierungsabhängig
        updateRegionOverlay(); // Ausschnitt-Rechteck ebenfalls
    }

    function updateMarker() {
        if (!marker) return;
        const { w } = imageSize();
        if (currentPx < 0 || !w) { marker.style.display = 'none'; return; }
        const x = currentPx % w, y = Math.floor(currentPx / w);
        const z = zoomFactor();
        const size = Math.max(4, Math.round(z));
        marker.style.display = 'block';
        marker.style.left = Math.round(x * z) + 'px';
        marker.style.top = Math.round(y * z) + 'px';
        marker.style.width = size + 'px';
        marker.style.height = size + 'px';
    }

    function updateInfo() {
        if (!infoEl) return;
        if (currentPx < 0) { infoEl.textContent = 'Kein Fehler angesprungen.'; return; }
        const { w } = imageSize();
        const x = currentPx % w, y = Math.floor(currentPx / w);
        const e = currentError(currentPx);
        const rank = ranked.findIndex(r => r.i === currentPx);
        const cmd = appState.latestCommandArray ? appState.latestCommandArray[currentPx] : null;
        const cmdTxt = describeCommand(cmd, D.getStep(), D.getOffset()) || '–';
        const ign = ignored.has(currentPx) ? ' | IGNORIERT' : '';
        infoEl.textContent = `Pixel ${currentPx} (X ${x}, Y ${y}) | Rang ${rank >= 0 ? rank + 1 : '–'}/${ranked.length}`
            + ` | |Δ| = ${e.dr},${e.dg},${e.db} | ${cmdTxt}${ign}`;
    }

    // ----------------------------------------------------- Werte-Liste -------
    function renderValues() {
        if (!valuesEl) return;
        valuesEl.innerHTML = '';
        if (currentPx < 0) return;

        const format = D.getFormat();
        if (!canLocalEdit(format)) {
            valuesEl.innerHTML = '<div style="color:#888; padding:4px;">Lokale Wertänderungen gibt es nur für die HAM-Palettenformate.</div>';
            return;
        }
        const commands = appState.latestCommandArray;
        if (!commands || !commands.length) {
            valuesEl.innerHTML = '<div style="color:#888; padding:4px;">Keine Kommandodaten — bitte zuerst „2. Codieren“.</div>';
            return;
        }

        const stepVal = D.getStep();
        const offset = D.getOffset();
        const metric = D.getMetric();
        const acc = computeAccAtPixel(commands, currentPx, stepVal, paletteRAM(), offset);

        const orig = appState.originalImageData;
        const o4 = currentPx * 4;
        const target = orig && o4 + 2 < orig.data.length
            ? { r: orig.data[o4], g: orig.data[o4 + 1], b: orig.data[o4 + 2] }
            : { r: acc.r, g: acc.g, b: acc.b };
        const dec = appState.decodedImageData;
        const decodedNow = dec && o4 + 2 < dec.data.length
            ? { r: dec.data[o4], g: dec.data[o4 + 1], b: dec.data[o4 + 2] }
            : null;

        const { effFormat, values } = listReachableValues({
            format, imgW: appState.currentImgW, pxIndex: currentPx,
            stepVal, paletteRAM: paletteRAM(), offset, acc, target, metric
        });

        const head = document.createElement('div');
        head.style.cssText = 'color:#888; padding:2px 4px 4px 4px; line-height:1.5;';
        head.innerHTML = `Phase: <b style="color:#ccc;">${effFormat}</b> | akkumuliert (Pixel davor): <b style="color:#ccc;">RGB(${acc.r},${acc.g},${acc.b})</b>`
            + ` | ${values.length} mögliche Werte<br>`
            + `<span style="display:inline-flex; align-items:center; gap:5px;">Original (Soll):`
            + `<span style="display:inline-block; width:14px; height:14px; background:rgb(${target.r},${target.g},${target.b}); border:1px solid #888;"></span>`
            + `<b style="color:#ffd400;">RGB(${target.r},${target.g},${target.b})</b></span>`
            + (decodedNow ? ` <span style="display:inline-flex; align-items:center; gap:5px; margin-left:10px;">aktuell decodiert:`
                + `<span style="display:inline-block; width:14px; height:14px; background:rgb(${decodedNow.r},${decodedNow.g},${decodedNow.b}); border:1px solid #888;"></span>`
                + `<b style="color:#4dabf7;">RGB(${decodedNow.r},${decodedNow.g},${decodedNow.b})</b></span>` : '');
        valuesEl.appendChild(head);

        // Werte für den Klick-Handler merken (inkl. Kommando zum Pinnen)
        lastValues = values;

        for (let vi = 0; vi < values.length; vi++) {
            const v = values[vi];
            const label = describeCommand(v.cmd, stepVal, offset) || '–';
            const row = document.createElement('div');
            row.className = 'errwin-val';
            row.dataset.idx = vi;
            row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:3px 4px; cursor:pointer; border-radius:3px;';
            row.onmouseenter = () => { row.style.background = '#242a2f'; };
            row.onmouseleave = () => { row.style.background = 'transparent'; };
            // Original (Soll) und auszuwählende Farbe NEBENEINANDER
            row.innerHTML =
                `<span style="display:inline-block; width:12px; height:12px; background:rgb(${target.r},${target.g},${target.b}); border:1px solid #888;" title="Original/Soll"></span>`
                + `<span style="width:88px; color:#ffd400;">${target.r},${target.g},${target.b}</span>`
                + `<span style="color:#888;">→</span>`
                + `<span style="display:inline-block; width:12px; height:12px; background:rgb(${v.r},${v.g},${v.b}); border:1px solid #666;" title="auszuwählende Farbe"></span>`
                + `<span style="width:88px; color:#eaeaea;">${v.r},${v.g},${v.b}</span>`
                + `<span style="width:52px; color:${v.kind === 'anchor' ? '#4dabf7' : '#ffc107'};">${v.kind === 'anchor' ? 'Anker' : 'Delta'}</span>`
                + `<span style="flex:1; color:#aaa;">${label}</span>`
                + `<span style="width:62px; text-align:right; color:${v.dist === 0 ? '#28a745' : '#888'};">Δ ${v.dist.toFixed(1)}</span>`;
            valuesEl.appendChild(row);
        }
    }

    // ------------------------------------------------ Bearbeitungs-Ziel -----
    function paletteRAM() { return appState.globalPaletteRAM; }

    // Liefert das zu ändernde Bild (das modifizierte) und prüft, ob die
    // vorhandenen Befehle dazu passen. Wenn noch kein modifiziertes Bild
    // existiert, wird es aus dem Original erzeugt (= inhaltsgleich zur
    // encodierten Quelle, daher bleiben die Befehle gültig).
    function ensureEditTarget() {
        const format = D.getFormat();
        if (!canLocalEdit(format)) {
            return { ok: false, msg: 'Lokale Änderungen gibt es nur für die HAM-Palettenformate.' };
        }
        const commands = appState.latestCommandArray;
        if (!commands || !commands.length) {
            return { ok: false, msg: 'Keine Kommandodaten — bitte zuerst „2. Codieren“ drücken.' };
        }
        if (!appState.decodedImageData || !appState.errorViewData) {
            return { ok: false, msg: 'Decode/Fehlerbild fehlt — bitte zuerst „2. Codieren“ drücken.' };
        }

        if (!appState.modifiedImageData) {
            const src = appState.commandSource || appState.originalImageData;
            if (!src) return { ok: false, msg: 'Kein Quellbild vorhanden.' };
            appState.modifiedImageData = new ImageData(
                new Uint8ClampedArray(src.data), src.width, src.height
            );
            appState.viewMode = 'modified';
            appState.showModified = true;
            // Inhalt ist identisch zur encodierten Quelle → Befehle bleiben gültig
            appState.commandSource = appState.modifiedImageData;
        } else if (appState.commandSource && appState.commandSource !== appState.modifiedImageData) {
            return {
                ok: false,
                msg: 'Die Befehle stammen vom Original. Bitte Ansicht „Modifiziert“ wählen und „2. Codieren“ drücken, dann erneut ändern.'
            };
        }

        return { ok: true, data: appState.modifiedImageData.data };
    }

    function finishLocalEdit(res, label) {
        updateErrorRange(
            appState.errorViewData.data,
            (appState.commandSource || appState.modifiedImageData).data,
            appState.decodedImageData.data,
            res.startPx, res.endPx
        );
        D.onLocalUpdate(res);
        rebuildLists();
        render();
        renderValues();
        const resyncTxt = res.valueResync ? 'Resync über gleichen Pixelwert ✅' : (res.forced ? 'Resync am nächsten Anker ✅' : 'Resync ✅');
        hint(`${label} | Fenster ${res.span} px ab Pixel ${res.startPx} | ${resyncTxt}`
            + ` | Lookahead ${res.usedLookahead || 0} px`);
        D.setStatus(`${label}: lokal nachcodiert über ${res.span} px (${resyncTxt})`);
    }

    // Nach einer Änderung automatisch zum nächsten Fehler springen — im zuletzt
    // benutzten Navigationsmodus (Rasterfolge oder Abweichungs-Rangliste).
    function advanceAfterEdit() {
        if (!autoAdvance) return;
        if (lastNavMode === 'rank') {
            if (!ranked.length) { hint('Keine weiteren Fehler im Arbeitsbereich.'); return; }
            const idx = Math.max(0, Math.min(rankCursor, ranked.length - 1));
            selectPixel(ranked[idx].i);
        } else {
            navRaster(+1);
        }
    }

    // ---------------------------------------------------------- Aktionen ----
    function selectPixel(px) {
        currentPx = px;
        updateMarker();
        updateInfo();
        renderValues();
        centerOnCurrentPixel(); // nur das eigene Fenster-Canvas zentrieren
        // Hauptansichten bleiben bewusst unverändert (kein Zoom-/Pan-Sprung).
    }

    function navRaster(dir) {
        lastNavMode = 'raster';
        if (!raster.length) { hint('Keine Fehler im Arbeitsbereich über der aktuellen Schwelle.'); return; }
        if (currentPx < 0) { selectPixel(raster[0]); return; }
        if (dir > 0) {
            const idx = raster.findIndex(v => v > currentPx);
            selectPixel(idx === -1 ? raster[0] : raster[idx]);
        } else {
            let prev = -1;
            for (let k = 0; k < raster.length; k++) { if (raster[k] < currentPx) prev = raster[k]; else break; }
            selectPixel(prev === -1 ? raster[raster.length - 1] : prev);
        }
    }

    function navRank(dir) {
        lastNavMode = 'rank';
        if (!ranked.length) { hint('Keine Fehler im Arbeitsbereich über der aktuellen Schwelle.'); return; }
        let ri = ranked.findIndex(e => e.i === currentPx);
        if (ri === -1) { rankCursor = 0; selectPixel(ranked[0].i); return; }
        ri = Math.max(0, Math.min(ranked.length - 1, ri + dir));
        rankCursor = ri;
        selectPixel(ranked[ri].i);
    }

    function ignoreCurrent() {
        if (currentPx < 0) { hint('Kein Fehler angesprungen.'); return; }
        ignored.add(currentPx);
        rebuildLists();
        render();
        D.setStatus(`Fehler bei Pixel ${currentPx} auf 0 gesetzt (ignoriert)`);
        advanceAfterEdit();
    }

    async function applyValue(v) {
        const t = ensureEditTarget();
        if (!t.ok) { hint(t.msg); return; }
        const editedPx = currentPx;
        const o = editedPx * 4;
        t.data[o] = v.r; t.data[o + 1] = v.g; t.data[o + 2] = v.b;
        const label = describeCommand(v.cmd, D.getStep(), D.getOffset()) || (v.kind === 'anchor' ? 'Anker' : 'Delta');

        const res = performLocalEdit({
            sourceData: t.data, width: appState.currentImgW, height: appState.currentImgH,
            format: D.getFormat(), stepVal: D.getStep(), paletteRAM: paletteRAM(), offset: D.getOffset(),
            metric: D.getMetric(),
            commands: appState.latestCommandArray,
            decodedData: appState.decodedImageData.data,
            startPx: editedPx, minEndPx: editedPx + 1,
            forcedFirstCmd: v.cmd,   // gewähltes Kommando pinnen → Pixel wird exakt getroffen
            lookaheadPx: 32,         // 32 px Receding-Horizon-Beam, danach Greedy
            // Folgepixel: 'source' = neu optimieren (Standard), 'olddecode' = alte Farben behalten
            tailFromOldDecode: tailMode === 'olddecode'
        });
        if (!res.ok) { hint(res.reason); return; }
        finishLocalEdit(res, `Wert RGB(${v.r},${v.g},${v.b}) gesetzt [${label}]`);
        advanceAfterEdit();
    }

    async function applyWavelet() {
        if (currentPx < 0) { hint('Kein Fehler angesprungen.'); return; }
        const t = ensureEditTarget();
        if (!t.ok) { hint(t.msg); return; }

        const { w, h } = imageSize();
        const cx = currentPx % w, cy = Math.floor(currentPx / w);
        const wav = applyLocalWaveletDamping(t.data, w, h, cx, cy);
        if (wav.changed === 0) { hint('Wavelet-Filter hat in der 3×3-Region nichts geändert.'); return; }

        const res = performLocalEdit({
            sourceData: t.data, width: w, height: h,
            format: D.getFormat(), stepVal: D.getStep(), paletteRAM: paletteRAM(), offset: D.getOffset(),
            metric: D.getMetric(),
            commands: appState.latestCommandArray,
            decodedData: appState.decodedImageData.data,
            startPx: wav.firstPx, minEndPx: wav.lastPx + 1, lookaheadPx: 32
        });
        if (!res.ok) { hint(res.reason); return; }
        finishLocalEdit(res, `Wavelet 3×3 (${wav.changed} px geändert)`);
        advanceAfterEdit();
    }

    // Wendet den lokalen Wavelet-Filter auf ALLE Fehler im Arbeits-Ausschnitt an
    // (jeweils 3×3 + lokaler Re-Encode). Ohne Ausschnitt: ganzes Bild.
    async function applyWaveletToRegion() {
        const t = ensureEditTarget();
        if (!t.ok) { hint(t.msg); return; }

        const list = raster.slice(); // aktuelle Fehlerliste im Arbeitsbereich
        if (!list.length) { hint('Keine Fehler im Arbeitsbereich.'); return; }

        const MAX_PIX = 2000;
        const todo = list.slice(0, MAX_PIX);
        const { w, h } = imageSize();
        let applied = 0, failed = 0, lastRes = null;

        hint(`Wavelet auf Ausschnitt läuft … (${todo.length} Fehler${list.length > MAX_PIX ? `, auf ${MAX_PIX} begrenzt` : ''})`);
        for (const px of todo) {
            // Nur bearbeiten, wenn dort noch ein Fehler liegt (kann sich durch
            // vorherige Schritte schon erledigt haben).
            const e = currentError(px);
            if (e.m <= 0) continue;
            if (!inRegion(px)) continue;

            const cx = px % w, cy = Math.floor(px / w);
            const wav = applyLocalWaveletDamping(t.data, w, h, cx, cy);
            if (wav.changed === 0) continue;

            const res = performLocalEdit({
                sourceData: t.data, width: w, height: h,
                format: D.getFormat(), stepVal: D.getStep(), paletteRAM: paletteRAM(), offset: D.getOffset(),
                metric: D.getMetric(),
                commands: appState.latestCommandArray,
                decodedData: appState.decodedImageData.data,
                startPx: wav.firstPx, minEndPx: wav.lastPx + 1, lookaheadPx: 32
            });
            if (!res.ok) { failed++; continue; }
            updateErrorRange(
                appState.errorViewData.data,
                (appState.commandSource || appState.modifiedImageData).data,
                appState.decodedImageData.data,
                res.startPx, res.endPx
            );
            applied++;
            lastRes = res;
        }

        if (lastRes) D.onLocalUpdate(lastRes);
        rebuildLists();
        render();
        renderValues();
        hint(`Wavelet auf Ausschnitt: ${applied} Fehler bearbeitet${failed ? `, ${failed} fehlgeschlagen` : ''}`
            + (region ? '' : ' (ganzes Bild)'));
        D.setStatus(`Wavelet auf Ausschnitt: ${applied} Fehler lokal nachcodiert`);
    }

    // -------------------------------------------------------------- API ----
    // ACHTUNG: als benannte Funktion im Closure — wird auch intern benutzt
    // (selectByCoord/nextHighest/updateDeps). Nur im api-Objekt zu stehen reicht nicht!
    function isOpen() { return !!(panel && panel.style.display !== 'none'); }

    function open() { ensureDom(); panel.style.display = 'block'; refresh(); }
    function close() { if (panel) panel.style.display = 'none'; }

    // Übernimmt die Deps des neu aufgebauten Builders (Canvases/Statuszeile).
    // Bei neuem Bild oder Format wird der Auswahlzustand zurückgesetzt.
    function updateDeps(newDeps = {}) {
        Object.assign(D, newDeps);
        const { w, h } = imageSize();
        const fmt = D.getFormat();
        if (w !== lastW || h !== lastH || fmt !== lastFormat) {
            lastW = w; lastH = h; lastFormat = fmt;
            currentPx = -1;
            ignored.clear();
            region = null;
            selecting = false;
            displayImageData = null;
            lastZoomApplied = null;
            lastValues = null;
            if (regionEl) regionEl.style.display = 'none';
            if (valuesEl) valuesEl.innerHTML = '';
        }
        if (isOpen()) refresh();
    }

    // Auswahl per Klick in der Hauptansicht (Bildkoordinaten)
    function selectByCoord(x, y) {
        const { w, h } = imageSize();
        if (!w || !h) return;
        const cx = Math.max(0, Math.min(w - 1, Math.round(x)));
        const cy = Math.max(0, Math.min(h - 1, Math.round(y)));
        const px = cy * w + cx;
        if (!isOpen()) open();
        if (!appState.errorViewData) {
            hint(`Pixel ${px} (X ${cx}, Y ${cy}) gewählt — noch kein Fehlerbild, bitte „2. Codieren“ drücken.`);
            return;
        }
        if (region && !inRegion(px)) {
            region = null;
            updateRegionOverlay();
            updateRegionInfo();
            rebuildLists();
            hint('Klick außerhalb des Ausschnitts — Ausschnitt aufgehoben.');
        }
        selectPixel(px);
    }

    // Nächstgrößten Fehler anspringen (öffnet das Fenster bei Bedarf)
    function nextHighest() {
        if (!isOpen()) open();
        if (!appState.errorViewData) { hint('Noch kein Fehlerbild — bitte „2. Codieren“ drücken.'); return; }
        navRank(+1);
    }

    function refresh() {
        ensureDom();
        if (thrInput) thrInput.value = String(displayThreshold);
        updateRegionInfo();
        rebuildLists();
        render();
        if (currentPx >= 0) renderValues();
    }

    const api = {
        open,
        close,
        refresh,
        selectByCoord,
        nextHighest,
        updateDeps,
        isOpen
    };
    singleton = api;
    return api;
}

// Fenster schließen (z. B. beim Verlassen des Builder-Modus)
export function closeErrorWindow() {
    if (singleton) singleton.close();
}
