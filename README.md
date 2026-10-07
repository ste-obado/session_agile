# Class Recorder & Self-Study Tool — MVP

This is a working first pass, built to match the spec in
`meeting-recorder-tool-spec.docx`. It has two parts:

- **`extension/`** — the Chrome extension (Manifest V3). Records a tab's
  audio on demand, keeps recording across tab switches, logs downloads
  during the recording, and stores everything locally in IndexedDB.
- **`backend/`** — a FastAPI stub. Receives an uploaded recording and
  returns a walkthrough — but the actual Whisper transcription and LLM
  walkthrough generation are left as clearly marked `TODO`s in
  `backend/main.py`, since they need API keys / a model this environment
  doesn't have. Everything around them (routing, file handling, the
  contract the extension expects) is real and tested.

## What's been tested here

- `backend/main.py` imports cleanly and its `/health` and `/walkthrough`
  endpoints were run and verified to respond correctly (see the stub
  transcript/walkthrough text they return).
- All four extension JS files (`background.js`, `offscreen.js`,
  `content.js`, `library.js`) pass a Node syntax check.

## What has NOT been tested (needs a real Chrome browser)

This sandbox has no browser, so the extension itself has not been loaded
or clicked through yet. Load it and test in a real Chrome/Edge browser
before relying on it. Things worth watching for on first run:

1. **`chrome.tabCapture.getMediaStreamId` permission behavior** — this is
   called from the background service worker, triggered by a message from
   a user's click in the content script. This is the documented MV3
   pattern, but Chrome's exact permission prompts/behavior can vary by
   version — test that a real capture stream comes through.
2. **Audio pass-through** — `offscreen.js` reconnects the captured stream
   to the speakers so the student still hears the class while it records.
   Confirm this actually works and doesn't echo/double up.
3. **IndexedDB blob size limits** — long recordings produce large blobs.
   Browsers generally handle this fine, but test with a realistic
   30–60 minute recording, not just a few seconds.
4. **Auto-discard exclusion** — `chrome.tabs.update(tabId, { autoDiscardable: false })`
   is called when recording starts. Verify this actually prevents Chrome's
   memory saver from unloading the tab during a long, unattended session.

## Important: how starting a recording actually works

Chrome does not allow a click inside page content (like our pill) to start
`tabCapture` — only these count as a trusted invocation:
- Clicking the extension's **toolbar icon**
- A **keyboard shortcut** (`Ctrl+Shift+R` by default — see `chrome://extensions/shortcuts`
  if you want to change it)

So: **start** a recording via the toolbar icon or `Ctrl+Shift+R`. The pill
itself is a live status display, and clicking it **stops** an in-progress
recording (stopping has no such restriction). If you click the pill while
nothing is recording, it shows a brief hint instead of trying to start.

If the toolbar icon isn't visible, click the puzzle-piece icon in Chrome's
toolbar and pin "Class Recorder & Self-Study Tool" for one-click access.

## Library layout (the adopted sketch, now real)

`library.html`/`library.js` is now the sidebar layout from your hand-drawn
sketch, not a flat list:

- **Collapsible sidebar** — logo, a Recents list of your actual recordings,
  a pin (&#9733;) button per recording that keeps it at the top of the
  list, and a bottom section with a placeholder "You" row (no accounts
  yet) and a real link to Settings
- **Main panel** — shows the selected recording, with Play/Download/"…"
  controls. The "…" menu has real Rename (prompts, then persists),
  Download, and Delete actions
- **Walkthrough** — opens below, in either reading or chat style per
  Settings, exactly as before — just now living in the sidebar layout
  instead of a flat card

Pinned recordings sort to the top; everything else sorts by most recent.

## Settings

Click **Settings** (top-right of the library page) to reach:

- **Keyboard shortcut** — shows the current one, with a button that opens
  Chrome's own shortcut editor to change it
- **Keep tab active while recording** — really toggles the auto-discard
  fix from earlier; `background.js` now checks this before calling
  `chrome.tabs.update(..., { autoDiscardable: false })`
- **Backend URL** — where recordings are sent for a walkthrough (was
  already read by `library.js`, now has an actual field to set it)
- **Walkthrough style** — **reading** (the plain expandable text panel)
  or **chat** (a real back-and-forth: your question is sent to the
  backend's new `/followup` endpoint, tested and working with the stub
  response)
- **Auto-delete old recordings** — enforced both here and every time
  `library.html` loads, via `applyRetentionPolicy()`
- **Clear all recordings** — wipes the IndexedDB store, with a
  confirmation step

All of this is real, wired-up behavior, not placeholders — except the
actual LLM answer inside `/followup`, which is still the same kind of
stub as `/walkthrough` until you plug in a real model.

## Loading the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select the `extension/` folder
4. Open any tab — a dark pill should appear in the bottom-right corner

## Testing the recording flow

1. Open a tab with some audio playing (e.g. a YouTube video, to simulate
   a class)
2. Click the extension's **toolbar icon** (or press `Ctrl+Shift+R`) to
   start recording — the pill's dot should turn red and a timer should
   start, and the toolbar icon should show a red "REC" badge
3. Switch to a different tab and do something else for a bit — recording
   should keep running (this is the key requirement from the spec)
4. Click the pill (or the toolbar icon again, or the shortcut again) to stop
5. Click **Library** on the pill to open the recordings list — this page
   has been redesigned (see below); it has NOT been visually verified in
   a real browser, only reviewed by hand, so take a first real look here
6. You should see the recording — try **Play** and **Download audio**

## Testing the walkthrough flow (with the stub backend)

1. In `backend/`, run:
   ```
   pip install -r requirements.txt
   uvicorn main:app --reload
   ```
2. In the library page, click **Get walkthrough** on a recording
3. You should see the stub transcript/walkthrough text appear — this
   confirms the extension → backend → extension round trip works
4. To get real transcripts and walkthroughs, replace `transcribe_audio()`
   and `generate_walkthrough()` in `backend/main.py` per the comments
   inside that file

## Not yet built (see the spec doc for full list)

- Distraction/tab-switch correlation was explicitly dropped from scope
  per your direction — this version is just record → save → on-demand
  walkthrough, nothing more
- Kiswahili/code-switching transcription handling (flagged as a later
  milestone in the spec)
- Android version (separate Kotlin project, not part of this extension)
- Any UI polish beyond the functional MVP (drag/snap, hover-dropdown
  history strip, etc. from the earlier tab-switcher prototypes — these
  were designed but not carried over into this recorder build yet)
