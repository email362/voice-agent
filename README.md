# Voice Agent POC

This project is a local proof of concept for a cascaded voice-agent pipeline. It serves a small browser UI that records microphone audio, posts it to a FastAPI backend, transcribes it with local OpenAI Whisper, sends the resulting text to NanoGPT's OpenAI-compatible chat completions API, and displays both the transcript and assistant reply.

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
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

Activate the virtual environment before running project commands:

```bash
source .venv/bin/activate
uvicorn app.main:app --reload --env-file .env
```

Open http://127.0.0.1:8000 and use the recording button.

Commands below assume the virtual environment is activated. Activating the virtual environment does not automatically load `.env`; the `--env-file .env` flag is what makes Uvicorn load it.

The backend loads the `tiny` Whisper model by default. To use a different local model:

```bash
WHISPER_MODEL=base uvicorn app.main:app --reload --env-file .env
```

NanoGPT is required for assistant replies. Add it to `.env`:

```env
NANOGPT_API_KEY=your_api_key
```

The NanoGPT model defaults to `gpt-4o-mini`. To use a different model, add it to `.env`:

```env
NANOGPT_MODEL=gpt-5.2
```

## API

- `GET /health` returns backend health, the configured Whisper and NanoGPT models, whether NanoGPT is configured, and whether `ffmpeg` is available.
- `POST /api/transcribe` accepts a multipart form upload named `file` and returns transcription text, detected language, audio duration, Whisper processing time, NanoGPT assistant reply, NanoGPT model, and NanoGPT processing time.
