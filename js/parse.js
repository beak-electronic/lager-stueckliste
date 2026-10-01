/**
 * Parse free-text BG-Laufzettel input.
 * Input is ONLY Stückzahl + Baugruppenbezeichnung.
 * buchstabe / startnummer / sachbearbeiter come from defaults (settings).
 */

export class Job {
  constructor({ baugruppe, stueckzahl, buchstabe, startnummer, sachbearbeiter }) {
    this.baugruppe = baugruppe;
    this.stueckzahl = stueckzahl;
    this.buchstabe = buchstabe;
    this.startnummer = startnummer;
    this.sachbearbeiter = sachbearbeiter;
  }

  /** Drop leading article number like 100.123 */
  get pdfStem() {
    const name = this.baugruppe.replace(/^\d+(?:\.\d+)?\s+/, "").trim();
    return name || this.baugruppe;
  }
}

const QTY = /\b(\d+)\s*x\b/i;
const QTY_BARE = /\b(\d+)\b/g;

/**
 * @param {string} text
 * @param {{ buchstabe?: string, startnummer?: number|string, sachbearbeiter?: string }} [defaults]
 * @returns {Job}
 */
export function parseJob(text, defaults = {}) {
  const raw = text.trim().split(/\s+/).join(" ");
  if (!raw) throw new Error("Leere Eingabe");

  let working = raw;
  let stueckzahl = null;

  let m = QTY.exec(working);
  if (m) {
    stueckzahl = parseInt(m[1], 10);
    working = (working.slice(0, m.index) + " " + working.slice(m.index + m[0].length)).trim();
  } else {
    const candidates = [];
    QTY_BARE.lastIndex = 0;
    let bm;
    while ((bm = QTY_BARE.exec(working)) !== null) {
      const start = bm.index;
      if (start > 0 && working[start - 1] === ".") continue;
      if (start > 0 && /[A-Za-zÄÖÜäöü]/.test(working[start - 1])) continue;
      candidates.push({ index: start, len: bm[0].length, value: bm[1] });
    }
    if (!candidates.length) throw new Error("Stückzahl nicht gefunden (z. B. 45x)");
    const c = candidates[0];
    stueckzahl = parseInt(c.value, 10);
    working = (working.slice(0, c.index) + " " + working.slice(c.index + c.len)).trim();
  }

  const baugruppe = working.trim();
  if (!baugruppe) throw new Error("Baugruppen-Bezeichnung nicht gefunden");
  if (stueckzahl < 1) throw new Error("Stückzahl muss >= 1 sein");

  const buchstabeRaw = defaults.buchstabe != null ? String(defaults.buchstabe) : "B";
  const buchstabe = buchstabeRaw.trim().charAt(0).toUpperCase() || "B";
  const startnummer = parseInt(defaults.startnummer, 10);
  if (!Number.isFinite(startnummer) || startnummer < 0) {
    throw new Error("Startnummer in den Einstellungen fehlt oder ist ungültig");
  }
  const sachbearbeiter = String(defaults.sachbearbeiter || "").trim();
  if (!sachbearbeiter) throw new Error("Sachbearbeiter in den Einstellungen fehlt");

  return new Job({ baugruppe, stueckzahl, buchstabe, startnummer, sachbearbeiter });
}
