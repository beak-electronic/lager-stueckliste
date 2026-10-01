/**
 * Serial number extraction from DataMatrix / device code payloads.
 * Rule: SN = text after the last hyphen "-".
 *
 * Example:
 *   extractSerialFromPayload("DE-200.433-PA180DM-SPEKTRA-V1-BS0180E01A21K0103")
 *   → "BS0180E01A21K0103"
 *
 * Also accepts a bare serial (no hyphen) as-is.
 * Unicode dashes in the payload are treated like ASCII "-".
 */

/** UI / placeholder tokens that must never trigger a PDF search. */
const PLACEHOLDER_SERIALS = new Set(["", "—", "–", "−", "-", "‑", "‒"]);

/** Unicode dashes/minus → ASCII hyphen (keep in sync with catalog.normalizeDashes). */
function normalizeDashes(text) {
  return String(text ?? "").replace(
    /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g,
    "-"
  );
}

/**
 * @param {string} raw
 * @returns {string} trimmed serial or empty string
 */
export function extractSerialFromPayload(raw) {
  const text = normalizeDashes(String(raw ?? "")).trim();
  if (!text) return "";
  const idx = text.lastIndexOf("-");
  if (idx === -1) return text;
  const sn = text.slice(idx + 1).trim();
  return sn;
}

/**
 * Lightweight sanity check for BEAK-style device serials (letters/digits).
 * @param {string} sn
 * @returns {boolean}
 */
export function looksLikeSerial(sn) {
  const s = String(sn || "").trim();
  return /^[A-Z0-9][A-Z0-9._]{4,40}$/i.test(s);
}

/**
 * True when SN is non-empty, not a UI placeholder (—, -, whitespace), and looks valid.
 * Use before any catalog search / PDF open.
 * @param {string} sn
 * @returns {boolean}
 */
export function isUsableSerial(sn) {
  const s = String(sn ?? "").trim();
  if (!s || PLACEHOLDER_SERIALS.has(s)) return false;
  return looksLikeSerial(s);
}
