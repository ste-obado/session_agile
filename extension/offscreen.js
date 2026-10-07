// offscreen.js
// This is the only place in the extension allowed to touch getUserMedia /
// MediaRecorder (service workers can't). It lives at the extension's own
// chrome-extension:// origin, which is why it can share an IndexedDB
// database with library.html — they're the same origin.

const DB_NAME = "ClassRecordings";
const STORE_NAME = "recordings";

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let currentTabTitle = null;
let currentStartTime = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true
        });
        store.createIndex("startTime", "startTime");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveRecording(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function startCapture(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // Without this, capturing the tab's audio stream silences it for the
  // student — piping it back to the speakers keeps the class audible
  // while it's being recorded in the background.
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.start(1000); // collect in 1s chunks
}

async function stopCapture({ downloadLog, tabTitle, startTime, endTime }) {
  if (!mediaRecorder) return;

  await new Promise((resolve) => {
    mediaRecorder.onstop = resolve;
    mediaRecorder.stop();
  });

  mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
  audioChunks = [];
  mediaRecorder = null;

  const id = await saveRecording({
    tabTitle: tabTitle || currentTabTitle || "Untitled class",
    startTime: startTime || currentStartTime,
    endTime: endTime || Date.now(),
    downloadLog: downloadLog || [],
    audioBlob,
    walkthrough: null // filled in later, on demand, by library.js
  });

  chrome.runtime.sendMessage({ type: "RECORDING_SAVED", id });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OFFSCREEN_START_CAPTURE") {
    currentTabTitle = message.tabTitle;
    currentStartTime = message.startTime;
    startCapture(message.streamId).catch((err) => {
      console.error("Failed to start tab capture:", err);
    });
  }
  if (message.type === "OFFSCREEN_STOP_CAPTURE") {
    stopCapture(message).catch((err) => {
      console.error("Failed to stop tab capture:", err);
    });
  }
  if (message.type === "OFFSCREEN_STATUS_QUERY") {
    sendResponse({
      recording: !!(mediaRecorder && mediaRecorder.state === "recording")
    });
    return true;
  }
});
