"""People features: week-ahead flood alerts and shelter matching between hosts and evacuees.

Everything is kept in JSON files under state/ on the Float server. There are no accounts: creating
an alert, shelter offer or shelter request returns a secret token that the browser keeps, and the
token is needed to read or change that record. Contact details are shared only after a host accepts.
"""
import json
import math
import secrets
import threading
import time
from datetime import datetime, timezone

from . import live, models
from .config import STATE
LEVELS = ["LOW", "MODERATE", "HIGH", "VERY HIGH"]
FLOOD_ALERT_WORDS = ("flood", "hurricane", "tropical storm", "storm surge")
MAX_RECORDS = {"subscriptions": 5000, "offers": 1000, "requests": 5000, "notifications": 50000}
_lock = threading.RLock()


# --- storage -------------------------------------------------------------------------------------
def _load(name):
    path = STATE / f"{name}.json"
    return json.loads(path.read_text()) if path.exists() else {}


def _save(name, data):
    STATE.mkdir(exist_ok=True)
    tmp = STATE / f"{name}.json.tmp"
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(STATE / f"{name}.json")


def _new_id():
    return secrets.token_hex(6)


def _check(record, token):
    if not record or not secrets.compare_digest(record["token"], str(token or "")):
        raise PermissionError("Unknown record or wrong token.")


def text(v, limit, required=False):
    v = str(v or "").strip()[:limit]
    if required and not v:
        raise ValueError("Please fill in all required fields.")
    return v


def integer(v, lo, hi):
    try:
        v = int(v)
    except (TypeError, ValueError):
        raise ValueError("Please enter a number.")
    if not lo <= v <= hi:
        raise ValueError(f"Number must be between {lo} and {hi}.")
    return v


