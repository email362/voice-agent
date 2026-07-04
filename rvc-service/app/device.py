from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DeviceStatus:
    configured_device: str
    effective_device: str
    cuda_available: bool | None
    fallback_reason: str | None


def resolve_device(configured_device: str) -> DeviceStatus:
    if not configured_device.startswith("cuda"):
        return DeviceStatus(configured_device, configured_device, None, None)

    try:
        import torch  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on optional torch install
        return DeviceStatus(configured_device, "cpu", None, f"torch unavailable, using cpu fallback: {exc}")

    try:
        if torch.cuda.is_available():
            return DeviceStatus(configured_device, configured_device, True, None)
        return DeviceStatus(configured_device, "cpu", False, "CUDA is not available to torch, using cpu fallback")
    except Exception as exc:  # pragma: no cover - defensive around CUDA runtime issues
        return DeviceStatus(configured_device, "cpu", False, f"CUDA check failed, using cpu fallback: {exc}")
