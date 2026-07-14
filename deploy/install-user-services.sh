#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PORT=8787
RENDER_DIR=""

while (($#)); do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "missing value for --port" >&2; exit 1; }
      PORT="$2"
      shift 2
      ;;
    --render-dir)
      [[ $# -ge 2 ]] || { echo "missing value for --render-dir" >&2; exit 1; }
      RENDER_DIR="$2"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$RENDER_DIR" ]]; then
  node "$ROOT_DIR/deploy/render-systemd.js" --project-root "$ROOT_DIR" --port "$PORT" --output-dir "$RENDER_DIR"
  exit 0
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
node "$ROOT_DIR/deploy/render-systemd.js" --project-root "$ROOT_DIR" --port "$PORT" --check-port --output-dir "$UNIT_DIR"
systemctl --user daemon-reload
echo "Units installed but not enabled. Run: systemctl --user enable --now voice-agent-rvc.service voice-agent-web.service"
