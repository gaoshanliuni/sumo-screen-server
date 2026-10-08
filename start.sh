#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -x "${ROOT_DIR}/backend/start.sh" ]]; then
  exec "${ROOT_DIR}/backend/start.sh"
fi

if [[ -f "${ROOT_DIR}/backend/start.sh" ]]; then
  exec bash "${ROOT_DIR}/backend/start.sh"
fi

if [[ -f "/app/backend/start.sh" ]]; then
  exec bash "/app/backend/start.sh"
fi

echo "[start.sh] ERROR: backend/start.sh not found"
exit 1
