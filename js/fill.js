import * as pdfjsLib from '../vendor/pdf.min.mjs';
import {
  emptyCells,
  headerCells,
  cellsInColumn,
  cellKey,
  insetBottomLeft,
  toBottomLeft,
  cellCssPercent,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  INSET,
  FILL_WHITE,
} from './grid.js';
import {
  loadSettings,
  saveInitials,
  saveColorIndex,
  saveLastColumnDateOnly,
  saveFieldTemplateId,
  saveZoomMode,
  stampDateString,
  todayShortGerman,
  todayStampDateYY,
  normalizeDateString,
  normalizeStampDateYY,
  colorCss,
  colorRgb01,
  DARK_COLORS,
  LAST_COLUMN_INDEX,
} from './settings.js';
import {
  KNOWN_TEMPLATES,
  resolveTemplateId,
  loadTemplate,
  fieldKey,
  stampDateForSettings,
  fieldsForPage,
} from './fields.js';
import {
  drawGeraetePage,
  embedFieldValuesInPdf,
  serializeFieldValues,
  parseFieldValuesFromKeywords,
  applyParsedFieldValues,
} from './field-fill.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const { PDFDocument, rgb, StandardFonts, LineCapStyle } = PDFLib;

const state = {
  settings: loadSettings(),
  pdfBytes: null,
  pdfDoc: null, // pdf.js doc
  fileName: 'Laufzettel.pdf',
  /** @type {FileSystemFileHandle|null} */
  fileHandle: null,
  /** @type {Map<string, {pageIndex:number,col:number,row:number,date:string,initials:string,colorIndex:number,fromFile?:boolean}>} */
  stamps: new Map(),
  /** Keys cleared this session (esp. fromFile) — white-out on save, omit from bgfill= */
  cleared: new Set(),
  /** Explicit white-cover (erase mode) — solid white on overlay + save; omit from bgfill= */
  whiteouts: new Set(),
  /** Document-only: tap applies/clears whiteout instead of stamps. Not localStorage. */
  eraseMode: false,
  rendering: false,
  /**
   * Freehand ink per page (Apple Pencil).
   * @type {Map<number, Array<{color:string,width:number,points:Array<{x:number,y:number}>}>>}
   */
  ink: new Map(),
  /** Page index of the last completed stroke (for undo). */
  lastInkPage: null,
  /** Chronological undo: ink strokes + stamp/whiteout cell changes. */
  undoStack: [],
  /** @type {{pageIndex:number,stroke:object,pointerId:number}|null} */
  activeInk: null,
  /** Geräte field template (null = legacy BG grid). */
  template: null,
  templateId: '',
  /** @type {Map<string, {page:number,number:number,id:string,type:string,text:string,colorIndex:number,rect_pt:number[]}>} */
  fieldValues: new Map(),
  pdfHeaderText: '',
};

const el = {
  home: document.getElementById('home'),
  fillMode: document.getElementById('fill-mode'),
  toolbar: document.getElementById('fill-toolbar'),
  viewer: document.getElementById('viewer'),
  fileInput: document.getElementById('file-input'),
  btnSave: document.getElementById('btn-save'),
  btnInkUndo: document.getElementById('btn-ink-undo'),
  btnClose: document.getElementById('btn-fill-close'),
  btnSettings: document.getElementById('btn-fill-settings'),
  stampSettingsCanvas: document.getElementById('fill-settings-stamp'),
  toast: document.getElementById('toast'),
  dialog: document.getElementById('fill-settings-dialog'),
  initials: document.getElementById('fill-settings-initials'),
  date: document.getElementById('fill-settings-date'),
  dateHint: document.getElementById('fill-settings-date-hint'),
  resetDate: document.getElementById('btn-fill-reset-date'),
  cycleColor: document.getElementById('btn-fill-cycle-color'),
  colorGrid: document.getElementById('fill-color-grid'),
  eraseMode: document.getElementById('fill-settings-erase-mode'),
  lastColDateOnly: document.getElementById('fill-settings-last-col-date-only'),
  settingsForm: document.getElementById('fill-settings-form'),
  fieldTemplate: document.getElementById('fill-settings-template'),
  zoom: document.getElementById('fill-settings-zoom'),
  fieldEntryDialog: document.getElementById('field-entry-dialog'),
  fieldEntryTitle: document.getElementById('field-entry-title'),
  fieldEntryInput: document.getElementById('field-entry-input'),
  fieldEntryHint: document.getElementById('field-entry-hint'),
  fieldEntryOk: document.getElementById('btn-field-entry-ok'),
  fieldEntryCancel: document.getElementById('btn-field-entry-cancel'),
};

let toastTimer = 0;

/** Ignore hit-cell clicks shortly after Apple Pencil activity (pen must never stamp). */
let suppressStampClickUntil = 0;

function markPenStampSuppress(ms = 900) {
  suppressStampClickUntil = Math.max(suppressStampClickUntil, performance.now() + ms);
}

function shouldIgnoreStampClick(e) {
  if (performance.now() < suppressStampClickUntil) return true;
  if (e && e.pointerType === 'pen') return true;
  return false;
}

function stampInitialsForColumn(col) {
  const dateOnly =
    !!state.settings.lastColumnDateOnly && Number(col) === LAST_COLUMN_INDEX;
  if (dateOnly) return '';
  return (state.settings.initials || '').trim();
}

function requiresInitialsForColumn(col) {
  return !(!!state.settings.lastColumnDateOnly && Number(col) === LAST_COLUMN_INDEX);
}

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3800);
}

function setDocumentUI(open) {
  // Home = generator + PDF öffnen; fill-mode = toolbar + viewer fullscreen
  el.home.classList.toggle('hidden', open);
  el.fillMode.classList.toggle('hidden', !open);
  document.body.classList.toggle('fill-open', open);
  el.btnSave.classList.toggle('hidden', !open);
  if (!open) {
    el.btnInkUndo.classList.add('hidden');
  } else {
    updateInkUndoButton();
  }
}

function inkStrokeCount() {
  let n = 0;
  for (const strokes of state.ink.values()) n += strokes.length;
  return n;
}

function updateInkUndoButton() {
  const show = !!state.pdfDoc && state.undoStack.length > 0;
  el.btnInkUndo.classList.toggle('hidden', !show);
}

function cloneStamp(stamp) {
  return stamp ? { ...stamp } : null;
}

function snapshotKeys(keys) {
  return keys.map((key) => ({
    key,
    stamp: state.stamps.has(key) ? cloneStamp(state.stamps.get(key)) : null,
    whiteout: state.whiteouts.has(key),
    cleared: state.cleared.has(key),
  }));
}

function restoreKeySnapshot(snap) {
  for (const s of snap) {
    if (s.stamp) state.stamps.set(s.key, cloneStamp(s.stamp));
    else state.stamps.delete(s.key);
    if (s.whiteout) state.whiteouts.add(s.key);
    else state.whiteouts.delete(s.key);
    if (s.cleared) state.cleared.add(s.key);
    else state.cleared.delete(s.key);
  }
}

function pushUndo(entry) {
  state.undoStack.push(entry);
  updateInkUndoButton();
}

function clearDocument() {
  state.pdfBytes = null;
  state.pdfDoc = null;
  state.fileHandle = null;
  state.stamps.clear();
  state.cleared.clear();
  state.whiteouts.clear();
  state.eraseMode = false;
  state.ink.clear();
  state.lastInkPage = null;
  state.activeInk = null;
  state.undoStack = [];
  state.settings.dateOverride = null;
  state.template = null;
  state.templateId = '';
  state.fieldValues.clear();
  state.pdfHeaderText = '';
  el.viewer.innerHTML = '';
  setDocumentUI(false);
}

function usesGeraeteFields() {
  return !!state.template;
}

function snapshotFieldKeys(keys) {
  return keys.map((key) => ({
    key,
    value: state.fieldValues.has(key) ? { ...state.fieldValues.get(key) } : null,
  }));
}

function restoreFieldSnapshot(snap) {
  for (const s of snap) {
    if (s.value) state.fieldValues.set(s.key, { ...s.value });
    else state.fieldValues.delete(s.key);
  }
}

async function extractPdfHeaderText(pdf) {
  try {
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    return (tc.items || []).map((it) => it.str || '').join(' ');
  } catch (_) {
    return '';
  }
}

async function resolveAndLoadTemplate(fileName, pdf) {
  state.pdfHeaderText = await extractPdfHeaderText(pdf);
  const id = resolveTemplateId({
    filename: fileName,
    pdfText: state.pdfHeaderText,
    settings: state.settings,
  });
  state.templateId = id;
  if (!id) {
    state.template = null;
    return;
  }
  try {
    state.template = await loadTemplate(id);
  } catch (err) {
    console.warn('template load failed', err);
    state.template = null;
  }
}

function getFieldApi() {
  return {
    template: state.template,
    fieldValues: state.fieldValues,
    settings: state.settings,
    showToast,
    openSettings,
    redrawPage,
    pushUndo,
    snapshotFieldKeys,
    restoreFieldSnapshot,
    promptFieldInput,
    shouldIgnoreStampClick,
    markPenStampSuppress,
    isPenPointer,
    pageScales,
    eraseMode: () => !!state.eraseMode,
  };
}

