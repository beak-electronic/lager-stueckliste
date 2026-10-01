import { initFill } from "./fill.js";
import {
  pickPdfFolder,
  getPdfFolderHandle,
  clearPdfFolderHandle,
  supportsDirectoryPicker,
  reindexPdfFolder,
  getFolderIndexInfo,
} from "./catalog.js";

const STORAGE_KEY = "lager-stueckliste-settings-v1";

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  saveMode: "auto",
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state.settings, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (_) {}
  if (!state.settings.saveMode) state.settings.saveMode = "auto";
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch (_) {}
}

function setStatus(text, kind = "") {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function showToast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 3600);
}

/** No-op stub: cameras removed; fill.js may still call this. */
export async function ensureCamerasReleased() {}

function syncSettingsForm() {
  const saveMode = $("#settings-save-mode");
  if (saveMode) saveMode.value = state.settings.saveMode || "auto";
}

function readSettingsFromForm() {
  const saveMode = $("#settings-save-mode");
  if (saveMode) state.settings.saveMode = saveMode.value || "auto";
}

async function refreshFolderLabel() {
  const el = $("#settings-folder-label");
  if (!el) return;
  if (!supportsDirectoryPicker()) {
    el.textContent =
      "Ordnerwahl nicht verfügbar in diesem Browser (z. B. iPad Safari).";
    return;
  }
  const handle = await getPdfFolderHandle();
  const info = getFolderIndexInfo();
  if (handle?.name) {
    const countPart =
      info.folderName === handle.name && info.count >= 0
        ? ` · ${info.count} PDF(s) beim Start eingelesen`
        : "";
    el.textContent = `Aktueller Ordner: ${handle.name}${countPart}`;
  } else {
    el.textContent = "Kein Ordner gewählt.";
  }
}

function syncFolderPlatformUi() {
  const hasDir = supportsDirectoryPicker();
  const folderBlock = $("#settings-folder-block");
  const pickBtn = $("#btn-pick-folder");
  const clearBtn = $("#btn-clear-folder");
  if (folderBlock) {
    folderBlock.classList.toggle("is-unsupported", !hasDir);
  }
  if (pickBtn) {
    pickBtn.disabled = !hasDir;
    pickBtn.title = hasDir
      ? "Ordner mit Lager-Stücklisten-PDFs wählen"
      : "In diesem Browser nicht verfügbar (z. B. iPad Safari)";
  }
  if (clearBtn) {
    clearBtn.disabled = !hasDir;
  }
}

async function refreshCatalogUi() {
  syncFolderPlatformUi();
  await refreshFolderLabel();
}

async function openSettings() {
  const dlg = $("#home-settings-dialog");
  syncSettingsForm();
  await refreshCatalogUi();
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeSettings() {
  const dlg = $("#home-settings-dialog");
  readSettingsFromForm();
  saveSettings();
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

/**
 * Desktop: request permission + re-index remembered folder into memory map.
 */
async function startupCatalogRefresh() {
  syncFolderPlatformUi();
  if (!supportsDirectoryPicker()) {
    await refreshCatalogUi();
    return;
  }
  const handle = await getPdfFolderHandle();
  if (!handle) {
    await refreshCatalogUi();
    return;
  }
  setStatus("PDF-Ordner wird neu eingelesen…", "busy");
  const result = await reindexPdfFolder();
  await refreshCatalogUi();
  if (result?.ok) {
    setStatus(
      result.count
        ? `Ordner „${result.folderName || handle.name}“: ${result.count} PDF(s) eingelesen`
        : `Ordner „${result.folderName || handle.name}“: keine PDFs gefunden`
    );
  } else if (result?.reason === "permission") {
    setStatus("PDF-Ordner: Zugriff verweigert", "error");
    showToast("Ordnerzugriff nicht erteilt — in den Einstellungen erneut wählen.");
  } else {
    setStatus("Bereit – Lager Stückliste öffnen");
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW register failed", err);
    });
  });
}

function syncThemeChrome() {
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const color = dark ? "#1c1c1e" : "#ffffff";
  let live = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!live) {
    live = document.createElement("meta");
    live.name = "theme-color";
    document.head.insertBefore(live, document.head.firstChild);
  }
  live.setAttribute("content", color);
  for (const m of document.querySelectorAll('meta[name="theme-color"][media]')) {
    if (m.media.includes("dark") && dark) m.setAttribute("content", color);
    if (m.media.includes("light") && !dark) m.setAttribute("content", color);
  }
}

function wireUi() {
  $("#btn-home-settings")?.addEventListener("click", openSettings);
  $("#btn-home-settings-done")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeSettings();
  });
  $("#home-settings-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    closeSettings();
  });
  $("#btn-pick-folder")?.addEventListener("click", async () => {
    try {
      const handle = await pickPdfFolder();
      const info = getFolderIndexInfo();
      showToast(`Ordner „${handle.name}“ · ${info.count} PDF(s) eingelesen`);
      await refreshCatalogUi();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      showToast(err?.message || "Ordner konnte nicht gewählt werden");
    }
  });
  $("#btn-clear-folder")?.addEventListener("click", async () => {
    await clearPdfFolderHandle();
    await refreshCatalogUi();
    showToast("Ordnerzuordnung entfernt");
  });
}

function init() {
  loadSettings();
  syncThemeChrome();
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => syncThemeChrome();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (_) {}

  setStatus("Bereit – Lager Stückliste öffnen");
  wireUi();
  initFill();
  registerSW();
  // Remembered Windows folder: re-index after UI is live
  startupCatalogRefresh().catch((err) => {
    console.warn("startup folder refresh failed", err);
  });
}

init();

export function getSaveMode() {
  return state.settings.saveMode || "auto";
}

/** Kept for fill.js compatibility (generator auto-increment unused here). */
export function onStampSaved() {}

/** Called after catalog changes if fill.js needs a hook. */
export async function onPdfCatalogUpdated() {
  await refreshCatalogUi();
}
