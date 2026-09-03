#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uvicorn_bin="$project_dir/.venv/bin/uvicorn"
model_path="$project_dir/analysis/models/pose_landmarker_lite.task"
local_port="${SNOWTRACE_LOCAL_PORT:-8080}"

if [[ -z "${SNOWTRACE_JOB_TOKEN:-}" ]]; then
  echo "SNOWTRACE_JOB_TOKEN is required. Use the same analysis token configured in Sites." >&2
  exit 1
fi

if [[ ! -x "$uvicorn_bin" ]]; then
  echo "Missing $uvicorn_bin. Create .venv and install the analysis package first." >&2
  exit 1
fi

if [[ ! -f "$model_path" ]]; then
  echo "Missing MediaPipe model: $model_path" >&2
  exit 1
fi

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required but was not found on PATH." >&2
    exit 1
  fi
done

case "$local_port" in
  ''|*[!0-9]*)
    echo "SNOWTRACE_LOCAL_PORT must be a number between 1 and 65535." >&2
    exit 1
    ;;
esac

if (( local_port < 1 || local_port > 65535 )); then
  echo "SNOWTRACE_LOCAL_PORT must be a number between 1 and 65535." >&2
  exit 1
fi

export MPLCONFIGDIR="${MPLCONFIGDIR:-$project_dir/.snowtrace-work/matplotlib}"
export SNOWTRACE_POSE_MODEL="$model_path"
export SNOWTRACE_MAX_ACTIVE_JOBS="${SNOWTRACE_MAX_ACTIVE_JOBS:-1}"
export SNOWTRACE_MAX_SOURCE_BYTES="${SNOWTRACE_MAX_SOURCE_BYTES:-99614720}"
export SNOWTRACE_SOURCE_HOSTS="${SNOWTRACE_SOURCE_HOSTS:-snowtrace-coach.sjysjy.chatgpt.site}"
export SNOWTRACE_CALLBACK_HOSTS="${SNOWTRACE_CALLBACK_HOSTS:-snowtrace-coach.sjysjy.chatgpt.site}"

# Local file URLs are useful in isolated tests but must never be accepted by a
# worker reachable through a tunnel.
unset SNOWTRACE_ALLOW_LOCAL_FILES

mkdir -p "$MPLCONFIGDIR"

echo "Starting Snowtrace analysis on http://127.0.0.1:$local_port"
echo "The service is loopback-only; expose it with a separate authenticated tunnel when needed."

exec "$uvicorn_bin" snowtrace_analysis.api:app \
  --host 127.0.0.1 \
  --port "$local_port"
