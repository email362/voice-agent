from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
import os
import shutil
import time

import httpx
import whisper
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "tiny")
NANOGPT_API_KEY = os.getenv("NANOGPT_API_KEY")
NANOGPT_MODEL = os.getenv("NANOGPT_MODEL", "gpt-4o-mini")
NANOGPT_BASE_URL = os.getenv("NANOGPT_BASE_URL", "https://nano-gpt.com/api/v1")
NANOGPT_SYSTEM_PROMPT = "You are a concise, helpful voice assistant."
NANOGPT_TIMEOUT_SECONDS = 30.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.whisper_model_name = WHISPER_MODEL
    app.state.whisper_model = whisper.load_model(WHISPER_MODEL)
    yield


app = FastAPI(title="Voice Agent POC", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "whisper_model": app.state.whisper_model_name,
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "nanogpt_model": NANOGPT_MODEL,
        "nanogpt_configured": bool(NANOGPT_API_KEY),
    }


async def get_nanogpt_reply(transcript: str) -> dict[str, object]:
    if not transcript:
        return {
            "reply": "",
            "llm_model": NANOGPT_MODEL,
            "llm_processing_seconds": 0.0,
        }

    if not NANOGPT_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="NANOGPT_API_KEY is required to request an assistant reply.",
        )

    start_time = time.perf_counter()
    payload = {
        "model": NANOGPT_MODEL,
        "messages": [
            {"role": "system", "content": NANOGPT_SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
    }
    headers = {
        "Authorization": f"Bearer {NANOGPT_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=NANOGPT_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{NANOGPT_BASE_URL.rstrip('/')}/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:300] or exc.response.reason_phrase
        raise HTTPException(
            status_code=502,
            detail=f"NanoGPT request failed: {detail}",
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"NanoGPT request failed: {exc}",
        ) from exc

    try:
        reply = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="NanoGPT returned an invalid chat completion response.",
        ) from exc

    return {
        "reply": reply,
        "llm_model": data.get("model", NANOGPT_MODEL),
        "llm_processing_seconds": round(time.perf_counter() - start_time, 2),
    }


@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)) -> dict[str, object]:
    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is required for Whisper audio decoding but was not found on PATH.",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    suffix = Path(file.filename or "").suffix or ".webm"
    start_time = time.perf_counter()
    temp_path = None

    try:
        with NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        result = app.state.whisper_model.transcribe(temp_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)

    segments = result.get("segments") or []
    duration_seconds = float(segments[-1]["end"]) if segments else 0.0

    transcript = result.get("text", "").strip()
    transcription_seconds = round(time.perf_counter() - start_time, 2)
    llm_result = await get_nanogpt_reply(transcript)

    return {
        **llm_result,
        "text": transcript,
        "language": result.get("language"),
        "duration_seconds": round(duration_seconds, 2),
        "processing_seconds": transcription_seconds,
    }
