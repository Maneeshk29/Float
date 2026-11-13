"""Build data/essentials.json: hospitals, pharmacies, shelters, fuel and grocery locations from OpenStreetMap.

Locations only. OpenStreetMap does not say whether a place is open or stocked, so Float shows
availability as "unknown".

Usage:  python training/build_essentials.py [osm_raw.json]
        (without an argument it downloads from the Overpass API, retrying while the server is busy)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BBOX = "29.45,-95.95,30.20,-94.85"   # Greater Houston / Harris County pilot area
QUERY = f"""[out:json][timeout:180];(
nwr["amenity"="hospital"]({BBOX});
nwr["amenity"="fuel"]({BBOX});
nwr["amenity"="pharmacy"]({BBOX});
nwr["shop"="supermarket"]({BBOX});
nwr["social_facility"="shelter"]({BBOX});
nwr["emergency"="assembly_point"]({BBOX});
);out center tags;"""
SERVERS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
USER_AGENT = "Float/0.1 (https://github.com/Maneeshk29/Float)"


def download():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    for attempt in range(20):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=200) as resp:
                    raw = json.load(resp)
                if raw.get("elements"):
                    return raw
            except Exception as e:
                print(f"  {url}: {e}")
        time.sleep(30)
    raise SystemExit("Overpass API did not answer; try again later.")


def category(tags):
    if tags.get("amenity") == "hospital":
        return "hospital"
    if tags.get("amenity") == "fuel":
        return "fuel"
    if tags.get("amenity") == "pharmacy":
        return "pharmacy"
    if tags.get("shop") == "supermarket":
        return "grocery"
    return "shelter"


def main(path=None):
    raw = json.loads(Path(path).read_text()) if path else download()
    places = []
    for el in raw["elements"]:
        tags = el.get("tags", {})
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or lon is None:
            continue
        addr = " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city")]))
        places.append({"type": category(tags), "name": tags.get("name") or tags.get("brand") or "(unnamed)",
                       "lat": round(lat, 6), "lon": round(lon, 6), "address": addr,
                       "osm": f"{el['type']}/{el['id']}"})
    out = {"source": "OpenStreetMap contributors (ODbL)",
           "osm_snapshot": raw.get("osm3s", {}).get("timestamp_osm_base", ""),
           "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "bbox": BBOX, "places": places}
    (ROOT / "data" / "essentials.json").write_text(json.dumps(out, separators=(",", ":")))
    counts = {}
    for p in places:
        counts[p["type"]] = counts.get(p["type"], 0) + 1
    print(f"wrote data/essentials.json: {counts}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
