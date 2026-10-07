// content.js
// The pill is a STATUS DISPLAY and STOP control. Chrome does not allow a
// click inside page content to start tabCapture — only the extension's
// toolbar icon or a keyboard shortcut count as a trusted invocation for
// that. So: start via the toolbar icon / Ctrl+Shift+R, and use the pill
// (or the same icon/shortcut) to stop and to see live status.

(function () {
  const pill = document.createElement("div");
  pill.id = "cr-pill";
  pill.innerHTML = `
    <span id="cr-dot"></span>
    <span id="cr-label">Not recording</span>
    <span id="cr-timer" style="display:none;">00:00</span>
    <button id="cr-library-btn" title="Open recordings library">Library</button>
  `;
  document.documentElement.appendChild(pill);

  const dot = pill.querySelector("#cr-dot");
  const label = pill.querySelector("#cr-label");
  const timerEl = pill.querySelector("#cr-timer");
  const libraryBtn = pill.querySelector("#cr-library-btn");

  let isRecording = false;
  let startTime = null;
  let timerInterval = null;
  let hintTimeout = null;

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function setRecordingUI(recording, start) {
    isRecording = recording;
    dot.classList.toggle("cr-live", recording);
    timerEl.style.display = recording ? "inline" : "none";
    if (!hintTimeout) {
      label.textContent = recording ? "Recording…" : "Not recording";
    }

    clearInterval(timerInterval);
    if (recording) {
      startTime = start || Date.now();
      timerInterval = setInterval(() => {
        timerEl.textContent = formatElapsed(Date.now() - startTime);
      }, 1000);
    }
  }

  function showHint(text) {
    clearTimeout(hintTimeout);
    const previous = isRecording ? "Recording…" : "Not recording";
    label.textContent = text;
    hintTimeout = setTimeout(() => {
      label.textContent = previous;
      hintTimeout = null;
    }, 3000);
  }

  pill.addEventListener("click", (e) => {
    if (e.target === libraryBtn) return;

    if (isRecording) {
      // Stopping is allowed from a normal click — no trusted-gesture
      // restriction applies once a recording is already in progress.
      chrome.runtime.sendMessage({ type: "TOGGLE_RECORDING_REQUEST" }, (response) => {
        if (response && response.ok) setRecordingUI(false);
      });
    } else {
      // Starting is NOT allowed from here — Chrome requires the toolbar
      // icon or the keyboard shortcut for that.
      showHint("Click the toolbar icon or press Ctrl+Shift+R to start");
    }
  });

  libraryBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_LIBRARY" });
  });

  // Background pushes these regardless of what started/stopped the
  // recording (toolbar icon, keyboard shortcut, or the pill's stop click),
  // so the UI stays accurate no matter which tab is currently visible.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "RECORDING_STARTED") {
      setRecordingUI(true, message.startTime);
    }
    if (message.type === "RECORDING_STOPPED") {
      setRecordingUI(false);
    }
  });

  // Sync UI on page load in case a recording is already in progress.
  chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" }, (state) => {
    if (state && state.isRecording) {
      setRecordingUI(true, state.startTime);
    }
  });
})();
