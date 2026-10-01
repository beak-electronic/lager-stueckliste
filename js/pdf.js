/**
 * Draw Baugruppenlaufzettel PDFs with pdf-lib using reference PDF coordinates.
 * pymupdf top-left Y → pdf-lib bottom-left: yPdf = PAGE_H - yTop
 */

import { PAGE_WIDTH as PAGE_W, PAGE_HEIGHT as PAGE_H, V_LINES, H_LINES } from './grid.js';

/** Column X edges — must match fill stamp grid (V_LINES). */
const COL_X = V_LINES;

const PINK = { r: 221 / 255, g: 0, b: 122 / 255 };
const GRAY_LOGO = { r: 114 / 255, g: 114 / 255, b: 114 / 255 }; // #727272
const BLACK = { r: 0, g: 0, b: 0 };
const LINE_W = 0.14;

/** Windows postprocess uses this for baseline from conceptual line-top */
const WIN_ASCENT = 0.92;
const HEADER_NUDGE_Y = -1.35;
const BAUG_PAD_X = 8.59; // SOLL: value x=246.37, box x0=237.78

const TABLE_TOP = H_LINES[0];
const HEADER_BOT = H_LINES[1];
const ROW_H = H_LINES[2] - H_LINES[1];

const COL_HEADERS = [
  ["Baugruppen", "SN"],
  ["Bestückung", "SMD\u00a0&\u00a0Reflow"],
  ["Bestückung", "Hand"],
  ["Lötprozess", "Schwall"],
  ["Handlöten", "Montage"],
  ["Kontrolle", "Sichtprüfung"],
  ["Kontrolle", "Funktionstest"],
  ["Baugruppe", "gebucht"],
];

let _fontsPromise = null;

function yPdf(yTop) {
  return PAGE_H - yTop;
}

function rgbOf({ r, g, b }) {
  return PDFLib.rgb(r, g, b);
}

async function loadFonts(pdfDoc) {
  if (!_fontsPromise) {
    _fontsPromise = (async () => {
      const [reg, bold, aeonis, constan] = await Promise.all([
        fetch("fonts/Calibri.subset.ttf").then((r) => r.arrayBuffer()),
        fetch("fonts/Calibri-Bold.subset.ttf").then((r) => r.arrayBuffer()),
        fetch("fonts/Aeonis.subset.ttf").then((r) => r.arrayBuffer()),
        fetch("fonts/Constantia-Bold.subset.ttf").then((r) => r.arrayBuffer()),
      ]);
      return { reg, bold, aeonis, constan };
    })();
  }
  const bufs = await _fontsPromise;
  const font = await pdfDoc.embedFont(bufs.reg);
  const fontBold = await pdfDoc.embedFont(bufs.bold);
  const fontLogo = await pdfDoc.embedFont(bufs.aeonis);
  const fontBullet = await pdfDoc.embedFont(bufs.constan);
  return { font, fontBold, fontLogo, fontBullet };
}

function drawHLine(page, x0, x1, yTop) {
  const y = yPdf(yTop) - LINE_W / 2;
  page.drawRectangle({
    x: x0,
    y,
    width: x1 - x0,
    height: LINE_W,
    color: rgbOf(BLACK),
  });
}

function drawVLine(page, x, yTop0, yTop1) {
  const top = Math.min(yTop0, yTop1);
  const bot = Math.max(yTop0, yTop1);
  page.drawRectangle({
    x: x - LINE_W / 2,
    y: yPdf(bot),
    width: LINE_W,
    height: bot - top,
    color: rgbOf(BLACK),
  });
}

function drawBox(page, x0, y0Top, x1, y1Top, fill) {
  const top = Math.min(y0Top, y1Top);
  const bot = Math.max(y0Top, y1Top);
  if (fill) {
    page.drawRectangle({
      x: x0,
      y: yPdf(bot),
      width: x1 - x0,
      height: bot - top,
      color: rgbOf(fill),
    });
  }
  drawHLine(page, x0, x1, top);
  drawHLine(page, x0, x1, bot);
  drawVLine(page, x0, top, bot);
  drawVLine(page, x1, top, bot);
}

/** Ascent/descent ratios from embedded fontkit metrics when available. */
function fontMetrics(font) {
  try {
    const f = font?.embedder?.font;
    if (f && f.unitsPerEm) {
      return {
        ascent: f.ascent / f.unitsPerEm,
        descent: Math.abs(f.descent) / f.unitsPerEm,
      };
    }
  } catch (_) {
    /* ignore */
  }
  return { ascent: WIN_ASCENT, descent: 0.25 };
}

