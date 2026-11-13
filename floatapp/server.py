"""Float web server (Python standard library HTTP server + the trained models).

Run:  python -m floatapp.server   then open http://localhost:8080
"""
import base64
import hashlib
import io
import json
import math
import mimetypes
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pandas as pd
from PIL import Image

from . import check, community, live, models
from .config import ALERT_CHECK_HOURS, DATA, EVIDENCE, HOST, MODELS, PORT, STATIC, VLM_MODEL

def records(frame):
    """DataFrame -> list of dicts with NaN turned into None (valid JSON)."""
    return frame.astype(object).where(frame.notna(), None).to_dict("records")


ALL_SITES = pd.read_csv(DATA / "sites.csv")
SITE_BY_ID = {r["image_id"]: r for r in records(ALL_SITES)}
SITES = ALL_SITES.dropna(subset=["lat", "lon"])          # located sites (4 images have no coordinates)
ESSENTIALS = json.loads((DATA / "essentials.json").read_text())
METRICS = {name: json.loads((MODELS / f"{name}_metrics.json").read_text())
           for name in ("risk_model", "image_model") if (MODELS / f"{name}_metrics.json").exists()}
POOL = ThreadPoolExecutor(8)
evidence_lock = threading.Lock()
MAX_UPLOAD = 15 * 1024 * 1024


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# --- Data endpoints ------------------------------------------------------------------------------
def sites_payload():
    keep = ["image_id", "lat", "lon", "label", "labeled_by", "locality", "date", "event_name",
            "image_role", "source_agency", "qwen_reason", "fema_zones", "rain_3d_mm"]
    return {"sites": records(SITES[keep]),
            "provenance": {"source": "UTSA Texas flood imagery (USDA NAIP, NOAA NGS) labeled for Float: "
                                     "100 by hand, the rest by Qwen3-VL on the GB10",
                           "status_type": "historical"}}


def nearby_essentials(lat, lon, radius_km=10, per_type=5):
    by_type = {}
    for p in ESSENTIALS["places"]:
        d = km(lat, lon, p["lat"], p["lon"])
        if d <= radius_km:
            by_type.setdefault(p["type"], []).append({**p, "km": round(d, 1)})
    return {t: sorted(v, key=lambda x: x["km"])[:per_type] for t, v in by_type.items()}


def nearby(lat, lon, radius_km=30, per_type=12):
    """Nearest hospitals, pharmacies, grocery, fuel and shelters: shown whatever the flood risk."""
    s, w, n, e = (float(v) for v in ESSENTIALS["bbox"].split(","))
    return {"places": nearby_essentials(lat, lon, radius_km, per_type),
            "in_coverage": s <= lat <= n and w <= lon <= e,
            "provenance": {"source": ESSENTIALS["source"], "status_type": "reference",
                           "observed_at": ESSENTIALS["osm_snapshot"], "retrieved_at": ESSENTIALS["retrieved_at"]}}


def nearby_evidence(lat, lon, radius_km=5):
    near = []
    for r in records(SITES):
        d = km(lat, lon, r["lat"], r["lon"])
        if d <= radius_km:
            near.append({"image_id": r["image_id"], "label": r["label"], "date": r["date"],
                         "event_name": r["event_name"], "km": round(d, 2)})
    near.sort(key=lambda x: x["km"])
    return {"radius_km": radius_km, "count": len(near),
            "flooded": sum(1 for n in near if n["label"] == "flood"), "sites": near[:12]}


def point(lat, lon):
    jobs = {"alerts": POOL.submit(live.nws_alerts, lat, lon), "rain": POOL.submit(live.rainfall, lat, lon),
            "fema": POOL.submit(live.fema_zone, lat, lon)}
    res = {k: f.result() for k, f in jobs.items()}
    rain, fema = res["rain"], res["fema"]
    risk = None
    if rain["ok"]:
        sfha = fema.get("sfha") if fema["ok"] else None
        risk = models.risk_timeline(rain, rain.get("elevation_m"), sfha)
        risk["outlook"] = models.outlook(rain, rain.get("elevation_m"), sfha)
        risk["provenance"] = {"source": "Float experimental model", "status_type": "experimental",
                              "retrieved_at": live.now_iso()}
        now = rain["now_index"]
        rain["summary"] = {"past_1h_mm": round(rain["rain_mm"][now], 1),
                           "past_24h_mm": round(sum(rain["rain_mm"][max(now - 23, 0):now + 1]), 1),
                           "next_6h_mm": round(sum(rain["rain_mm"][now + 1:now + 7]), 1),
                           "next_24h_mm": round(sum(rain["rain_mm"][now + 1:now + 25]), 1)}
        rain["chart"] = [[t, r] for t, r in zip(rain["times"][max(now - 48, 0):now + 25],
                                                rain["rain_mm"][max(now - 48, 0):now + 25])]
        for k in ("times", "rain_mm"):
            rain.pop(k)
    return {"lat": lat, "lon": lon, "alerts": res["alerts"], "rain": rain, "fema": fema, "risk": risk,
            "essentials": {"places": nearby_essentials(lat, lon),
                           "provenance": {"source": ESSENTIALS["source"], "status_type": "reference",
                                          "observed_at": ESSENTIALS["osm_snapshot"],
                                          "retrieved_at": ESSENTIALS["retrieved_at"]}},
            "evidence": nearby_evidence(lat, lon)}


