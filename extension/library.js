// library.js
// Runs as an extension page (chrome-extension://<id>/library.html), which
// shares its origin — and therefore its IndexedDB database — with
// offscreen.html. No messaging needed to read recordings, just open the DB.

const DB_NAME = "ClassRecordings";
const STORE_NAME = "recordings";
const SETTINGS_DEFAULTS = {
  backendUrl: "http://localhost:8000/walkthrough",
  walkthroughStyle: "reading",
  retentionDays: "never"
};

let allRecordings = [];
let selectedId = null;
let settings = SETTINGS_DEFAULTS;
let sidebarCollapsed = false;

// ---------- storage ----------

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
    req.onsuccess = () => resolve(req.result);
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

async function updateRecord(id, fields) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = { ...getReq.result, ...fields };
      store.put(record);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function applyRetentionPolicy(retentionDays) {
  if (retentionDays === "never" || !retentionDays) return;
  const cutoffMs = Date.now() - Number(retentionDays) * 24 * 60 * 60 * 1000;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      req.result.forEach((record) => {
        if (record.startTime < cutoffMs) store.delete(record.id);
      });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(SETTINGS_DEFAULTS));
  return { ...SETTINGS_DEFAULTS, ...stored };
}

// ---------- formatting ----------

function formatCounter(record) {
  const sec = Math.max(0, Math.round((record.endTime - record.startTime) / 1000));
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatMeta(record) {
  const date = new Date(record.startTime).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric"
  });
  let meta = `${formatCounter(record)} recorded ${date}`;
  if (record.downloadLog && record.downloadLog.length > 0) {
    const n = record.downloadLog.length;
    meta += n === 1 ? " — 1 file downloaded" : ` — ${n} files downloaded`;
  }
  return meta;
}

function sortedRecordings() {
  return [...allRecordings].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.startTime - a.startTime;
  });
}

// ---------- sidebar ----------

