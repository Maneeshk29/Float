"""The trained models: flood-risk timeline (tabular) and aerial-image classifier, plus Qwen on the GB10."""
import base64
import io
import json
import threading
import urllib.request

import math

from .config import MODELS, VLM_KEY, VLM_MODEL, VLM_URL

HORIZONS = [0, 1, 3, 6, 12, 24]
_lock = threading.Lock()
_risk = None
_image = None


def risk_bundle():
    """The trained gradient-boosted risk model, exported to plain JSON trees (training/export_risk_model.py)."""
    global _risk
    with _lock:
        if _risk is None:
            _risk = json.loads((MODELS / "risk_model.json").read_text())
    return _risk


def predict_risk(bundle, rows):
    """Flood probability for each feature row (same result as scikit-learn's predict_proba)."""
    out = []
    for x in rows:
        raw = bundle["baseline"]
        for t in bundle["trees"]:
            node = 0
            while not t["leaf"][node]:
                v = x[t["feature"][node]]
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    go_left = t["missing_left"][node]
                else:
                    go_left = v <= t["threshold"][node]
                node = t["left"][node] if go_left else t["right"][node]
            raw += t["value"][node]
        out.append(1.0 / (1.0 + math.exp(-raw)))
    return out


def level(p):
    if p >= 0.8:
        return "VERY HIGH"
    if p >= 0.5:
        return "HIGH"
    if p >= 0.2:
        return "MODERATE"
    return "LOW"


def score_hours(rain, elevation_m, fema_sfha, offsets):
    """Combined (trained model + rainfall rule) flood probability at each hour offset from now.

    Rain windows end at hour now+offset, so forecast rain is included for future offsets."""
    bundle = risk_bundle()
    hourly, now = rain["rain_mm"], rain["now_index"]
    rows, details = [], []
    for h in offsets:
        end = min(now + h, len(hourly) - 1) + 1   # rainfall up to and including hour now+h

        def window(hours):
            return round(sum(hourly[max(end - hours, 0):end]), 1)

        rows.append({"rain_1d_mm": window(24), "rain_3d_mm": window(72), "rain_7d_mm": window(168),
                     "elevation_m": elevation_m, "fema_sfha": None if fema_sfha is None else int(fema_sfha)})
        details.append({"forecast_rain_mm": round(sum(hourly[now + 1:end]), 1) if h else 0.0,
                        "rain_6h_mm": window(6)})
    probs = predict_risk(bundle, [[None if r[f] is None else float(r[f]) for f in bundle["features"]] for r in rows])
    out = []
    for h, p_ml, feats, d in zip(offsets, probs, rows, details):
        p_rule = rule_probability(d["rain_6h_mm"], feats["rain_1d_mm"], feats["rain_3d_mm"], fema_sfha)
        out.append({"h": h, "p": max(float(p_ml), p_rule), "p_ml": float(p_ml), "p_rule": p_rule,
                    "feats": feats, **d})
    return out


