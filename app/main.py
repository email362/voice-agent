from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
import os
import shutil
import time

import whisper
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "tiny")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.whisper_model_name = WHISPER_MODEL
    app.state.whisper_model = whisper.load_model(WHISPER_MODEL)
    yield


app = FastAPI(title="Voice Agent STT POC", lifespan=lifespan)
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

    return {
        "text": result.get("text", "").strip(),
        "language": result.get("language"),
        "duration_seconds": round(duration_seconds, 2),
        "processing_seconds": round(time.perf_counter() - start_time, 2),
    }