function parseFilledFromKeywords(keywords) {
  if (!keywords) return [];
  const str = Array.isArray(keywords) ? keywords.join(',') : String(keywords);
  const m = str.match(/bgfill=([0-9,\-\s]+)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {File} file
 * @param {FileSystemFileHandle|null} [fileHandle]
 */
export async function openFile(file, fileHandle = null) {
  try {
    const mod = await import('./app.js');
    if (typeof mod.ensureCamerasReleased === 'function') await mod.ensureCamerasReleased();
  } catch (_) {}

  if (!file) return;
  try {
    showToast('PDF wird geladen…');
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
    const pdf = await loadingTask.promise;

    state.pdfBytes = bytes;
    state.pdfDoc = pdf;
    state.fileName = file.name || 'Laufzettel.pdf';
    state.fileHandle = fileHandle || null;
    state.stamps.clear();
    state.cleared.clear();
    state.whiteouts.clear();
    state.eraseMode = false;
    state.ink.clear();
    state.lastInkPage = null;
    state.activeInk = null;
    state.undoStack = [];
    state.settings.dateOverride = null;
    state.fieldValues.clear();
    state.template = null;
    state.templateId = '';

    await resolveAndLoadTemplate(state.fileName, pdf);

    // Do NOT restore glfill/bgfill overlays on open. A partially filled PDF already
    // has stamps baked into the page — redrawing them causes double text. Treat the
    // file as untouched: only blue hit targets + new stamps from this session.
    state.fieldValues.clear();
    state.stamps.clear();

    setDocumentUI(true);
    // Wait for fill-mode layout so viewer width (and Pencil mapping) is correct.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await renderAllPages();
    showToast(`${pdf.numPages} Seite(n) geladen`);
  } catch (err) {
    console.error(err);
    clearDocument();
    showToast('PDF konnte nicht geöffnet werden.');
  }
}

async function getFolderStartIn() {
  try {
    const { getPdfFolderHandle } = await import('./catalog.js');
    const dir = await getPdfFolderHandle();
    if (!dir) return undefined;
    // Permission may already be granted from startup reindex / settings pick.
    if (dir.queryPermission) {
      const perm = await dir.queryPermission({ mode: 'read' });
      if (perm !== 'granted' && dir.requestPermission) {
        const next = await dir.requestPermission({ mode: 'read' });
        if (next !== 'granted') return undefined;
      }
    }
    return dir;
  } catch (_) {
    return undefined;
  }
}

export async function pickAndOpen() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const startIn = await getFolderStartIn();
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        ...(startIn ? { startIn } : {}),
        types: [
          {
            description: 'PDF',
            accept: { 'application/pdf': ['.pdf'] },
          },
        ],
      });
      // Prefer readwrite so Speichern can overwrite the same file.
      try {
        if (handle.requestPermission) {
          const perm = await handle.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted' && handle.queryPermission) {
            // Keep handle anyway; createWritable may re-prompt later.
          }
        }
      } catch (_) {
        /* permission APIs vary; keep handle */
      }
      const file = await handle.getFile();
      await openFile(file, handle);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('showOpenFilePicker failed, falling back to input', err);
    }
  }
  el.fileInput.click();
}

function pageSize(page) {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

/** Lager landscape table crop (pt, top-left). */
const LAGER_VIEW_CROP_FIT = [70.9, 42.6, 780.6, 551.3];
/**
 * Standard view: through Bauform (ends ~586), before Lieferant/ARROW (~593).
 * Hides Lieferant / Bestell-Nummer / VPE; keeps Differenz + Bauform.
 */
const LAGER_VIEW_CROP_COLS_HIDDEN = [70.9, 42.6, 589.5, 551.3];

/** First/last tap_row_cover y extents for a 0-based page, or null. */
function pageRowYExtents(pageIndex0) {
  const fields = fieldsForPage(state.template, pageIndex0) || [];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const f of fields) {
    if (!(f.type === 'tap_row_cover' || f.kind === 'row')) continue;
    const r = f.rect_pt;
    if (!Array.isArray(r) || r.length < 4) continue;
    y0 = Math.min(y0, Number(r[1]));
    y1 = Math.max(y1, Number(r[3]));
  }
  if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 <= y0) return null;
  return { y0, y1 };
}

/** Bottom of gebucht hit area (needed on the last page for the stamp). */
function pageGebuchtY1(pageIndex0) {
  const fields = fieldsForPage(state.template, pageIndex0) || [];
  const g = fields.find((f) => f.type === 'tap_gebucht');
  if (!g) return LAGER_VIEW_CROP_COLS_HIDDEN[3];
  const r = g.hit_rect_pt || g.rect_pt;
  if (!Array.isArray(r) || r.length < 4) return LAGER_VIEW_CROP_COLS_HIDDEN[3];
  return Math.max(Number(r[3]), LAGER_VIEW_CROP_COLS_HIDDEN[3]);
}

/**
 * Active view crop in PDF pts [x0,y0,x1,y1] (top-left origin), or null = full page.
 * zoomMode:
 *   cols-hidden (default) — hide Lieferant/Bestellnummer/VPE; keep Differenz+Bauform;
 *     multi-page: crop bottom after last table row; continuation pages crop top to
 *     first markable row; last page keeps footer for gebucht stamp
 *   fit — fit table to display (previous current crop)
 *   original — full page (previous version)
 */
function activeViewCropPt(pageWidth, pageHeight, pageIndex0 = 0) {
  const mode = state.settings?.zoomMode || 'cols-hidden';
  if (mode === 'original') return null;

  const raw = state.template?.view_crop_pt;
  let crop = null;
  if (mode === 'cols-hidden') {
    if (Array.isArray(raw) && raw.length === 4) {
      crop = raw.map(Number);
      // Keep left from template; force right edge after Bauform / before Lieferant.
      crop[2] = LAGER_VIEW_CROP_COLS_HIDDEN[2];
    } else {
      crop = LAGER_VIEW_CROP_COLS_HIDDEN.slice();
    }

    // Vertical tight crop (standard / cols-hidden only).
    const totalPages = state.pdfDoc?.numPages || 1;
    const isFirst = pageIndex0 <= 0;
    const isLast = pageIndex0 >= totalPages - 1;
    const ext = pageRowYExtents(pageIndex0);
    if (ext) {
      if (!isFirst) {
        // Continuation page: start at first markable cell (drop repeated header).
        crop[1] = ext.y0;
      }
      if (isLast) {
        // Last page: keep footer band for „gebucht am … von …“.
        crop[3] = Math.max(ext.y1, pageGebuchtY1(pageIndex0));
      } else {
        // Intermediate pages: cut just after the last table row.
        crop[3] = ext.y1;
      }
    }
  } else {
    // fit
    if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => Number.isFinite(Number(n)))) {
      crop = raw.map(Number);
    } else if (state.templateId === 'lager-stueckliste' || state.template?.id === 'lager-stueckliste') {
      crop = LAGER_VIEW_CROP_FIT.slice();
    }
  }
  if (!crop) return null;
  let [x0, y0, x1, y1] = crop;
  x0 = Math.max(0, Math.min(pageWidth, x0));
  x1 = Math.max(0, Math.min(pageWidth, x1));
  y0 = Math.max(0, Math.min(pageHeight, y0));
  y1 = Math.max(0, Math.min(pageHeight, y1));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return [x0, y0, x1, y1];
}

/** Tight page stacking in standard (cols-hidden) zoom so page breaks look seamless. */
function syncViewerSeamless() {
  const viewer = el.viewer || document.getElementById('viewer');
  if (!viewer) return;
  const seamless = (state.settings?.zoomMode || 'cols-hidden') === 'cols-hidden';
  viewer.classList.toggle('seamless-pages', seamless);
}

async function renderAllPages() {
  if (!state.pdfDoc || state.rendering) return;
  state.rendering = true;
  syncViewerSeamless();
  el.viewer.innerHTML = '';
  const pdf = state.pdfDoc;
  const scroller = document.getElementById('main-fill');
  // Never use window.innerWidth alone — on iPhone that is wider than the padded viewer
  // and causes Y stamp drift that grows toward the page bottom.
  let avail = el.viewer.clientWidth || 0;
  if (avail < 40) {
    avail = Math.max(0, (scroller?.clientWidth || window.innerWidth) - 8);
  }
  const maxCss = Math.min(Math.max(avail, 200), 1400);

  try {
    /** @type {HTMLElement[]} */
    const wraps = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { width: pw, height: ph } = pageSize(page);
      const crop = activeViewCropPt(pw, ph, i - 1);
      const contentW = crop ? crop[2] - crop[0] : pw;
      const contentH = crop ? crop[3] - crop[1] : ph;

      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.pageIndex = String(i - 1);
      wrap.dataset.pageWidth = String(pw);
      wrap.dataset.pageHeight = String(ph);
      if (crop) {
        wrap.dataset.cropX0 = String(crop[0]);
        wrap.dataset.cropY0 = String(crop[1]);
        wrap.dataset.cropX1 = String(crop[2]);
        wrap.dataset.cropY1 = String(crop[3]);
      }
      // Fill viewer width with cropped content box; height from content aspect-ratio.
      wrap.style.width = '100%';
      wrap.style.maxWidth = `${maxCss}px`;
      wrap.style.aspectRatio = `${contentW} / ${contentH}`;
      wrap.style.height = 'auto';
      wrap.style.overflow = 'hidden';

      const stage = document.createElement('div');
      stage.className = 'page-stage';
      // Full page size; positioned so crop box aligns to wrap (set after measure).
      stage.style.position = 'absolute';
      stage.style.left = '0';
      stage.style.top = '0';
      stage.style.width = '100%';
      stage.style.height = '100%';

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.style.width = '100%';
      canvas.style.height = '100%';

      const fieldsLayer = document.createElement('canvas');
      fieldsLayer.className = 'fields-layer';
      fieldsLayer.style.width = '100%';
      fieldsLayer.style.height = '100%';

      const overlay = document.createElement('canvas');
      overlay.className = 'overlay';
      overlay.style.width = '100%';
      overlay.style.height = '100%';

      const inkCanvas = document.createElement('canvas');
      inkCanvas.className = 'ink-canvas';
      inkCanvas.style.width = '100%';
      inkCanvas.style.height = '100%';

      const hit = document.createElement('div');
      hit.className = 'hit-layer';
      hit.style.width = '100%';
      hit.style.height = '100%';

      // z-order: PDF → field highlights → stamps/text/covers → pencil → hits
      // Layers live on the full-page stage; wrap clips to the crop box.
      stage.appendChild(canvas);
      stage.appendChild(fieldsLayer);
      stage.appendChild(overlay);
      stage.appendChild(inkCanvas);
      stage.appendChild(hit);
      wrap.appendChild(stage);
      el.viewer.appendChild(wrap);
      wraps.push(wrap);
      attachInkHandlers(wrap);
    }

    // Layout pass: measure real CSS box, then render PDF bits to that exact size.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (let i = 0; i < wraps.length; i++) {
      const wrap = wraps[i];
      const page = await pdf.getPage(i + 1);
      const pw = Number(wrap.dataset.pageWidth);
      const ph = Number(wrap.dataset.pageHeight);
      const crop = wrap.dataset.cropX0 != null
        ? [
            Number(wrap.dataset.cropX0),
            Number(wrap.dataset.cropY0),
            Number(wrap.dataset.cropX1),
            Number(wrap.dataset.cropY1),
          ]
        : null;
      const contentW = crop ? crop[2] - crop[0] : pw;
      const contentH = crop ? crop[3] - crop[1] : ph;
      const stage = wrap.querySelector('.page-stage');
      const canvas = wrap.querySelector('canvas.page-canvas');
      // Wrap = cropped content width; scale so table fills the viewer.
      const cssW = Math.max(1, wrap.clientWidth || maxCss);
      const scale = cssW / contentW;
      const cssH = contentH * scale;
      const stageW = pw * scale;
      const stageH = ph * scale;
      wrap.style.width = `${cssW}px`;
      wrap.style.height = `${cssH}px`;
      wrap.style.maxWidth = '';
      wrap.style.aspectRatio = '';
      if (stage) {
        stage.style.width = `${stageW}px`;
        stage.style.height = `${stageH}px`;
        if (crop) {
          stage.style.left = `${-crop[0] * scale}px`;
          stage.style.top = `${-crop[1] * scale}px`;
        } else {
          stage.style.left = '0';
          stage.style.top = '0';
        }
      }
      canvas.style.width = `${stageW}px`;
      canvas.style.height = `${stageH}px`;

      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;

      drawPageOverlay(wrap, pw, ph);
      drawInkCanvas(wrap, pw, ph);
    }
  } finally {
    state.rendering = false;
    updateInkUndoButton();
  }
}