function renderSidebar() {
  const listEl = document.getElementById("rec-list");
  listEl.innerHTML = "";

  sortedRecordings().forEach((record) => {
    const item = document.createElement("div");
    item.className = "rec-item" + (record.id === selectedId ? " active" : "");
    item.innerHTML = `
      <span class="rec-name">${record.tabTitle || "Untitled class"}</span>
      <button class="pin-btn${record.pinned ? " pinned" : ""}" title="Pin">&#9733;</button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".pin-btn")) return;
      selectedId = record.id;
      renderSidebar();
      renderMain();
    });
    item.querySelector(".pin-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      record.pinned = !record.pinned;
      await updateRecord(record.id, { pinned: record.pinned });
      renderSidebar();
    });
    listEl.appendChild(item);
  });
}

document.getElementById("collapse-btn").addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById("sidebar").classList.toggle("collapsed", sidebarCollapsed);
  document.getElementById("collapse-btn").innerHTML = sidebarCollapsed ? "&#8250;" : "&#8249;";
});

// ---------- main panel ----------

function getSelectedRecord() {
  return allRecordings.find((r) => r.id === selectedId) || null;
}

async function requestWalkthrough(record, readout, button) {
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "PROCESSING…";
  readout.style.display = "block";
  renderReadingPanel(readout, "Sending the recording for transcription and a walkthrough — this can take a while for longer classes.");

  try {
    const formData = new FormData();
    formData.append("audio", record.audioBlob, "recording.webm");
    formData.append("downloadLog", JSON.stringify(record.downloadLog || []));
    formData.append("tabTitle", record.tabTitle || "");

    const res = await fetch(settings.backendUrl, { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const data = await res.json();

    const fields = {
      walkthrough: data.walkthrough || "",
      transcript: data.transcript || "",
      chatHistory: [{ role: "ai", text: data.walkthrough || "No walkthrough text came back." }]
    };
    await updateRecord(record.id, fields);
    Object.assign(record, fields);

    button.textContent = "REPLAY";
    renderWalkthroughPanel(record, readout);
  } catch (err) {
    renderReadingPanel(readout,
      "Couldn't reach the backend at " + settings.backendUrl +
      ". Make sure it's running.\n\n" + err.message
    );
    button.textContent = originalLabel;
  } finally {
    button.disabled = false;
  }
}

function renderReadingPanel(readout, text) {
  readout.innerHTML = `
    <p class="readout-label">walkthrough</p>
    <div class="readout-body"></div>
    <div class="followup-row">
      <span class="prompt">&gt;</span>
      <input type="text" placeholder="ask a follow-up question (coming soon)" disabled>
      <button disabled>ASK</button>
    </div>
  `;
  readout.querySelector(".readout-body").textContent = text;
}

async function sendFollowUp(record, question, appendMessage) {
  appendMessage("user", question);
  appendMessage("ai", "…", true);

  try {
    const formData = new FormData();
    formData.append("transcript", record.transcript || "");
    formData.append("question", question);

    const followupUrl = settings.backendUrl.replace(/\/walkthrough$/, "/followup");
    const res = await fetch(followupUrl, { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const data = await res.json();
    appendMessage("ai", data.answer || "No answer came back.", false, true);
  } catch (err) {
    appendMessage("ai", "Couldn't reach the backend for a follow-up answer: " + err.message, false, true);
  }

  await updateRecord(record.id, { chatHistory: record.chatHistory || [] });
}

function renderWalkthroughPanel(record, readout) {
  if (settings.walkthroughStyle !== "chat") {
    readout.innerHTML = `
      <p class="readout-label">walkthrough</p>
      <div class="readout-body"></div>
      <div class="followup-row">
        <span class="prompt">&gt;</span>
        <input type="text" placeholder="ask a follow-up question (coming soon)" disabled>
        <button disabled>ASK</button>
      </div>
    `;
    readout.querySelector(".readout-body").textContent = record.walkthrough || "";
    return;
  }

  readout.innerHTML = `
    <p class="readout-label">walkthrough</p>
    <div class="chat-messages" style="display:flex; flex-direction:column; gap:10px; margin-bottom:14px;"></div>
    <div class="followup-row">
      <span class="prompt">&gt;</span>
      <input type="text" class="chat-input" placeholder="ask a follow-up question">
      <button class="chat-send">ASK</button>
    </div>
  `;
  const messagesEl = readout.querySelector(".chat-messages");

  function renderMessages() {
    messagesEl.innerHTML = "";
    (record.chatHistory || []).forEach((m) => {
      const bubble = document.createElement("div");
      const isUser = m.role === "user";
      bubble.style.cssText =
        "max-width:85%; padding:8px 12px; border-radius:3px; font-size:13px; line-height:1.55;" +
        (isUser
          ? "align-self:flex-end; background:rgba(217,164,65,0.14); color:#D9A441;"
          : "align-self:flex-start; background:#1B1F24; color:#EDE9DF; border:1px solid #333B44;");
      bubble.textContent = m.text;
      messagesEl.appendChild(bubble);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessage(role, text, isPlaceholder = false, replacePlaceholder = false) {
    record.chatHistory = record.chatHistory || [];
    if (replacePlaceholder) {
      const idx = [...record.chatHistory].reverse().findIndex((m) => m.text === "…");
      if (idx !== -1) {
        record.chatHistory[record.chatHistory.length - 1 - idx] = { role, text };
        renderMessages();
        return;
      }
    }
    record.chatHistory.push({ role, text });
    renderMessages();
  }

  renderMessages();

  const input = readout.querySelector(".chat-input");
  const sendBtn = readout.querySelector(".chat-send");
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendFollowUp(record, text, appendMessage);
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

function renderMain() {
  const record = getSelectedRecord();
  const body = document.getElementById("main-body");
  const menuDropdown = document.getElementById("menu-dropdown");
  menuDropdown.style.display = "none";

  if (!record) {
    document.getElementById("main-title").textContent = "No recordings yet";
    document.getElementById("main-meta").textContent = "";
    body.innerHTML = '<p class="empty">Start a recording from the toolbar icon while you\'re in a class.</p>';
    return;
  }

  document.getElementById("main-title").textContent = record.tabTitle || "Untitled class";
  document.getElementById("main-meta").textContent = formatMeta(record);

  body.innerHTML = `
    <audio class="rec-audio" controls></audio>
    <div style="margin-top:16px;">
      <button class="readout-btn walkthrough-btn">${record.walkthrough ? "REPLAY WALKTHROUGH" : "GET WALKTHROUGH"}</button>
    </div>
    <div class="readout"></div>
  `;

  const audioEl = body.querySelector(".rec-audio");
  const audioUrl = URL.createObjectURL(record.audioBlob);
  const readout = body.querySelector(".readout");
  const walkthroughBtn = body.querySelector(".walkthrough-btn");

  if (record.walkthrough) {
    readout.style.display = "block";
    renderWalkthroughPanel(record, readout);
  }

  walkthroughBtn.addEventListener("click", () => {
    if (record.walkthrough) {
      readout.style.display = readout.style.display === "block" ? "none" : "block";
      return;
    }
    requestWalkthrough(record, readout, walkthroughBtn);
  });

  document.getElementById("play-btn").onclick = () => {
    audioEl.src = audioUrl;
    audioEl.style.display = "block";
    audioEl.play();
  };

  document.getElementById("download-btn").onclick = () => {
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = `${(record.tabTitle || "recording").replace(/[^a-z0-9]/gi, "_")}.webm`;
    a.click();
  };

  document.getElementById("menu-btn").onclick = () => {
    menuDropdown.style.display = menuDropdown.style.display === "block" ? "none" : "block";
  };

  document.getElementById("rename-item").onclick = async () => {
    menuDropdown.style.display = "none";
    const newName = prompt("Rename this recording:", record.tabTitle || "");
    if (newName === null || newName.trim() === "") return;
    record.tabTitle = newName.trim();
    await updateRecord(record.id, { tabTitle: record.tabTitle });
    renderSidebar();
    renderMain();
  };

  document.getElementById("download-item").onclick = () => {
    menuDropdown.style.display = "none";
    document.getElementById("download-btn").click();
  };

  document.getElementById("delete-item").onclick = async () => {
    menuDropdown.style.display = "none";
    if (!confirm("Delete this recording? This can't be undone.")) return;
    await deleteRecording(record.id);
    allRecordings = allRecordings.filter((r) => r.id !== record.id);
    selectedId = allRecordings.length > 0 ? sortedRecordings()[0].id : null;
    renderSidebar();
    renderMain();
  };
}

// ---------- boot ----------

async function init() {
  settings = await getSettings();
  await applyRetentionPolicy(settings.retentionDays);
  allRecordings = await getAllRecordings();

  if (allRecordings.length > 0) {
    selectedId = sortedRecordings()[0].id;
  }

  renderSidebar();
  renderMain();
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("menu-dropdown");
  if (menu.style.display === "block" && !e.target.closest("#menu-btn") && !e.target.closest("#menu-dropdown")) {
    menu.style.display = "none";
  }
});

init();
