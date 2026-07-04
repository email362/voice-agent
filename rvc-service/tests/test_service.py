from pathlib import Path
import asyncio
import tempfile
import sys
import types
import threading
import time

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


async def invoke_asgi(app, body_parts, headers=None):
    messages = []
    parts = list(body_parts)
    index = 0

    async def receive():
        nonlocal index
        if index >= len(parts):
            return {"type": "http.request", "body": b"", "more_body": False}
        body = parts[index]
        index += 1
        return {"type": "http.request", "body": body, "more_body": index < len(parts)}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/convert",
        "raw_path": b"/convert",
        "query_string": b"",
        "headers": headers or [],
        "client": ("testclient", 123),
        "server": ("testserver", 80),
        "root_path": "",
    }

    await app(scope, receive, send)
    return messages


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


def test_model_discovery_prefers_index_next_to_explicit_model(tmp_path):
    from app.config import Settings
    from app.model_discovery import discover_model_files

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    model_dir = tmp_path / "explicit"
    model_dir.mkdir()

    model_path = model_dir / "voice.pth"
    model_path.write_bytes(b"model")
    preferred_index = model_dir / "voice.index"
    preferred_index.write_bytes(b"preferred")
    fallback_index = models_dir / "fallback.index"
    fallback_index.write_bytes(b"fallback")

    settings = Settings(
        project_root=tmp_path,
        models_dir=models_dir,
        model_path=model_path,
        device="cuda:0",
    )

    result = discover_model_files(settings)

    assert result.model_path == model_path.resolve()
    assert result.index_path == preferred_index.resolve()


def test_model_discovery_rejects_invalid_explicit_index_path(tmp_path):
    from app.config import Settings
    from app.model_discovery import discover_model_files

    model_path = tmp_path / "voice.pth"
    model_path.write_bytes(b"model")

    settings = Settings(
        project_root=tmp_path,
        model_path=model_path,
        index_path=tmp_path / "missing.index",
        device="cuda:0",
    )

    with pytest.raises(FileNotFoundError, match="RVC_INDEX_PATH"):
        discover_model_files(settings)


def test_health_reports_cuda_default_and_model_status(monkeypatch):
    from app.main import create_app
    from app.rvc_engine import RvcEngine

    async def ready(self):
        return True

    monkeypatch.setattr(RvcEngine, "ensure_ready", ready)

    client = TestClient(create_app())
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["configured_device"] == "cuda:0"
    assert body["model"]["loaded"] is True
    assert body["model"]["model_path"].endswith("Glamrock-Freddy_119e_7259s.pth")
    assert body["model"]["index_path"].endswith("added_IVF1243_Flat_nprobe_1_v2.index")
    assert body["backend"]["available"] is True
    assert "backend" in body


def test_health_returns_not_ok_when_backend_unavailable(monkeypatch):
    from app.main import create_app
    from app.rvc_engine import RvcEngine

    async def ready(self):
        return False

    monkeypatch.setattr(RvcEngine, "ensure_ready", ready)

    app = create_app()
    app.state.engine._backend_error = "rvc-python is not installed"
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["backend"]["available"] is False
    assert body["backend"]["error"] == "rvc-python is not installed"


def test_health_returns_not_ok_when_backend_initialization_fails(monkeypatch):
    from app.main import create_app
    from app.rvc_engine import RvcEngine

    async def ready(self):
        self._backend_error = "Failed to initialize RVC model: boom"
        return False

    monkeypatch.setattr(RvcEngine, "ensure_ready", ready)

    client = TestClient(create_app())
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["backend"]["available"] is False
    assert body["backend"]["error"] == "Failed to initialize RVC model: boom"


def test_health_serializes_backend_initialization(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "voice.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[tmp_path]),
        DeviceStatus(
            configured_device="cuda:0",
            effective_device="cuda:0",
            cuda_available=True,
            fallback_reason=None,
        ),
    )

    init_calls = 0
    init_lock = threading.Lock()
    first_init_started = threading.Event()
    release_first_init = threading.Event()

    def fake_initialize_backend(self):
        nonlocal init_calls
        with init_lock:
            init_calls += 1
        first_init_started.set()
        assert release_first_init.wait(timeout=2), "backend initialization should be released by the test"
        self._rvc = object()
        return self._rvc

    monkeypatch.setattr(RvcEngine, "_initialize_backend", fake_initialize_backend)

    async def run_concurrent_health_checks():
        task1 = asyncio.create_task(engine.ensure_ready())
        task2 = asyncio.create_task(engine.ensure_ready())
        assert await asyncio.to_thread(first_init_started.wait, 2)
        await asyncio.sleep(0.05)
        assert init_calls == 1
        release_first_init.set()
        assert await asyncio.gather(task1, task2) == [True, True]

    asyncio.run(run_concurrent_health_checks())

    assert init_calls == 1


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