/* ---------- Apple Pencil freehand ink ---------- */

const INK_BASE_CSS_PX = 2.0;
const INK_MIN_CSS_PX = 1.4;
const INK_MAX_CSS_PX = 2.8;

function isPenPointer(e) {
  if (e.pointerType === 'pen') return true;
  // Touch fallback (older iOS / incomplete pointer events): stylus touchType
  const lists = [];
  if (e.touches && e.touches.length) lists.push(e.touches);
  if (e.changedTouches && e.changedTouches.length) lists.push(e.changedTouches);
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].touchType === 'stylus') return true;
    }
  }
  return false;
}

function pageInk(pageIndex) {
  if (!state.ink.has(pageIndex)) state.ink.set(pageIndex, []);
  return state.ink.get(pageIndex);
}

/** Visible PDF page pixels — stamps/ink must use this, not the wrap box. */
function pageSurfaceRect(wrap) {
  const pageCanvas = wrap.querySelector('canvas.page-canvas');
  return (pageCanvas || wrap).getBoundingClientRect();
}

/** Separate X/Y scales from the laid-out page canvas (fixes iPhone Y drift). */
function pageScales(wrap, pageWidth, pageHeight) {
  const rect = pageSurfaceRect(wrap);
  const cssW = rect.width || wrap.clientWidth || pageWidth;
  const cssH = rect.height || wrap.clientHeight || cssW * (pageHeight / pageWidth);
  return {
    rect,
    cssW,
    cssH,
    scaleX: cssW / pageWidth,
    scaleY: cssH / pageHeight,
  };
}

function inkSurfaceRect(wrap) {
  return pageSurfaceRect(wrap);
}

function clientToPdfPoint(wrap, clientX, clientY) {
  const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
  const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
  const { rect, cssW, cssH } = pageScales(wrap, pw, ph);
  const x = ((clientX - rect.left) / cssW) * pw;
  const y = ((clientY - rect.top) / cssH) * ph;
  return {
    x: Math.max(0, Math.min(pw, x)),
    y: Math.max(0, Math.min(ph, y)),
  };
}

function pressureWidthPdf(wrap, pressure) {
  const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
  const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
  const { scaleX: scale } = pageScales(wrap, pw, ph);
  let cssPx = INK_BASE_CSS_PX;
  if (typeof pressure === 'number' && pressure > 0 && pressure < 1) {
    // Subtle variation around base (ignore 0 / 0.5 defaults loosely via range)
    const t = Math.max(0.15, Math.min(0.95, pressure));
    cssPx = INK_MIN_CSS_PX + (INK_MAX_CSS_PX - INK_MIN_CSS_PX) * t;
  }
  return cssPx / scale;
}

function currentInkColorCss() {
  return colorCss(state.settings.colorIndex);
}

function drawStrokePath(ctx, stroke, scaleX, scaleY = scaleX) {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  const scaleAvg = (scaleX + scaleY) / 2;
  ctx.strokeStyle = stroke.color || currentInkColorCss();
  ctx.lineWidth = Math.max(0.5, (stroke.width || 1.5) * scaleAvg);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x * scaleX, pts[0].y * scaleY);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x * scaleX, pts[i].y * scaleY);
  }
  if (pts.length === 1) {
    // Dot
    ctx.lineTo(pts[0].x * scaleX + 0.01, pts[0].y * scaleY);
  }
  ctx.stroke();
}

