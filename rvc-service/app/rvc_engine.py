from __future__ import annotations

import inspect
import tempfile
from pathlib import Path
from typing import Any

from .device import DeviceStatus
from .model_discovery import ModelFiles


class RvcBackendUnavailable(RuntimeError):
    pass


class RvcConversionError(RuntimeError):
    pass




def _patch_torch_load_for_rvc() -> None:
    # rvc-python/fairseq load trusted local model checkpoints that require pickle
    # objects. Newer PyTorch defaults torch.load(weights_only=True), which breaks
    # those checkpoints. This process is local-only and uses the user's model files.
    try:
        import torch  # type: ignore
    except Exception:
        return
    if getattr(torch.load, "_rvc_weights_only_patch", False):
        return
    original_load = torch.load

    def patched_load(*args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("weights_only", False)
        return original_load(*args, **kwargs)

    patched_load._rvc_weights_only_patch = True  # type: ignore[attr-defined]
    torch.load = patched_load  # type: ignore[assignment]


class RvcEngine:
    def __init__(self, model_files: ModelFiles, device_status: DeviceStatus) -> None:
        self.model_files = model_files
        self.device_status = device_status
        self._backend_error: str | None = None
        self._rvc: Any | None = None

    @property
    def backend_available(self) -> bool:
        try:
            import rvc_python.infer  # noqa: F401
        except Exception as exc:
            self._backend_error = str(exc)
            return False
        return True

    @property
    def backend_error(self) -> str | None:
        if self._backend_error is None and not self.backend_available:
            return self._backend_error
        return self._backend_error

    def _load_backend(self) -> Any:
        if self._rvc is not None:
            return self._rvc
        _patch_torch_load_for_rvc()
        try:
            from rvc_python.infer import RVCInference
        except Exception as exc:
            self._backend_error = str(exc)
            raise RvcBackendUnavailable(f"rvc-python is not installed or could not be imported: {exc}") from exc

        try:
            index_path = str(self.model_files.index_path) if self.model_files.index_path else ''
            rvc = RVCInference(device=self.device_status.effective_device, index_path=index_path)
            rvc.load_model(str(self.model_files.model_path), index_path=index_path)
        except Exception as exc:
            raise RvcConversionError(f"Failed to initialize RVC model: {exc}") from exc

        self._rvc = rvc
        return rvc

    async def convert_file(
        self,
        input_path: Path,
        *,
        pitch: int = 0,
        index_rate: float = 0.5,
        f0_method: str = "rmvpe",
    ) -> Path:
        _patch_torch_load_for_rvc()
        rvc = self._load_backend()
        output_path = Path(tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name)

        kwargs = {
            "f0up_key": pitch,
            "f0method": f0_method,
            "index_rate": index_rate,
        }
        if self.model_files.index_path:
            kwargs["index_path"] = str(self.model_files.index_path)

        try:
            signature = inspect.signature(rvc.infer_file)
            accepted = set(signature.parameters)
            filtered_kwargs = {key: value for key, value in kwargs.items() if key in accepted}
            rvc.infer_file(str(input_path), str(output_path), **filtered_kwargs)
        except TypeError:
            # Some rvc-python versions only accept input/output paths. Keep a working conversion path.
            rvc.infer_file(str(input_path), str(output_path))
        except Exception as exc:
            raise RvcConversionError(f"RVC conversion failed: {exc}") from exc

        return output_path
