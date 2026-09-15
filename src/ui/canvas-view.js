export const viewState = { mode: 'fit', customScale: null, panX: 0, panY: 0, startX: 0, startY: 0, panning: false };

export function getScaleFactor(mode, imgW, imgH, viewportElement) {
    // Freie Zoomstufe (z. B. vom Fehlerbild-Fenster synchronisiert)
    if (mode === 'custom' && viewState.customScale) return viewState.customScale;
    if (!viewportElement) return 1.0;
    if (mode === 'fit') {
        const vRect = viewportElement.getBoundingClientRect();
        if (vRect.width === 0) return 1.0;
        return Math.min((vRect.width - 20) / imgW, (vRect.height - 20) / imgH);
    }
    if (mode === '1x') return 1.0;
    if (mode === '2x') return 2.0;
    if (mode === '4x') return 4.0;
    if (mode === '8x') return 8.0;
    if (mode === '16x') return 16.0;
    if (mode === '32x') return 32.0;
    if (mode === '64x') return 64.0;
    return 64.0; // Fallback für unbekannte Modi
}

export function updateView(imgW, imgH) {
    if (!imgW || !imgH) return;
    const viewOriginal = document.getElementById('pane-left');
    const canvasOriginal = document.getElementById('canvas-original');
    const canvasDecoded = document.getElementById('canvas-decoded');
    
    if(!viewOriginal || !canvasOriginal || !canvasDecoded) return;

    const vRect = viewOriginal.getBoundingClientRect();
    let scale = getScaleFactor(viewState.mode, imgW, imgH, viewOriginal);
    const centerX = (vRect.width - (imgW * scale)) / 2;
    const centerY = (vRect.height - (imgH * scale)) / 2;

    const tStr = `translate(${centerX + viewState.panX}px, ${centerY + viewState.panY}px) scale(${scale})`;
    
    canvasOriginal.style.transformOrigin = '0 0';
    canvasDecoded.style.transformOrigin = '0 0';
    canvasOriginal.style.transform = tStr;
    canvasDecoded.style.transform = tStr;
}

export function setZoomMode(newMode, imgW, imgH) {
    if (!imgW || !imgH) return;
    const viewOriginal = document.getElementById('pane-left');
    if(!viewOriginal) return;
    
    document.querySelectorAll('.btn-zoom').forEach(b => b.classList.remove('active'));
    let activeBtn = document.getElementById(`btn-zoom-${newMode}`);
    if (activeBtn) activeBtn.classList.add('active');

    const vRect = viewOriginal.getBoundingClientRect();
    let oldScale = getScaleFactor(viewState.mode, imgW, imgH, viewOriginal);
    
    let centerX = (vRect.width / 2) - (vRect.width - (imgW * oldScale)) / 2 - viewState.panX;
    let centerY = (vRect.height / 2) - (vRect.height - (imgH * oldScale)) / 2 - viewState.panY;
    
    let imgCenterX = centerX / oldScale;
    let imgCenterY = centerY / oldScale;

    viewState.mode = newMode;
    let newScale = getScaleFactor(newMode, imgW, imgH, viewOriginal);

    if (newMode === 'fit') {
        viewState.panX = 0; viewState.panY = 0;
    } else {
        viewState.panX = (vRect.width / 2) - (vRect.width - (imgW * newScale)) / 2 - (imgCenterX * newScale);
        viewState.panY = (vRect.height / 2) - (vRect.height - (imgH * newScale)) / 2 - (imgCenterY * newScale);
    }
    updateView(imgW, imgH);
}

export function centerOnCoordinate(x, y, imgW, imgH) {
    let modal = document.getElementById('analysis-modal');
    if(modal) modal.style.display = 'none';
    setZoomMode('8x', imgW, imgH);

    const viewOriginal = document.getElementById('pane-left');
    if(!viewOriginal) return;
    const vRect = viewOriginal.getBoundingClientRect();

    viewState.panX = (vRect.width / 2) - (x * 8.0) - ((vRect.width - (imgW * 8.0)) / 2);
    viewState.panY = (vRect.height / 2) - (y * 8.0) - ((vRect.height - (imgH * 8.0)) / 2);
    updateView(imgW, imgH);
}