function drawInkCanvas(wrap, pageWidth, pageHeight) {
  const inkCanvas = wrap.querySelector('canvas.ink-canvas');
  if (!inkCanvas) return;
  const pageIndex = Number(wrap.dataset.pageIndex);
  syncLayerToPageCanvas(wrap, inkCanvas);
  const ctx = inkCanvas.getContext('2d');
  const { cssW, cssH, scaleX, scaleY } = pageScales(wrap, pageWidth, pageHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const needW = Math.max(1, Math.round(cssW * dpr));
  const needH = Math.max(1, Math.round(cssH * dpr));
  if (inkCanvas.width !== needW || inkCanvas.height !== needH) {
    inkCanvas.width = needW;
    inkCanvas.height = needH;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const strokes = state.ink.get(pageIndex) || [];
  for (const stroke of strokes) drawStrokePath(ctx, stroke, scaleX, scaleY);

  if (state.activeInk && state.activeInk.pageIndex === pageIndex) {
    drawStrokePath(ctx, state.activeInk.stroke, scaleX, scaleY);
  }
}

function redrawInkPage(pageIndex) {
  const wrap = el.viewer.querySelector(`.page-wrap[data-page-index="${pageIndex}"]`);
  if (!wrap) return;
  const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
  const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
  drawInkCanvas(wrap, pw, ph);
}

function finishActiveInk(commit) {
  const active = state.activeInk;
  if (!active) return;
  const wrap = el.viewer.querySelector(`.page-wrap[data-page-index="${active.pageIndex}"]`);
  if (wrap) wrap.classList.remove('inking');
  setPenScrollLock(false);
  if (commit && active.stroke.points.length > 0) {
    pageInk(active.pageIndex).push(active.stroke);
    state.lastInkPage = active.pageIndex;
    pushUndo({ kind: 'ink', pageIndex: active.pageIndex });
  }
  state.activeInk = null;
  if (wrap) {
    const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
    const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
    drawInkCanvas(wrap, pw, ph);
  }
  updateInkUndoButton();
}


function bindFillWheelScroll() {
  const scroller = document.getElementById('main-fill');
  if (!scroller || scroller.dataset.wheelBound === '1') return;
  scroller.dataset.wheelBound = '1';
  // Windows Chrome / installed PWA: wheel over hit-cells or canvas often never
  // reaches the flex scrollport — normalize delta and scroll #main-fill manually.
  const onWheel = (e) => {
    if (!document.body.classList.contains('fill-open')) return;
    if (scroller.dataset.scrollLocked === '1') return;
    if (e.ctrlKey) return; // allow pinch-zoom
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // lines → px
    else if (e.deltaMode === 2) dy *= scroller.clientHeight || 1; // pages
    if (!dy && e.deltaX) return; // ignore pure horizontal
    const prev = scroller.scrollTop;
    scroller.scrollTop = prev + dy;
    if (scroller.scrollTop !== prev) {
      e.preventDefault();
    }
  };
  // Capture on fill shell only (once) so hit-cells/canvas still scroll on Windows.
  const shell = document.getElementById('fill-mode') || scroller;
  shell.addEventListener('wheel', onWheel, { passive: false, capture: true });
}

function setPenScrollLock(on) {
  const scroller = document.getElementById('main-fill');
  if (!scroller) return;
  if (on) {
    if (scroller.dataset.scrollLocked === '1') return;
    scroller.dataset.scrollLocked = '1';
    scroller.dataset.lockedScrollTop = String(scroller.scrollTop || 0);
    scroller.style.overflow = 'hidden';
    document.body.classList.add('pen-drawing');
  } else {
    if (scroller.dataset.scrollLocked !== '1') return;
    const top = Number(scroller.dataset.lockedScrollTop || 0);
    scroller.style.overflow = '';
    scroller.scrollTop = top;
    delete scroller.dataset.scrollLocked;
    delete scroller.dataset.lockedScrollTop;
    document.body.classList.remove('pen-drawing');
  }
}

function attachInkHandlers(wrap) {
  if (wrap.dataset.inkBound === '1') return;
  wrap.dataset.inkBound = '1';

  const onDown = (e) => {
    if (!isPenPointer(e)) return;
    // Pen must not stamp / header-hit.
    markPenStampSuppress();
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    const pageIndex = Number(wrap.dataset.pageIndex);
    const pt = clientToPdfPoint(wrap, e.clientX, e.clientY);
    const width = pressureWidthPdf(wrap, e.pressure);
    state.activeInk = {
      pageIndex,
      pointerId: e.pointerId,
      stroke: {
        color: currentInkColorCss(),
        width,
        points: [pt],
      },
    };
    wrap.classList.add('inking');
    setPenScrollLock(true);
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    redrawInkPage(pageIndex);
  };

  const onMove = (e) => {
    const active = state.activeInk;
    if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
    if (active.pointerId != null && e.pointerId != null && e.pointerId !== active.pointerId) return;
    if (!isPenPointer(e) && e.pointerType && e.pointerType !== 'pen') return;
    e.preventDefault();
    e.stopPropagation();
    const pt = clientToPdfPoint(wrap, e.clientX, e.clientY);
    const pts = active.stroke.points;
    const last = pts[pts.length - 1];
    // Skip tiny jitter
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.35) return;
    // Optional: update width subtly from pressure (keep first width as base; blend)
    if (typeof e.pressure === 'number' && e.pressure > 0 && e.pressure < 1) {
      const w = pressureWidthPdf(wrap, e.pressure);
      active.stroke.width = active.stroke.width * 0.85 + w * 0.15;
    }
    pts.push(pt);
    redrawInkPage(active.pageIndex);
  };

  const onUp = (e) => {
    const active = state.activeInk;
    if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
    if (active.pointerId != null && e.pointerId != null && e.pointerId !== active.pointerId) return;
    markPenStampSuppress();
    e.preventDefault();
    e.stopPropagation();
    try {
      wrap.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    finishActiveInk(true);
  };

  const onCancel = (e) => {
    const active = state.activeInk;
    if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
    finishActiveInk(false);
  };

  // Capture phase so pen never reaches hit-layer cell buttons.
  wrap.addEventListener('pointerdown', onDown, { capture: true, passive: false });
  wrap.addEventListener('pointermove', onMove, { capture: true, passive: false });
  wrap.addEventListener('pointerup', onUp, { capture: true, passive: false });
  wrap.addEventListener('pointercancel', onCancel, { capture: true, passive: false });

  // Touch fallback ONLY when PointerEvent is unavailable (avoids double strokes /
  // early touchend finishing the same Pencil stroke already handled by pointer*).
  if (!('PointerEvent' in window)) {
    wrap.addEventListener(
      'touchstart',
      (e) => {
        if (!isPenPointer(e)) return;
        markPenStampSuppress();
        e.preventDefault();
        e.stopPropagation();
        const t = e.changedTouches[0];
        if (!t) return;
        const pageIndex = Number(wrap.dataset.pageIndex);
        const pt = clientToPdfPoint(wrap, t.clientX, t.clientY);
        state.activeInk = {
          pageIndex,
          pointerId: t.identifier,
          stroke: {
            color: currentInkColorCss(),
            width: pressureWidthPdf(wrap, t.force || 0.5),
            points: [pt],
          },
        };
        wrap.classList.add('inking');
        redrawInkPage(pageIndex);
      },
      { capture: true, passive: false }
    );

    wrap.addEventListener(
      'touchmove',
      (e) => {
        const active = state.activeInk;
        if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
        if (!isPenPointer(e) && !(active && wrap.classList.contains('inking'))) return;
        e.preventDefault();
        e.stopPropagation();
        const t = [...e.changedTouches].find((x) => x.identifier === active.pointerId) || e.changedTouches[0];
        if (!t) return;
        const pt = clientToPdfPoint(wrap, t.clientX, t.clientY);
        const pts = active.stroke.points;
        const last = pts[pts.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.35) return;
        pts.push(pt);
        redrawInkPage(active.pageIndex);
      },
      { capture: true, passive: false }
    );

    const touchEnd = (e) => {
      const active = state.activeInk;
      if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
      e.preventDefault();
      e.stopPropagation();
      finishActiveInk(true);
    };
    wrap.addEventListener('touchend', touchEnd, { capture: true, passive: false });
    wrap.addEventListener('touchcancel', (e) => {
      const active = state.activeInk;
      if (!active || active.pageIndex !== Number(wrap.dataset.pageIndex)) return;
      finishActiveInk(false);
    }, { capture: true, passive: false });
  }
}

function undoLastAction() {
  const entry = state.undoStack.pop();
  if (!entry) {
    updateInkUndoButton();
    return;
  }
  if (entry.kind === 'ink') {
    const strokes = state.ink.get(entry.pageIndex);
    if (strokes && strokes.length) {
      strokes.pop();
      if (!strokes.length) state.ink.delete(entry.pageIndex);
    }
    state.lastInkPage = entry.pageIndex;
    redrawInkPage(entry.pageIndex);
  } else if (entry.kind === 'cells') {
    restoreKeySnapshot(entry.before);
    redrawPage(entry.pageIndex);
  } else if (entry.kind === 'fields') {
    restoreFieldSnapshot(entry.before);
    redrawPage(entry.pageIndex);
  }
  updateInkUndoButton();
}

/** @deprecated name kept for older call sites */
function undoLastInkStroke() {
  undoLastAction();
}

/**
 * Draw ink strokes into a pdf-lib page (PDF bottom-left coords).
 */
function drawInkStrokesOnPdfPage(page, pageHeight, strokes) {
  if (!strokes || !strokes.length) return;
  const cap = LineCapStyle ? LineCapStyle.Round : 1;
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts || !pts.length) continue;
    const c = stroke.color || currentInkColorCss();
    let r = 0.08;
    let g = 0.2;
    let b = 0.55;
    const m = String(c).match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (m) {
      r = Number(m[1]) / 255;
      g = Number(m[2]) / 255;
      b = Number(m[3]) / 255;
    } else {
      const col = colorRgb01(state.settings.colorIndex);
      r = col.r;
      g = col.g;
      b = col.b;
    }
    const thickness = Math.max(0.6, stroke.width || 1.5);
    const color = rgb(r, g, b);

    // pdf-lib drawSvgPath: SVG y-down; place origin at page top-left (y=pageHeight).
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      d += (i === 0 ? `M ${pts[i].x} ${pts[i].y}` : ` L ${pts[i].x} ${pts[i].y}`);
    }
    if (pts.length === 1) {
      d = `M ${pts[0].x} ${pts[0].y} L ${pts[0].x + 0.01} ${pts[0].y}`;
    }
    try {
      page.drawSvgPath(d, {
        x: 0,
        y: pageHeight,
        borderColor: color,
        borderWidth: thickness,
        borderLineCap: cap,
      });
    } catch (err) {
      console.warn('drawSvgPath failed, using drawLine', err);
      const toBl = (pt) => ({ x: pt.x, y: pageHeight - pt.y });
      if (pts.length === 1) {
        const bl = toBl(pts[0]);
        page.drawLine({
          start: bl,
          end: { x: bl.x + 0.01, y: bl.y },
          thickness,
          color,
          lineCap: cap,
        });
      } else {
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({
            start: toBl(pts[i - 1]),
            end: toBl(pts[i]),
            thickness,
            color,
            lineCap: cap,
          });
        }
      }
    }
  }
}

function syncLayerToPageCanvas(wrap, elLayer) {
  const pageCanvas = wrap.querySelector('canvas.page-canvas');
  if (!pageCanvas || !elLayer) return null;
  // Match the rendered PDF page box exactly (wrap can differ with max-width/aspect drift).
  elLayer.style.left = `${pageCanvas.offsetLeft}px`;
  elLayer.style.top = `${pageCanvas.offsetTop}px`;
  elLayer.style.width = `${pageCanvas.offsetWidth}px`;
  elLayer.style.height = `${pageCanvas.offsetHeight}px`;
  elLayer.style.right = 'auto';
  elLayer.style.bottom = 'auto';
  return pageCanvas;
}

