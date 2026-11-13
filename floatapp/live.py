"""Live public data feeds. Every result carries provenance: source, status type, retrieval and observation time.

status_type values (shown as badges in the app):
  official   - government warning (NWS)
  verified   - live measurement from an operating agency (USGS gauges)
  forecast   - weather-model data (Open-Meteo)
  reference  - static regulatory or map data (FEMA flood zones, OpenStreetMap)
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .config import PILOT_COUNTY_FIPS, USER_AGENT

_cache, _lock = {}, threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_json(url, ttl, timeout=20, headers=None):
    """GET a JSON URL, cached for ttl seconds. Raises on failure."""
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], hit[2]
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(3):   # public services occasionally reset connections
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.load(resp)
            break
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(0.5 * (attempt + 1))
    retrieved = now_iso()
    with _lock:
        _cache[url] = (time.time(), data, retrieved)
    return data, retrieved


def provenance(source, status_type, retrieved_at, observed_at=None, url=None):
    return {"source": source, "status_type": status_type, "retrieved_at": retrieved_at,
            "observed_at": observed_at, "url": url}


def failed(source, status_type, error):
    return {"ok": False, "error": f"{type(error).__name__}: {str(error)[:160]}",
            "provenance": provenance(source, status_type, now_iso())}


# --- OFFICIAL: National Weather Service alerts --------------------------------------------------
def nws_alerts(lat, lon):
    url = f"https://api.weather.gov/alerts/active?point={lat:.4f},{lon:.4f}"
    try:
        # NWS asks clients not to poll more often than every 30 seconds
        data, retrieved = get_json(url, ttl=60, headers={"Accept": "application/geo+json"})
    except Exception as e:
        return failed("National Weather Service", "official", e)
    alerts = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        alerts.append({"id": p.get("id") or f.get("id"), "event": p.get("event"), "severity": p.get("severity"), "urgency": p.get("urgency"),
                       "headline": p.get("headline"), "description": (p.get("description") or "")[:1200],
                       "instruction": (p.get("instruction") or "")[:800], "sender": p.get("senderName"),
                       "effective": p.get("effective"), "expires": p.get("expires") or p.get("ends"),
                       "area": p.get("areaDesc")})
    return {"ok": True, "alerts": alerts,
            "provenance": provenance("National Weather Service (api.weather.gov)", "official", retrieved,
                                     data.get("updated"), url)}


# --- FORECAST: hourly rainfall (past 7 days + next 8 days) and ground elevation -----------------
def rainfall(lat, lon):
    q = urllib.parse.urlencode({"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "hourly": "precipitation",
                                "past_days": 7, "forecast_days": 8, "timeformat": "unixtime",
                                "precipitation_unit": "mm"})
    url = f"https://api.open-meteo.com/v1/forecast?{q}"
    try:
        data, retrieved = get_json(url, ttl=600)
    except Exception as e:
        return failed("Open-Meteo", "forecast", e)
    times = data["hourly"]["time"]
    rain = [v or 0.0 for v in data["hourly"]["precipitation"]]
    now = time.time()
    idx = max(i for i, t in enumerate(times) if t <= now)   # index of the current hour
    return {"ok": True, "times": times, "rain_mm": rain, "now_index": idx,
            "elevation_m": data.get("elevation"),
            "provenance": provenance("Open-Meteo weather models (NOAA GFS/HRRR blend) and Copernicus 90 m DEM",
                                     "forecast", retrieved, None, url)}


# --- REFERENCE: FEMA National Flood Hazard Layer -------------------------------------------------
def fema_zone(lat, lon):
    q = urllib.parse.urlencode({"geometry": f"{lon:.5f},{lat:.5f}", "geometryType": "esriGeometryPoint",
                                "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                                "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF", "returnGeometry": "false", "f": "json"})
    url = f"https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?{q}"
    try:
        data, retrieved = get_json(url, ttl=86400)
    except Exception as e:
        return failed("FEMA National Flood Hazard Layer", "reference", e)
    feats = [f["attributes"] for f in data.get("features", [])]
    zone = feats[0] if feats else None
    return {"ok": True, "mapped": bool(zone), "zone": zone["FLD_ZONE"] if zone else None,
            "subtype": zone.get("ZONE_SUBTY") if zone else None,
            "sfha": (zone["SFHA_TF"] == "T") if zone else None,
            "provenance": provenance("FEMA National Flood Hazard Layer", "reference", retrieved, None, url)}


# --- VERIFIED: USGS stream gauges, Harris County -------------------------------------------------
def gauges():
    url = ("https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00065&siteStatus=active"
           f"&period=PT6H&countyCd={PILOT_COUNTY_FIPS}")
    try:
        data, retrieved = get_json(url, ttl=300, timeout=30)
    except Exception as e:
        return failed("USGS Water Services", "verified", e)
    out = []
    for ts in data["value"]["timeSeries"]:
        info = ts["sourceInfo"]
        vals = [v for v in ts["values"][0]["value"]
                if v["value"] not in ("", None) and float(v["value"]) != float(ts["variable"]["noDataValue"])]
        if not vals:
            continue
        first, last = vals[0], vals[-1]
        hours = max((datetime.fromisoformat(last["dateTime"]) - datetime.fromisoformat(first["dateTime"])).total_seconds() / 3600, 0.25)
        rate = (float(last["value"]) - float(first["value"])) / hours
        trend = "rising" if rate > 0.1 else "falling" if rate < -0.1 else "steady"
        geo = info["geoLocation"]["geogLocation"]
        out.append({"site": info["siteCode"][0]["value"], "name": info["siteName"],
                    "lat": geo["latitude"], "lon": geo["longitude"],
                    "stage_ft": float(last["value"]), "observed_at": last["dateTime"],
                    "change_ft_per_hr": round(rate, 2), "trend": trend,
                    "series": [[v["dateTime"], float(v["value"])] for v in vals[::4]]})
    return {"ok": True, "gauges": out,
            "provenance": provenance("USGS Water Services instantaneous values (gauge height)", "verified",
                                     retrieved, None, url)}


# --- Address search (OpenStreetMap Nominatim) ----------------------------------------------------
def geocode(query):
    q = urllib.parse.urlencode({"q": query, "format": "jsonv2", "limit": 5, "countrycodes": "us",
                                "viewbox": "-96.2,30.4,-94.6,29.2"})
    data, _ = get_json(f"https://nominatim.openstreetmap.org/search?{q}", ttl=86400)
    return [{"name": r["display_name"], "lat": float(r["lat"]), "lon": float(r["lon"])} for r in data]
