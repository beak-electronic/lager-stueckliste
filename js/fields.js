/**
 * Lager Stückliste field templates (geometry + capabilities).
 * Auto-fallback picks the only template when filename/header has no DE- article match.
 */

export const KNOWN_TEMPLATES = [
  { id: 'lager-stueckliste', label: 'Lager Stückliste (Zeilen)', dataUrl: '../data/template-lager-stueckliste.json' },
];

export const FIELD_HIGHLIGHT = {
  fill: '#ADD8E6',
  alpha: 0.59,
};

const DE_ARTICLE_RE = /\bDE-(\d{1,4}\.\d{1,4})\b/i;
const ARTICLE_LOOSE_RE = /\b(\d{1,4}\.\d{1,4})\b/;

/** @type {Map<string, object>} */
const templateCache = new Map();

export function extractArticleKey(text) {
  const s = String(text || '');
  const m = s.match(DE_ARTICLE_RE);
  if (m) return m[1];
  // FB-200.433-V1 style
  const fb = s.match(/\bFB-(\d{1,4}\.\d{1,4})\b/i);
  if (fb) return fb[1];
  return '';
}

export function extractArticleFromFilename(name) {
  return extractArticleKey(name || '');
}

/**
 * Resolve active template id.
 * @param {{ filename?: string, pdfText?: string, settings?: { fieldTemplateId?: string } }} opts
 */
export function resolveTemplateId(opts = {}) {
  const settings = opts.settings || {};
  const override = String(settings.fieldTemplateId || '').trim();
  if (override && override !== 'auto' && KNOWN_TEMPLATES.some((t) => t.id === override)) return override;

  const fromFile = extractArticleFromFilename(opts.filename);
  if (fromFile && KNOWN_TEMPLATES.some((t) => t.id === fromFile)) return fromFile;

  const fromText = extractArticleKey(opts.pdfText || '');
  if (fromText && KNOWN_TEMPLATES.some((t) => t.id === fromText)) return fromText;

  // Auto fallback: only known template for now
  if (KNOWN_TEMPLATES.length === 1) return KNOWN_TEMPLATES[0].id;
  return fromText || fromFile || KNOWN_TEMPLATES[0]?.id || '';
}

