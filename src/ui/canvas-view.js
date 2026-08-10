// src/ui/canvas-view.js

export const viewState = { mode: 'fit', panX: 0, panY: 0, startX: 0, startY: 0, panning: false };

export function getScaleFactor(mode, imgW, imgH, viewportElement) {
    if (!viewportElement) return 1.0;
    if (mode === 'fit') {
        const vRect = viewportElement.getBoundingClientRect();
        if (vRect.width === 0) return 1.0;
        return Math.min(vRect.width / imgW, vRect.height / imgH) * 0.95;
    }
    if (mode === '1x') return 1.0;
    if (mode === '2x') return 2.0;
    if (mode === '4x') return 4.0;
    return 8.0;
}

export function updateView(imgW, imgH) {
    if (!imgW || !imgH) return;
    const viewOriginal = document.getElementById('wrapper-original');
    const canvasOriginal = document.getElementById('canvas-original');
    const canvasDecoded = document.getElementById('canvas-decoded');
    
    if(!viewOriginal || !canvasOriginal || !canvasDecoded) return;

    const vRect = viewOriginal.getBoundingClientRect();
    let scale = getScaleFactor(viewState.mode, imgW, imgH, viewOriginal);
    const centerX = (vRect.width - (imgW * scale)) / 2;
    const centerY = (vRect.height - (imgH * scale)) / 2;

    const tStr = `translate(${centerX + viewState.panX}px, ${centerY + viewState.panY}px) scale(${scale})`;
    canvasOriginal.style.transform = tStr;
    canvasDecoded.style.transform = tStr;
}

export function setZoomMode(newMode, imgW, imgH) {
    if (!imgW || !imgH) return;
    const viewOriginal = document.getElementById('wrapper-original');
    if(!viewOriginal) return;
    const vRect = viewOriginal.getBoundingClientRect();

    let oldScale = getScaleFactor(viewState.mode, imgW, imgH, viewOriginal);
    let centerX = (vRect.width / 2) - (vRect.width - (imgW * oldScale)) / 2 - viewState.panX;
    let centerY = (vRect.height / 2) - (vRect.height - (imgH * oldScale)) / 2 - viewState.panY;

    let imgCenterX = centerX / oldScale;
    let imgCenterY = centerY / oldScale;

    viewState.mode = newMode;

    // Aktualisiert Buttons nur, wenn sie im HTML existieren
    ['fit', '1x', '2x', '4x', '8x'].forEach(m => {
        let btn = document.getElementById(`btn-zoom-${m}`);
        if(btn) btn.classList.remove('active');
    });
    let activeBtn = document.getElementById(`btn-zoom-${newMode}`);
    if(activeBtn) activeBtn.classList.add('active');

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

    const viewOriginal = document.getElementById('wrapper-original');
    if(!viewOriginal) return;
    const vRect = viewOriginal.getBoundingClientRect();

    viewState.panX = (vRect.width / 2) - (x * 8.0) - ((vRect.width - (imgW * 8.0)) / 2);
    viewState.panY = (vRect.height / 2) - (y * 8.0) - ((vRect.height - (imgH * 8.0)) / 2);
    updateView(imgW, imgH);
}

export function redrawCanvasWithHighlight(originalData, decodedData, imgW, imgH, startPx, endPx, totalPixels) {
    if (!imgW || !originalData) return;
    const canvasOriginal = document.getElementById('canvas-original');
    const canvasDecoded = document.getElementById('canvas-decoded');
    if(!canvasOriginal || !canvasDecoded) return;

    const ctxOriginal = canvasOriginal.getContext('2d', { willReadFrequently: true });
    const ctxDecoded = canvasDecoded.getContext('2d', { willReadFrequently: true });

    ctxOriginal.putImageData(originalData, 0, 0);
    if (decodedData) ctxDecoded.putImageData(decodedData, 0, 0);
    else ctxDecoded.clearRect(0, 0, imgW, imgH);

    if(startPx >= totalPixels) return;

    let startY = Math.floor(startPx / imgW), startX = startPx % imgW;
    let endY = Math.floor(endPx / imgW), endX = endPx % imgW;

    function applyDimming(ctx) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        if (startY > 0) ctx.fillRect(0, 0, imgW, startY);
        if (startX > 0) ctx.fillRect(0, startY, startX, 1);
        if (endPx < totalPixels) {
            if (endX < imgW) ctx.fillRect(endX, endY, imgW - endX, 1);
            if (endY < imgH - 1) ctx.fillRect(0, endY + 1, imgW, imgH - endY - 1);
        }
    }
    applyDimming(ctxOriginal);
    if (decodedData) applyDimming(ctxDecoded);
}

export function setupCanvasEvents(getDimensionsFn) {
    const viewports = [document.getElementById('wrapper-original'), document.getElementById('wrapper-decoded')].filter(Boolean);
    const mousePosText = document.getElementById('mouse-pos-text'); // Darf null sein

    viewports.forEach(view => {
        view.addEventListener('mousedown', e => {
            const dim = getDimensionsFn();
            if(!dim.w) return;
            e.preventDefault();
            viewState.startX = e.clientX - viewState.panX;
            viewState.startY = e.clientY - viewState.panY;
            viewState.panning = true;
            view.style.cursor = 'grabbing';
        });
    });

    window.addEventListener('mouseup', () => {
        viewState.panning = false;
        viewports.forEach(view => view.style.cursor = '');
    });

    window.addEventListener('mousemove', e => {
        const dim = getDimensionsFn();
        if (!dim.w) return;

        if(viewports.length > 0 && mousePosText) {
            const vRect = viewports[0].getBoundingClientRect();
            let scale = getScaleFactor(viewState.mode, dim.w, dim.h, viewports[0]);
            let imgX = Math.floor((e.clientX - vRect.left - ((vRect.width - (dim.w * scale)) / 2) - viewState.panX) / scale);
            let imgY = Math.floor((e.clientY - vRect.top - ((vRect.height - (dim.h * scale)) / 2) - viewState.panY) / scale);

            if (imgX >= 0 && imgX < dim.w && imgY >= 0 && imgY < dim.h) {
                mousePosText.innerText = `X: ${imgX} | Y: ${imgY} | Px: ${imgY * dim.w + imgX}`;
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

    window.addEventListener('resize', () => {
        const dim = getDimensionsFn();
        if (dim.w) updateView(dim.w, dim.h);
    });
}