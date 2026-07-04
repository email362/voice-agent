from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_model_discovery_ignores_zone_identifier_and_prefers_project_root(monkeypatch):
    from app.config import Settings
    from app.model_discovery import discover_model_files

    repo_root = ROOT.parent
    settings = Settings(project_root=repo_root, device="cuda:0")
    result = discover_model_files(settings)

    assert result.model_path.name == "Glamrock-Freddy_119e_7259s.pth"
    assert result.index_path is not None
    assert result.index_path.name == "added_IVF1243_Flat_nprobe_1_v2.index"
    assert not result.model_path.name.endswith("Zone.Identifier")


def test_health_reports_cuda_default_and_model_status():
    from app.main import create_app

    client = TestClient(create_app())
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["configured_device"] == "cuda:0"
    assert body["model"]["loaded"] is True
    assert body["model"]["model_path"].endswith("Glamrock-Freddy_119e_7259s.pth")
    assert body["model"]["index_path"].endswith("added_IVF1243_Flat_nprobe_1_v2.index")
    assert "backend" in body


def test_convert_returns_503_when_backend_unavailable(monkeypatch):
    from app.main import create_app
    from app.rvc_engine import RvcBackendUnavailable

    app = create_app()

    async def unavailable_convert(*args, **kwargs):
        raise RvcBackendUnavailable("rvc-python is not installed")

    app.state.engine.convert_file = unavailable_convert
    client = TestClient(app)

    response = client.post(
        "/convert",
        files={"audio": ("input.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )

    assert response.status_code == 503
    assert "rvc-python is not installed" in response.json()["detail"]


def test_convert_returns_wav_from_engine(tmp_path):
    from app.main import create_app

    app = create_app()
    output = b"RIFFmockWAVEdata"

    async def fake_convert(input_path, **kwargs):
        out = tmp_path / "out.wav"
        out.write_bytes(output)
        return out

    app.state.engine.convert_file = fake_convert
    client = TestClient(app)

    response = client.post(
        "/convert?pitch=2&index_rate=0.7&f0_method=rmvpe",
        files={"audio": ("input.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.content == output