function drawPageOverlay(wrap, pageWidth, pageHeight) {
  if (usesGeraeteFields()) {
    drawGeraetePage(wrap, pageWidth, pageHeight, getFieldApi());
    return;
  }
  const pageIndex = Number(wrap.dataset.pageIndex);
  const overlay = wrap.querySelector('canvas.overlay');
  const hit = wrap.querySelector('.hit-layer');
  const inkCanvas = wrap.querySelector('canvas.ink-canvas');
  const fieldsLayer = wrap.querySelector('canvas.fields-layer');
  if (fieldsLayer) {
    const fctx = fieldsLayer.getContext('2d');
    fctx && fctx.clearRect(0, 0, fieldsLayer.width, fieldsLayer.height);
  }
  const pageCanvas = syncLayerToPageCanvas(wrap, overlay);
  syncLayerToPageCanvas(wrap, hit);
  syncLayerToPageCanvas(wrap, inkCanvas);
  const ctx = overlay.getContext('2d');
  const { cssW, cssH, scaleX, scaleY } = pageScales(wrap, pageWidth, pageHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const needW = Math.max(1, Math.round(cssW * dpr));
  const needH = Math.max(1, Math.round(cssH * dpr));
  if (overlay.width !== needW || overlay.height !== needH) {
    overlay.width = needW;
    overlay.height = needH;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  hit.innerHTML = '';

  for (const cell of emptyCells) {
    const key = cellKey(pageIndex, cell.col, cell.row);
    const stamp = state.stamps.get(key);
    const isWhiteout = state.whiteouts.has(key);

    if (isWhiteout) {
      drawWhiteoutPreview(ctx, cell, scaleX, scaleY);
    } else if (stamp) {
      if (!stamp.fromFile || stamp.date) {
        drawStampPreview(ctx, cell, stamp, scaleX, scaleY);
      }
    }
    // Empty cells: no visible outline — hit targets stay invisible.

    // Hit targets on empty AND filled cells (second tap clears; eraseMode → whiteout).
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = stamp || isWhiteout ? 'hit-cell filled' : 'hit-cell';
    btn.setAttribute(
      'aria-label',
      isWhiteout
        ? `Zelle Spalte ${cell.col} Zeile ${cell.row} Weißabdeckung`
        : stamp
          ? `Zelle Spalte ${cell.col} Zeile ${cell.row} leeren`
          : `Zelle Spalte ${cell.col} Zeile ${cell.row}`
    );
    const pct = cellCssPercent(cell, pageWidth, pageHeight);
    btn.style.left = `${pct.left}%`;
    btn.style.top = `${pct.top}%`;
    btn.style.width = `${pct.width}%`;
    btn.style.height = `${pct.height}%`;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen' || isPenPointer(e)) {
        markPenStampSuppress();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    btn.addEventListener('click', (e) => {
      if (shouldIgnoreStampClick(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onCellTap(pageIndex, cell);
    });
    hit.appendChild(btn);
  }

  // Column header band — stamp / clear entire process column (10 cells).
  // In eraseMode: white-cover / clear whiteouts for the column.
  for (const header of headerCells) {
    const colCells = cellsInColumn(header.col);
    let headerActive;
    let ariaLabel;
    if (state.eraseMode) {
      headerActive = colCells.every((c) => state.whiteouts.has(cellKey(pageIndex, c.col, c.row)));
      ariaLabel = headerActive
        ? `Spalte ${header.col} Weißabdeckung entfernen`
        : `Spalte ${header.col} weiß überdecken`;
    } else {
      headerActive = colCells.every((c) => state.stamps.has(cellKey(pageIndex, c.col, c.row)));
      ariaLabel = headerActive
        ? `Spalte ${header.col} leeren`
        : `Spalte ${header.col} stempeln`;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = headerActive ? 'hit-cell hit-header filled' : 'hit-cell hit-header';
    btn.setAttribute('aria-label', ariaLabel);
    const pct = cellCssPercent(header, pageWidth, pageHeight);
    btn.style.left = `${pct.left}%`;
    btn.style.top = `${pct.top}%`;
    btn.style.width = `${pct.width}%`;
    btn.style.height = `${pct.height}%`;
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen' || isPenPointer(e)) {
        markPenStampSuppress();
        e.preventDefault();
        e.stopPropagation();
      }
    });
    btn.addEventListener('click', (e) => {
      if (shouldIgnoreStampClick(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onHeaderTap(pageIndex, header.col);
    });
    hit.appendChild(btn);
  }
}

/**
 * Stamp layout inside an inset rect (shared for canvas + PDF fallback).
 * PDF space: origin bottom-left, higher y = up.
 * Centers the whole block (date + gap + boxed initials) in the white inset;
 * initials + stroke box are the visual focus (larger font + padding).
 */
function computeStampLayout(inset, dateStr, initials, measure) {
  const { x, y, width: w, height: h } = inset;
  const top = y + h; // PDF: top edge
  const cx = x + w / 2;
  const margin = Math.max(1.8, Math.min(3.5, h * 0.08));
  const hasInitials = !!(initials && String(initials).trim());

  // Date-only: keep date at the SAME Y as a normal stamp (placeholder
  // initials only for geometry). Lower area stays free for Pencil signature.
  if (!hasInitials) {
    const layout = computeStampLayout(inset, dateStr, 'DK', measure);
    return {
      dateSize: layout.dateSize,
      initSize: 0,
      dateBaseline: layout.dateBaseline,
      initBaseline: layout.initBaseline,
      dateWidth: layout.dateWidth,
      initWidth: 0,
      box: null,
      cx: layout.cx,
      dateOnly: true,
    };
  }

  // Keep stamp graphic clear of cell grid lines (esp. iPad retina).
  let initSize = Math.min(13.5, Math.max(10, h * 0.34));
  const maxTextW = Math.max(4, w - 6);
  while (initSize > 7 && measure(initials, initSize, true) > maxTextW - 8) initSize -= 0.25;

  let initWidth = measure(initials, initSize, true);

  // Roomier colored stroke box around initials.
  let boxPadX = Math.max(3.2, initSize * 0.28);
  let boxPadY = Math.max(2.5, initSize * 0.22);
  let boxW = initWidth + boxPadX * 2;
  let boxH = initSize + boxPadY * 2;

  // Fit box to inset width if needed.
  if (boxW > w - margin * 2) {
    boxW = Math.max(4, w - margin * 2);
    boxPadX = Math.max(1.5, (boxW - initWidth) / 2);
  }

  // Date: grow so measured width ≈ 85–95% of initials box (minus small pad).
  const dateTargetW = Math.min(maxTextW, Math.max(4, boxW * 0.9));
  const dateMaxW = Math.min(maxTextW, Math.max(4, boxW - 1.2));
  let dateSize = Math.min(12, Math.max(7, h * 0.24));
  let dateWidth = measure(dateStr, dateSize, false) || 1;
  dateSize = Math.min(13.5, Math.max(5.5, dateSize * (dateTargetW / dateWidth)));
  dateWidth = measure(dateStr, dateSize, false);
  let guard = 0;
  while (dateSize > 5 && dateWidth > dateMaxW && guard++ < 40) {
    dateSize -= 0.2;
    dateWidth = measure(dateStr, dateSize, false);
  }
  guard = 0;
  while (dateSize < 13.5 && dateWidth < boxW * 0.85 && guard++ < 40) {
    dateSize += 0.2;
    dateWidth = measure(dateStr, dateSize, false);
    if (dateWidth > dateMaxW) {
      dateSize -= 0.2;
      dateWidth = measure(dateStr, dateSize, false);
      break;
    }
  }

  let gap = Math.max(2.2, Math.min(4, h * 0.07));
  let dateVisualH = dateSize * 0.82;
  let blockH = dateVisualH + gap + boxH;

  // Prefer shrinking gap (then date slightly) over touching initials/box.
  guard = 0;
  while (blockH > h - margin * 2 && gap > 1.2 && guard++ < 20) {
    gap -= 0.15;
    blockH = dateVisualH + gap + boxH;
  }
  guard = 0;
  while (blockH > h - margin * 2 && dateSize > 7 && guard++ < 30) {
    dateSize -= 0.25;
    dateWidth = measure(dateStr, dateSize, false);
    dateVisualH = dateSize * 0.82;
    blockH = dateVisualH + gap + boxH;
  }
  // Last resort only: shrink initials/box (same as older versions).
  guard = 0;
  while (blockH > h - margin * 2 && initSize > 7.5 && guard++ < 40) {
    initSize -= 0.35;
    initWidth = measure(initials, initSize, true);
    boxPadX = Math.max(3.2, initSize * 0.3);
    boxPadY = Math.max(2.6, initSize * 0.24);
    boxW = Math.min(w - margin * 2, initWidth + boxPadX * 2);
    boxH = initSize + boxPadY * 2;
    blockH = dateVisualH + gap + boxH;
  }
  if (blockH > h - margin * 2) {
    blockH = h - margin * 2;
  }

  // Vertically center the whole block as a group.
  const blockBottom = y + Math.max(margin, (h - blockH) / 2);
  const blockTop = blockBottom + blockH;

  // Date near top of block (cap height ≈ 0.72 * size above baseline).
  const dateBaseline = blockTop - dateSize * 0.72;

  // Box below date + gap.
  const boxTop = blockTop - dateVisualH - gap;
  let boxY = boxTop - boxH;
  if (boxY < y + margin * 0.5) boxY = y + margin * 0.5;
  if (boxY + boxH > top - margin * 0.5) boxY = top - margin * 0.5 - boxH;

  // Optically center bold capitals inside the box.
  // Visual mid of caps ≈ baseline + size * 0.35.
  const initBaseline = boxY + boxH / 2 - initSize * 0.35;

  return {
    dateSize,
    initSize,
    dateBaseline,
    initBaseline,
    dateWidth,
    initWidth,
    box: {
      x: x + (w - boxW) / 2,
      y: boxY,
      width: boxW,
      height: boxH,
    },
    cx,
    dateOnly: false,
  };
}

/**
 * Draw stamp into a canvas inset rect (top-left origin). Same look for overlay + PDF PNG.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{date:string,initials:string,colorIndex:number,fromFile?:boolean}} stamp
 * @param {number} ix
 * @param {number} iy
 * @param {number} iw inset width in ctx units
 * @param {number} ih inset height in ctx units
 * @param {number} [lineScale=1] scales stroke width (usually 1 in PDF-pt space)
 */
function drawStampOnCanvas(ctx, stamp, ix, iy, iw, ih, lineScale = 1) {
  // 1) White inset fill
  ctx.fillStyle = `rgb(${FILL_WHITE.r},${FILL_WHITE.g},${FILL_WHITE.b})`;
  ctx.fillRect(ix, iy, iw, ih);

  if (stamp.fromFile && !stamp.date) return;
  if (!stamp.date && !stamp.initials) return;

  const color = colorCss(stamp.colorIndex);
  // Canvas: top-left origin, +y down. Map PDF layout ( +y up ) onto the inset.
  const insetPdf = { x: 0, y: 0, width: iw, height: ih };
  const measure = (text, size, bold) => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    return ctx.measureText(text).width;
  };
  const layout = computeStampLayout(insetPdf, stamp.date, stamp.initials, measure);

  const pdfToCanvasY = (pdfY) => iy + ih - pdfY; // PDF y=0 at bottom of inset

  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const cx = ix + iw / 2;

  // 2) Date dd.MM. near TOP — not bold; sized ~box width in layout
  ctx.font = `${layout.dateSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillText(stamp.date, cx, pdfToCanvasY(layout.dateBaseline), Math.max(0, iw - 4));

  if (layout.dateOnly || !layout.box || !stamp.initials) return;

  // 4) Colored stroke box only around initials
  const box = layout.box;
  const boxTop = pdfToCanvasY(box.y + box.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.9 * lineScale, 1);
  ctx.strokeRect(ix + box.x, boxTop, box.width, box.height);

  // 3) Initials below — BOLD larger, centered
  ctx.font = `bold ${layout.initSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.fillText(stamp.initials, cx, pdfToCanvasY(layout.initBaseline), Math.max(0, iw - 4));
}

function drawWhiteoutPreview(ctx, cell, scaleX, scaleY = scaleX) {
  const ix = (cell.x0 + INSET) * scaleX;
  const iy = (cell.y0 + INSET) * scaleY;
  const iw = (cell.x1 - cell.x0 - INSET * 2) * scaleX;
  const ih = (cell.y1 - cell.y0 - INSET * 2) * scaleY;
  ctx.fillStyle = `rgb(${FILL_WHITE.r},${FILL_WHITE.g},${FILL_WHITE.b})`;
  ctx.fillRect(ix, iy, iw, ih);
}

function drawStampPreview(ctx, cell, stamp, scaleX, scaleY = scaleX) {
  // Layout in PDF-point inset space (same as export raster), then blit to CSS pixels.
  // Do NOT feed scaled CSS sizes into computeStampLayout — font caps are in PDF pts.
  const insetW = cell.x1 - cell.x0 - INSET * 2;
  const insetH = cell.y1 - cell.y0 - INSET * 2;
  const ix = (cell.x0 + INSET) * scaleX;
  const iy = (cell.y0 + INSET) * scaleY;
  const iw = insetW * scaleX;
  const ih = insetH * scaleY;

  const ras = STAMP_RASTER_SCALE;
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.ceil(insetW * ras));
  off.height = Math.max(1, Math.ceil(insetH * ras));
  const octx = off.getContext('2d');
  if (!octx) return;
  octx.setTransform(ras, 0, 0, ras, 0, 0);
  drawStampOnCanvas(octx, stamp, 0, 0, insetW, insetH, 1);
  ctx.drawImage(off, ix, iy, iw, ih);
}

const STAMP_RASTER_SCALE = 4;

/**
 * Rasterize the same preview drawing to PNG bytes for pdf-lib embedPng.
 * @returns {Promise<Uint8Array|null>}
 */
function rasterizeStampPng(stamp, insetWidth, insetHeight) {
  const w = Math.max(1, Math.ceil(insetWidth * STAMP_RASTER_SCALE));
  const h = Math.max(1, Math.ceil(insetHeight * STAMP_RASTER_SCALE));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.setTransform(STAMP_RASTER_SCALE, 0, 0, STAMP_RASTER_SCALE, 0, 0);
  drawStampOnCanvas(ctx, stamp, 0, 0, insetWidth, insetHeight, 1);
  return new Promise((resolve) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      },
      'image/png'
    );
  });
}