def priorities():
    """Emergency-manager view: which areas need attention first (transparent formula)."""
    rows = []
    for loc, g in SITES.groupby("locality"):
        labeled = g[g["label"].isin(["flood", "not_flood"])]
        after = labeled[labeled["image_role"] == "response"]
        base = after if len(after) else labeled
        lat, lon = g["lat"].astype(float).mean(), g["lon"].astype(float).mean()
        first = g.iloc[0]
        hosp = [p for p in ESSENTIALS["places"] if p["type"] == "hospital" and km(lat, lon, p["lat"], p["lon"]) <= 10]
        rows.append({"locality": loc, "county": first["county"], "event": first["event_name"],
                     "lat": lat, "lon": lon, "images": int(len(g)),
                     "flood_share": round(float((base["label"] == "flood").mean()), 3) if len(base) else 0.0,
                     "poverty_pct": num(first["poverty_pct"]), "no_vehicle_pct": num(first["no_vehicle_pct"]),
                     "age65_pct": num(first["age65_pct"]), "disability_pct": num(first["disability_pct"]),
                     "hospitals_10km": len(hosp),
                     "in_essentials_area": bool(29.45 <= lat <= 30.20 and -95.95 <= lon <= -94.85)})
    df = pd.DataFrame(rows)
    vul_cols = ["poverty_pct", "no_vehicle_pct", "age65_pct", "disability_pct"]
    norm = (df[vul_cols] - df[vul_cols].min()) / (df[vul_cols].max() - df[vul_cols].min()).replace(0, 1)
    df["vulnerability"] = norm.mean(axis=1).fillna(0).round(3)
    access_gap = 1 - (df["hospitals_10km"].clip(upper=10) / 10)
    # Outside the essentials snapshot hospital access is unknown: score on the other two terms, rescaled to 100
    df["score"] = (50 * df["flood_share"] + 35 * df["vulnerability"] + 15 * access_gap).where(
        df["in_essentials_area"], (50 * df["flood_share"] + 35 * df["vulnerability"]) * 100 / 85).round(1)
    df = df.sort_values("score", ascending=False)
    return {"areas": records(df),
            "formula": "score = 50 x share of post-storm images showing flooding + 35 x county vulnerability "
                       "(poverty, no-vehicle households, age 65+, disability; scaled 0-1 across areas) + "
                       "15 x hospital-access gap (fewer than 10 hospitals within 10 km). Outside the Houston essentials "
                       "snapshot, hospital access is unknown and the first two terms are rescaled to 100.",
            "note": "County figures are ACS estimates for the whole county, not the neighborhood. Vulnerability "
                    "is used to direct extra support, never to deny it."}


# --- Images --------------------------------------------------------------------------------------
def decode_image(data_url):
    raw = base64.b64decode(data_url.split(",", 1)[-1])
    if len(raw) > MAX_UPLOAD:
        raise ValueError("Image is larger than 15 MB.")
    return raw, Image.open(io.BytesIO(raw))


def analyze(img, use_qwen=True):
    out = {"classifier": models.classify_image(img)}
    if use_qwen:
        try:
            out["qwen"] = models.ask_qwen(img)
        except Exception as e:
            out["qwen_error"] = str(e)[:200]
    return out


def save_evidence(body):
    raw, img = decode_image(body["image"])
    result = analyze(img, body.get("use_qwen", True))
    digest = hashlib.sha256(raw).hexdigest()
    ext = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}.get(img.format, "jpg")
    record = {"id": digest[:16], "sha256": digest, "file": f"{digest[:16]}.{ext}",
              "captured_at": live.now_iso(), "lat": num(body.get("lat")), "lon": num(body.get("lon")),
              "note": str(body.get("note", ""))[:1000], "analysis": result}
    with evidence_lock:
        EVIDENCE.mkdir(exist_ok=True)
        (EVIDENCE / record["file"]).write_bytes(raw)
        (EVIDENCE / f"{record['id']}.json").write_text(json.dumps(record, indent=1))
    return record


def list_evidence():
    if not EVIDENCE.exists():
        return []
    recs = [json.loads(p.read_text()) for p in EVIDENCE.glob("*.json")]
    return sorted(recs, key=lambda r: r["captured_at"], reverse=True)