function drawTextTop(page, text, x, yTop, size, font, opts = {}) {
  // opts.ascentRatio: override (use WIN_ASCENT for Windows-style conceptual tops)
  const ratio = opts.ascentRatio != null ? opts.ascentRatio : fontMetrics(font).ascent;
  const baselineTop = yTop + size * ratio;
  page.drawText(text, {
    x,
    y: yPdf(baselineTop),
    size,
    font,
    color: rgbOf(opts.color || BLACK),
  });
}

function drawTextInBox(page, text, x0, x1, y0Top, y1Top, size, font, opts = {}) {
  const tw = font.widthOfTextAtSize(text, size);
  const align = opts.align || "center";
  let x;
  if (align === "left") {
    x = x0 + (opts.padX != null ? opts.padX : 0);
  } else {
    x = x0 + (x1 - x0 - tw) / 2;
  }
  const mid = (y0Top + y1Top) / 2;
  const { ascent, descent } = fontMetrics(font);
  // Vertically center glyph box [baseline-ascent, baseline+descent] on cell mid
  const baselineTop = mid + (size * (ascent - descent)) / 2;
  page.drawText(text, {
    x,
    y: yPdf(baselineTop),
    size,
    font,
    color: rgbOf(opts.color || BLACK),
  });
}

function drawTextCenteredInBox(page, text, x0, x1, y0Top, y1Top, size, font, opts = {}) {
  drawTextInBox(page, text, x0, x1, y0Top, y1Top, size, font, { ...opts, align: "center" });
}

function drawLabelRight(page, lines, rightX, yTopFirst, size, font, gap = 10.5) {
  lines.forEach((line, i) => {
    const tw = font.widthOfTextAtSize(line, size);
    drawTextTop(page, line, rightX - tw, yTopFirst + i * gap, size, font);
  });
}

function todayBerlin() {
  const fmt = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  // de-DE typically dd.mm.yyyy
  return fmt.format(new Date());
}

function drawBeakLogo(page, fontLogo, fontBullet) {
  // SOLL: Aeonis letters @20pt gray #727272 + tracking spaces @~23pt,
  // then Constantia-Bold pink • (vector text, not a raster/circle).
  const letters = ["B", "E", "A", "K"];
  const letterSize = 20;
  const spaceSize = 23;
  const letterYTop = 66.0;
  let x = 437.85;
  for (let i = 0; i < letters.length; i++) {
    drawTextTop(page, letters[i], x, letterYTop, letterSize, fontLogo, {
      color: GRAY_LOGO,
      ascentRatio: fontMetrics(fontLogo).ascent,
    });
    x += fontLogo.widthOfTextAtSize(letters[i], letterSize);
    if (i < letters.length - 1) {
      x += fontLogo.widthOfTextAtSize(" ", spaceSize);
    }
  }
  // small gap (~15pt space in SOLL) then pink •
  x += 4.44;
  drawTextTop(page, "•", x, 64.66, letterSize, fontBullet, {
    color: PINK,
    ascentRatio: fontMetrics(fontBullet).ascent,
  });
}

function drawHeaderChrome(page, fonts) {
  const { font, fontLogo, fontBullet } = fonts;
  const xL = COL_X[0];
  const xR = COL_X[8];
  const y0 = 53.9;
  const yMid = 77.9;
  const y1 = 101.95;
  const xA = 178.0;
  const xB = 417.1;

  // outer + splits
  drawBox(page, xL, y0, xR, y1, null);
  drawVLine(page, xA, y0, y1);
  drawVLine(page, xB, y0, y1);
  drawHLine(page, xL, xA, yMid);

  drawTextTop(page, "Formblatt", 102.3, 60.4, 8, font);
  drawTextTop(page, "FBL 7.5 - 06", 99.6, 84.3, 8, font);
  drawTextTop(page, "Baugruppenlaufzettel", 249.5, 70.3, 11, font);
  drawBeakLogo(page, fontLogo, fontBullet);
}

