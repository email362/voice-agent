#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RVC_DIR="$ROOT_DIR/rvc-service"
RVC_HOST="${RVC_HOST:-127.0.0.1}"
RVC_PORT="${RVC_PORT:-5055}"
RVC_DEVICE="${RVC_DEVICE:-cuda:0}"
RVC_SERVICE_URL="${RVC_SERVICE_URL:-http://$RVC_HOST:$RVC_PORT}"
RVC_PID=""

cleanup() {
  if [[ -n "$RVC_PID" ]] && kill -0 "$RVC_PID" 2>/dev/null; then
    kill "$RVC_PID" 2>/dev/null || true
    wait "$RVC_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -x "$RVC_DIR/.venv/bin/python" ]]; then
  echo "Missing RVC Python environment at $RVC_DIR/.venv/bin/python" >&2
  echo "Create it with: cd rvc-service && python3.10 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

(
  cd "$RVC_DIR"
  RVC_HOST="$RVC_HOST" RVC_PORT="$RVC_PORT" RVC_DEVICE="$RVC_DEVICE" "$RVC_DIR/.venv/bin/python" run.py
) &
RVC_PID="$!"

cd "$ROOT_DIR"
RVC_SERVICE_URL="$RVC_SERVICE_URL" npm start
