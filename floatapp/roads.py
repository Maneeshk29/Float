"""Live Houston road closures (Houston TranStar) and routes that avoid them (Valhalla, OpenStreetMap).

Closure kinds:
  closed  - total closures and high-water (flood) alerts: routes avoid these
  partial - lane closures, City of Houston obstructions, active incidents: shown, not avoided
"""
import json
import urllib.parse
from datetime import datetime

from . import live

TRANSTAR = "https://traffic.houstontranstar.org"
VALHALLA = "https://valhalla1.openstreetmap.de/route"
HOUSTON_BBOX = (29.2, -96.2, 30.5, -94.6)          # south, west, north, east (Greater Houston)


def in_houston(lat, lon):
    s, w, n, e = HOUSTON_BBOX
    return s <= lat <= n and w <= lon <= e


def _feed(path):
    data, retrieved = live.get_json(f"{TRANSTAR}{path}?arg=1", ttl=300, timeout=30)
    return data, retrieved


def _coord(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    return (lat, lon) if in_houston(lat, lon) else None


def _active_dates(date_from, date_to):
    today = datetime.now().date()
    try:
        start = datetime.strptime(date_from, "%m/%d/%Y").date()
        end = datetime.strptime(date_to, "%m/%d/%Y").date()
    except (TypeError, ValueError):
        return True
    return start <= today <= end


def closures():
    """All current closures with coordinates in Greater Houston."""
    items, errors, retrieved = [], [], None

    def add(kind, source, title, detail, c):
        if c:
            items.append({"kind": kind, "source": source, "title": title.strip(), "detail": detail.strip(),
                          "lat": round(c[0], 5), "lon": round(c[1], 5)})

    try:
        data, retrieved = _feed("/data/layers/roadclosures_json.js")
        for r in data.get("roadclosures", []):
            if r.get("status") != "Active":
                continue
            total = "total" in r.get("lanes", "").lower()
            add("closed" if total else "partial", "TranStar", r.get("location", ""),
                f"{r.get('lanes', '')} · {r.get('desc', '')} · {r.get('duration', '')}", _coord(r.get("lat"), r.get("lng")))
    except Exception as e:
        errors.append(f"road closures: {e}")
    try:
        data, _ = _feed("/data/layers/floodalert_json.js")
        rows = data if isinstance(data, list) else next((v for v in data.values() if isinstance(v, list)), [])
        for r in rows:
            name = r.get("location") or r.get("name") or r.get("desc") or "High water"
            add("closed", "TranStar flood warning", f"High water: {name}", r.get("desc", "") or r.get("status", ""),
                _coord(r.get("lat") or r.get("latitude"), r.get("lng") or r.get("lon") or r.get("longitude")))
    except Exception as e:
        errors.append(f"flood alerts: {e}")
    try:
        data, _ = _feed("/data/layers/incidents_json.js")
        for r in data.get("incidents", []):
            if r.get("status") == "Cleared":
                continue
            add("partial", "TranStar incident", f"{r.get('desc', 'Incident')}: {r.get('location', '')}",
                f"Lanes: {r.get('lanes', '')} · {r.get('time', '')}", _coord(r.get("lat"), r.get("lng")))
    except Exception as e:
        errors.append(f"incidents: {e}")
    try:
        data, _ = _feed("/data/layers/laneclosures_json.js")
        for r in data.get("laneclosures", []):
            if r.get("status") == "Active":
                add("partial", "TranStar lane closure", r.get("location", ""), f"{r.get('lanes', '')} · {r.get('duration', '')}",
                    _coord(r.get("lat"), r.get("lng")))
    except Exception as e:
        errors.append(f"lane closures: {e}")
    try:
        data, _ = _feed("/coh_roadclosuredata/roadclosures_coh_points_geojson.js")
        for f in data.get("features", []):
            p = f.get("properties", {})
            if not _active_dates(p.get("DateFrom"), p.get("DateTo")):
                continue
            lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
            add("partial", "City of Houston", f"{p.get('StreetName', '').title()} ({p.get('LanesBlocked', '?')} lane(s) blocked)",
                p.get("Duration", ""), _coord(lat, lon))
    except Exception as e:
        errors.append(f"City of Houston: {e}")
    return {"ok": bool(items) or not errors, "items": items, "errors": errors,
            "counts": {"closed": sum(1 for i in items if i["kind"] == "closed"), "partial": sum(1 for i in items if i["kind"] == "partial")},
            "provenance": live.provenance("Houston TranStar + City of Houston road closures", "verified", retrieved or live.now_iso())}


def _decode(shape, precision=6):
    coords, idx, lat, lng = [], 0, 0, 0
    while idx < len(shape):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(shape[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append([round(lat / 10 ** precision, 5), round(lng / 10 ** precision, 5)])
    return coords


def route(from_lat, from_lon, to_lat, to_lon):
    """Up to 3 driving routes that avoid closed roads and high water near the trip."""
    closed = [c for c in closures()["items"] if c["kind"] == "closed"]
    s, n = min(from_lat, to_lat) - 0.15, max(from_lat, to_lat) + 0.15
    w, e = min(from_lon, to_lon) - 0.15, max(from_lon, to_lon) + 0.15
    avoid = [c for c in closed if s <= c["lat"] <= n and w <= c["lon"] <= e][:50]
    body = {"locations": [{"lat": from_lat, "lon": from_lon}, {"lat": to_lat, "lon": to_lon}],
            "costing": "auto", "alternates": 2, "units": "kilometers", "directions_type": "none",
            "exclude_locations": [{"lat": c["lat"], "lon": c["lon"]} for c in avoid]}
    data, retrieved = live.get_json(f"{VALHALLA}?json={urllib.parse.quote(json.dumps(body))}", ttl=120, timeout=30)
    trips = [data["trip"]] + [a["trip"] for a in data.get("alternates", [])]
    routes = []
    for t in trips:
        routes.append({"km": round(t["summary"]["length"], 1), "minutes": round(t["summary"]["time"] / 60),
                       "path": _decode(t["legs"][0]["shape"])})
    routes.sort(key=lambda r: r["minutes"])
    return {"ok": True, "routes": routes, "avoided": avoid,
            "provenance": live.provenance("Valhalla routing on OpenStreetMap roads (FOSSGIS)", "reference", retrieved)}