function onCellTap(pageIndex, cell) {
  const key = cellKey(pageIndex, cell.col, cell.row);
  const before = snapshotKeys([key]);

  // Erase mode: toggle whiteout only — never place date/initials stamps.
  if (state.eraseMode) {
    if (state.whiteouts.has(key)) {
      state.whiteouts.delete(key);
    } else {
      if (state.stamps.has(key)) state.stamps.delete(key);
      state.cleared.delete(key);
      state.whiteouts.add(key);
    }
    pushUndo({ kind: 'cells', pageIndex, before });
    redrawPage(pageIndex);
    return;
  }

  // Normal: whiteout cell → remove cover then stamp as usual below.
  if (state.whiteouts.has(key) && !state.stamps.has(key)) {
    state.whiteouts.delete(key);
  }

  if (state.stamps.has(key)) {
    const stamp = state.stamps.get(key);
    state.stamps.delete(key);
    state.whiteouts.delete(key);
    // fromFile (baked PDF ink / keyword): track for white-out + omit from bgfill=
    if (stamp.fromFile) {
      state.cleared.add(key);
    }
    pushUndo({ kind: 'cells', pageIndex, before });
    redrawPage(pageIndex);
    return;
  }

  const initials = stampInitialsForColumn(cell.col);
  if (requiresInitialsForColumn(cell.col) && !initials) {
    showToast('Bitte Initialen in den Einstellungen setzen.');
    openSettings();
    return;
  }

  state.cleared.delete(key);
  state.whiteouts.delete(key);
  state.stamps.set(key, {
    pageIndex,
    col: cell.col,
    row: cell.row,
    date: stampDateString(state.settings),
    initials,
    colorIndex: state.settings.colorIndex,
  });

  pushUndo({ kind: 'cells', pageIndex, before });
  redrawPage(pageIndex);
}

function redrawPage(pageIndex) {
  const wrap = el.viewer.querySelector(`.page-wrap[data-page-index="${pageIndex}"]`);
  if (wrap) {
    const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
    const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
    drawPageOverlay(wrap, pw, ph);
  }
}

/**
 * Header tap: if all 10 data cells in the column are filled → clear all;
 * otherwise stamp every empty cell in that column (same date/initials/color).
 * Erase mode: whiteout all 10 (or clear those 10 if already all whiteouts).
 */
function onHeaderTap(pageIndex, col) {
  const colCells = cellsInColumn(col);
  if (!colCells.length) return;
  const colKeys = colCells.map((c) => cellKey(pageIndex, c.col, c.row));
  const before = snapshotKeys(colKeys);

  if (state.eraseMode) {
    const allWhite = colKeys.every((k) => state.whiteouts.has(k));
    if (allWhite) {
      for (const key of colKeys) state.whiteouts.delete(key);
    } else {
      for (const cell of colCells) {
        const key = cellKey(pageIndex, cell.col, cell.row);
        state.stamps.delete(key);
        state.cleared.delete(key);
        state.whiteouts.add(key);
      }
    }
    pushUndo({ kind: 'cells', pageIndex, before });
    redrawPage(pageIndex);
    return;
  }

  const allFilled = colCells.every((c) => state.stamps.has(cellKey(pageIndex, c.col, c.row)));

  if (allFilled) {
    for (const cell of colCells) {
      const key = cellKey(pageIndex, cell.col, cell.row);
      const stamp = state.stamps.get(key);
      if (!stamp) continue;
      state.stamps.delete(key);
      state.whiteouts.delete(key);
      if (stamp.fromFile) state.cleared.add(key);
    }
    pushUndo({ kind: 'cells', pageIndex, before });
    redrawPage(pageIndex);
    return;
  }

  const initials = stampInitialsForColumn(col);
  if (requiresInitialsForColumn(col) && !initials) {
    showToast('Bitte Initialen in den Einstellungen setzen.');
    openSettings();
    return;
  }

  const date = stampDateString(state.settings);
  const colorIndex = state.settings.colorIndex;
  for (const cell of colCells) {
    const key = cellKey(pageIndex, cell.col, cell.row);
    if (state.stamps.has(key)) continue; // skip already stamped
    state.cleared.delete(key);
    state.whiteouts.delete(key);
    state.stamps.set(key, {
      pageIndex,
      col: cell.col,
      row: cell.row,
      date,
      initials,
      colorIndex,
    });
  }
  pushUndo({ kind: 'cells', pageIndex, before });
  redrawPage(pageIndex);
}

function canSharePdfFile(file) {
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return true;
  try {
    return navigator.canShare({ files: [file] });
  } catch (_) {
    return false;
  }
}


function preferDownloadSave() {
  try {
    const mode =
      localStorage.getItem('geraete-laufzettel-settings-v1') ||
      localStorage.getItem('bg-gen-settings-v2');
    let saveMode = 'auto';
    if (mode) {
      const parsed = JSON.parse(mode);
      saveMode = parsed.saveMode || 'auto';
    }
    if (saveMode === 'download') return true;
    if (saveMode === 'share') return false;
    // auto: Mac/desktop → download; iPad/iPhone → share
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isMacSafari = /Macintosh/.test(ua) && !isIOS;
    return isMacSafari || (!isIOS && !/Android/i.test(ua));
  } catch (_) {
    return false;
  }
}


async function syncCatalogAfterSave(blob, name) {
  try {
    const cat = await import('./catalog.js');
    if (typeof cat.upsertSavedPdf === 'function') {
      await cat.upsertSavedPdf(blob, name);
    }
    const mod = await import('./app.js');
    if (typeof mod.onPdfCatalogUpdated === 'function') {
      await mod.onPdfCatalogUpdated();
    }
  } catch (err) {
    console.warn('catalog sync after save failed', err);
  }
}

async function notifyStampSaved() {
  const qty = state.pendingQty || 0;
  state.pendingQty = 0;
  if (!qty) return;
  try {
    const mod = await import('./app.js');
    if (typeof mod.onStampSaved === 'function') mod.onStampSaved(qty);
  } catch (err) {
    console.warn('onStampSaved failed', err);
  }
}




function closeOtherDialogs(exceptId) {
  for (const d of document.querySelectorAll('dialog[open]')) {
    if (exceptId && d.id === exceptId) continue;
    try {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    } catch (_) {}
  }
}

/* ---------- Field text entry (manual only; camera removed) ---------- */

let fieldEntryResolver = null;

function closeFieldEntryDialog(result) {
  const dlg = el.fieldEntryDialog;
  if (dlg && typeof dlg.close === 'function') dlg.close();
  else if (dlg) dlg.removeAttribute('open');
  const r = fieldEntryResolver;
  fieldEntryResolver = null;
  if (r) r(result);
}

/**
 * @param {{title:string,kind:string,initial?:string,placeholder?:string}} opts
 * @returns {Promise<string|null>}
 */
