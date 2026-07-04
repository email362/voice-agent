from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .config import Settings


@dataclass(frozen=True)
class ModelFiles:
    model_path: Path
    index_path: Path | None
    searched_dirs: list[Path]


def _valid_model_file(path: Path, suffix: str) -> bool:
    return path.is_file() and path.suffix == suffix and not path.name.endswith("Zone.Identifier")


def _candidate_dirs(settings: Settings) -> list[Path]:
    dirs: list[Path] = []
    if settings.models_dir:
        dirs.append(settings.models_dir)
    dirs.extend([
        settings.project_root / "rvc-service" / "models",
        settings.project_root / "models",
        settings.project_root,
    ])
    seen: set[Path] = set()
    unique: list[Path] = []
    for directory in dirs:
        resolved = directory.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def _index_candidate_dirs(settings: Settings, model_path: Path) -> list[Path]:
    dirs = [model_path.parent, *_candidate_dirs(settings)]
    seen: set[Path] = set()
    unique: list[Path] = []
    for directory in dirs:
        resolved = directory.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def discover_model_files(settings: Settings) -> ModelFiles:
    searched_dirs = _candidate_dirs(settings)

    if settings.model_path:
        model_path = settings.model_path
    else:
        model_path = next(
            (path for directory in searched_dirs if directory.exists() for path in sorted(directory.glob("*.pth")) if _valid_model_file(path, ".pth")),
            None,
        )

    if model_path is None or not _valid_model_file(model_path, ".pth"):
        searched = ", ".join(str(path) for path in searched_dirs)
        raise FileNotFoundError(f"No .pth RVC model found. Searched: {searched}")

    if settings.index_path:
        if not _valid_model_file(settings.index_path, ".index"):
            raise FileNotFoundError(f"RVC_INDEX_PATH must point to an existing .index file: {settings.index_path}")
        index_path = settings.index_path
    else:
        index_dirs = _index_candidate_dirs(settings, model_path)
        index_path = next(
            (path for directory in index_dirs if directory.exists() for path in sorted(directory.glob("*.index")) if _valid_model_file(path, ".index")),
            None,
        )

    return ModelFiles(model_path=model_path.resolve(), index_path=index_path.resolve() if index_path else None, searched_dirs=searched_dirs)