function drawMetaFields(page, job, fonts, datum) {
  const { font, fontBold } = fonts;

  // Datum box (no fill)
  drawBox(page, 118.2, 113.9, 178.1, 137.96, null);
  drawTextCenteredInBox(page, datum, 118.2, 178.1, 113.9, 137.96, 11, font);

  // Baugruppe — value left-aligned (SOLL pad ≈ 8.6 pt), vertically centered; no fill
  drawBox(page, 237.8, 113.8, 536.7, 137.8, null);
  drawTextInBox(page, job.baugruppe, 237.8, 536.7, 113.8, 137.8, 12, fontBold, {
    align: "left",
    padX: BAUG_PAD_X,
  });

  // Stückzahl only (Etikett Startnummer / Buchstabe cells removed); no fill
  drawBox(page, 237.8, 143.8, 297.6, 167.8, null);
  drawTextCenteredInBox(page, String(job.stueckzahl), 237.8, 297.6, 143.8, 167.8, 12, fontBold);

  // Sachbearbeiter — no fill
  drawBox(page, 237.8, 173.8, 297.6, 197.8, null);
  drawTextCenteredInBox(page, job.sachbearbeiter, 237.8, 297.6, 173.8, 197.8, 12, fontBold);

  // Labels (7pt, right-aligned near x≈229) — no Etikett Startnummer / Buchstabe
  const labelX = 229.3;
  drawLabelRight(page, ["Baugruppen\u2010", "bezeichnung"], labelX, 117.5, 7, font, 10.5);
  drawLabelRight(page, ["Stückzahl", "pro\u00a0Auftrag"], labelX, 147.5, 7, font, 10.5);
  drawLabelRight(page, ["Sachbearbeiter", "Lager"], labelX, 177.4, 7, font, 10.5);

  // Datum label
  const dw = font.widthOfTextAtSize("Datum", 7);
  drawTextTop(page, "Datum", 109.8 - dw, 121.5, 7, font);
}

function drawTable(page, job, fonts, rowCount, snStartIndex) {
  const { font, fontBold } = fonts;
  const x0 = COL_X[0];
  const x1 = COL_X[8];
  // Exact H_LINES so fill-stamp inset never covers printed grid lines.
  const tableBot = H_LINES[rowCount + 1];

  // horizontal lines
  for (let i = 0; i <= rowCount + 1; i++) {
    drawHLine(page, x0, x1, H_LINES[i]);
  }

  // vertical lines
  for (const x of COL_X) {
    drawVLine(page, x, TABLE_TOP, tableBot);
  }

  // column headers (two lines, centered) — Windows-style vertical centering
  const cellMid = (TABLE_TOP + HEADER_BOT) / 2;
  const gap = 12.2;
  const sz = 8;
  const y0Top = cellMid - (gap + sz) / 2 + HEADER_NUDGE_Y;
  const y1Top = y0Top + gap;
  for (let c = 0; c < 8; c++) {
    const [l1, l2] = COL_HEADERS[c];
    const cx0 = COL_X[c];
    const cx1 = COL_X[c + 1];
    const tw1 = font.widthOfTextAtSize(l1, sz);
    const tw2 = font.widthOfTextAtSize(l2, sz);
    drawTextTop(page, l1, cx0 + (cx1 - cx0 - tw1) / 2, y0Top, sz, font, {
      ascentRatio: WIN_ASCENT,
    });
    drawTextTop(page, l2, cx0 + (cx1 - cx0 - tw2) / 2, y1Top, sz, font, {
      ascentRatio: WIN_ASCENT,
    });
  }

  // SN rows
  for (let i = 0; i < rowCount; i++) {
    const num = job.startnummer + snStartIndex + i;
    const sn = `${job.buchstabe}${String(num).padStart(5, "0")}`;
    const ry0 = H_LINES[i + 1];
    const ry1 = H_LINES[i + 2];
    drawTextCenteredInBox(page, sn, COL_X[0], COL_X[1], ry0, ry1, 12, fontBold);
  }
}

function drawPage(page, job, fonts, datum, rowCount, snStartIndex) {
  drawHeaderChrome(page, fonts);
  drawMetaFields(page, job, fonts, datum);
  drawTable(page, job, fonts, rowCount, snStartIndex);
}

/**
 * @param {import('./parse.js').Job} job
 * @returns {Promise<{ bytes: Uint8Array, filename: string }>}
 */
export async function generatePdf(job) {
  if (typeof PDFLib === "undefined") throw new Error("pdf-lib nicht geladen");

  const pdfDoc = await PDFLib.PDFDocument.create();
  if (typeof fontkit !== "undefined") {
    pdfDoc.registerFontkit(fontkit);
  }
  const fonts = await loadFonts(pdfDoc);
  const datum = todayBerlin();
  const pagesNeeded = Math.ceil(job.stueckzahl / 10);

  for (let p = 0; p < pagesNeeded; p++) {
    const remaining = job.stueckzahl - p * 10;
    const rows = Math.min(10, remaining);
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    drawPage(page, job, fonts, datum, rows, p * 10);
  }

  const bytes = await pdfDoc.save();
  return { bytes, filename: `${job.pdfStem}.pdf` };
}

/** Expose for tests */
export const _test = { todayBerlin, PAGE_W, PAGE_H, ROW_H };