/**
 * Setzt eine freie Zoomstufe (nicht an die Zoom-Buttons gebunden) und zentriert
 * die Ansicht auf eine Bildkoordinate. Beide Panes (Original/Smart Target/
 * Fehlerbild links, Dekodiert rechts) benutzen dieselbe Transformation, wandern
 * also gemeinsam.
 *
 * Wird vom Fehlerbild-Fenster benutzt, damit Hauptansicht und Fenster dieselbe
 * Zoomstufe und denselben Bildausschnitt zeigen.
 */
export function setZoomScale(scale, imgW, imgH, centerX, centerY) {
    const viewOriginal = document.getElementById('pane-left');
    if (!viewOriginal || !imgW || !imgH || !scale || !Number.isFinite(scale)) return;

    viewState.mode = 'custom';
    viewState.customScale = scale;

    // Freie Stufe → keine der festen Zoom-Buttons ist aktiv
    document.querySelectorAll('.btn-zoom').forEach(b => b.classList.remove('active'));

    const vRect = viewOriginal.getBoundingClientRect();
    const cx = (centerX != null) ? centerX : imgW / 2;
    const cy = (centerY != null) ? centerY : imgH / 2;

    viewState.panX = (vRect.width / 2) - (cx * scale) - ((vRect.width - (imgW * scale)) / 2);
    viewState.panY = (vRect.height / 2) - (cy * scale) - ((vRect.height - (imgH * scale)) / 2);
    updateView(imgW, imgH);
}

/**
 * Maussteuerung der beiden Panes:
 *   * LINKSKLICK  → Pixel auswählen (onPixelPick(x, y), Bildkoordinaten)
 *   * RECHTE MAUSTASTE ziehen → Ansicht verschieben (Pan)
 *   * Mausposition/Statuszeile: wird für das Pane gerechnet, über dem der Zeiger steht
 *
 * Wichtig: Die window-Listener werden nur EINMAL registriert (der Builder wird bei
 * jedem Bild-/Formatwechsel neu aufgebaut). Die wechselnden Callbacks liegen in
 * Modul-Variablen, die bei jedem Aufruf aktualisiert werden.
 */
let _getDims = null;
let _getImageData = null;
let _onPixelPick = null;
let _panes = [];
let _eventsBound = false;
let _pickEnabled = true; // false, während z. B. die ROI-Auswahl aktiv ist

/** Pixel-Auswahl per Linksklick (de)aktivieren — z. B. während ROI-Zeichnen. */
export function setPickEnabled(v) { _pickEnabled = !!v; }