def test_convert_ignores_client_supplied_filename(tmp_path):
    from app.main import create_app

    app = create_app()
    seen = {}

    async def fake_convert(input_path, **kwargs):
        seen["input_path"] = input_path
        out = tmp_path / "out.wav"
        out.write_bytes(b"RIFFmockWAVEdata")
        return out

    app.state.engine.convert_file = fake_convert
    client = TestClient(app)

    response = client.post(
        "/convert",
        files={"audio": ("../../tmp/pwned.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )

    assert response.status_code == 200
    assert seen["input_path"].name == "input.wav"


def test_convert_rejects_oversized_upload(tmp_path):
    from app.config import Settings
    from app.main import create_app

    app = create_app(Settings(max_convert_upload_bytes=4))
    app.state.engine.convert_file = lambda *args, **kwargs: pytest.fail("conversion should not run")
    client = TestClient(app)

    response = client.post(
        "/convert",
        files={"audio": ("input.wav", b"012345", "audio/wav")},
    )

    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_convert_rejects_oversized_upload_before_parsing():
    from app.config import Settings
    from app.main import create_app

    app = create_app(Settings(max_convert_upload_bytes=1))
    app.state.engine.convert_file = lambda *args, **kwargs: pytest.fail("conversion should not run")

    messages = asyncio.run(
        invoke_asgi(
            app,
            [b"a"],
            headers=[(b"content-length", str(2 * 1024 * 1024).encode("ascii"))],
        )
    )
    status = next(message for message in messages if message["type"] == "http.response.start")
    body = next(message for message in messages if message["type"] == "http.response.body")

    assert status["status"] == 413
    assert b"too large" in body["body"]


def test_convert_file_cleans_up_temp_output_on_failure(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcConversionError, RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    class Backend:
        def infer_file(self, *args, **kwargs):
            raise RuntimeError("boom")

    async def fake_load_backend():
        return Backend()

    monkeypatch.setattr(engine, "_load_backend", fake_load_backend)

    original_mkstemp = tempfile.mkstemp
    created = {}

    def fake_mkstemp(*args, **kwargs):
        created["dir"] = kwargs.get("dir")
        kwargs = {**kwargs, "dir": tmp_path}
        fd, path = original_mkstemp(*args, **kwargs)
        created["path"] = Path(path)
        return fd, path

    monkeypatch.setattr(tempfile, "mkstemp", fake_mkstemp)

    input_path = tmp_path / "input.wav"
    input_path.write_bytes(b"RIFF....WAVEfmt ")

    with pytest.raises(RvcConversionError):
        asyncio.run(engine.convert_file(input_path))

    assert created["dir"] == input_path.parent
    assert not created["path"].exists()


def test_initialize_backend_omits_index_path_when_missing(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    seen = {}

    class FakeRVCInference:
        def __init__(self, **kwargs):
            seen["constructor_kwargs"] = kwargs

        def load_model(self, model_path, **kwargs):
            seen["model_path"] = model_path
            seen["load_kwargs"] = kwargs

    infer_module = types.ModuleType("rvc_python.infer")
    infer_module.RVCInference = FakeRVCInference
    package_module = types.ModuleType("rvc_python")
    package_module.infer = infer_module
    monkeypatch.setitem(sys.modules, "rvc_python", package_module)
    monkeypatch.setitem(sys.modules, "rvc_python.infer", infer_module)

    backend = engine._initialize_backend()

    assert backend is engine._rvc
    assert seen["constructor_kwargs"] == {"device": "cpu"}
    assert seen["model_path"] == str(model_path)
    assert seen["load_kwargs"] == {}


def test_initialize_backend_promotes_dependency_errors_to_unavailable(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcBackendUnavailable, RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    class FakeRVCInference:
        def __init__(self, **kwargs):
            raise ModuleNotFoundError("No module named 'torch'")

    infer_module = types.ModuleType("rvc_python.infer")
    infer_module.RVCInference = FakeRVCInference
    package_module = types.ModuleType("rvc_python")
    package_module.infer = infer_module
    monkeypatch.setitem(sys.modules, "rvc_python", package_module)
    monkeypatch.setitem(sys.modules, "rvc_python.infer", infer_module)

    with pytest.raises(RvcBackendUnavailable, match="dependencies could not be imported"):
        engine._initialize_backend()


def test_initialize_backend_passes_index_path_to_supported_loader(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    index_path = tmp_path / "model.index"
    index_path.write_bytes(b"index")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=index_path, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    seen = {}

    class FakeRVCInference:
        def __init__(self, device):
            seen["constructor_kwargs"] = {"device": device}

        def load_model(self, model_path, index_path=None):
            seen["model_path"] = model_path
            seen["load_kwargs"] = {"index_path": index_path} if index_path is not None else {}

    infer_module = types.ModuleType("rvc_python.infer")
    infer_module.RVCInference = FakeRVCInference
    package_module = types.ModuleType("rvc_python")
    package_module.infer = infer_module
    monkeypatch.setitem(sys.modules, "rvc_python", package_module)
    monkeypatch.setitem(sys.modules, "rvc_python.infer", infer_module)

    backend = engine._initialize_backend()

    assert backend is engine._rvc
    assert seen["constructor_kwargs"] == {"device": "cpu"}
    assert seen["model_path"] == str(model_path)
    assert seen["load_kwargs"] == {"index_path": str(index_path)}


def test_load_backend_initialization_runs_off_thread(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    calls = []

    async def fake_to_thread(func, *args, **kwargs):
        calls.append(func.__name__)
        return func(*args, **kwargs)

    class FakeRVCInference:
        def __init__(self, **kwargs):
            pass

        def load_model(self, model_path, **kwargs):
            pass

    infer_module = types.ModuleType("rvc_python.infer")
    infer_module.RVCInference = FakeRVCInference
    package_module = types.ModuleType("rvc_python")
    package_module.infer = infer_module
    monkeypatch.setitem(sys.modules, "rvc_python", package_module)
    monkeypatch.setitem(sys.modules, "rvc_python.infer", infer_module)
    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)

    backend = asyncio.run(engine._load_backend())

    assert backend is engine._rvc
    assert calls == ["_initialize_backend"]


def test_convert_file_serializes_backend_usage(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=None, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    class Backend:
        def infer_file(self, input_path, output_path, **kwargs):
            time.sleep(0.2)
            Path(output_path).write_bytes(b"RIFFmockWAVEdata")

    backend = Backend()
    async def fake_load_backend():
        return backend

    monkeypatch.setattr(engine, "_load_backend", fake_load_backend)

    input_path = tmp_path / "input.wav"
    input_path.write_bytes(b"RIFF....WAVEfmt ")

    started = threading.Event()
    release = threading.Event()
    active_calls = 0
    max_active_calls = 0
    lock = threading.Lock()

    async def gated_to_thread(func, *args, **kwargs):
        nonlocal active_calls, max_active_calls
        with lock:
            active_calls += 1
            max_active_calls = max(max_active_calls, active_calls)
        started.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        try:
            return func(*args, **kwargs)
        finally:
            with lock:
                active_calls -= 1

    monkeypatch.setattr(asyncio, "to_thread", gated_to_thread)

    async def run_two_conversions():
        first = asyncio.create_task(engine.convert_file(input_path))
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        second = asyncio.create_task(engine.convert_file(input_path))
        await asyncio.sleep(0.05)
        assert max_active_calls == 1
        release.set()
        await first
        await second

    asyncio.run(run_two_conversions())


def test_convert_file_applies_conversion_parameters(monkeypatch, tmp_path):
    from app.device import DeviceStatus
    from app.model_discovery import ModelFiles
    from app.rvc_engine import RvcEngine

    model_path = tmp_path / "model.pth"
    model_path.write_bytes(b"model")
    index_path = tmp_path / "model.index"
    index_path.write_bytes(b"index")
    engine = RvcEngine(
        ModelFiles(model_path=model_path, index_path=index_path, searched_dirs=[]),
        DeviceStatus(configured_device="cpu", effective_device="cpu", cuda_available=None, fallback_reason=None),
    )

    seen = {}

    class Backend:
        def set_params(self, **kwargs):
            seen["set_params"] = kwargs

        def infer_file(self, input_path, output_path, **kwargs):
            seen["infer_file"] = kwargs
            Path(output_path).write_bytes(b"RIFFmockWAVEdata")

    async def fake_load_backend():
        return Backend()

    monkeypatch.setattr(engine, "_load_backend", fake_load_backend)

    input_path = tmp_path / "input.wav"
    input_path.write_bytes(b"RIFF....WAVEfmt ")

    asyncio.run(engine.convert_file(input_path, pitch=3, index_rate=0.75, f0_method="harvest"))

    assert seen["set_params"] == {
        "f0up_key": 3,
        "f0method": "harvest",
        "index_rate": 0.75,
    }
    assert seen["infer_file"] == {
        "f0up_key": 3,
        "f0method": "harvest",
        "index_rate": 0.75,
    }
