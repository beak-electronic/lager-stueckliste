const LS_INITIALS = 'ls.initials';
const LS_INITIALS_LEGACY = 'bg.initials';
const LS_COLOR = 'ls.colorIndex';
const LS_COLOR_LEGACY = 'bg.colorIndex';
const LS_LAST_COL_DATE_ONLY = 'bg.lastColDateOnly';
const LS_FIELD_TEMPLATE = 'gl.fieldTemplateId';
const LS_ZOOM_MODE = 'gl.zoomMode';

export const DARK_COLORS = [
  { r: 0.08, g: 0.2, b: 0.55 }, // navy (default)
  { r: 0.1, g: 0.1, b: 0.12 }, // near black
  { r: 0.45, g: 0.12, b: 0.12 }, // dark red
  { r: 0.12, g: 0.38, b: 0.22 }, // forest
  { r: 0.35, g: 0.18, b: 0.45 }, // purple
  { r: 0.45, g: 0.28, b: 0.08 }, // brown
  { r: 0.08, g: 0.35, b: 0.4 }, // teal
  { r: 0.25, g: 0.25, b: 0.28 }, // charcoal
];

/** Column index for „Baugruppe gebucht“ (last process column). */
export const LAST_COLUMN_INDEX = 7;

function clampIndex(i) {
  return Math.max(0, Math.min(DARK_COLORS.length - 1, i | 0));
}

export function loadSettings() {
  let initials = localStorage.getItem(LS_INITIALS);
  if (!initials || !initials.trim()) {
    initials = localStorage.getItem(LS_INITIALS_LEGACY);
  }
  if (!initials || !initials.trim()) initials = 'SG';
  const colorRaw = localStorage.getItem(LS_COLOR) ?? localStorage.getItem(LS_COLOR_LEGACY) ?? '0';
  const colorIndex = clampIndex(parseInt(colorRaw, 10));
  // Migrate legacy keys once so color/initials stick under ls.* on iPad/PWA.
  try {
    if (!localStorage.getItem(LS_COLOR)) localStorage.setItem(LS_COLOR, String(colorIndex));
    if (!localStorage.getItem(LS_INITIALS) && initials) localStorage.setItem(LS_INITIALS, initials);
  } catch (_) {}
  const lastColRaw = localStorage.getItem(LS_LAST_COL_DATE_ONLY);
  // Default ON (date only) when unset
  const lastColumnDateOnly = lastColRaw === null ? true : lastColRaw === '1' || lastColRaw === 'true';
  const fieldTemplateId = localStorage.getItem(LS_FIELD_TEMPLATE) || 'auto';
  const zoomRaw = localStorage.getItem(LS_ZOOM_MODE) || 'cols-hidden';
  const zoomMode = ['cols-hidden', 'fit', 'original'].includes(zoomRaw) ? zoomRaw : 'cols-hidden';
  return {
    initials,
    colorIndex,
    lastColumnDateOnly,
    /** @type {string} 'auto' or template id e.g. 200.433 */
    fieldTemplateId,
    /** @type {'cols-hidden'|'fit'|'original'} PDF editor zoom */
    zoomMode,
    /** @type {string|null} document-only, not persisted — stamp date TT.MM.JJ */
    dateOverride: null,
  };
}

export function saveInitials(initials) {
  localStorage.setItem(LS_INITIALS, initials);
}

export function saveColorIndex(index) {
  localStorage.setItem(LS_COLOR, String(clampIndex(index)));
}

export function saveLastColumnDateOnly(on) {
  localStorage.setItem(LS_LAST_COL_DATE_ONLY, on ? '1' : '0');
}

export function saveFieldTemplateId(id) {
  localStorage.setItem(LS_FIELD_TEMPLATE, String(id || 'auto'));
}

export function saveZoomMode(mode) {
  const m = ['cols-hidden', 'fit', 'original'].includes(mode) ? mode : 'cols-hidden';
  localStorage.setItem(LS_ZOOM_MODE, m);
  return m;
}

/** Legacy BG short date dd.MM. (no year). */
export function todayShortGerman(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.`;
}

/** Stamp date DD.MM.YY in Europe/Berlin (Geräte fields). */
export function todayStampDateYY(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

/** Save-day suffix (dd.MM.yy) in Europe/Berlin. */
export function todaySaveSuffixGerman(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `(${get('day')}.${get('month')}.${get('year')})`;
}

/**
 * Append or replace German short date suffix before .pdf
 * e.g. "BG Endstufe 2718 V2.pdf" → "BG Endstufe 2718 V2 (13.09.26).pdf"
 */
export function withSaveDateSuffix(filename) {
  let name = String(filename || 'Laufzettel.pdf');
  if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
  const stem = name.replace(/\.pdf$/i, '');
  const cleaned = stem.replace(/\s*\(\d{2}\.\d{2}\.\d{2}\)\s*$/, '').trim();
  return `${cleaned} ${todaySaveSuffixGerman()}.pdf`;
}

/** Legacy normalize ending with '.' */
export function normalizeDateString(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!s.endsWith('.')) s += '.';
  return s;
}

/** Normalize to DD.MM.YY */
export function normalizeStampDateYY(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?\.?$/);
  if (!m) {
    // Fall back: strip trailing dots
    return s.replace(/\.+$/, '');
  }
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yy = m[3] || '';
  if (yy.length === 4) yy = yy.slice(2);
  if (!yy) yy = todayStampDateYY().slice(-2);
  return `${dd}.${mm}.${yy}`;
}

export function stampDateString(settings) {
  const override = settings.dateOverride ? String(settings.dateOverride).trim() : '';
  if (override) return normalizeStampDateYY(override);
  return todayStampDateYY();
}

export function colorCss(index) {
  const c = DARK_COLORS[clampIndex(index)];
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export function colorRgb01(index) {
  return DARK_COLORS[clampIndex(index)];
}
