"""Personal flood check for one location: place, weather, flood history, local news and an impact verdict.

Sources (all free, no API key):
  place    - FCC Census Area API (county) + OpenStreetMap Nominatim reverse geocoding (city, ZIP)
  weather  - Open-Meteo daily forecast
  history  - OpenFEMA NFIP flood-insurance claims by ZIP, OpenFEMA disaster declarations by county
  news     - Google News RSS search for flooding near the place
"""
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from . import live

FLOOD_INCIDENTS = ("Flood", "Hurricane", "Severe Storm", "Tropical Storm", "Coastal Storm", "Typhoon")
WARNING_EVENTS = ("Flash Flood Warning", "Flood Warning", "Hurricane Warning", "Storm Surge Warning",
                  "Flash Flood Emergency", "Tropical Storm Warning")
WATCH_EVENTS = ("Flood Watch", "Flash Flood Watch", "Hurricane Watch", "Storm Surge Watch", "Tropical Storm Watch",
                "Flood Advisory")
WMO = {0: ("Clear", "☀️"), 1: ("Mostly clear", "🌤️"), 2: ("Partly cloudy", "⛅"), 3: ("Cloudy", "☁️"),
       45: ("Fog", "🌫️"), 48: ("Fog", "🌫️"), 51: ("Drizzle", "🌦️"), 53: ("Drizzle", "🌦️"), 55: ("Drizzle", "🌦️"),
       56: ("Freezing drizzle", "🌧️"), 57: ("Freezing drizzle", "🌧️"), 61: ("Light rain", "🌦️"), 63: ("Rain", "🌧️"),
       65: ("Heavy rain", "🌧️"), 66: ("Freezing rain", "🌧️"), 67: ("Freezing rain", "🌧️"), 71: ("Snow", "🌨️"),
       73: ("Snow", "🌨️"), 75: ("Heavy snow", "❄️"), 77: ("Snow", "🌨️"), 80: ("Showers", "🌦️"), 81: ("Showers", "🌧️"),
       82: ("Violent showers", "⛈️"), 85: ("Snow showers", "🌨️"), 86: ("Snow showers", "🌨️"), 95: ("Thunderstorm", "⛈️"),
       96: ("Thunderstorm, hail", "⛈️"), 99: ("Thunderstorm, hail", "⛈️")}


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:160]}"}


