// library.js
// Runs as an extension page (chrome-extension://<id>/library.html), which
// shares its origin — and therefore its IndexedDB database — with
// offscreen.html. No messaging needed to read recordings, just open the DB.

const DB_NAME = "ClassRecordings";
const STORE_NAME = "recordings";
const DEFAULT_BACKEND_URL = "http://localhost:8000/walkthrough";

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

async function getAllRecordings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startTime - a.startTime));
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecording(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateWalkthrough(id, walkthrough) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      record.walkthrough = walkthrough;
      store.put(record);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// "42m recorded on Sep 5, 2026" — a sentence, not dot-joined fragments.
function formatMeta(record) {
  const sec = Math.max(0, Math.round((record.endTime - record.startTime) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const duration = m > 0 ? `${m}m ${s}s` : `${s}s`;
  const date = new Date(record.startTime).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric"
  });
  let meta = `${duration} recorded on ${date}`;
  if (record.downloadLog && record.downloadLog.length > 0) {
    const n = record.downloadLog.length;
    meta += n === 1
      ? " — you downloaded a file during this class"
      : ` — you downloaded ${n} files during this class`;
  }
  return meta;
}

async function getBackendUrl() {
  const stored = await chrome.storage.local.get("backendUrl");
  return stored.backendUrl || DEFAULT_BACKEND_URL;
}

async function requestWalkthrough(record, panel, bodyText, button) {
  button.disabled = true;
  button.textContent = "Reading through the lecture…";
  panel.style.display = "block";
  bodyText.textContent = "Sending the recording for transcription and a walkthrough — this can take a while for longer classes.";

  try {
    const backendUrl = await getBackendUrl();
    const formData = new FormData();
    formData.append("audio", record.audioBlob, "recording.webm");
    formData.append("downloadLog", JSON.stringify(record.downloadLog || []));
    formData.append("tabTitle", record.tabTitle || "");

    const res = await fetch(backendUrl, { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const data = await res.json();

    bodyText.textContent = data.walkthrough || "No walkthrough text came back.";
    await updateWalkthrough(record.id, data.walkthrough || "");
    button.textContent = "Read again";
  } catch (err) {
    bodyText.textContent =
      "Couldn't reach the backend at " + (await getBackendUrl()) +
      ". Make sure it's running.\n\n" + err.message;
    button.textContent = "Read the walkthrough";
  } finally {
    button.disabled = false;
  }
}

function renderCard(record) {
  const rec = document.createElement("div");
  rec.className = "rec" + (record.walkthrough ? " has-walkthrough" : "");

  rec.innerHTML = `
    <div class="rec-bar"></div>
    <div class="rec-body">
      <p class="rec-title">${record.tabTitle || "Untitled class"}</p>
      <p class="rec-meta">${formatMeta(record)}</p>
      <div class="rec-actions">
        <button class="play-btn">Play</button>
        <button class="download-btn">Download audio</button>
        <button class="walkthrough-btn primary">${record.walkthrough ? "Read again" : "Read the walkthrough"}</button>
        <button class="delete-btn">Delete</button>
      </div>
      <audio class="rec-audio" controls></audio>
      <div class="page-panel">
        <h3>Walkthrough</h3>
        <div class="body-text"></div>
        <div class="followup-row">
          <input type="text" placeholder="Ask a follow-up question (coming soon)" disabled>
          <button disabled>Ask</button>
        </div>
      </div>
    </div>
  `;

  const audioUrl = URL.createObjectURL(record.audioBlob);
  const audioEl = rec.querySelector(".rec-audio");
  const panel = rec.querySelector(".page-panel");
  const bodyText = rec.querySelector(".body-text");
  const walkthroughBtn = rec.querySelector(".walkthrough-btn");

  if (record.walkthrough) {
    bodyText.textContent = record.walkthrough;
  }

  rec.querySelector(".play-btn").addEventListener("click", () => {
    audioEl.src = audioUrl;
    audioEl.style.display = "block";
    audioEl.play();
  });

  rec.querySelector(".download-btn").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = `${(record.tabTitle || "recording").replace(/[^a-z0-9]/gi, "_")}.webm`;
    a.click();
  });

  walkthroughBtn.addEventListener("click", () => {
    if (record.walkthrough) {
      panel.style.display = panel.style.display === "none" || !panel.style.display ? "block" : "none";
      return;
    }
    requestWalkthrough(record, panel, bodyText, walkthroughBtn);
  });

  rec.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm("Delete this recording? This can't be undone.")) return;
    await deleteRecording(record.id);
    rec.remove();
  });

  return rec;
}

async function render() {
  const listEl = document.getElementById("rec-list");
  const recordings = await getAllRecordings();

  if (recordings.length === 0) {
    listEl.innerHTML = '<p class="empty">No recordings yet. Start one from the toolbar icon while you\'re in a class.</p>';
    return;
  }

  listEl.innerHTML = "";
  recordings.forEach((r) => listEl.appendChild(renderCard(r)));
}

render();
