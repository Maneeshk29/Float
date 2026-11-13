#!/usr/bin/env bash
# Float: create a Python environment (first run only), install packages and start the app.
#   bash run.sh                         -> http://localhost:8080
#   GB10_API_KEY=... bash run.sh        -> also turns on the Qwen vision model on the GB10
#   PORT=8090 bash run.sh               -> different port
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  PY=""
  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then PY="$c"; break; fi
  done
  [ -n "$PY" ] || { echo "Float needs Python 3.11 or newer (https://www.python.org/downloads/)."; exit 1; }
  echo "First run: creating .venv with $PY and installing packages (a few minutes)..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r requirements.txt
fi
exec .venv/bin/python -m floatapp.server
