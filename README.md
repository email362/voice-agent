# Voice Agent STT POC

This project is a local proof of concept for the speech-to-text portion of a cascaded voice-agent pipeline. It serves a small browser UI that records microphone audio, posts it to a FastAPI backend, transcribes it with local OpenAI Whisper, and displays the resulting text.

## Prerequisites

- Python 3.12
- `ffmpeg` on `PATH`
- A browser with `MediaRecorder` support

On Ubuntu or WSL:

```bash
sudo apt update
sudo apt install ffmpeg
```

## Setup

```bash
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
.venv/bin/uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000 and use the recording button.

The backend loads the `tiny` Whisper model by default. To use a different local model:

```bash
WHISPER_MODEL=base .venv/bin/uvicorn app.main:app --reload
```

## API

- `GET /health` returns backend health, the configured Whisper model, and whether `ffmpeg` is available.
- `POST /api/transcribe` accepts a multipart form upload named `file` and returns transcription text, detected language, audio duration, and processing time.
