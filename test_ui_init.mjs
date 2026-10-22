// Smoke-Test für die Builder-Oberfläche: initialisiert den Modus gegen einen
// minimalen DOM-Stub und prüft, dass der Smart-Target-Bereich gefüllt wird
// (Phasen-Info für das gewählte Format + Hinweiszeile). Fängt Tippfehler in
// Element-IDs und Laufzeitfehler beim UI-Aufbau ab, ohne Browser.
//
// Aufruf: node test_ui_init.mjs [format]
import fs from 'node:fs';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
try { Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true }); } catch (e) {}

const source = fs.readFileSync('src/modes/ham_builder.js', 'utf8');
// Alle im Markup definierten IDs einsammeln (doppelt UND einfach angeführT)
const ids = new Set();
for (const m of source.matchAll(/id="([^"$]+)"/g)) ids.add(m[1]);
for (const m of source.matchAll(/id='([^'$]+)'/g)) ids.add(m[1]);

const ctxStub = new Proxy({}, {
    get: (t, k) => {
        if (k === 'canvas') return { width: 0, height: 0 };
        if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
        if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
        return () => {};
    }
});
function makeEl(id) {
    const el = {
        id, value: '', innerHTML: '', textContent: '', disabled: false, checked: false,
        style: new Proxy({}, { get: () => '', set: () => true }),
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        dataset: {},
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        removeChild() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
        addEventListener() {}, removeEventListener() {}, click() {}, focus() {}, blur() {},
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
        insertBefore() {}, contains: () => false, closest: () => null,
        getContext: () => ctxStub, toDataURL: () => '', width: 0, height: 0,
        parentElement: null, firstChild: null
    };
    return el;
}

const registry = new Map();
for (const id of ids) {
    const el = makeEl(id);
    // Sinnvolle Startwerte für die Felder, die der Code ausliest
    if (id === 'st-anchor-tol') el.value = '24';
    if (id === 'format') el.value = 'HAM_32BIT_63436343';
    if (id === 'pal-offset-input') el.value = '0';
    registry.set(id, el);
}

const documentStub = {
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('created-' + tag),
    addEventListener() {}, removeEventListener() {},
    body: makeEl('body'), documentElement: makeEl('html'),
    createElementNS: () => makeEl('ns')
};
globalThis.document = documentStub;
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
globalThis.alert = () => {};
globalThis.confirm = () => false;

const { initHamBuilderMode } = await import('./src/modes/ham_builder.js');

const fakePixels = new Uint8ClampedArray(8 * 8 * 4);
const appState = {
    currentFormat: (process.argv[2] || 'HAM_32BIT_63436343'), currentImgW: 8, currentImgH: 8,
    originalImageData: { width: 8, height: 8, data: fakePixels },
    modifiedImageData: null, decodedImageData: null,
    errorViewData: null, latestCommandArray: null, latestPackedData: null,
    globalPaletteRAM: new Uint8Array(768), commandSource: null, viewMode: 'original'
};

const container = makeEl('container');
try {
    initHamBuilderMode(appState, container);
    console.log('### initHamBuilderMode lief ohne Fehler durch');
} catch (err) {
    console.log('### FEHLER beim Initialisieren: ' + err.message);
    console.log(err.stack.split('\n').slice(0, 4).join('\n'));
    process.exit(1);
}

const thr = registry.get('st-threshold');
const tol = registry.get('st-anchor-tol');
const btn = registry.get('btn-modify-image');
const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
for (const [name, el] of [['Schwelle-Tooltip', thr], ['Anker-Tooltip', tol], ['Modifizieren-Tooltip', btn]]) {
    const t = el && el.title ? clean(el.title) : '';
    console.log(`### ${name}: ${t ? t : 'LEER → nicht gesetzt'}`);
}
const ok = [thr, tol, btn].every(el => el && el.title && el.title.length > 40);
process.exit(ok ? 0 : 1);