function promptFieldInput(opts) {
  return new Promise((resolve) => {
    fieldEntryResolver = resolve;
    const dlg = el.fieldEntryDialog;
    if (!dlg) {
      const fallback = window.prompt(opts.title || 'Eingabe', opts.initial || '');
      resolve(fallback == null ? null : fallback);
      return;
    }
    if (el.fieldEntryTitle) el.fieldEntryTitle.textContent = opts.title || 'Eingabe';
    if (el.fieldEntryInput) {
      el.fieldEntryInput.value = opts.initial || '';
      el.fieldEntryInput.placeholder = opts.placeholder || '';
      el.fieldEntryInput.inputMode = opts.kind === 'date' ? 'numeric' : 'text';
      if (opts.kind === 'date' || opts.kind === 'scan_or_manual') {
        el.fieldEntryInput.setAttribute('autocapitalize', 'off');
        el.fieldEntryInput.setAttribute('autocorrect', 'off');
      } else if (opts.autocapitalize === 'words' || /name|namen|sachbearbeiter/i.test(opts.title || '') || /name/i.test(opts.placeholder || '')) {
        el.fieldEntryInput.setAttribute('autocapitalize', 'words');
        el.fieldEntryInput.setAttribute('autocorrect', 'on');
      } else {
        el.fieldEntryInput.setAttribute('autocapitalize', opts.autocapitalize || 'sentences');
        el.fieldEntryInput.setAttribute('autocorrect', 'on');
      }
    }
    if (el.fieldEntryHint) {
      if (opts.hint) {
        el.fieldEntryHint.textContent = opts.hint;
      } else if (opts.kind === 'scan_or_manual') {
        el.fieldEntryHint.textContent = 'Wert eintippen.';
      } else if (opts.kind === 'date') {
        el.fieldEntryHint.textContent = 'Datum als TT.MM.JJ eingeben.';
      } else {
        el.fieldEntryHint.textContent = 'Wert eintippen.';
      }
    }
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => el.fieldEntryInput?.focus(), 50);
  });
}

/** Keep opened filename casing so iPad/share can overwrite the original. */
function normalizePdfName(name) {
  let n = String(name || 'Laufzettel.pdf').trim() || 'Laufzettel.pdf';
  if (!/\.pdf$/i.test(n)) n = `${n}.pdf`;
  return n;
}

async function finishSaveBlob(blob, name) {
  name = normalizePdfName(name);
    // 1) File System Access overwrite — no share sheet (desktop Chrome with handle).
    if (state.fileHandle && typeof state.fileHandle.createWritable === 'function') {
      try {
        const writable = await state.fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        await syncCatalogAfterSave(blob, name);
        await notifyStampSaved();
        clearDocument();
        showToast('Originaldatei überschrieben');
        return;
      } catch (err) {
        console.warn('fileHandle overwrite failed', err);
      }
    }

    const file = new File([blob], name, { type: 'application/pdf' });

    if (preferDownloadSave()) {
      if (window.showSaveFilePicker) {
        try {
          const startIn = await getFolderStartIn();
          const handle = await window.showSaveFilePicker({
            suggestedName: name,
            ...(startIn ? { startIn } : {}),
            types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          await syncCatalogAfterSave(blob, name);
          await notifyStampSaved();
          clearDocument();
          showToast('PDF gespeichert');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') {
            showToast('Speichern abgebrochen — Dokument bleibt offen');
            return;
          }
          console.warn('showSaveFilePicker failed', err);
        }
      }
      downloadBlob(blob, name);
      await syncCatalogAfterSave(blob, name);
      await notifyStampSaved();
      clearDocument();
      showToast('Download gestartet — Datei im Download-Ordner / Finder');
      return;
    }

    if (canSharePdfFile(file)) {
      try {
        await navigator.share({ files: [file] });
        await syncCatalogAfterSave(blob, name);
        await notifyStampSaved();
        clearDocument();
        showToast('Über Teilen-Menü gespeichert — Original ggf. ersetzen');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          showToast('Speichern abgebrochen — Dokument bleibt offen');
          return;
        }
        console.warn('navigator.share failed', err);
      }
    }

    downloadBlob(blob, name);
    await syncCatalogAfterSave(blob, name);
    await notifyStampSaved();
    clearDocument();
    showToast('Download gestartet — auf dem iPad Original ggf. manuell ersetzen');
}

async function saveDocument() {
  if (!state.pdfBytes) return;
  try {
    showToast('PDF wird gespeichert…');
    const pdfDoc = await PDFDocument.load(state.pdfBytes, { ignoreEncryption: true });
    // Helvetica kept only as fallback if PNG embed fails.
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    if (usesGeraeteFields()) {
      await embedFieldValuesInPdf(pdfDoc, pages, state.fieldValues, state.settings);
      for (const [pageIndex, strokes] of state.ink.entries()) {
        const page = pages[pageIndex];
        if (!page || !strokes?.length) continue;
        const { height: pageHeight } = page.getSize();
        drawInkStrokesOnPdfPage(page, pageHeight, strokes);
      }
      const existingRaw = pdfDoc.getKeywords();
      const existingArr = Array.isArray(existingRaw)
        ? existingRaw
        : existingRaw
          ? String(existingRaw).split(/[,;]/).map((s) => s.trim()).filter(Boolean)
          : [];
      const kept = existingArr.filter((k) => !/^glfill=/i.test(k) && !/^bgfill=/i.test(k));
      try {
        const payload = encodeURIComponent(JSON.stringify(serializeFieldValues(state.fieldValues)));
        kept.push(`glfill=${payload}`);
      } catch (_) {}
      pdfDoc.setKeywords(kept);

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: 'application/pdf' });
      let name = state.fileName || 'Laufzettel.pdf'; // keep opened PDF name exactly (no date suffix)
      await finishSaveBlob(blob, name);
      return;
    }

    // White-out: session clears (near-full cell) + erase-mode whiteouts (stamp inset).
    const drawWhiteRect = (page, pageHeight, cell, useInset) => {
      if (useInset) {
        const inset = insetBottomLeft(cell, pageHeight, INSET);
        page.drawRectangle({
          x: inset.x,
          y: inset.y,
          width: inset.width,
          height: inset.height,
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });
      } else {
        const full = toBottomLeft(cell, pageHeight);
        page.drawRectangle({
          x: full.x + 0.5,
          y: full.y + 0.5,
          width: Math.max(0, full.width - 1),
          height: Math.max(0, full.height - 1),
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });
      }
    };

    for (const key of state.cleared) {
      if (state.whiteouts.has(key)) continue; // whiteouts drawn with inset below
      const parts = key.split('-');
      if (parts.length !== 3) continue;
      const [pageIndex, col, row] = parts.map(Number);
      if ([pageIndex, col, row].some((n) => Number.isNaN(n))) continue;
      const page = pages[pageIndex];
      if (!page) continue;
      const { height: pageHeight } = page.getSize();
      const cell = emptyCells.find((c) => c.col === col && c.row === row);
      if (!cell) continue;
      drawWhiteRect(page, pageHeight, cell, false);
    }

    for (const key of state.whiteouts) {
      const parts = key.split('-');
      if (parts.length !== 3) continue;
      const [pageIndex, col, row] = parts.map(Number);
      if ([pageIndex, col, row].some((n) => Number.isNaN(n))) continue;
      const page = pages[pageIndex];
      if (!page) continue;
      const { height: pageHeight } = page.getSize();
      const cell = emptyCells.find((c) => c.col === col && c.row === row);
      if (!cell) continue;
      drawWhiteRect(page, pageHeight, cell, true);
    }

    const keys = [];
    for (const [key, stamp] of state.stamps) {
      keys.push(key);
      if (stamp.fromFile && !stamp.date) continue; // already in PDF content
      const page = pages[stamp.pageIndex];
      if (!page) continue;
      const { height: pageHeight } = page.getSize();
      const cell = emptyCells.find((c) => c.col === stamp.col && c.row === stamp.row);
      if (!cell) continue;

      const inset = insetBottomLeft(cell, pageHeight, INSET);

      // Prefer rasterizing the same canvas preview so PDF ≈ screen.
      let embedded = false;
      try {
        const pngBytes = await rasterizeStampPng(stamp, inset.width, inset.height);
        if (pngBytes) {
          const png = await pdfDoc.embedPng(pngBytes);
          page.drawImage(png, {
            x: inset.x,
            y: inset.y,
            width: inset.width,
            height: inset.height,
          });
          embedded = true;
        }
      } catch (err) {
        console.warn('stamp PNG embed failed, using text fallback', err);
      }

      if (!embedded) {
        page.drawRectangle({
          x: inset.x,
          y: inset.y,
          width: inset.width,
          height: inset.height,
          color: rgb(FILL_WHITE.r / 255, FILL_WHITE.g / 255, FILL_WHITE.b / 255),
          borderWidth: 0,
        });
        const c = colorRgb01(stamp.colorIndex);
        const textColor = rgb(c.r, c.g, c.b);
        const measure = (text, size, bold) =>
          (bold ? helveticaBold : helvetica).widthOfTextAtSize(text, size);
        const layout = computeStampLayout(inset, stamp.date, stamp.initials, measure);
        page.drawText(stamp.date, {
          x: inset.x + Math.max(0, (inset.width - layout.dateWidth) / 2),
          y: layout.dateBaseline,
          size: layout.dateSize,
          font: helvetica,
          color: textColor,
        });
        if (!layout.dateOnly && layout.box && stamp.initials) {
          page.drawRectangle({
            x: layout.box.x,
            y: layout.box.y,
            width: layout.box.width,
            height: layout.box.height,
            borderColor: textColor,
            borderWidth: 1,
          });
          page.drawText(stamp.initials, {
            x: inset.x + Math.max(0, (inset.width - layout.initWidth) / 2),
            y: layout.initBaseline,
            size: layout.initSize,
            font: helveticaBold,
            color: textColor,
          });
        }
      }
    }

    // Freehand ink (Apple Pencil) — vector paths (top-down → pdf-lib SVG).
    for (const [pageIndex, strokes] of state.ink.entries()) {
      const page = pages[pageIndex];
      if (!page || !strokes?.length) continue;
      const { height: pageHeight } = page.getSize();
      drawInkStrokesOnPdfPage(page, pageHeight, strokes);
    }

    // Remember filled keys for re-open (no double-fill). Cleared keys omitted.
    const existingRaw = pdfDoc.getKeywords();
    const existingArr = Array.isArray(existingRaw)
      ? existingRaw
      : existingRaw
        ? String(existingRaw)
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const kept = existingArr.filter((k) => !/^bgfill=/i.test(k));
    kept.push(`bgfill=${keys.join(',')}`);
    pdfDoc.setKeywords(kept);

    const out = await pdfDoc.save();
    const blob = new Blob([out], { type: 'application/pdf' });
    let name = state.fileName || 'Laufzettel.pdf'; // keep opened PDF name exactly (no date suffix)
    await finishSaveBlob(blob, name);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showToast('Speichern abgebrochen — Dokument bleibt offen');
      return;
    }
    console.error(err);
    showToast('Speichern fehlgeschlagen.');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- Settings UI ---------- */