def outlook(rain, elevation_m, fema_sfha, tz="America/Chicago"):
    """Daily flood-risk outlook for today and the next 7 days (peak hourly risk per local day)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    zone = ZoneInfo(tz)
    times, hourly, now = rain["times"], rain["rain_mm"], rain["now_index"]
    offsets = list(range(0, len(times) - now))
    days = {}
    for s in score_hours(rain, elevation_m, fema_sfha, offsets):
        idx = now + s["h"]
        day = datetime.fromtimestamp(times[idx], zone).date()
        d = days.setdefault(day, {"p": 0.0, "rain_mm": 0.0, "peak_h": s["h"]})
        d["rain_mm"] += hourly[idx]
        if s["p"] > d["p"]:
            d["p"], d["peak_h"] = s["p"], s["h"]
    out = []
    for i, (day, d) in enumerate(sorted(days.items())[:8]):
        out.append({"date": day.isoformat(), "weekday": day.strftime("%a"), "label": day.strftime("%a %b %-d"),
                    "probability": round(d["p"], 3), "level": level(d["p"]), "rain_mm": round(d["rain_mm"], 1),
                    "confidence": "high" if i <= 1 else "medium" if i <= 4 else "low"})
    peak = max(out, key=lambda d: d["probability"]) if out else None
    return {"days": out, "peak": peak}


def risk_timeline(rain, elevation_m, fema_sfha):
    """Flood probability now and at +1/3/6/12/24 h, using observed + forecast rainfall windows."""
    bundle = risk_bundle()
    out = []
    for s in score_hours(rain, elevation_m, fema_sfha, HORIZONS):
        h, p, p_ml, p_rule, feats, d = s["h"], s["p"], s["p_ml"], s["p_rule"], s["feats"], s
        reasons = []
        if h:
            reasons.append(f"{d['forecast_rain_mm']:.0f} mm of rain forecast in the next {h} h")
        reasons.append(f"{d['rain_6h_mm']:.0f} mm in 6 h, {feats['rain_1d_mm']:.0f} mm in 24 h and "
                       f"{feats['rain_3d_mm']:.0f} mm in 3 days up to this time")
        if fema_sfha is True:
            reasons.append("inside a FEMA Special Flood Hazard Area")
        elif fema_sfha is False:
            reasons.append("outside FEMA's mapped high-risk flood zone (flooding still happens outside it)")
        reasons.append(f"trained model {p_ml:.0%}, rainfall rule {p_rule:.0%}; Float shows the higher")
        out.append({"horizon_h": h, "probability": round(p, 3), "level": level(p),
                    "model_probability": round(float(p_ml), 3), "rule_probability": round(p_rule, 3),
                    "features": feats, "reasons": reasons})
    return {"version": bundle["version"], "timeline": out}


def rule_probability(rain_6h, rain_1d, rain_3d, fema_sfha):
    """Deterministic layer (research brief, layer 1). The trained model has almost no examples between
    'dry' and 'Hurricane Harvey', so it can under-rate moderate storms; this uncalibrated rule of thumb
    keeps heavy rain from ever showing as low risk."""
    clip = lambda v: min(max(v, 0.0), 0.9)
    p = max(clip((rain_6h - 40) / 80), clip((rain_1d - 60) / 120), clip((rain_3d - 100) / 200))
    if fema_sfha and p > 0:
        p = min(p + 0.1, 0.95)
    return round(p, 3)


def image_model():
    global _image
    with _lock:
        if _image is None:
            import torch
            import torch.nn as nn
            from torchvision import models, transforms
            net = models.resnet18(weights=None)
            net.fc = nn.Linear(net.fc.in_features, 2)
            net.load_state_dict(torch.load(MODELS / "image_model.pt", map_location="cpu"))
            net.eval()
            tf = transforms.Compose([transforms.Resize((224, 224)), transforms.ToTensor(),
                                     transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
            _image = (net, tf, torch)
    return _image


def image_ai_available():
    """The image classifier needs PyTorch (installed by run.sh; too large for serverless hosting)."""
    try:
        import torch  # noqa: F401
        import torchvision  # noqa: F401
    except ImportError:
        return False
    return (MODELS / "image_model.pt").exists()


def classify_image(pil_image):
    if not image_ai_available():
        return None
    net, tf, torch = image_model()
    with torch.no_grad():
        p = torch.softmax(net(tf(pil_image.convert("RGB")).unsqueeze(0)), 1)[0, 1].item()
    return {"flood_probability": round(p, 3), "label": "flood" if p >= 0.5 else "not_flood",
            "model": "Float ResNet-18 (trained on 1,193 labeled Texas aerial images)"}


QWEN_PROMPT = ("You are helping a resident document flood conditions. Look at this photo. "
               "1) Is floodwater visible? Answer FLOOD, NOT_FLOOD or UNCERTAIN on the first line. "
               "2) In two or three short plain-language sentences, describe what is visible that matters "
               "for safety or an insurance claim (water level against walls, cars or roads, damaged items). "
               "3) Say what cannot be determined from the photo. Do not guess water depth in feet.")


def vlm_available():
    return bool(VLM_KEY)


def ask_qwen(pil_image, prompt=QWEN_PROMPT, max_tokens=220):
    """Describe an image with Qwen3-VL on the GB10. Raises if the server is unreachable."""
    if not VLM_KEY:
        raise RuntimeError("GB10_API_KEY is not set, so the GB10 vision model is off.")
    img = pil_image.convert("RGB")
    img.thumbnail((1024, 1024))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    body = json.dumps({"model": VLM_MODEL, "temperature": 0.001, "max_tokens": max_tokens,
                       "messages": [{"role": "user", "content": [
                           {"type": "text", "text": prompt},
                           {"type": "image_url", "image_url": {"url": url}}]}]}).encode()
    req = urllib.request.Request(f"{VLM_URL}/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {VLM_KEY}"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        text = json.load(resp)["choices"][0]["message"]["content"].strip()
    first, _, rest = text.partition("\n")
    head = first.upper()
    verdict = "not_flood" if "NOT" in head else "flood" if "FLOOD" in head else "uncertain"
    return {"verdict": verdict, "description": rest.strip() or text, "model": f"{VLM_MODEL} on the GB10"}


def vlm_status():
    if not VLM_KEY:
        return {"enabled": False, "reason": "GB10_API_KEY not set"}
    try:
        req = urllib.request.Request(f"{VLM_URL}/models", headers={"Authorization": f"Bearer {VLM_KEY}"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            ids = [m["id"] for m in json.load(resp)["data"]]
        return {"enabled": VLM_MODEL in ids, "model": VLM_MODEL,
                "reason": None if VLM_MODEL in ids else f"{VLM_MODEL} not served"}
    except Exception as e:
        return {"enabled": False, "reason": f"GB10 not reachable ({type(e).__name__})"}
