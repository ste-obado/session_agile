// settings.js
// Every value here is read by another part of the extension:
//   - keepTabActive      -> background.js (autoDiscardable behavior)
//   - backendUrl         -> library.js (already wired)
//   - walkthroughStyle   -> library.js (reading vs chat rendering)
//   - autoRequestOnStop  -> background.js (not yet triggered from there —
//                           left for a future change, stored now so the
//                           UI and storage shape are ready for it)
//   - retentionDays      -> applied here, on this page's own load, and
//                           also re-applied each time library.html opens

const DEFAULTS = {
  keepTabActive: true,
  backendUrl: "http://localhost:8000/walkthrough",
  walkthroughStyle: "reading",
  autoRequestOnStop: false,
  retentionDays: "never"
};

const DB_NAME = "ClassRecordings";
const STORE_NAME = "recordings";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function clearAllRecordings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Exported for library.js to call on load too, so retention is enforced
// whenever the library is opened, not only from this settings page.
async function applyRetentionPolicy(retentionDays) {
  if (retentionDays === "never" || !retentionDays) return 0;
  const cutoffMs = Date.now() - Number(retentionDays) * 24 * 60 * 60 * 1000;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    let deleted = 0;
    req.onsuccess = () => {
      req.result.forEach((record) => {
        if (record.startTime < cutoffMs) {
          store.delete(record.id);
          deleted++;
        }
      });
    };
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
  });
}

function showStatus(text) {
  const el = document.getElementById("save-status");
  el.textContent = text;
  el.classList.add("saved");
  setTimeout(() => {
    el.textContent = "";
    el.classList.remove("saved");
  }, 2000);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };

  document.getElementById("keep-active-toggle").checked = settings.keepTabActive;
  document.getElementById("backend-url-input").value = settings.backendUrl;
  document.getElementById("style-select").value = settings.walkthroughStyle;
  document.getElementById("auto-request-toggle").checked = settings.autoRequestOnStop;
  document.getElementById("retention-select").value = settings.retentionDays;

  document.getElementById("version-value").textContent = chrome.runtime.getManifest().version;

  const commands = await chrome.commands.getAll();
  const toggleCommand = commands.find((c) => c.name === "toggle-recording");
  document.getElementById("shortcut-value").textContent =
    toggleCommand && toggleCommand.shortcut
      ? toggleCommand.shortcut
      : "Not set";
}

function wireSetting(elementId, storageKey, eventName = "change") {
  const el = document.getElementById(elementId);
  el.addEventListener(eventName, async () => {
    const value = el.type === "checkbox" ? el.checked : el.value;
    await chrome.storage.local.set({ [storageKey]: value });
    showStatus("Saved");
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  wireSetting("keep-active-toggle", "keepTabActive");
  wireSetting("backend-url-input", "backendUrl", "blur");
  wireSetting("style-select", "walkthroughStyle");
  wireSetting("auto-request-toggle", "autoRequestOnStop");
  wireSetting("retention-select", "retentionDays");

  document.getElementById("change-shortcut-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  document.getElementById("clear-all-btn").addEventListener("click", async () => {
    if (!confirm("Delete every saved recording on this device? This can't be undone.")) return;
    await clearAllRecordings();
    showStatus("All recordings cleared");
  });

  document.getElementById("back-btn").addEventListener("click", () => {
    window.location.href = "library.html";
  });
});
