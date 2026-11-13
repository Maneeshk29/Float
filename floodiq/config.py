"""Paths and settings. Everything secret comes from environment variables."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MODELS = ROOT / "models"
STATIC = ROOT / "static"
EVIDENCE = ROOT / "evidence"          # recovery photos and their records (kept on this machine)

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")

# Qwen vision model on the GB10 (OpenAI-compatible API). Leave GB10_API_KEY unset to run without it.
VLM_URL = os.environ.get("GB10_URL", "http://10.246.100.230/v1").rstrip("/")
VLM_KEY = os.environ.get("GB10_API_KEY", "")
VLM_MODEL = os.environ.get("GB10_MODEL", "qwen3-vl-8b-instruct")

USER_AGENT = "FloodIQ/0.1 (https://github.com/Maneeshk29/FloodIQ-)"
PILOT_COUNTY_FIPS = "48201"           # Harris County, TX