def coord(lat, lon):
    lat, lon = float(lat), float(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Bad location.")
    return lat, lon


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _room(name, data):
    if len(data) >= MAX_RECORDS[name]:
        raise ValueError("Float is full right now. Please try again later.")


# --- week-ahead alerts ---------------------------------------------------------------------------
def subscribe(body):
    lat, lon = coord(body.get("lat"), body.get("lon"))
    threshold = body.get("threshold", "HIGH")
    if threshold not in ("MODERATE", "HIGH"):
        raise ValueError("Threshold must be MODERATE or HIGH.")
    sub = {"id": _new_id(), "token": secrets.token_urlsafe(16), "lat": round(lat, 4), "lon": round(lon, 4),
           "label": text(body.get("label"), 120) or f"{lat:.3f}, {lon:.3f}",
           "name": text(body.get("name"), 60), "threshold": threshold, "created": now_iso(),
           "last_checked": None, "last_peak": None}
    with _lock:
        subs = _load("subscriptions")
        _room("subscriptions", subs)
        subs[sub["id"]] = sub
        _save("subscriptions", subs)
    check_subscription(sub["id"])
    return _load("subscriptions")[sub["id"]]


def unsubscribe(body):
    with _lock:
        subs = _load("subscriptions")
        _check(subs.get(body.get("id")), body.get("token"))
        subs.pop(body["id"])
        _save("subscriptions", subs)
    return {"ok": True}


def _notify(notes, sub, key, kind, title, message, extra=None):
    nid = f"{sub['id']}:{key}"
    if nid in notes:
        return False
    notes[nid] = {"id": nid, "sub_id": sub["id"], "kind": kind, "title": title, "message": message,
                  "created": now_iso(), **(extra or {})}
    return True


def check_subscription(sub_id):
    """Fetch the 7-day outlook and official alerts for one place and record any new notifications."""
    sub = _load("subscriptions").get(sub_id)
    if not sub:
        return []
    rain = live.rainfall(sub["lat"], sub["lon"])
    fema = live.fema_zone(sub["lat"], sub["lon"])
    alerts = live.nws_alerts(sub["lat"], sub["lon"])
    created = []
    with _lock:
        notes = _load("notifications")
        if rain["ok"]:
            sfha = fema.get("sfha") if fema["ok"] else None
            look = models.outlook(rain, rain.get("elevation_m"), sfha)
            at_least = LEVELS.index(sub["threshold"])
            for day in look["days"]:
                if LEVELS.index(day["level"]) >= at_least:
                    days_ahead = (datetime.fromisoformat(day["date"]).date()
                                  - datetime.now().date()).days
                    when = "today" if days_ahead <= 0 else "tomorrow" if days_ahead == 1 else f"in {days_ahead} days"
                    if _notify(notes, sub, f"risk:{day['date']}:{day['level']}", "experimental",
                               f"{day['level']} flood risk {when}",
                               f"{day['label']} · {round(day['probability'] * 100)}% · {day['rain_mm']:.0f} mm rain forecast "
                               f"· {sub['label']}",
                               {"date": day["date"], "level": day["level"], "confidence": day["confidence"]}):
                        created.append(day["date"])
                    break   # one alert per check: the earliest day that reaches the threshold
            sub_update = {"last_peak": look["peak"]}
        else:
            sub_update = {}
        if alerts["ok"]:
            for a in alerts["alerts"]:
                if any(w in (a["event"] or "").lower() for w in FLOOD_ALERT_WORDS):
                    if _notify(notes, sub, f"nws:{a['id']}", "official", a["event"],
                               (a["headline"] or a["event"])[:240], {"expires": a["expires"]}):
                        created.append(a["id"])
        if len(notes) > MAX_RECORDS["notifications"]:
            for k in sorted(notes, key=lambda k: notes[k]["created"])[:len(notes) - MAX_RECORDS["notifications"]]:
                notes.pop(k)
        _save("notifications", notes)
        subs = _load("subscriptions")
        if sub_id in subs:
            subs[sub_id].update({"last_checked": now_iso(), **sub_update})
            _save("subscriptions", subs)
    return created


def inbox(body):
    mine = {}
    subs = _load("subscriptions")
    for item in body.get("subs", [])[:50]:
        s = subs.get(item.get("id"))
        if s and secrets.compare_digest(s["token"], str(item.get("token", ""))):
            mine[s["id"]] = s
    notes = [n for n in _load("notifications").values() if n["sub_id"] in mine]
    notes.sort(key=lambda n: n["created"], reverse=True)
    public = [{k: v for k, v in s.items() if k != "token"} for s in mine.values()]
    return {"subscriptions": public, "notifications": notes[:100]}


def start_checker(interval_s):
    """Background thread: re-check every subscribed place every interval_s seconds."""
    def loop():
        time.sleep(30)
        while True:
            for sub_id in list(_load("subscriptions")):
                try:
                    check_subscription(sub_id)
                except Exception as e:
                    print(f"alert check failed for {sub_id}: {e}", flush=True)
                time.sleep(1)
            time.sleep(interval_s)
    threading.Thread(target=loop, daemon=True, name="alert-checker").start()


# --- shelter matching ----------------------------------------------------------------------------
def _spots_left(offer, requests):
    taken = sum(r["people"] for r in requests.values() if r["offer_id"] == offer["id"] and r["status"] == "accepted")
    return max(offer["spots"] - taken, 0)


def _public_offer(o, requests, lat=None, lon=None):
    out = {"id": o["id"], "area": o["area"], "spots_left": _spots_left(o, requests), "spots": o["spots"],
           "pets": o["pets"], "accessible": o["accessible"], "available_from": o["available_from"],
           "available_to": o["available_to"], "note": o["note"], "created": o["created"],
           "lat": round(o["lat"], 2), "lon": round(o["lon"], 2)}   # about 1 km: no exact address
    if lat is not None:
        out["km"] = round(km(lat, lon, o["lat"], o["lon"]), 1)
    return out


def create_offer(body):
    lat, lon = coord(body.get("lat"), body.get("lon"))
    offer = {"id": _new_id(), "token": secrets.token_urlsafe(16), "lat": lat, "lon": lon,
             "area": text(body.get("area"), 80, True), "spots": integer(body.get("spots"), 1, 50),
             "pets": bool(body.get("pets")), "accessible": bool(body.get("accessible")),
             "available_from": text(body.get("available_from"), 10), "available_to": text(body.get("available_to"), 10),
             "note": text(body.get("note"), 300), "name": text(body.get("name"), 60, True),
             "contact": text(body.get("contact"), 120, True), "active": True, "created": now_iso()}
    with _lock:
        offers = _load("offers")
        _room("offers", offers)
        offers[offer["id"]] = offer
        _save("offers", offers)
    return {"id": offer["id"], "token": offer["token"]}


def close_offer(body):
    with _lock:
        offers = _load("offers")
        _check(offers.get(body.get("id")), body.get("token"))
        offers[body["id"]]["active"] = False
        _save("offers", offers)
    return {"ok": True}


def find_offers(lat, lon, people=1, pets=False, accessible=False, radius_km=80):
    requests = _load("requests")
    out = []
    for o in _load("offers").values():
        if not o["active"]:
            continue
        p = _public_offer(o, requests, lat, lon)
        if p["km"] > radius_km or p["spots_left"] < people or (pets and not o["pets"]) or (accessible and not o["accessible"]):
            continue
        out.append(p)
    return sorted(out, key=lambda p: p["km"])[:30]


def create_request(body):
    with _lock:
        offers, requests = _load("offers"), _load("requests")
        offer = offers.get(body.get("offer_id"))
        if not offer or not offer["active"]:
            raise ValueError("That place is no longer available.")
        people = integer(body.get("people"), 1, 50)
        if _spots_left(offer, requests) < people:
            raise ValueError("Not enough spots left at that place.")
        _room("requests", requests)
        req = {"id": _new_id(), "token": secrets.token_urlsafe(16), "offer_id": offer["id"], "people": people,
               "pets": bool(body.get("pets")), "needs": text(body.get("needs"), 200),
               "note": text(body.get("note"), 300), "name": text(body.get("name"), 60, True),
               "contact": text(body.get("contact"), 120, True), "status": "pending", "created": now_iso()}
        requests[req["id"]] = req
        _save("requests", requests)
    return {"id": req["id"], "token": req["token"]}


def respond(body):
    decision = body.get("decision")
    if decision not in ("accept", "decline"):
        raise ValueError("Decision must be accept or decline.")
    with _lock:
        offers, requests = _load("offers"), _load("requests")
        offer = offers.get(body.get("offer_id"))
        _check(offer, body.get("token"))
        req = requests.get(body.get("request_id"))
        if not req or req["offer_id"] != offer["id"]:
            raise ValueError("Unknown request.")
        if decision == "accept" and req["status"] != "accepted":
            if _spots_left(offer, requests) < req["people"]:
                raise ValueError("Not enough spots left.")
        req["status"] = "accepted" if decision == "accept" else "declined"
        req["decided"] = now_iso()
        _save("requests", requests)
    return {"ok": True}


def mine(body):
    offers, requests = _load("offers"), _load("requests")
    my_offers, my_requests = [], []
    for item in body.get("offers", [])[:20]:
        o = offers.get(item.get("id"))
        if not o or not secrets.compare_digest(o["token"], str(item.get("token", ""))):
            continue
        incoming = []
        for r in requests.values():
            if r["offer_id"] != o["id"]:
                continue
            entry = {k: r[k] for k in ("id", "people", "pets", "needs", "note", "name", "status", "created")}
            if r["status"] == "accepted":
                entry["contact"] = r["contact"]
            incoming.append(entry)
        incoming.sort(key=lambda r: r["created"], reverse=True)
        my_offers.append({**_public_offer(o, requests), "active": o["active"], "name": o["name"],
                          "contact": o["contact"], "requests": incoming})
    for item in body.get("requests", [])[:20]:
        r = requests.get(item.get("id"))
        if not r or not secrets.compare_digest(r["token"], str(item.get("token", ""))):
            continue
        o = offers.get(r["offer_id"], {})
        entry = {k: r[k] for k in ("id", "people", "status", "created")}
        entry["area"] = o.get("area", "")
        if r["status"] == "accepted":
            entry["host_name"], entry["host_contact"] = o.get("name"), o.get("contact")
        my_requests.append(entry)
    return {"offers": my_offers, "requests": my_requests}
