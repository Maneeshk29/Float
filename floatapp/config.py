"""Paths and settings. Everything secret comes from environment variables."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MODELS = ROOT / "models"
STATIC = ROOT / "static"
EVIDENCE = ROOT / "evidence"          # recovery photos and their records (kept on this machine)
STATE = Path(os.environ.get("FLOAT_STATE_DIR", ROOT / "state"))   # alerts and shelter matches

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Qwen vision model on the GB10 (OpenAI-compatible API). Leave GB10_API_KEY unset to run without it.
VLM_URL = os.environ.get("GB10_URL", "http://10.246.100.230/v1").rstrip("/")
VLM_KEY = os.environ.get("GB10_API_KEY", "")
VLM_MODEL = os.environ.get("GB10_MODEL", "qwen3-vl-8b-instruct")

USER_AGENT = "Float/0.1 (https://github.com/Maneeshk29/Float)"
PILOT_COUNTY_FIPS = "48201"           # Harris County, TX
ALERT_CHECK_HOURS = float(os.environ.get("ALERT_CHECK_HOURS", "3"))   # how often signed-up places are re-checked