function redrawSettingsStampBadge() {
  const canvas = el.stampSettingsCanvas;
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = 36;
  const w = Math.round(css * dpr);
  const h = Math.round(css * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, css, css);
  // light gray plate (readable in Dark Mode)
  ctx.fillStyle = '#e8e8ed';
  ctx.fillRect(0, 0, css, css);
  const initials = ((state.settings && state.settings.initials) || 'DK').trim().slice(0, 4) || 'DK';
  const color = colorCss(state.settings.colorIndex || 0);
  // boxed initials centered (stamp-like)
  ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(initials).width;
  const padX = 5;
  const padY = 3;
  const boxW = Math.min(css - 6, tw + padX * 2);
  const boxH = 18;
  const bx = (css - boxW) / 2;
  const by = (css - boxH) / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 3);
  else {
    ctx.rect(bx, by, boxW, boxH);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(initials, css / 2, css / 2 + 0.5);
}

function syncColorUI() {
  redrawSettingsStampBadge();
  const css = colorCss(state.settings.colorIndex);
  el.cycleColor.style.background = css;
  el.colorGrid.querySelectorAll('.color-swatch').forEach((btn, idx) => {
    btn.classList.toggle('selected', idx === state.settings.colorIndex);
  });
}

function buildColorGrid() {
  el.colorGrid.innerHTML = '';
  DARK_COLORS.forEach((_, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.style.background = colorCss(idx);
    btn.setAttribute('aria-label', `Farbe ${idx + 1}`);
    btn.addEventListener('click', () => {
      state.settings.colorIndex = idx;
      saveColorIndex(idx);
      syncColorUI();
    });
    el.colorGrid.appendChild(btn);
  });
}

function populateTemplateSelect() {
  const sel = el.fieldTemplate;
  if (!sel) return;
  const cur = sel.value || state.settings.fieldTemplateId || 'auto';
  const autoLabel = state.templateId
    ? `Auto (erkannt: ${state.templateId})`
    : 'Auto (aus Dateiname / PDF)';
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = autoLabel;
  sel.appendChild(auto);
  for (const t of KNOWN_TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  const ok = [...sel.options].some((o) => o.value === cur);
  sel.value = ok ? cur : 'auto';
}

function openSettings() {
  el.initials.value = state.settings.initials;
  el.date.value = state.settings.dateOverride || '';
  el.dateHint.textContent = `Leer = heutiges Datum (${todayStampDateYY()}). Format TT.MM.JJ. Beim Schließen des Dokuments wird die Überschreibung verworfen.`;
  if (el.eraseMode) el.eraseMode.checked = !!state.eraseMode;
  if (el.lastColDateOnly) el.lastColDateOnly.checked = !!state.settings.lastColumnDateOnly;
  if (el.fieldTemplate) {
    populateTemplateSelect();
    const cur = state.settings.fieldTemplateId || 'auto';
    el.fieldTemplate.value = cur;
  }
  if (el.zoom) {
    el.zoom.value = state.settings.zoomMode || 'cols-hidden';
  }
  syncColorUI();
  if (typeof el.dialog.showModal === 'function') {
    el.dialog.showModal();
  } else {
    el.dialog.setAttribute('open', '');
  }
}

function applySettingsFromForm() {
  const initials = el.initials.value.trim() || 'DK';
  state.settings.initials = initials;
  saveInitials(initials);

  const raw = el.date.value.trim();
  state.settings.dateOverride = raw ? normalizeStampDateYY(raw) : null;

  if (el.lastColDateOnly) {
    state.settings.lastColumnDateOnly = !!el.lastColDateOnly.checked;
    saveLastColumnDateOnly(state.settings.lastColumnDateOnly);
  }

  if (el.fieldTemplate) {
    const tid = el.fieldTemplate.value || 'auto';
    state.settings.fieldTemplateId = tid;
    saveFieldTemplateId(tid);
  }

  if (el.zoom) {
    const zm = saveZoomMode(el.zoom.value || 'cols-hidden');
    const prev = state.settings.zoomMode;
    state.settings.zoomMode = zm;
    if (prev !== zm) {
      syncViewerSeamless();
      if (state.pdfDoc) renderAllPages();
    }
  }
}

/* ---------- Wire up ---------- */

let fillWired = false;


/** Open a freshly generated PDF (bytes) in fill mode for immediate stamping. */
export async function openGeneratedPdf(bytes, filename, opts = {}) {
  const name = filename || 'Laufzettel.pdf';
  state.pendingQty = parseInt(opts.pendingQty, 10) || 0;
  const file = new File([bytes], name, { type: 'application/pdf' });
  await openFile(file, null);
}

export function initFill() {
  if (fillWired) return;
  fillWired = true;
  bindFillWheelScroll();
  populateTemplateSelect();
  redrawSettingsStampBadge();

  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    let handle = null;
    try {
      if (el.fileInput.files && typeof el.fileInput.files[0]?.handle !== 'undefined') {
        handle = el.fileInput.files[0].handle;
      }
    } catch (_) {
      /* ignore */
    }
    if (file) openFile(file, handle);
  });

  // Prefer File System Access picker (readwrite) when available.
  document.querySelectorAll('label[for="file-input"], #btn-pdf-open').forEach((label) => {
    label.addEventListener('click', (e) => {
      e.preventDefault();
      pickAndOpen();
    });
  });

  el.btnSave.addEventListener('click', () => saveDocument());
  el.btnInkUndo.addEventListener('click', () => undoLastAction());
  el.btnSettings.addEventListener('click', () => openSettings());
  if (el.btnClose) {
    el.btnClose.addEventListener('click', () => {
      const ok = window.confirm('Wirklich schließen ohne zu speichern?');
      if (!ok) return;
      clearDocument();
      showToast('Dokument geschlossen');
    });
  }

  el.cycleColor.addEventListener('click', () => {
    state.settings.colorIndex = (state.settings.colorIndex + 1) % DARK_COLORS.length;
    saveColorIndex(state.settings.colorIndex);
    syncColorUI();
  });

  el.resetDate.addEventListener('click', () => {
    el.date.value = '';
    state.settings.dateOverride = null;
  });

  el.settingsForm.addEventListener('submit', () => {
    applySettingsFromForm();
  });

  el.initials.addEventListener('change', () => {
    const initials = el.initials.value.trim() || 'DK';
    state.settings.initials = initials;
    saveInitials(initials);
    redrawSettingsStampBadge();
  });

  el.date.addEventListener('change', () => {
    const raw = el.date.value.trim();
    state.settings.dateOverride = raw ? normalizeStampDateYY(raw) : null;
  });

  el.eraseMode.addEventListener('change', () => {
    state.eraseMode = !!el.eraseMode.checked;
    if (state.pdfDoc) {
      el.viewer.querySelectorAll('.page-wrap').forEach((wrap) => {
        const pageIndex = Number(wrap.dataset.pageIndex);
        const pw = Number(wrap.dataset.pageWidth) || PAGE_WIDTH;
        const ph = Number(wrap.dataset.pageHeight) || PAGE_HEIGHT;
        drawPageOverlay(wrap, pw, ph);
      });
    }
  });

  if (el.lastColDateOnly) {
    el.lastColDateOnly.addEventListener('change', () => {
      state.settings.lastColumnDateOnly = !!el.lastColDateOnly.checked;
      saveLastColumnDateOnly(state.settings.lastColumnDateOnly);
    });
  }

  if (el.zoom) {
    el.zoom.addEventListener('change', () => {
      const zm = saveZoomMode(el.zoom.value || 'cols-hidden');
      state.settings.zoomMode = zm;
      syncViewerSeamless();
      if (state.pdfDoc) renderAllPages();
    });
  }


  if (el.fieldEntryOk) {
    el.fieldEntryOk.addEventListener('click', (e) => {
      e.preventDefault();
      const v = el.fieldEntryInput?.value ?? '';
      closeFieldEntryDialog(v);
    });
  }
  if (el.fieldEntryCancel) {
    el.fieldEntryCancel.addEventListener('click', (e) => {
      e.preventDefault();
      closeFieldEntryDialog(null);
    });
  }
  if (el.fieldEntryDialog) {
    el.fieldEntryDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeFieldEntryDialog(null);
    });
  }

  if (el.fieldTemplate) {
    el.fieldTemplate.addEventListener('change', async () => {
      const tid = el.fieldTemplate.value || 'auto';
      state.settings.fieldTemplateId = tid;
      saveFieldTemplateId(tid);
      if (state.pdfDoc) {
        await resolveAndLoadTemplate(state.fileName, state.pdfDoc);
        await renderAllPages();
        showToast(state.templateId ? `Vorlage: ${state.templateId}` : 'Keine Feldvorlage');
      }
    });
  }

  el.toast.addEventListener('click', () => el.toast.classList.add('hidden'));

  let resizeTimer = 0;
  function scheduleRerender() {
    if (!state.pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderAllPages(), 250);
  }
  window.addEventListener('resize', scheduleRerender);
  window.addEventListener('orientationchange', scheduleRerender);

  buildColorGrid();
  syncColorUI();
  setDocumentUI(false);

  // Dev/preview helper: ?open=sample-open.pdf auto-loads a PDF (no File picker).
  try {
    const params = new URLSearchParams(location.search);
    const openPath = params.get('open');
    if (openPath) {
      fetch(openPath)
        .then((r) => r.blob())
        .then((blob) => {
          const name = openPath.split('/').pop() || 'Laufzettel.pdf';
          const file = new File([blob], name, { type: 'application/pdf' });
          return openFile(file, null);
        })
        .catch((err) => console.warn('auto-open failed', err));
    }
  } catch (_) {
    /* ignore */
  }
}
