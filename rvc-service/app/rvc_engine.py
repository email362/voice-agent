from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import tempfile
from pathlib import Path
from typing import Any, Callable

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


def _is_backend_dependency_error(exc: Exception) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, (ImportError, ModuleNotFoundError)):
            return True
        if isinstance(current, OSError):
            message = str(current).lower()
            if "cannot open shared object file" in message or "dll load failed" in message:
                return True
        current = current.__cause__ or current.__context__
    return False


class RvcEngine:
    def __init__(self, model_files: ModelFiles, device_status: DeviceStatus) -> None:
        self.model_files = model_files
        self.device_status = device_status
        self._backend_error: str | None = None
        self._backend_failure: Exception | None = None
        self._rvc: Any | None = None
        self._backend_init_lock = asyncio.Lock()
        self._conversion_lock = asyncio.Lock()

    @property
    def backend_available(self) -> bool:
        try:
            import rvc_python.infer  # noqa: F401
        except Exception as exc:
            self._backend_error = str(exc)
            return False
        self._backend_error = None
        return True

    @property
    def backend_error(self) -> str | None:
        if self._rvc is not None:
            return None
        if self._backend_failure is not None:
            return str(self._backend_failure)
        if self._backend_error is None and not self.backend_available:
            return self._backend_error
        return self._backend_error

    def _initialize_backend(self) -> Any:
        if self._rvc is not None:
            return self._rvc
        _patch_torch_load_for_rvc()
        try:
            from rvc_python.infer import RVCInference
        except Exception as exc:
            self._backend_error = str(exc)
            raise RvcBackendUnavailable(f"rvc-python is not installed or could not be imported: {exc}") from exc

        try:
            backend_kwargs, _ = self._filter_supported_kwargs(
                RVCInference,
                {"device": self.device_status.effective_device},
            )
            rvc = RVCInference(**backend_kwargs)
            load_kwargs: dict[str, Any] = {}
            if self.model_files.index_path:
                load_kwargs["index_path"] = str(self.model_files.index_path)
            load_kwargs, _ = self._filter_supported_kwargs(rvc.load_model, load_kwargs)
            rvc.load_model(str(self.model_files.model_path), **load_kwargs)
        except Exception as exc:
            self._backend_error = str(exc)
            if _is_backend_dependency_error(exc):
                raise RvcBackendUnavailable(f"rvc-python or one of its dependencies could not be imported: {exc}") from exc
            raise RvcConversionError(f"Failed to initialize RVC model: {exc}") from exc

        self._rvc = rvc
        self._backend_error = None
        return rvc

    async def _load_backend(self) -> Any:
        if self._rvc is not None:
            return self._rvc
        if self._backend_failure is not None:
            raise self._backend_failure
        async with self._backend_init_lock:
            if self._rvc is not None:
                return self._rvc
            if self._backend_failure is not None:
                raise self._backend_failure
            try:
                return await asyncio.to_thread(self._initialize_backend)
            except Exception as exc:
                self._backend_failure = exc
                raise

    @staticmethod
    def _check_cancelled(cancelled: Callable[[], bool] | None) -> None:
        if cancelled and cancelled():
            raise asyncio.CancelledError

    async def ensure_ready(self) -> bool:
        try:
            await self._load_backend()
        except Exception:
            return False
        return True

    @staticmethod
    def _filter_supported_kwargs(callable_obj: Any, kwargs: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        try:
            signature = inspect.signature(callable_obj)
        except (TypeError, ValueError):
            return kwargs, False
        if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
            return kwargs, True
        accepted = set(signature.parameters)
        return {key: value for key, value in kwargs.items() if key in accepted}, True

    @staticmethod
    def _should_retry_infer_without_kwargs(error: TypeError, kwargs: dict[str, Any]) -> bool:
        if not kwargs:
            return False
        message = str(error).lower()
        if "unexpected keyword argument" in message:
            return True
        if "positional arguments but" in message and "were given" in message:
            return True
        if "multiple values for argument" in message:
            return True
        return False

    async def convert_file(
        self,
        input_path: Path,
        *,
        pitch: int = 0,
        index_rate: float = 0.5,
        f0_method: str = "rmvpe",
        cancelled: Callable[[], bool] | None = None,
    ) -> Path:
        _patch_torch_load_for_rvc()
        await self._conversion_lock.acquire()
        release_lock = True
        try:
            self._check_cancelled(cancelled)
            rvc = await self._load_backend()
            self._check_cancelled(cancelled)
            output_fd, output_name = tempfile.mkstemp(dir=input_path.parent, suffix=".wav")
            os.close(output_fd)
            output_path = Path(output_name)

            kwargs = {
                "f0up_key": pitch,
                "f0method": f0_method,
                "index_rate": index_rate,
            }

            try:
                def run_inference() -> None:
                    self._check_cancelled(cancelled)
                    filtered_kwargs, infer_signature_known = self._filter_supported_kwargs(rvc.infer_file, kwargs)
                    set_params = getattr(rvc, "set_params", None)
                    if callable(set_params):
                        set_params_kwargs, _ = self._filter_supported_kwargs(set_params, kwargs)
                        if set_params_kwargs:
                            set_params(**set_params_kwargs)
                    try:
                        rvc.infer_file(str(input_path), str(output_path), **filtered_kwargs)
                    except TypeError as error:
                        if infer_signature_known or not self._should_retry_infer_without_kwargs(error, filtered_kwargs):
                            raise
                        # Some rvc-python versions only accept input/output paths. Keep a working conversion path.
                        rvc.infer_file(str(input_path), str(output_path))

                infer_task = asyncio.create_task(asyncio.to_thread(run_inference))
                if cancelled is not None:
                    cancel_task = asyncio.create_task(self._wait_for_cancellation(cancelled))
                    done, pending = await asyncio.wait(
                        {infer_task, cancel_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if cancel_task in done:
                        async def cleanup_after_inference() -> None:
                            with contextlib.suppress(BaseException):
                                await infer_task
                            output_path.unlink(missing_ok=True)
                            if self._conversion_lock.locked():
                                self._conversion_lock.release()

                        release_lock = False
                        asyncio.create_task(cleanup_after_inference())
                        raise asyncio.CancelledError
                    cancel_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await cancel_task
                    await infer_task
                else:
                    await infer_task
            except asyncio.CancelledError:
                output_path.unlink(missing_ok=True)
                raise
            except Exception as exc:
                output_path.unlink(missing_ok=True)
                raise RvcConversionError(f"RVC conversion failed: {exc}") from exc

            return output_path
        finally:
            if release_lock and self._conversion_lock.locked():
                self._conversion_lock.release()

    @staticmethod
    async def _wait_for_cancellation(cancelled: Callable[[], bool]) -> None:
        while not cancelled():
            await asyncio.sleep(0.05)
        raise asyncio.CancelledError
