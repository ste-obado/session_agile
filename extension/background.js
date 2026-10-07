// background.js
// Owns recording STATE and coordinates between the content-script toggle,
// the offscreen document (which does the actual audio capture), and
// chrome.downloads (which logs files the student downloads mid-class).
//
// IMPORTANT: MV3 service workers are NOT kept alive continuously — Chrome
// kills this script after ~30s of inactivity and restarts it fresh on the
// next event. A plain JS variable would lose track of an in-progress
// recording every time that happens (this was the bug behind "recording
// restarts after a refresh"). So all state lives in chrome.storage.local,
// which survives restarts, and is treated as the single source of truth.

const OFFSCREEN_URL = "offscreen.html";
const STORAGE_KEY = "recordingState";

// offscreen and tabCapture.getMediaStreamId are relatively recent Chromium
// APIs. Some Chromium-based browsers (older Edge/Brave/Opera builds, or
// ones with aggressive privacy settings) may not fully support them,
// which shows up as "lag" or silent failure rather than a clear error.
function checkApiSupport() {
  const missing = [];
  if (!chrome.offscreen) missing.push("chrome.offscreen");
  if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) missing.push("chrome.tabCapture.getMediaStreamId");
  return missing;
}

const DEFAULT_STATE = {
  isRecording: false,
  tabId: null,
  tabTitle: null,
  startTime: null,
  downloadLog: [] // { filename, timestamp }
};

async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || DEFAULT_STATE;
}

async function setState(newState) {
  await chrome.storage.local.set({ [STORAGE_KEY]: newState });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Recording tab audio for class review"
  });
}

// Asks the offscreen document directly whether a MediaRecorder is already
// running. Used as a safety net: if storage says "not recording" but the
// offscreen document disagrees (e.g. storage write raced with a restart),
// we trust the offscreen document and resync instead of starting a
// duplicate, overlapping recording.
async function offscreenIsActuallyRecording() {
  if (!(await hasOffscreenDocument())) return false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS_QUERY" });
    return !!(response && response.recording);
  } catch (e) {
    return false;
  }
}

async function startRecording(tab) {
  const missing = checkApiSupport();
  if (missing.length > 0) {
    console.error("This browser is missing required APIs:", missing.join(", "));
    return { ok: false, error: "unsupported-browser", missing };
  }

  const state = await getState();

  if (state.isRecording || (await offscreenIsActuallyRecording())) {
    return { ok: false, error: "already-recording" };
  }

  // Ask Chrome for a stream id that identifies THIS tab's audio/video.
  // Must be requested from an extension page context (background counts),
  // AND must happen as a direct result of a trusted invocation — the
  // toolbar icon or a keyboard command. A click inside page content
  // (e.g. our own pill) does NOT count, no matter what permissions are
  // declared — this is a hard Chrome security restriction.
  const t0 = performance.now();
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });
  console.log(`getMediaStreamId took ${Math.round(performance.now() - t0)}ms`);

  const t1 = performance.now();
  await ensureOffscreenDocument();
  console.log(`ensureOffscreenDocument took ${Math.round(performance.now() - t1)}ms`);

  const newState = {
    isRecording: true,
    tabId: tab.id,
    tabTitle: tab.title || "Untitled tab",
    startTime: Date.now(),
    downloadLog: []
  };
  await setState(newState);

  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } catch (e) {
    console.warn("Could not disable auto-discard for tab:", e);
  }

  chrome.runtime.sendMessage({
    type: "OFFSCREEN_START_CAPTURE",
    streamId,
    tabTitle: newState.tabTitle,
    startTime: newState.startTime
  });

  chrome.action.setBadgeText({ text: "REC", tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: "#e0483c" });
  notifyTab(tab.id, { type: "RECORDING_STARTED", startTime: newState.startTime });

  return { ok: true };
}

async function stopRecording() {
  const state = await getState();
  const actuallyRecording = state.isRecording || (await offscreenIsActuallyRecording());

  if (!actuallyRecording) return { ok: false, error: "not-recording" };

  const finishedTabId = state.tabId;

  chrome.runtime.sendMessage({
    type: "OFFSCREEN_STOP_CAPTURE",
    downloadLog: state.downloadLog,
    tabTitle: state.tabTitle,
    startTime: state.startTime,
    endTime: Date.now()
  });

  if (finishedTabId != null) {
    try {
      await chrome.tabs.update(finishedTabId, { autoDiscardable: true });
    } catch (e) {
      // Tab may already be closed — safe to ignore.
    }
    chrome.action.setBadgeText({ text: "", tabId: finishedTabId });
    notifyTab(finishedTabId, { type: "RECORDING_STOPPED" });
  }

  await setState(DEFAULT_STATE);
  return { ok: true };
}

function notifyTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab may not have the content script (e.g. a chrome:// page) — ignore.
  });
}

// Trusted invocation #1: clicking the toolbar icon.
chrome.action.onClicked.addListener(async (tab) => {
  const state = await getState();
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording(tab).catch((err) => {
      console.error("Failed to start recording via toolbar icon:", err);
    });
  }
});

// Trusted invocation #2: a keyboard shortcut (see manifest "commands"),
// in case the toolbar icon is hidden behind the puzzle-piece menu.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") return;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) return;
  const state = await getState();
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording(activeTab).catch((err) => {
      console.error("Failed to start recording via keyboard shortcut:", err);
    });
  }
});

// Log downloads only while actively recording — this is what lets the
// eventual walkthrough say "around this point you downloaded X".
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const state = await getState();
  if (!state.isRecording) return;
  state.downloadLog.push({
    filename: downloadItem.filename || downloadItem.url,
    timestamp: Date.now()
  });
  await setState(state);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TOGGLE_RECORDING_REQUEST") {
    (async () => {
      const state = await getState();
      if (state.isRecording) {
        const result = await stopRecording();
        sendResponse({ ...result, isRecording: false });
      } else {
        // Starting from a page-content click is not allowed by Chrome —
        // only the toolbar icon or the keyboard shortcut can start capture.
        sendResponse({ ok: false, error: "use-toolbar-icon", isRecording: false });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (message.type === "OPEN_LIBRARY") {
    chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
    return true;
  }

  if (message.type === "GET_RECORDING_STATE") {
    (async () => {
      const state = await getState();
      sendResponse({
        isRecording: state.isRecording,
        startTime: state.startTime,
        tabTitle: state.tabTitle
      });
    })();
    return true;
  }
});
