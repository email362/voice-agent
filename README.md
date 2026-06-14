# Voice Agent POC

This project is a local proof of concept for a cascaded voice-agent pipeline. It serves a small browser UI that records microphone audio, posts it to a FastAPI backend, transcribes it with local OpenAI Whisper, sends the resulting text to NanoGPT's OpenAI-compatible chat completions API, displays both the transcript and assistant reply, and can speak the reply with ElevenLabs text to speech.

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

ElevenLabs is required only when `Speak replies` is enabled. This app uses an already-created Instant Voice Clone; it does not create or upload voice samples.

One-time ElevenLabs setup:

1. In ElevenLabs, create an Instant Voice Clone and upload the requested voice samples.
2. Copy the resulting `voice_id`.
3. Add the ElevenLabs settings to `.env`:

```env
ELEVENLABS_API_KEY=your_api_key
ELEVENLABS_VOICE_ID=your_instant_voice_clone_voice_id
```

Optional ElevenLabs settings:

```env
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
ELEVENLABS_TIMEOUT_SECONDS=120
```

`ELEVENLABS_MODEL_ID` defaults to `eleven_flash_v2_5` for lower time to first audio. `ELEVENLABS_TIMEOUT_SECONDS` is the full stream timeout, so longer replies can keep downloading after playback starts.

Do not commit voice samples to this repository. Only create or use cloned voices with the speaker's consent and the rights required for your use case.

## API

- `GET /health` returns backend health, the configured Whisper and NanoGPT models, whether NanoGPT and ElevenLabs are configured, and whether `ffmpeg` is available.
- `POST /api/transcribe` accepts a multipart form upload named `file` and returns transcription text, detected language, audio duration, Whisper processing time, NanoGPT assistant reply, NanoGPT model, and NanoGPT processing time.
- `POST /api/tts/session` accepts JSON shaped like `{ "text": "assistant reply text" }` and returns a short-lived playback URL without exposing the text in the query string.
- `GET /api/tts/stream/{id}` streams `audio/mpeg` MP3 bytes from ElevenLabs so the browser can start playback before the full reply has downloaded.
- `POST /api/tts` accepts JSON shaped like `{ "text": "assistant reply text" }` and returns buffered `audio/mpeg` MP3 bytes from ElevenLabs as a fallback/debug endpoint.