# --- HTTP ------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json", cache="no-store"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def static_file(self, base, rel):
        target = (base / rel).resolve()
        if base.resolve() not in target.parents or not target.is_file():
            return self.send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return self.send(200, target.read_bytes(), ctype, "max-age=3600")

    def do_GET(self):
        url = urlparse(self.path)
        path, qs = unquote(url.path), parse_qs(url.query)
        try:
            if path in ("/", "/index.html"):
                return self.send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path.startswith("/static/"):
                return self.static_file(STATIC, path[len("/static/"):])
            if path.startswith("/evidence/"):
                return self.static_file(EVIDENCE, path[len("/evidence/"):])
            if path == "/api/meta":
                return self.send(200, {"metrics": METRICS, "gb10": models.vlm_status(),
                                       "risk_model": models.risk_bundle()["version"],
                                       "essentials": {k: ESSENTIALS[k] for k in ("source", "osm_snapshot", "retrieved_at")},
                                       "sites": len(ALL_SITES), "server_time": live.now_iso()})
            if path == "/api/sites":
                return self.send(200, sites_payload(), cache="max-age=3600")
            if path == "/api/essentials":
                return self.send(200, ESSENTIALS, cache="max-age=3600")
            if path == "/api/point":
                lat, lon = float(qs["lat"][0]), float(qs["lon"][0])
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    return self.send(400, {"error": "bad coordinates"})
                return self.send(200, point(lat, lon))
            if path == "/api/gauges":
                return self.send(200, live.gauges())
            if path == "/api/geocode":
                q = qs.get("q", [""])[0].strip()
                return self.send(200, {"results": live.geocode(q) if q else []})
            if path == "/api/priorities":
                return self.send(200, priorities())
            if path == "/api/evidence":
                return self.send(200, {"records": list_evidence()})
            if path == "/api/shelter/offers":
                lat, lon = float(qs["lat"][0]), float(qs["lon"][0])
                return self.send(200, {"offers": community.find_offers(
                    lat, lon, int(qs.get("people", ["1"])[0]), qs.get("pets", ["0"])[0] == "1",
                    qs.get("accessible", ["0"])[0] == "1", kind=qs.get("kind", ["shelter"])[0])})
            if path == "/api/check":
                lat, lon = float(qs["lat"][0]), float(qs["lon"][0])
                return self.send(200, check.check(lat, lon, point(lat, lon)))
            if path == "/api/nearby":
                lat, lon = float(qs["lat"][0]), float(qs["lon"][0])
                return self.send(200, nearby(lat, lon))
            if path.startswith("/api/site/"):
                site = SITE_BY_ID.get(path.split("/")[3])
                if not site:
                    return self.send(404, {"error": "unknown site"})
                img = Image.open(STATIC / "thumbs" / f"{site['image_id']}.jpg")
                use_qwen = qs.get("qwen", ["1"])[0] == "1"
                return self.send(200, {"site": site, **analyze(img, use_qwen)})
            return self.send(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_UPLOAD * 1.4:
                return self.send(413, {"error": "Upload too large (15 MB max)."})
            body = json.loads(self.rfile.read(length) or b"{}")
            if path == "/api/analyze":
                _, img = decode_image(body["image"])
                return self.send(200, analyze(img, body.get("use_qwen", True)))
            if path == "/api/evidence":
                return self.send(200, save_evidence(body))
            actions = {"/api/alerts/subscribe": community.subscribe, "/api/alerts/unsubscribe": community.unsubscribe,
                       "/api/alerts/inbox": community.inbox, "/api/shelter/offer": community.create_offer,
                       "/api/shelter/close": community.close_offer, "/api/shelter/request": community.create_request,
                       "/api/shelter/respond": community.respond, "/api/shelter/mine": community.mine,
                       "/api/profile/save": community.save_profile, "/api/profile/get": community.get_profile}
            if path in actions:
                try:
                    return self.send(200, actions[path](body))
                except (ValueError, PermissionError) as e:
                    return self.send(400, {"error": str(e)})
            return self.send(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})


def port_in_use(port):
    """True if anything already accepts connections on localhost:port (IPv4 or IPv6)."""
    import socket
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            pass
    return False


def main():
    for port in range(PORT, PORT + 20):          # if the port is taken, use the next free one
        if port_in_use(port):
            continue
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit(f"Ports {PORT}-{PORT + 19} are all in use. Set PORT=... and try again.")
    server.daemon_threads = True
    status = models.vlm_status()
    community.start_checker(ALERT_CHECK_HOURS * 3600)
    print(f"\n  Float is running:  http://localhost:{port}")
    print(f"  GB10 vision model ({VLM_MODEL}): {'on' if status['enabled'] else 'off - ' + str(status['reason'])}")
    print(f"  Flood alerts: every place people sign up for is re-checked every {ALERT_CHECK_HOURS:g} h")
    print("  Press Ctrl+C to stop.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nFloat stopped.")


if __name__ == "__main__":
    main()
