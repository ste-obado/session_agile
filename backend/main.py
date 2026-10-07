"""
Meeting recorder backend — MVP stub.

This service is called ON DEMAND only (see extension/library.js), when a
student taps "Get walkthrough" on a saved recording. It is intentionally a
stub right now: the transcription and walkthrough-generation steps are left
as clearly marked TODOs, since they require API keys / a self-hosted model
that aren't available in this environment.

Real implementation plan:
  1. Transcription — plug in Whisper. Two common options:
       a) openai-whisper or faster-whisper, run locally/self-hosted (free,
          but needs a GPU or patience on CPU)
       b) A cloud STT API (e.g. AssemblyAI) if you'd rather not host a model
  2. Walkthrough generation — send the transcript (plus the download log,
     so the AI can reference "around here you downloaded X") to an LLM
     with a prompt that teaches the material back, not a generic summary.

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload
"""

import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Meeting Recorder Backend")

# The extension calls this from a chrome-extension:// origin — CORS must
# allow that during local development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def transcribe_audio(audio_path: str) -> str:
    """
    TODO: replace with a real Whisper call, e.g.:

        import whisper
        model = whisper.load_model("base")
        result = model.transcribe(audio_path)
        return result["text"]

    Left as a stub so this runs without extra heavy dependencies/model
    downloads in environments that don't have them yet.
    """
    return (
        "[STUB TRANSCRIPT] Replace transcribe_audio() in main.py with a real "
        "Whisper call. The audio file was received successfully at: "
        f"{audio_path}"
    )


def generate_walkthrough(transcript: str, download_log: list, tab_title: str) -> str:
    """
    TODO: replace with a real LLM call. Example shape using Anthropic's
    Python SDK (pip install anthropic):

        import anthropic
        client = anthropic.Anthropic(api_key="...")
        download_note = "\\n".join(
            f"- {d['filename']} (at {d['timestamp']})" for d in download_log
        )
        prompt = f'''
        You are tutoring a student who just recorded this class: {tab_title}.
        Walk them through what was taught, step by step, as if teaching it
        to them for the first time — not a meeting-style summary. If any of
        these downloaded files were likely referenced, mention when to open
        them:
        {download_note}

        Transcript:
        {transcript}
        '''
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    Left as a stub for the same reason as transcribe_audio().
    """
    file_note = ""
    if download_log:
        names = ", ".join(d.get("filename", "a file") for d in download_log)
        file_note = f" Files downloaded during class: {names}."

    return (
        f"[STUB WALKTHROUGH] This is a placeholder. Once transcribe_audio() "
        f"and generate_walkthrough() are wired up to real Whisper/LLM calls, "
        f"this endpoint will return a step-by-step, teach-it-back explanation "
        f"of '{tab_title}'.{file_note}\n\n"
        f"Transcript received (stub):\n{transcript}"
    )


@app.post("/walkthrough")
async def walkthrough(
    audio: UploadFile,
    downloadLog: str = Form("[]"),
    tabTitle: str = Form(""),
):
    download_log = json.loads(downloadLog) if downloadLog else []

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        transcript = transcribe_audio(tmp_path)
        walkthrough_text = generate_walkthrough(transcript, download_log, tabTitle)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return {"transcript": transcript, "walkthrough": walkthrough_text}


@app.get("/health")
async def health():
    return {"status": "ok"}
