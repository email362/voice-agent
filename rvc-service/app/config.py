from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    project_root: Path = Path(__file__).resolve().parents[2]
    models_dir: Path | None = None
    model_path: Path | None = None
    index_path: Path | None = None
    max_convert_upload_bytes: int = 25 * 1024 * 1024
    device: str = "cuda:0"
    host: str = "127.0.0.1"
    port: int = 5055

    @classmethod
    def from_env(cls) -> "Settings":
        project_root = Path(os.getenv("RVC_PROJECT_ROOT", Path(__file__).resolve().parents[2])).resolve()
        models_dir_raw = os.getenv("RVC_MODELS_DIR")
        model_path_raw = os.getenv("RVC_MODEL_PATH")
        index_path_raw = os.getenv("RVC_INDEX_PATH")
        max_convert_upload_bytes_raw = os.getenv("RVC_MAX_CONVERT_UPLOAD_BYTES")
        return cls(
            project_root=project_root,
            models_dir=Path(models_dir_raw).resolve() if models_dir_raw else None,
            model_path=Path(model_path_raw).resolve() if model_path_raw else None,
            index_path=Path(index_path_raw).resolve() if index_path_raw else None,
            max_convert_upload_bytes=int(max_convert_upload_bytes_raw) if max_convert_upload_bytes_raw else 25 * 1024 * 1024,
            device=os.getenv("RVC_DEVICE", "cuda:0"),
            host=os.getenv("RVC_HOST", "127.0.0.1"),
            port=int(os.getenv("RVC_PORT", "5055")),
        )
