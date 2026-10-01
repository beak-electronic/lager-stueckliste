/** Fixed A4 Baugruppenlaufzettel process-cell grid (PDF points, top-left origin). */

export const PAGE_WIDTH = 595.304;
export const PAGE_HEIGHT = 841.89;

export const V_LINES = [58.5, 118.2, 178.0, 237.8, 297.6, 357.4, 417.1, 476.9, 536.7];
export const H_LINES = [209.75, 243.48, 292.97, 342.46, 391.95, 441.44, 490.93, 540.42, 589.91, 639.4, 688.89, 738.38];

export const PROCESS_COLS = [1, 2, 3, 4, 5, 6, 7];
export const DATA_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const INSET = 6;
/** White fill behind stamp text (overlay + pdf-lib). */
export const FILL_WHITE = { r: 255, g: 255, b: 255 };

/**
 * @typedef {{ col: number, row: number, x0: number, y0: number, x1: number, y1: number }} Cell
 */

/** @type {Cell[]} */
export const emptyCells = (() => {
  const cells = [];
  for (const ri of DATA_ROWS) {
    for (const ci of PROCESS_COLS) {
      cells.push({
        col: ci,
        row: ri,
        x0: V_LINES[ci],
        y0: H_LINES[ri],
        x1: V_LINES[ci + 1],
        y1: H_LINES[ri + 1],
      });
    }
  }
  return cells;
})();

/**
 * Process-column header band (H_LINES[0]..[1]) — tap targets only, not stamped.
 * SN column (ci=0 / V_LINES[0]..[1]) is excluded.
 * @type {Cell[]}
 */
export const headerCells = PROCESS_COLS.map((ci) => ({
  col: ci,
  row: 0,
  x0: V_LINES[ci],
  y0: H_LINES[0],
  x1: V_LINES[ci + 1],
  y1: H_LINES[1],
}));

/** Data cells for one process column (10 rows). */
export function cellsInColumn(col) {
  return emptyCells.filter((c) => c.col === col);
}

export function cellKey(pageIndex, col, row) {
  return `${pageIndex}-${col}-${row}`;
}

/** Top-down rect → pdf-lib / PDF bottom-left bounds. */
export function toBottomLeft(cell, pageHeight = PAGE_HEIGHT) {
  const width = cell.x1 - cell.x0;
  const height = cell.y1 - cell.y0;
  return {
    x: cell.x0,
    y: pageHeight - cell.y1,
    width,
    height,
  };
}

/** Inset rect in bottom-left space. */
export function insetBottomLeft(cell, pageHeight = PAGE_HEIGHT, inset = INSET) {
  const full = toBottomLeft(cell, pageHeight);
  return {
    x: full.x + inset,
    y: full.y + inset,
    width: Math.max(0, full.width - inset * 2),
    height: Math.max(0, full.height - inset * 2),
  };
}

/** CSS % positions for overlay (top-left origin relative to page). */
export function cellCssPercent(cell, pageWidth = PAGE_WIDTH, pageHeight = PAGE_HEIGHT) {
  return {
    left: (cell.x0 / pageWidth) * 100,
    top: (cell.y0 / pageHeight) * 100,
    width: ((cell.x1 - cell.x0) / pageWidth) * 100,
    height: ((cell.y1 - cell.y0) / pageHeight) * 100,
  };
}

/** Inset CSS % for visual stamp preview on overlay canvas. */
export function insetCssPercent(cell, pageWidth = PAGE_WIDTH, pageHeight = PAGE_HEIGHT, inset = INSET) {
  return {
    left: ((cell.x0 + inset) / pageWidth) * 100,
    top: ((cell.y0 + inset) / pageHeight) * 100,
    width: ((cell.x1 - cell.x0 - inset * 2) / pageWidth) * 100,
    height: ((cell.y1 - cell.y0 - inset * 2) / pageHeight) * 100,
  };
}
