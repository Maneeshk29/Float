"""End-to-end test of Float's alert and shelter APIs against a running server."""
import json, sys, urllib.request, urllib.error
B = sys.argv[1]

def call(path, body=None):
    req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name, detail if not cond else "")
    return bool(cond)

ok = True
s, sub = call("/api/alerts/subscribe", {"lat": 29.7752, "lon": -95.6303, "label": "Addicks test", "threshold": "MODERATE"})
ok &= check("subscribe", s == 200 and sub.get("token") and sub.get("last_checked"), sub)
s, inbox = call("/api/alerts/inbox", {"subs": [{"id": sub["id"], "token": sub["token"]}]})
ok &= check("inbox with token", s == 200 and len(inbox["subscriptions"]) == 1 and "token" not in inbox["subscriptions"][0], inbox)
s, bad = call("/api/alerts/inbox", {"subs": [{"id": sub["id"], "token": "nope"}]})
ok &= check("inbox wrong token hides it", bad["subscriptions"] == [], bad)
s, err = call("/api/alerts/subscribe", {"lat": 29.7, "lon": -95.6, "threshold": "LOW"})
ok &= check("bad threshold rejected", s == 400, err)

s, offer = call("/api/shelter/offer", {"lat": 29.80, "lon": -95.82, "area": "Katy, near I-10", "spots": 4, "pets": True,
                                        "name": "Test Host", "contact": "555-0100", "note": "Spare room"})
ok &= check("create offer", s == 200 and offer.get("token"), offer)
s, err = call("/api/shelter/offer", {"lat": 29.8, "lon": -95.8, "area": "", "spots": 2, "name": "x", "contact": "y"})
ok &= check("offer missing area rejected", s == 400, err)
s, found = call(f"/api/shelter/offers?lat=29.7752&lon=-95.6303&people=3&pets=1")
mine_listed = [o for o in found["offers"] if o["id"] == offer["id"]]
ok &= check("offer found nearby", len(mine_listed) == 1, found)
ok &= check("public listing hides contact/name/exact spot", mine_listed and "contact" not in mine_listed[0] and "name" not in mine_listed[0]
            and mine_listed[0]["lat"] == 29.8, mine_listed)
s, found5 = call(f"/api/shelter/offers?lat=29.7752&lon=-95.6303&people=5")
ok &= check("too many people filtered out", not [o for o in found5["offers"] if o["id"] == offer["id"]], found5)

s, req = call("/api/shelter/request", {"offer_id": offer["id"], "people": 3, "pets": True, "name": "Test Guest",
                                        "contact": "guest@example.com", "needs": "insulin fridge"})
ok &= check("create request", s == 200 and req.get("token"), req)
s, gv = call("/api/shelter/mine", {"requests": [{"id": req["id"], "token": req["token"]}]})
ok &= check("guest sees pending, no host contact", gv["requests"][0]["status"] == "pending" and "host_contact" not in gv["requests"][0], gv)
s, hv = call("/api/shelter/mine", {"offers": [{"id": offer["id"], "token": offer["token"]}]})
inc = hv["offers"][0]["requests"][0]
ok &= check("host sees request, no guest contact yet", inc["name"] == "Test Guest" and "contact" not in inc, hv)
s, err = call("/api/shelter/respond", {"offer_id": offer["id"], "token": "x", "request_id": req["id"], "decision": "accept"})
ok &= check("respond wrong token rejected", s == 400, err)
s, r = call("/api/shelter/respond", {"offer_id": offer["id"], "token": offer["token"], "request_id": req["id"], "decision": "accept"})
ok &= check("host accepts", s == 200, r)
s, gv = call("/api/shelter/mine", {"requests": [{"id": req["id"], "token": req["token"]}]})
ok &= check("guest now sees host contact", gv["requests"][0].get("host_contact") == "555-0100", gv)
s, hv = call("/api/shelter/mine", {"offers": [{"id": offer["id"], "token": offer["token"]}]})
ok &= check("host now sees guest contact", hv["offers"][0]["requests"][0].get("contact") == "guest@example.com", hv)
ok &= check("spots left drops to 1", hv["offers"][0]["spots_left"] == 1, hv)
s, err = call("/api/shelter/request", {"offer_id": offer["id"], "people": 2, "name": "Late", "contact": "z"})
ok &= check("overbooking rejected", s == 400, err)
s, r = call("/api/shelter/close", {"id": offer["id"], "token": offer["token"]})
s, found = call(f"/api/shelter/offers?lat=29.7752&lon=-95.6303")
ok &= check("closed offer hidden", not [o for o in found["offers"] if o["id"] == offer["id"]], found)
s, r = call("/api/alerts/unsubscribe", {"id": sub["id"], "token": sub["token"]})
ok &= check("unsubscribe", s == 200, r)
print("ALL PASS" if ok else "SOME FAILED")