# --- place -----------------------------------------------------------------------------------------
def place(lat, lon):
    fcc, _ = live.get_json(f"https://geo.fcc.gov/api/census/area?lat={lat:.5f}&lon={lon:.5f}&format=json", ttl=86400)
    area = (fcc.get("results") or [{}])[0]
    q = urllib.parse.urlencode({"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "format": "jsonv2", "zoom": 16, "addressdetails": 1})
    rev, retrieved = live.get_json(f"https://nominatim.openstreetmap.org/reverse?{q}", ttl=86400)
    addr = rev.get("address", {})
    city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("hamlet") or addr.get("suburb") or ""
    return {"ok": True, "city": city, "zip": (addr.get("postcode") or "")[:5], "county": area.get("county_name", ""),
            "county_fips": area.get("county_fips", ""), "state": area.get("state_code", ""),
            "road": addr.get("road", ""), "retrieved_at": retrieved}


# --- weather ---------------------------------------------------------------------------------------
def weather(lat, lon):
    q = urllib.parse.urlencode({"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "forecast_days": 8,
                                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
                                "temperature_unit": "fahrenheit", "timezone": "America/Chicago"})
    data, retrieved = live.get_json(f"https://api.open-meteo.com/v1/forecast?{q}", ttl=1800)
    d = data["daily"]
    days = []
    for i, day in enumerate(d["time"]):
        text, icon = WMO.get(d["weather_code"][i], ("", "🌡️"))
        days.append({"date": day, "weekday": datetime.fromisoformat(day).strftime("%a"), "summary": text, "icon": icon,
                     "high_f": round(d["temperature_2m_max"][i] or 0), "low_f": round(d["temperature_2m_min"][i] or 0),
                     "rain_mm": round(d["precipitation_sum"][i] or 0, 1),
                     "rain_chance": d["precipitation_probability_max"][i]})
    return {"ok": True, "days": days, "week_rain_mm": round(sum(x["rain_mm"] for x in days), 1),
            "provenance": live.provenance("Open-Meteo daily forecast", "forecast", retrieved)}


# --- flood history ---------------------------------------------------------------------------------
def nfip_claims(zipcode):
    if not zipcode:
        return {"ok": False, "error": "no ZIP code"}
    q = urllib.parse.urlencode({"$filter": f"reportedZipCode eq '{zipcode}'", "$top": 10000,
                                "$select": "yearOfLoss,amountPaidOnBuildingClaim,amountPaidOnContentsClaim"}, safe="$'")
    data, retrieved = live.get_json(f"https://www.fema.gov/api/open/v3/NfipClaims?{q}", ttl=86400, timeout=60)
    rows = data.get("NfipClaims", [])
    by_year = {}
    paid = 0.0
    for r in rows:
        y = r.get("yearOfLoss")
        if y:
            by_year[y] = by_year.get(y, 0) + 1
        paid += (r.get("amountPaidOnBuildingClaim") or 0) + (r.get("amountPaidOnContentsClaim") or 0)
    top = sorted(by_year.items(), key=lambda kv: kv[1], reverse=True)[:5]
    return {"ok": True, "zip": zipcode, "claims": len(rows), "capped": len(rows) >= 10000, "paid_usd": round(paid),
            "worst_years": [{"year": y, "claims": n} for y, n in top],
            "by_year": sorted(([y, n] for y, n in by_year.items() if y >= 1990)),
            "last_year": max(by_year) if by_year else None,
            "provenance": live.provenance("OpenFEMA NFIP redacted claims (flood insurance)", "historical", retrieved)}


def disasters(county_fips):
    if len(county_fips) != 5:
        return {"ok": False, "error": "no county"}
    q = urllib.parse.urlencode({"$filter": f"fipsStateCode eq '{county_fips[:2]}' and fipsCountyCode eq '{county_fips[2:]}'",
                                "$select": "disasterNumber,declarationDate,incidentType,declarationTitle",
                                "$orderby": "declarationDate desc", "$top": 1000}, safe="$'")
    data, retrieved = live.get_json(f"https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?{q}", ttl=86400, timeout=60)
    seen, events = set(), []
    for r in data.get("DisasterDeclarationsSummaries", []):
        if r["incidentType"] in FLOOD_INCIDENTS and r["disasterNumber"] not in seen:
            seen.add(r["disasterNumber"])
            events.append({"year": int(r["declarationDate"][:4]), "type": r["incidentType"],
                           "title": r["declarationTitle"].title()})
    since = [e for e in events if e["year"] >= 2000]
    return {"ok": True, "count_since_2000": len(since), "recent": events[:6],
            "provenance": live.provenance("OpenFEMA disaster declarations", "historical", retrieved)}


def history_level(claims, decl, fema, evidence):
    points, reasons = 0, []
    if claims.get("ok"):
        n = claims["claims"]
        if n >= 500:
            points += 2
            reasons.append(f"{n:,} flood insurance claims in ZIP {claims['zip']}")
        elif n >= 50:
            points += 1
            reasons.append(f"{n:,} flood insurance claims in ZIP {claims['zip']}")
    if fema.get("ok") and fema.get("sfha"):
        points += 2
        reasons.append(f"inside FEMA flood zone {fema['zone']}")
    if evidence and evidence.get("count") and evidence["flooded"] / evidence["count"] >= 0.3:
        points += 1
        reasons.append(f"{evidence['flooded']} nearby aerial photos flooded in past storms")
    if decl.get("ok") and decl["count_since_2000"] >= 5:
        points += 1
        reasons.append(f"{decl['count_since_2000']} federal flood/storm disasters in the county since 2000")
    level = "high" if points >= 3 else "medium" if points >= 1 else "low"
    return {"level": level, "reasons": reasons}


# --- news ------------------------------------------------------------------------------------------
def news(place_info):
    """Recent flood news for the city; falls back to the county when the city has little coverage."""
    places = [p for p in (place_info.get("city"), place_info.get("county")) if p] or ["Houston"]
    items, used = [], []
    for where in places:
        found = news_search(where)
        used.append(where)
        seen = {i["title"] for i in items}
        items += [i for i in found if i["title"] not in seen]
        if len(items) >= 3:
            break
    items.sort(key=lambda x: x["published"] or "", reverse=True)
    return {"ok": True, "query_place": " / ".join(used), "items": items[:8],
            "provenance": live.provenance("Google News (news.google.com RSS)", "reference", live.now_iso())}


def news_search(where):
    query = f'(flood OR flooding OR "flash flood") "{where}" when:30d'
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    req = urllib.request.Request(url, headers={"User-Agent": live.USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for it in root.iter("item"):
        title = it.findtext("title") or ""
        source = it.findtext("source") or ""
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        try:
            published = parsedate_to_datetime(it.findtext("pubDate")).astimezone(timezone.utc)
        except Exception:
            published = None
        items.append({"title": title, "source": source, "link": it.findtext("link"),
                      "published": published.strftime("%Y-%m-%dT%H:%M:%SZ") if published else None})
    return items


# --- verdict ---------------------------------------------------------------------------------------
def impact(outlook, alerts, hist):
    warnings = [a for a in alerts.get("alerts", []) if any(w in (a["event"] or "") for w in WARNING_EVENTS)]
    watches = [a for a in alerts.get("alerts", []) if any(w in (a["event"] or "") for w in WATCH_EVENTS)]
    peak = (outlook or {}).get("peak")
    order = ["LOW", "MODERATE", "HIGH", "VERY HIGH"]
    rank = order.index(peak["level"]) if peak else 0
    if hist["level"] == "high" and rank >= 1:
        rank = min(rank + 1, 3)        # flood-prone places flood sooner
    if warnings:
        level = "heavy"
    elif rank >= 2:
        level = "heavy"
    elif rank == 1 or watches:
        level = "possible"
    else:
        level = "unlikely"
    when = peak["label"] if peak and level != "unlikely" else None
    title = {"heavy": "Heavy flooding likely", "possible": "Flooding possible", "unlikely": "No flooding expected"}[level]
    reasons = []
    if warnings:
        reasons.append(f"Official: {warnings[0]['event']}")
    elif watches:
        reasons.append(f"Official: {watches[0]['event']}")
    if peak:
        reasons.append(f"Forecast peak: {peak['level'].lower()} risk {peak['label']}")
    if hist["reasons"]:
        reasons.append("History: " + hist["reasons"][0])
    return {"level": level, "title": title, "when": when, "reasons": reasons,
            "suggest_shelter": level == "heavy"}


POOL = ThreadPoolExecutor(8)


def check(lat, lon, point_data):
    wx_job = POOL.submit(safe, weather, lat, lon)
    plc = safe(place, lat, lon)
    if plc.get("ok"):
        jobs = [POOL.submit(safe, nfip_claims, plc["zip"]), POOL.submit(safe, disasters, plc["county_fips"]),
                POOL.submit(safe, news, plc)]
        claims, decl, nws = (j.result() for j in jobs)
    else:
        claims, decl, nws = {"ok": False}, {"ok": False}, safe(news, {})
    wx = wx_job.result()
    hist = history_level(claims, decl, point_data["fema"], point_data["evidence"])
    outlook = (point_data.get("risk") or {}).get("outlook")
    verdict = impact(outlook, point_data["alerts"] if point_data["alerts"].get("ok") else {}, hist)
    return {"place": plc, "weather": wx, "history": {**hist, "claims": claims, "disasters": decl},
            "news": nws, "impact": verdict, "checked_at": live.now_iso()}
