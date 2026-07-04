from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .config import Settings
from .device import resolve_device
from .model_discovery import discover_model_files
from .rvc_engine import RvcBackendUnavailable, RvcConversionError, RvcEngine


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Voice Agent RVC Service", version="0.1.0")

    try:
        model_files = discover_model_files(settings)
        model_error = None
    except Exception as exc:
        model_files = None
        model_error = str(exc)

    device_status = resolve_device(settings.device)
    engine = RvcEngine(model_files, device_status) if model_files else None

    app.state.settings = settings
    app.state.model_files = model_files
    app.state.model_error = model_error
    app.state.device_status = device_status
    app.state.engine = engine

    @app.get("/health")
    async def health() -> dict:
        backend_available = bool(engine and engine.backend_available)
        return {
            "ok": model_files is not None,
            "configured_device": device_status.configured_device,
            "effective_device": device_status.effective_device,
            "cuda_available": device_status.cuda_available,
            "fallback_reason": device_status.fallback_reason,
            "model": {
                "loaded": model_files is not None,
                "model_path": str(model_files.model_path) if model_files else None,
                "index_path": str(model_files.index_path) if model_files and model_files.index_path else None,
                "error": model_error,
            },
            "backend": {
                "name": "rvc-python",
                "available": backend_available,
                "error": engine.backend_error if engine else None,
            },
        }

    @app.post("/convert")
    async def convert(
        audio: UploadFile = File(...),
        pitch: int = Query(0, ge=-24, le=24),
        index_rate: float = Query(0.5, ge=0.0, le=1.0),
        f0_method: str = Query("rmvpe"),
    ) -> FileResponse:
        if app.state.engine is None:
            raise HTTPException(status_code=503, detail=app.state.model_error or "RVC model is not loaded")

        workdir = Path(tempfile.mkdtemp(prefix="rvc-service-"))
        input_path = workdir / (audio.filename or "input.wav")
        try:
            with input_path.open("wb") as handle:
                shutil.copyfileobj(audio.file, handle)
            output_path = await app.state.engine.convert_file(
                input_path,
                pitch=pitch,
                index_rate=index_rate,
                f0_method=f0_method,
            )
        except RvcBackendUnavailable as exc:
            shutil.rmtree(workdir, ignore_errors=True)
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except RvcConversionError as exc:
            shutil.rmtree(workdir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        def cleanup() -> None:
            shutil.rmtree(workdir, ignore_errors=True)
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass

        return FileResponse(
            output_path,
            media_type="audio/wav",
            filename="converted.wav",
            background=BackgroundTask(cleanup),
        )

    return app


app = create_app()