export async function loadTemplate(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return null;
  if (templateCache.has(id)) return templateCache.get(id);
  const meta = KNOWN_TEMPLATES.find((t) => t.id === id);
  if (!meta) return null;
  const url = new URL(meta.dataUrl, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Template ${id} nicht ladbar (${res.status})`);
  const data = await res.json();
  templateCache.set(id, data);
  return data;
}

export function fieldKey(page, number) {
  return `${page}:${number}`;
}

/** 1-based PDF page → page block (page index 0-based in fill.js). */
export function pageBlock(template, pageIndex0) {
  if (!template?.pages) return null;
  const page = pageIndex0 + 1;
  return template.pages[String(page)] || template.pages[page] || null;
}

/** 1-based PDF page → fields (page index 0-based in fill.js). */
export function fieldsForPage(template, pageIndex0) {
  return pageBlock(template, pageIndex0)?.fields || [];
}

export function pageStyle(template, pageIndex0) {
  return pageBlock(template, pageIndex0)?.style || null;
}

/** Lager Stückliste rows: white wash + Bedarf stroke, no OK/stamp text. */
export function isRowCoverField(field) {
  if (!field) return false;
  if (field.type === 'tap_row_cover') return true;
  return field.kind === 'row';
}

/** Bottom-of-page booking stamp („gebucht am … von …“). Never row-wash / blue highlight. */
export function isGebuchtField(field) {
  if (!field) return false;
  if (field.type === 'tap_gebucht') return true;
  return field.kind === 'gebucht';
}

/** Compose booking stamp text from settings (date override or today + initials). */
export const GEBUCHT_COLOR_HEX = '#dd007a';
export const GEBUCHT_COLOR_CSS = 'rgb(221, 0, 122)';
export const GEBUCHT_COLOR_RGB01 = { r: 221 / 255, g: 0, b: 122 / 255 };

export function gebuchtStampText(settings) {
  const date = stampDateForSettings(settings);
  const initials = stampInitialsForSettings(settings);
  return `gebucht am ${date} von ${initials}`;
}

export function bedarfRectForField(field, template) {
  if (field?.bedarf_rect_pt?.length === 4) return field.bedarf_rect_pt;
  const col = template?.bedarf_column;
  const rect = field?.rect_pt;
  if (!col || !rect) return null;
  const x0 = col.x0_pt;
  const x1 = col.x1_pt;
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  return [x0, rect[1], x1, rect[3]];
}

/** rect_pt [x0,y0,x1,y1] top-left → CSS % for hit layer. */
export function rectCssPercent(rect, pageWidth, pageHeight) {
  const [x0, y0, x1, y1] = rect;
  return {
    left: (x0 / pageWidth) * 100,
    top: (y0 / pageHeight) * 100,
    width: ((x1 - x0) / pageWidth) * 100,
    height: ((y1 - y0) / pageHeight) * 100,
  };
}

/** Drawing / PDF embed rect (text stays tight; never use hit size for paint). */
export function fieldTextRect(field) {
  if (!field) return null;
  if (field.text_rect_pt?.length === 4) return field.text_rect_pt;
  return field.rect_pt || null;
}

/** Invisible hit target (may be larger than text, e.g. full footer cell). */
export function fieldHitRect(field) {
  if (!field) return null;
  if (field.hit_rect_pt?.length === 4) return field.hit_rect_pt;
  return field.rect_pt || null;
}

/**
 * Draw semi-transparent field highlights (UI only, never saved).
 * Skip when page style disables them (alpha 0 / highlight false) or for row covers.
 */
export function drawFieldHighlights(ctx, fields, scaleX, scaleY, style) {
  if (!fields?.length) return;
  if (style?.highlight === false || style?.alpha === 0 || style?.fill_hex === null) return;
  const fill = style?.fill_hex || FIELD_HIGHLIGHT.fill;
  const alpha = Number.isFinite(style?.alpha) ? style.alpha : FIELD_HIGHLIGHT.alpha;
  if (!fill || alpha <= 0) return;

  ctx.save();
  ctx.fillStyle = fill;
  ctx.globalAlpha = alpha;
  for (const f of fields) {
    if (isRowCoverField(f) || isGebuchtField(f) || f.highlight === false) continue;
    if (!f.rect_pt) continue;
    const [x0, y0, x1, y1] = f.rect_pt;
    ctx.fillRect(x0 * scaleX, y0 * scaleY, (x1 - x0) * scaleX, (y1 - y0) * scaleY);
  }
  ctx.restore();
}

/** Edit-mode white wash (~20% transparent / almost opaque). Not baked into saved PDF. */
const ROW_COVER_FILL = 'rgba(255,255,255,0.80)';
const BEDARF_STROKE_DEFAULT = '#000000';
const BEDARF_STROKE_INSET_PT = 0.7;
const BEDARF_STROKE_PT = 1.05;

/**
 * White row wash (edit only) + strikethrough through Bedarf Stck.
 * @param {string} [strokeColor] stamp color for the line (defaults to black)
 */
export function drawRowCover(ctx, field, scaleX, scaleY, template, strokeColor) {
  const rect = field?.rect_pt;
  if (!rect) return;
  const [x0, y0, x1, y1] = rect;
  const ix = x0 * scaleX;
  const iy = y0 * scaleY;
  const iw = (x1 - x0) * scaleX;
  const ih = (y1 - y0) * scaleY;
  if (iw < 1 || ih < 1) return;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ROW_COVER_FILL;
  ctx.fillRect(ix, iy, iw, ih);

  const br = bedarfRectForField(field, template);
  if (br) {
    const inset = BEDARF_STROKE_INSET_PT;
    const [bx0, by0, bx1, by1] = br;
    const xL = (bx0 + inset) * scaleX;
    const xR = (bx1 - inset) * scaleX;
    const yMid = ((by0 + by1) / 2) * scaleY;
    if (xR - xL > 1) {
      const avg = (scaleX + scaleY) / 2;
      ctx.strokeStyle = strokeColor || BEDARF_STROKE_DEFAULT;
      ctx.lineWidth = Math.max(1, BEDARF_STROKE_PT * avg);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(xL, yMid);
      ctx.lineTo(xR, yMid);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export const ROW_COVER = {
  fill: ROW_COVER_FILL,
  stroke: BEDARF_STROKE_DEFAULT,
  insetPt: BEDARF_STROKE_INSET_PT,
  strokePt: BEDARF_STROKE_PT,
};

/**
 * Fit + center text in a field rect (canvas, top-left origin).
 */
export function drawCenteredFieldText(ctx, text, rect, colorCss, scaleX, scaleY, align = 'center', opts = {}) {
  if (!text) return;
  const [x0, y0, x1, y1] = rect;
  const ix = x0 * scaleX;
  const iy = y0 * scaleY;
  const iw = (x1 - x0) * scaleX;
  const ih = (y1 - y0) * scaleY;
  if (iw < 1 || ih < 1) return;

  const pad = Math.max(1, Math.min(iw, ih) * 0.08);
  const maxW = Math.max(2, iw - pad * 2);
  const maxH = Math.max(2, ih - pad * 2);
  let size = Math.min(maxH * 0.85, 28);
  const textAlign = align === 'left' || align === 'right' ? align : 'center';
  const weight = opts.bold ? '700' : '400';
  ctx.save();
  ctx.fillStyle = colorCss || 'rgb(20,51,140)';
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'middle';
  while (size > 5) {
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    size -= 0.5;
  }
  let tx = ix + iw / 2;
  if (textAlign === 'left') tx = ix + pad;
  else if (textAlign === 'right') tx = ix + iw - pad;
  ctx.fillText(String(text), tx, iy + ih / 2 + size * 0.04, maxW);
  ctx.restore();
}

/**
 * Initials stamp with colored Umrandung (stroke box), matching fill.js stamp style.
 * Canvas top-left origin; rect_pt is PDF top-left.
 */
export function drawInitialsStampInRect(ctx, text, rect, colorCss, scaleX, scaleY) {
  if (!text) return;
  const [x0, y0, x1, y1] = rect;
  const ix = x0 * scaleX;
  const iy = y0 * scaleY;
  const iw = (x1 - x0) * scaleX;
  const ih = (y1 - y0) * scaleY;
  if (iw < 1 || ih < 1) return;

  const color = colorCss || 'rgb(20,51,140)';
  const inset = Math.max(0.6, Math.min(iw, ih) * 0.06);
  const cx = ix + iw / 2;
  const cy = iy + ih / 2;

  ctx.save();
  // Light plate so outline stays readable over blue highlight
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(ix + inset * 0.35, iy + inset * 0.35, iw - inset * 0.7, ih - inset * 0.7);

  const maxW = Math.max(2, iw - inset * 2);
  const maxH = Math.max(2, ih - inset * 2);
  let size = Math.min(maxH * 0.72, 22);
  ctx.font = `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let tw = ctx.measureText(String(text)).width;
  while (size > 5 && tw > maxW * 0.78) {
    size -= 0.35;
    ctx.font = `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    tw = ctx.measureText(String(text)).width;
  }

  const padX = Math.max(3, size * 0.32);
  const padY = Math.max(1.6, size * 0.18);
  let boxW = Math.min(maxW, tw + padX * 2);
  let boxH = Math.min(maxH, size + padY * 2);
  // Keep a clear outline even in short cells
  boxH = Math.max(boxH, Math.min(maxH, size * 1.15));
  const bx = cx - boxW / 2;
  const by = cy - boxH / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.1, Math.min(2.2, size * 0.12));
  ctx.strokeRect(bx, by, boxW, boxH);

  ctx.fillStyle = color;
  ctx.fillText(String(text), cx, cy + size * 0.04, maxW);
  ctx.restore();
}


/** Parse „gebucht am {date} von {initials}“; null if not matching. */
export function parseGebuchtStamp(text) {
  const m = String(text || '').match(/^gebucht am\s+(.+?)\s+von\s+(.+)$/i);
  if (!m) return null;
  return { date: m[1].trim(), initials: m[2].trim() };
}

/**
 * Footer booking line: „gebucht am {date} von“ + initials in a stroke box
 * (same look as the fill-settings stamp badge top-left). No white plate.
 */
export function drawGebuchtStampInRect(ctx, text, rect, colorCss, scaleX, scaleY) {
  const parsed = parseGebuchtStamp(text);
  if (!parsed?.initials) {
    drawCenteredFieldText(ctx, text, rect, colorCss, scaleX, scaleY, 'center', { bold: true });
    return;
  }
  const [x0, y0, x1, y1] = rect;
  const ix = x0 * scaleX;
  const iy = y0 * scaleY;
  const iw = (x1 - x0) * scaleX;
  const ih = (y1 - y0) * scaleY;
  if (iw < 1 || ih < 1) return;

  const color = colorCss || GEBUCHT_COLOR_CSS;
  const prefix = `gebucht am ${parsed.date} von `;
  const initials = parsed.initials;

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  let size = Math.min(ih * 0.82, 13);
  const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const measure = (s, bold, sz) => {
    ctx.font = `${bold ? '700' : '400'} ${sz}px ${fontFamily}`;
    return ctx.measureText(s).width;
  };

  let padX = Math.max(2.4, size * 0.28);
  let padY = Math.max(1.1, size * 0.12);
  let prefixW = measure(prefix, true, size);
  let initW = measure(initials, true, size);
  let boxW = initW + padX * 2;
  let boxH = Math.min(ih - 0.5, size + padY * 2);
  let gap = Math.max(1.5, size * 0.12);
  let total = prefixW + gap + boxW;

  // Fit into rect width
  let guard = 0;
  while (total > iw - 2 && size > 5.5 && guard++ < 40) {
    size -= 0.25;
    padX = Math.max(2.2, size * 0.28);
    padY = Math.max(1.0, size * 0.12);
    prefixW = measure(prefix, true, size);
    initW = measure(initials, true, size);
    boxW = initW + padX * 2;
    boxH = Math.min(ih - 0.5, size + padY * 2);
    gap = Math.max(1.2, size * 0.12);
    total = prefixW + gap + boxW;
  }

  const startX = ix + Math.max(0, (iw - total) / 2);
  const cy = iy + ih / 2;

  ctx.font = `700 ${size}px ${fontFamily}`;
  ctx.fillText(prefix, startX, cy + size * 0.04);

  const bx = startX + prefixW + gap;
  const by = cy - boxH / 2;
  const radius = Math.min(2.5, boxH * 0.22);
  ctx.lineWidth = Math.max(1.4, Math.min(2.2, size * 0.14));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, boxW, boxH, radius);
  else ctx.rect(bx, by, boxW, boxH);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillText(initials, bx + boxW / 2, cy + size * 0.04);
  ctx.restore();
}

/** Dialog title: prefer template label; SN rows use prefix „SN“ + full left designation. */
export function fieldDialogTitle(field, fallback = 'Eingabe') {
  const label = String(field?.label || '').trim();
  if (label) {
    // Legacy labels „Seriennummer …“ → „SN …“
    if (/^Seriennummer\b/i.test(label)) {
      return label.replace(/^Seriennummer\b/i, 'SN').replace(/^SN\s+SN\b/, 'SN');
    }
    return label;
  }
  const left = String(field?.left_ref || '').trim();
  if (left) {
    const isSn =
      String(field?.id || '').startsWith('sn_') ||
      field?.type === 'scan_or_manual' ||
      /^\d{2,3}\.\d{3}\b/.test(left);
    if (isSn) return left.startsWith('SN ') ? left : `SN ${left}`;
    return left;
  }
  return fallback;
}

/** DD.MM.YY in Europe/Berlin. */
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

export function normalizeStampDateYY(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Accept DD.MM. or DD.MM.YY / DD.MM.YYYY
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?\.?$/);
  if (!m) return s.endsWith('.') ? s.slice(0, -1) : s;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yy = m[3] || '';
  if (yy.length === 4) yy = yy.slice(2);
  if (!yy) {
    // If only DD.MM. given, append current year
    yy = todayStampDateYY().slice(-2);
  }
  return `${dd}.${mm}.${yy}`;
}

export function stampDateForSettings(settings) {
  const override = settings?.dateOverride ? String(settings.dateOverride).trim() : '';
  if (override) return normalizeStampDateYY(override);
  return todayStampDateYY();
}

export function stampInitialsForSettings(settings) {
  return String(settings?.initials || '').trim();
}
