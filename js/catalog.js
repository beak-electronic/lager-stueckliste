/**
 * Resolve a Laufzettel PDF by serial (text after last hyphen in filename).
 * Matches `{SN}.pdf` or `…-{SN}.pdf` (e.g. DE-200.433-BS0180….pdf).
 * Order: directory handle (Chrome/Edge) → IndexedDB blob catalog (iPad) → bundled samples/.
 * User imports always win over demo samples.
 */

const IDB_NAME = "lager-stueckliste-catalog-v1";
const IDB_VERSION = 2;
const IDB_STORE_HANDLES = "handles";
const IDB_STORE_PDFS = "pdfs";
const DIR_KEY = "pdf-folder";
const META_KEY = "pdf-catalog-meta";

/** @type {Map<string, FileSystemFileHandle>} canonicalSerial → file handle from last folder re-index */
let folderPdfMap = new Map();
/** @type {string|null} */
let folderIndexName = null;
/** @type {number|null} */
let folderIndexAt = null;

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === "function";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_HANDLES)) {
        db.createObjectStore(IDB_STORE_HANDLES);
      }
      if (!db.objectStoreNames.contains(IDB_STORE_PDFS)) {
        db.createObjectStore(IDB_STORE_PDFS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    if (value === null || value === undefined) {
      tx.objectStore(store).delete(key);
    } else {
      tx.objectStore(store).put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbCount(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearStore(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Normalize Unicode dashes/minus to ASCII hyphen so filename SN matches DataMatrix SN.
 * Covers hyphen, non-breaking hyphen, figure dash, en/em dash, minus, small/fullwidth hyphen-minus.
 */
export function normalizeDashes(text) {
  return String(text ?? "").replace(
    /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g,
    "-"
  );
}

/**
 * Canonical IDB / map key: trimmed, dashes normalized, uppercased.
 * @param {string} sn
 * @returns {string}
 */
export function canonicalizeSerial(sn) {
  return normalizeDashes(String(sn ?? "").trim()).toUpperCase();
}

/**
 * Serial from PDF filename: text after the last hyphen in the stem.
 * e.g. DE-200.433-BS0180E01A21K0103.pdf → BS0180E01A21K0103
 * Plain SN.pdf (no hyphen) → full stem.
 * Unicode dashes in the filename are treated like ASCII "-".
 */
export function serialFromPdfFilename(name) {
  const stem = normalizeDashes(String(name || "").replace(/\.pdf$/i, ""));
  const i = stem.lastIndexOf("-");
  if (i >= 0 && i < stem.length - 1) {
    const sn = stem.slice(i + 1).trim();
    if (sn) return sn;
  }
  return stem;
}

/** True if filename equals SN.pdf or ends with -SN.pdf (SN compared case-insensitively). */
export function filenameMatchesSerial(name, serial) {
  const sn = canonicalizeSerial(serial);
  if (!sn || !isPdfFilename(name)) return false;
  return canonicalizeSerial(serialFromPdfFilename(name)) === sn;
}

function isPdfFilename(name) {
  return /\.pdf$/i.test(String(name || ""));
}

export async function savePdfFolderHandle(handle) {
  if (!handle) return;
  await idbSet(IDB_STORE_HANDLES, DIR_KEY, handle);
}

export async function getPdfFolderHandle() {
  try {
    return await idbGet(IDB_STORE_HANDLES, DIR_KEY);
  } catch (_) {
    return null;
  }
}

export async function clearPdfFolderHandle() {
  try {
    await idbSet(IDB_STORE_HANDLES, DIR_KEY, null);
  } catch (_) {}
  folderPdfMap.clear();
  folderIndexName = null;
  folderIndexAt = null;
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
async function ensureDirPermission(handle) {
  if (!handle) return false;
  try {
    if (handle.queryPermission) {
      let perm = await handle.queryPermission({ mode: "read" });
      if (perm === "granted") return true;
      if (handle.requestPermission) {
        perm = await handle.requestPermission({ mode: "read" });
        return perm === "granted";
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Re-scan persisted directory handle into an in-memory serial→handle map.
 * Call on app start (desktop) and after picking a folder.
 * @returns {Promise<{ok: boolean, reason?: string, count: number, folderName?: string}>}
 */
export async function reindexPdfFolder() {
  const dir = await getPdfFolderHandle();
  if (!dir) {
    folderPdfMap.clear();
    folderIndexName = null;
    folderIndexAt = null;
    return { ok: false, reason: "no-handle", count: 0 };
  }
  if (!(await ensureDirPermission(dir))) {
    return { ok: false, reason: "permission", count: 0, folderName: dir.name };
  }

  const next = new Map();
  try {
    if (typeof dir.entries === "function") {
      for await (const [name, handle] of dir.entries()) {
        if (!handle || handle.kind !== "file") continue;
        if (!isPdfFilename(name)) continue;
        const key = canonicalizeSerial(serialFromPdfFilename(name));
        if (key) next.set(key, handle);
      }
    } else if (typeof dir.values === "function") {
      for await (const handle of dir.values()) {
        if (!handle || handle.kind !== "file") continue;
        const name = handle.name || "";
        if (!isPdfFilename(name)) continue;
        const key = canonicalizeSerial(serialFromPdfFilename(name));
        if (key) next.set(key, handle);
      }
    }
  } catch (err) {
    console.warn("reindexPdfFolder failed", err);
    return { ok: false, reason: "scan-failed", count: 0, folderName: dir.name };
  }

  folderPdfMap = next;
  folderIndexName = dir.name || null;
  folderIndexAt = Date.now();
  return { ok: true, count: next.size, folderName: dir.name };
}

export function getFolderIndexInfo() {
  return {
    count: folderPdfMap.size,
    folderName: folderIndexName,
    indexedAt: folderIndexAt,
  };
}

/**
 * Ask user to pick a folder of Laufzettel PDFs (Chrome/Edge).
 */
export async function pickPdfFolder() {
  if (!supportsDirectoryPicker()) {
    throw new Error("Ordnerauswahl wird von diesem Browser nicht unterstützt.");
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
  await savePdfFolderHandle(handle);
  await reindexPdfFolder();
  return handle;
}

async function getCatalogMeta() {
  try {
    return (await idbGet(IDB_STORE_HANDLES, META_KEY)) || null;
  } catch (_) {
    return null;
  }
}

async function setCatalogMeta(meta) {
  await idbSet(IDB_STORE_HANDLES, META_KEY, meta);
}

/**
 * @returns {Promise<{count: number, lastUpdated: number|null}>}
 */
export async function getIdbCatalogStats() {
  let count = 0;
  try {
    count = await idbCount(IDB_STORE_PDFS);
  } catch (_) {
    count = 0;
  }
  const meta = await getCatalogMeta();
  return {
    count,
    lastUpdated: meta?.lastUpdated ?? null,
  };
}

/**
 * Merge/replace PDFs from a multi-file pick (iPad Files).
 * Key = canonical serial (text after last hyphen, uppercased).
 * @param {FileList|File[]} fileList
 * @returns {Promise<{imported: number, total: number}>}
 */
export async function mergePdfsFromFileList(fileList) {
  // Snapshot immediately — iOS may invalidate FileList after the change handler yields.
  const files = Array.from(fileList || []).filter((f) => f && isPdfFilename(f.name));
  if (!files.length) {
    const stats = await getIdbCatalogStats();
    return { imported: 0, total: stats.count };
  }

  // Read blobs before opening the IDB transaction (transactions close across awaits).
  const prepared = [];
  for (const file of files) {
    const serial = canonicalizeSerial(serialFromPdfFilename(file.name));
    if (!serial) continue;
    const data = await file.arrayBuffer();
    prepared.push({
      serial,
      record: {
        name: file.name,
        type: file.type || "application/pdf",
        data,
        updatedAt: Date.now(),
      },
    });
  }

  if (!prepared.length) {
    const stats = await getIdbCatalogStats();
    return { imported: 0, total: stats.count };
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_PDFS, "readwrite");
    const store = tx.objectStore(IDB_STORE_PDFS);
    for (const item of prepared) {
      store.put(item.record, item.serial);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const total = await idbCount(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: Date.now(), count: total });
  return { imported: prepared.length, total };
}


/**
 * After save: replace the IndexedDB catalog entry for this PDF so the next
 * scan opens the filled blob (not the pre-save import).
 * @param {Blob|ArrayBuffer|Uint8Array} blob
 * @param {string} name
 * @returns {Promise<{ok: boolean, serial?: string, total?: number}>}
 */
export async function upsertSavedPdf(blob, name) {
  const serial = canonicalizeSerial(serialFromPdfFilename(name));
  if (!serial || !blob) return { ok: false };
  let data;
  if (blob instanceof ArrayBuffer) data = blob;
  else if (blob instanceof Uint8Array) data = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  else data = await blob.arrayBuffer();

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_PDFS, "readwrite");
    tx.objectStore(IDB_STORE_PDFS).put(
      {
        name: name || `${serial}.pdf`,
        type: "application/pdf",
        data,
        updatedAt: Date.now(),
      },
      serial
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const total = await idbCount(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: Date.now(), count: total });
  return { ok: true, serial, total };
}

export async function clearIdbCatalog() {
  await idbClearStore(IDB_STORE_PDFS);
  await setCatalogMeta({ lastUpdated: null, count: 0 });
}

async function findInFolderMap(serial) {
  const key = canonicalizeSerial(serial);
  const handle = folderPdfMap.get(key) || folderPdfMap.get(serial);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return { file, fileHandle: handle, source: "folder" };
  } catch (_) {
    return null;
  }
}

async function findInDirectoryHandle(serial) {
  const dir = await getPdfFolderHandle();
  if (!dir || !(await ensureDirPermission(dir))) return null;
  const raw = String(serial || "").trim();
  const canon = canonicalizeSerial(raw);
  // Exact SN.pdf first (original + upper/lower + .pdf/.PDF)
  const nameTries = new Set([
    `${raw}.pdf`,
    `${raw}.PDF`,
    `${canon}.pdf`,
    `${canon}.PDF`,
    `${raw.toLowerCase()}.pdf`,
    `${raw.toLowerCase()}.PDF`,
  ]);
  for (const name of nameTries) {
    try {
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      return { file, fileHandle, source: "folder" };
    } catch (_) {
      /* not in folder */
    }
  }
  // Scan for …-{SN}.pdf (header-style names)
  try {
    if (typeof dir.entries === "function") {
      for await (const [name, handle] of dir.entries()) {
        if (!handle || handle.kind !== "file") continue;
        if (!filenameMatchesSerial(name, serial)) continue;
        const file = await handle.getFile();
        return { file, fileHandle: handle, source: "folder" };
      }
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function fileFromIdbEntry(entry, serial) {
  const bytes = entry.data;
  const name = entry.name || `${serial}.pdf`;
  const type = entry.type || "application/pdf";
  // Blob first — more reliable than raw ArrayBuffer on some WebKit builds.
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const file = new File([blob], name, { type });
  return { file, fileHandle: null, source: "idb" };
}

async function idbGetPdfEntryByKey(serial) {
  const canon = canonicalizeSerial(serial);
  const raw = String(serial || "").trim();
  const tries = [...new Set([canon, raw, raw.toUpperCase(), raw.toLowerCase()].filter(Boolean))];
  for (const key of tries) {
    const entry = await idbGet(IDB_STORE_PDFS, key);
    if (entry && entry.data) return entry;
  }
  return null;
}

/** Scan all IDB PDF records for a filename matching …-{SN}.pdf / {SN}.pdf (legacy keys). */
async function idbFindPdfEntryByFilenameScan(serial) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_PDFS, "readonly");
    const store = tx.objectStore(IDB_STORE_PDFS);
    const req = store.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(null);
        return;
      }
      const entry = cursor.value;
      const name = entry?.name || String(cursor.key || "");
      if (entry?.data && filenameMatchesSerial(name, serial)) {
        resolve(entry);
        return;
      }
      // Also match if the key itself is the serial (odd legacy shapes)
      if (entry?.data && canonicalizeSerial(String(cursor.key)) === canonicalizeSerial(serial)) {
        resolve(entry);
        return;
      }
      cursor.continue();
    };
  });
}

async function findInIdbCatalog(serial) {
  try {
    let entry = await idbGetPdfEntryByKey(serial);
    if (!entry) {
      entry = await idbFindPdfEntryByFilenameScan(serial);
    }
    if (!entry || !entry.data) return null;
    return fileFromIdbEntry(entry, canonicalizeSerial(serial));
  } catch (_) {
    return null;
  }
}

function isPlaceholderSerial(serial) {
  const s = String(serial || "").trim();
  return !s || s === "—" || s === "–" || s === "−" || s === "-" || s === "‑" || s === "‒";
}

async function blobLooksLikePdf(blob) {
  if (!blob || blob.size < 5) return false;
  const type = (blob.type || "").toLowerCase();
  if (type.includes("pdf")) return true;
  if (type.includes("html") || type.includes("text/")) return false;
  try {
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    return (
      head[0] === 0x25 &&
      head[1] === 0x50 &&
      head[2] === 0x44 &&
      head[3] === 0x46
    ); // %PDF
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} sn
 * @returns {Promise<{file: File, fileHandle: FileSystemFileHandle|null, source: string}|null>}
 */
/** @type {string[]|null} */
let samplesIndexCache = null;

async function loadSamplesIndex() {
  if (samplesIndexCache) return samplesIndexCache;
  try {
    const res = await fetch("./samples/index.json", { method: "GET" });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.files;
      if (Array.isArray(list)) {
        samplesIndexCache = list.map(String).filter(isPdfFilename);
        return samplesIndexCache;
      }
    }
  } catch (_) {
    /* fall through */
  }
  samplesIndexCache = [];
  return samplesIndexCache;
}

/** Abortable fetch so a hanging samples/ request cannot block IDB hits forever. */
async function fetchWithTimeout(url, ms = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { method: "GET", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function findInSamples(serial) {
  const index = await loadSamplesIndex();
  const fromIndex = index.filter((name) => filenameMatchesSerial(name, serial));
  const candidates = [
    ...fromIndex.map((name) => ({
      url: `./samples/${encodeURIComponent(name).replace(/%2F/gi, "/")}`,
      name,
    })),
    { url: `./samples/${serial}.pdf`, name: `${serial}.pdf` },
    { url: `./samples/${serial}.PDF`, name: `${serial}.PDF` },
    { url: `./samples/${canonicalizeSerial(serial)}.pdf`, name: `${canonicalizeSerial(serial)}.pdf` },
  ];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    try {
      const res = await fetchWithTimeout(c.url, 4000);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!(await blobLooksLikePdf(blob))) continue;
      const file = new File([blob], c.name || `${serial}.pdf`, { type: "application/pdf" });
      return { file, fileHandle: null, source: "samples" };
    } catch (_) {
      /* continue — timeout / network / abort */
    }
  }
  return null;
}

export async function findPdfBySerial(sn) {
  const serial = String(sn || "").trim();
  // Never search/open for empty or UI placeholder serials (—, -, whitespace).
  if (isPlaceholderSerial(serial)) return null;

  // Prefer user catalogs (folder / IDB imports) over bundled demos so
  // „PDFs aktualisieren“ reliably opens the file that was just imported.
  const fromMap = await findInFolderMap(serial);
  if (fromMap) return fromMap;

  const fromDir = await findInDirectoryHandle(serial);
  if (fromDir) return fromDir;

  const fromIdb = await findInIdbCatalog(serial);
  if (fromIdb) return fromIdb;

  const fromSamples = await findInSamples(serial);
  if (fromSamples) return fromSamples;

  return null;
}

export function formatCatalogUpdated(ts) {
  if (!ts) return "noch nie";
  try {
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toLocaleString("de-DE");
  }
}