function paneAt(clientX, clientY) {
    for (const p of _panes) {
        const r = p.getBoundingClientRect();
        if (r.width > 0 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p;
    }
    return null;
}

function imageCoordsInPane(pane, clientX, clientY, dim) {
    const vRect = pane.getBoundingClientRect();
    const ref = document.getElementById('pane-left') || pane;
    const scale = getScaleFactor(viewState.mode, dim.w, dim.h, ref);
    const x = Math.floor((clientX - vRect.left - ((vRect.width - (dim.w * scale)) / 2) - viewState.panX) / scale);
    const y = Math.floor((clientY - vRect.top - ((vRect.height - (dim.h * scale)) / 2) - viewState.panY) / scale);
    return { x, y };
}

export function setupCanvasEvents(getDimensionsFn, getImageDataFn, onPixelPick) {
    _getDims = getDimensionsFn;
    _getImageData = getImageDataFn;
    _onPixelPick = typeof onPixelPick === 'function' ? onPixelPick : null;

    // Panes werden bei jedem Builder-Aufbau neu erzeugt → hier frisch binden
    _panes = ['pane-left', 'pane-right'].map(id => document.getElementById(id)).filter(Boolean);

    _panes.forEach(pane => {
        // Linke Taste: Pixel SOFORT auswählen (kein Klick-/Drag-Buchhalten nötig).
        // Rechte Taste: verschieben.
        pane.addEventListener('mousedown', e => {
            if (e.button === 2) {
                viewState.panning = true;
                viewState.startX = e.clientX - viewState.panX;
                viewState.startY = e.clientY - viewState.panY;
                pane.classList.add('panning');
                e.preventDefault();
                return;
            }
            if (e.button !== 0) return;

            const dim = _getDims ? _getDims() : null;
            const p = (dim && dim.w && dim.h) ? imageCoordsInPane(pane, e.clientX, e.clientY, dim) : null;

            // Immer sichtbare Rückmeldung — damit erkennbar ist, ob der Klick ankommt
            const st = document.getElementById('status-text');
            if (st && p) {
                const inside = p.x >= 0 && p.x < dim.w && p.y >= 0 && p.y < dim.h;
                st.innerText = inside
                    ? `Klick erkannt (${pane.id}): X ${p.x}, Y ${p.y}${(_pickEnabled && _onPixelPick) ? '' : ' — Auswahl ist deaktiviert'}`
                    : `Klick außerhalb des Bildes (${pane.id}): X ${p.x}, Y ${p.y}`;
            } else if (st) {
                st.innerText = `Klick erkannt (${pane.id}) — keine Bilddaten`;
            }

            if (!_pickEnabled || !_onPixelPick || !p) return;
            if (p.x >= 0 && p.x < dim.w && p.y >= 0 && p.y < dim.h) _onPixelPick(p.x, p.y);
        });
        pane.addEventListener('contextmenu', e => e.preventDefault());
    });

    if (_eventsBound) return;
    _eventsBound = true;

    window.addEventListener('mouseup', e => {
        if (viewState.panning) {
            viewState.panning = false;
            document.querySelectorAll('.view-pane.panning').forEach(el => el.classList.remove('panning'));
        }
    });

    window.addEventListener('mousemove', e => {
        const dim = _getDims ? _getDims() : null;
        if (!dim || !dim.w) return;

        // Koordinaten für das Pane rechnen, über dem der Zeiger steht
        const pane = paneAt(e.clientX, e.clientY);
        const mousePosText = document.getElementById('mouse-pos-text');
        let imgX = -1, imgY = -1;
        if (pane) {
            const p = imageCoordsInPane(pane, e.clientX, e.clientY, dim);
            imgX = p.x; imgY = p.y;
        }

        if (mousePosText) {
            if (imgX >= 0 && imgX < dim.w && imgY >= 0 && imgY < dim.h) {
                const px = imgY * dim.w + imgX;
                let text = `X: ${imgX} | Y: ${imgY} | Px: ${px}`;

                if (_getImageData) {
                    const data = _getImageData();
                    if (data && data.original) {
                        let idx = px * 4;
                        let r1 = data.original.data[idx];
                        let g1 = data.original.data[idx + 1];
                        let b1 = data.original.data[idx + 2];
                        let a1 = data.original.data[idx + 3];

                        text += ` | Orig: RGBA(${r1},${g1},${b1},${Math.round((a1/255)*100)}%)`;
                        if (data.decoded) {
                            let r2 = data.decoded.data[idx];
                            let g2 = data.decoded.data[idx + 1];
                            let b2 = data.decoded.data[idx + 2];
                            text += ` | Dec: RGB(${r2},${g2},${b2})`;
                        }
                        if (data.getCommandText) {
                            const cmdText = data.getCommandText(px);
                            if (cmdText) text += ` | ${cmdText}`;
                        }
                    }
                }
                mousePosText.innerText = text;
            } else {
                mousePosText.innerText = `X: - | Y: - | Px: -`;
            }
        }

        if (!viewState.panning) return;
        e.preventDefault();
        viewState.panX = e.clientX - viewState.startX;
        viewState.panY = e.clientY - viewState.startY;
        updateView(dim.w, dim.h);
    });
}