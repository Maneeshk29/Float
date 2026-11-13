/* Float front end. Plain JavaScript + Leaflet.
   Flow: welcome (location -> why you're here) -> Home verdict for that place -> help, nearby, alerts. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("float:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("float:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const TABS = ["home", "nearby", "help", "alerts", "guides", "me", "manager", "about"];
  const PHASES = ["before", "during", "after"];
  const ROLES = {
    need_shelter: ["🏠", "I need a place to stay"], need_ride: ["🚗", "I need a ride out"], need_help: ["🆘", "I need other help"],
    offer_shelter: ["🤝", "I can host people"], offer_ride: ["🚙", "I can give rides"], informed: ["👀", "Just keeping informed"],
  };
  const PLACE_ICON = { hospital: "🏥", pharmacy: "💊", grocery: "🛒", fuel: "⛽", shelter: "🏫" };
  const PLACE_NAME = { hospital: "Hospitals", pharmacy: "Pharmacies", grocery: "Grocery", fuel: "Fuel", shelter: "Shelters" };
  const state = {
    tab: "home", phase: store.get("phase", null), place: store.get("place", null), data: null, check: null, nearby: null,
    nearbyCat: "hospital", nearbyView: "list", help: { area: "stay", mode: null }, showDetails: false, horizon: 3,
    profile: store.get("profile", null), profileKey: store.get("profileKey", null),
    subs: store.get("subs", []), keys: store.get("shelterKeys", { offers: [], requests: [] }),
    inbox: { subscriptions: [], notifications: [] }, mine: { offers: [], requests: [] },
    seen: new Set(store.get("seenNotes", [])), evidence: [], sites: [], gauges: [], meta: null,
  };

  // ---------- helpers ----------
  function ago(iso) {
    if (!iso) return "unknown";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  const clock = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const BADGE = { official: "Official", verified: "Live", forecast: "Forecast", experimental: "AI", reference: "Map data", historical: "History" };
  const badge = (t) => `<span class="badge ${esc(t)}">${esc(BADGE[t] || t)}</span>`;
  const lvClass = (lv) => "lv-" + String(lv).replace(" ", "");
  const pct = (p) => Math.round(p * 100) + "%";
  const km = (v) => v < 10 ? v.toFixed(1) + " km" : Math.round(v) + " km";
  const dirLink = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  async function api(url, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const placeName = () => state.place ? state.place.label || "Your location" : "Set location";
  const profileReady = () => state.profile && state.profile.name && state.profile.contact;
  const needsRide = () => state.profile && (state.profile.role === "need_ride" || !state.profile.has_car || state.profile.accessible);
  function bindGo(root) { $$("[data-go]", root).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setTab(b.dataset.go); })); }

  // ---------- welcome: location, then why you're here ----------
  function showWelcome(step) {
    const box = $("#welcome-box");
    $("#welcome").hidden = false;
    if (step === "location") {
      box.innerHTML = `<div class="brand"><img src="/static/logo-192.png" alt="" width="56" height="56" style="border-radius:14px;background:#fff">Float</div>
        <div><div class="title">Will a flood reach you?</div><p class="sub">Float checks your spot in Greater Houston: past floods, this week's weather and local news.</p></div>
        <button class="big-btn" id="w-gps">📍 Use my location</button>
        <div class="msg err" id="w-msg"></div>
        <div class="or">or</div>
        <form class="addr" id="w-form"><input id="w-addr" type="search" placeholder="Type your address" autocomplete="street-address"><div class="results" id="w-results" hidden></div></form>
        ${state.place ? `<button class="link" id="w-close">Keep ${esc(placeName())}</button>` : `<button class="link" id="w-skip">Skip for now (use Houston)</button>`}`;
      $("#w-gps").addEventListener("click", useMyLocation);
      $("#w-form").addEventListener("submit", (e) => { e.preventDefault(); searchAddress($("#w-addr").value, $("#w-results"), (r) => { setPlace(r.lat, r.lon, r.label); afterLocation(); }); });
      const skip = $("#w-skip"), close = $("#w-close");
      if (skip) skip.addEventListener("click", () => { setPlace(29.7604, -95.3698, "Houston"); afterLocation(); });
      if (close) close.addEventListener("click", hideWelcome);
    } else {
      box.innerHTML = `<div><div class="title">Why are you here?</div><p class="sub">Float connects you to the right help.</p></div>
        <div class="roles">${Object.entries(ROLES).map(([k, [e, t]]) => `<button class="role" data-role="${k}"><span class="e">${e}</span><strong>${esc(t)}</strong></button>`).join("")}</div>
        <button class="link" id="w-later">Decide later</button>`;
      $$("[data-role]", box).forEach((b) => b.addEventListener("click", async () => {
        await saveProfile({ ...(state.profile || { people: 1, has_car: true }), role: b.dataset.role });
        hideWelcome();
        if (["need_shelter", "need_ride", "offer_shelter", "offer_ride"].includes(b.dataset.role) && !profileReady()) {
          setTab("me"); toast("Add your name and phone so people can reach you");
        }
      }));
      $("#w-later").addEventListener("click", hideWelcome);
    }
  }
  function hideWelcome() { $("#welcome").hidden = true; store.set("welcomed", true); }
  function afterLocation() { if (!state.profile && !store.get("welcomed", false)) showWelcome("role"); else hideWelcome(); }
  function useMyLocation() {
    const msg = $("#w-msg");
    if (!("geolocation" in navigator)) { msg.textContent = "This browser can't share location. Type your address."; return; }
    msg.className = "msg"; msg.textContent = "Asking your browser...";
    navigator.geolocation.getCurrentPosition(
      (pos) => { msg.textContent = ""; setPlace(pos.coords.latitude, pos.coords.longitude, null); afterLocation(); },
      () => { msg.className = "msg err"; msg.textContent = "Location is blocked. Type your address instead."; },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  async function searchAddress(q, box, onPick) {
    q = q.trim(); if (!q) return;
    box.hidden = false; box.innerHTML = `<button disabled>Searching...</button>`;
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r, i) => `<button type="button" data-i="${i}">${esc(r.name)}</button>`).join("") : `<button disabled>No match. Try street and city.</button>`;
      $$("[data-i]", box).forEach((b) => b.addEventListener("click", () => {
        const r = results[+b.dataset.i]; box.hidden = true;
        onPick({ lat: r.lat, lon: r.lon, label: r.name.split(",").slice(0, 2).join(",") });
      }));
    } catch { box.innerHTML = `<button disabled>Search unavailable right now.</button>`; }
  }
  $("#place-chip").addEventListener("click", () => showWelcome("location"));

  // ---------- map (lives in the Nearby tab) ----------
  // Float's models were trained on Houston-area data, so the map stays on Greater Houston.
  const HOUSTON = { lat: 29.7604, lon: -95.3698, label: "Houston" };
  const inHouston = (lat, lon) => lat >= 29.2 && lat <= 30.5 && lon >= -96.2 && lon <= -94.6;
  const map = L.map("leaflet-map", { preferCanvas: true, minZoom: 8,
    maxBounds: L.latLngBounds([28.9, -96.7], [30.8, -94.1]), maxBoundsViscosity: 0.8 }).setView([29.78, -95.45], 10);
  const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const fema = L.tileLayer.wms("https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer",
    { layers: "28", format: "image/png", transparent: true, opacity: 0.5, attribution: "FEMA NFHL" });
  const layers = { places: L.layerGroup().addTo(map), hosts: L.layerGroup().addTo(map), gauges: L.layerGroup(), evidence: L.layerGroup(), manager: L.layerGroup().addTo(map),
    closures: L.layerGroup().addTo(map), routes: L.layerGroup().addTo(map) };
  L.control.layers({ "Street map": base }, { "Nearby places": layers.places, "Road closures": layers.closures, "Routes": layers.routes,
    "Hosts and drivers": layers.hosts, "River gauges": layers.gauges,
    "Past floods (photos)": layers.evidence, "FEMA flood zones": fema }, { collapsed: true }).addTo(map);
  let pin = null;
  map.on("click", (e) => { setPlace(e.latlng.lat, e.latlng.lng, null); toast("Location set"); });
  map.on("popupopen", (e) => { const b = e.popup.getElement().querySelector("[data-site]"); if (b) b.addEventListener("click", () => openSite(b.dataset.site)); });

  async function loadSites() {
    const { sites } = await api("/api/sites");
    state.sites = sites;
    const C = { flood: "#e0531f", not_flood: "#2e7d32", uncertain: "#c27c00" };
    sites.forEach((s) => L.circleMarker([s.lat, s.lon], { radius: 5, color: "#fff", weight: 1, fillColor: C[s.label], fillOpacity: 0.9 })
      .bindPopup(() => `<img src="/static/thumbs/${esc(s.image_id)}.jpg" alt=""><strong>${s.label === "flood" ? "Flooded" : "Dry"}</strong> · ${esc(s.date)}<br><button class="btn small" data-site="${esc(s.image_id)}">Analyze</button>`)
      .addTo(layers.evidence));
  }
  async function loadGauges() {
    try {
      const g = await api("/api/gauges");
      if (!g.ok) return;
      state.gauges = g.gauges; layers.gauges.clearLayers();
      g.gauges.forEach((x) => {
        const [a, c] = { rising: ["▲", "#e0531f"], falling: ["▼", "#2e7d32"], steady: ["■", "#5f6e7b"] }[x.trend];
        L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "", html: `<div style="color:${c};font-size:15px;text-shadow:0 0 2px #fff">${a}</div>`, iconSize: [16, 16] }) })
          .bindPopup(`<strong>${esc(x.name)}</strong><br>${x.stage_ft.toFixed(1)} ft · ${esc(x.trend)} · ${esc(ago(x.observed_at))}`).addTo(layers.gauges);
      });
    } catch (e) { console.warn("gauges", e); }
  }
  function nearestGauge() {
    if (!state.place || !state.gauges.length) return null;
    const r = Math.PI / 180, { lat, lon } = state.place;
    const d = (g) => 6371 * Math.acos(Math.min(1, Math.sin(lat * r) * Math.sin(g.lat * r) + Math.cos(lat * r) * Math.cos(g.lat * r) * Math.cos((g.lon - lon) * r)));
    return state.gauges.map((g) => ({ ...g, km: d(g) })).sort((a, b) => a.km - b.km)[0];
  }

  // ---------- place + data ----------
  function setPlace(lat, lon, label) {
    if (!inHouston(lat, lon)) { toast("Float covers Greater Houston. Showing Houston."); ({ lat, lon, label } = HOUSTON); }
    const keepDest = watchId !== null && state.route?.dest ? state.route.dest : null;   // tracking: re-route from here
    state.place = { lat, lon, label };
    state.route = null; state.nearbySel = 0; state.fitMap = !keepDest;
    store.set("place", state.place);
    state.data = null; state.check = null; state.nearby = null;
    if (pin) pin.remove();
    pin = L.marker([lat, lon]).addTo(map);
    if (!keepDest) map.setView([lat, lon], 12);
    refreshPlace();
    if (keepDest) routeTo(keepDest);
  }
  async function refreshPlace() {
    const { lat, lon } = state.place;
    $("#place-name").textContent = placeName();
    renderAll();
    const pointJob = api(`/api/point?lat=${lat}&lon=${lon}`).then((d) => {
      d.fetched_at = new Date().toISOString(); state.data = d; store.set("lastPoint", d); setOnline(true); autoPhase(); renderAll();
    }).catch(() => { const last = store.get("lastPoint"); setOnline(false, last); if (last) { state.data = last; renderAll(); } });
    api(`/api/nearby?lat=${lat}&lon=${lon}`).then((n) => { state.nearby = n; renderAll(); drawNearbyLayer(); }).catch(() => {});
    api(`/api/check?lat=${lat}&lon=${lon}`).then((c) => {
      state.check = c;
      if (!state.place.label && c.place.ok) {
        state.place.label = [c.place.city || c.place.county, c.place.zip].filter(Boolean).join(" ");
        store.set("place", state.place); $("#place-name").textContent = placeName();
      }
      if (state.profileKey) saveProfile({ ...state.profile }, true);
      autoPhase(); renderAll();
    }).catch((e) => { state.check = { error: e.message }; renderAll(); });
    loadHosts();
    await pointJob;
  }
  function setOnline(ok, last) {
    $("#offline-banner").hidden = ok;
    if (!ok) $("#offline-banner").textContent = last ? `OFFLINE · last update ${clock(last.fetched_at)}. Things may have changed.` : "OFFLINE · no saved data yet.";
  }
  const alertsNow = () => state.data?.alerts?.alerts || [];
  function autoPhase() {
    if (store.get("phaseManual", false) && state.phase) return updatePhaseUI();
    const heavy = state.check?.impact?.level === "heavy" || (state.data?.risk?.timeline?.[0]?.probability >= 0.5);
    state.phase = heavy ? "during" : "before";
    updatePhaseUI();
  }

  // ---------- phase + tabs ----------
  function updatePhaseUI() { $$(".phase button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.phase === state.phase))); }
  function setPhase(p) { state.phase = p; store.set("phase", p); store.set("phaseManual", true); updatePhaseUI(); renderAll(); }
  function setTab(tab) {
    if (!TABS.includes(tab)) tab = "home";
    state.tab = tab;
    if (location.hash.split("/")[0] !== "#" + tab) history.replaceState(null, "", "#" + tab);
    $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab || (["manager", "about"].includes(tab) && b.dataset.tab === "me"))));
    TABS.forEach((t) => { $("#tab-" + t).hidden = t !== tab; });
    renderTab(tab);
    if (tab === "nearby") { state.fitMap = true; fitMap(); if (stormMode() && !state.showClosures && !state.closuresAuto) { state.closuresAuto = true; toggleClosures(); } }
    if (tab === "alerts") markSeen();
    if (tab === "guides") loadEvidence().then(() => { if (state.tab === "guides") renderGuides(); });
    window.scrollTo(0, 0);
  }
  $$(".phase button").forEach((b) => b.addEventListener("click", () => setPhase(b.dataset.phase)));
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  const renderAll = () => renderTab(state.tab);
  function renderTab(t) { ({ home: renderHome, nearby: renderNearby, help: renderHelp, alerts: renderAlerts, guides: renderGuides, me: renderMe, manager: renderManager, about: renderAbout })[t](); }

  // ---------- HOME ----------
  function renderHome() {
    const el = $("#tab-home");
    if (!state.place) { el.innerHTML = `<div class="card"><h2>Where are you?</h2><button class="btn block" id="h-loc">📍 Set my location</button></div>`; $("#h-loc").addEventListener("click", () => showWelcome("location")); return; }
    const c = state.check, imp = c?.impact;
    const look = state.data?.risk?.outlook;
    const icon = { heavy: "🌊", possible: "⚠️", unlikely: "✅" }[imp?.level] || "⏳";
    const official = alertsNow()[0];
    let html = `<div class="hero ${imp ? imp.level : ""}"><div class="icon" aria-hidden="true">${icon}</div>
      ${official ? `<div class="official">🚨 ${esc(official.event)}${official.expires ? ` · until ${esc(clock(official.expires))}` : ""}</div>` : ""}
      <div class="eyebrow">Next 7 days · ${esc(placeName())}</div>
      <div class="headline">${imp ? esc(imp.title) : c?.error ? "Couldn't finish the check" : "Checking your area..."}</div>
      <div class="when">${imp?.when ? "Peak: " + esc(imp.when) : imp ? "Stay alert all the same." : "Weather, flood history and news"}</div>
      ${imp ? `<div class="why">${imp.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>` : ""}
      <div class="meta">${imp ? `Checked ${esc(ago(c.checked_at))} · AI forecast + official data · not an official warning` : ""}</div></div>`;
    if (imp?.suggest_shelter || ["need_shelter", "need_ride", "need_help"].includes(state.profile?.role)) html += `<div id="safety"></div>`;
    if (c?.weather?.ok) {
      const lv = Object.fromEntries((look?.days || []).map((d) => [d.date, d.level]));
      html += `<div class="glass-wx${c.weather.week_rain_mm > 25 ? " rainy" : ""}"><h2>This week ${badge("forecast")}</h2><div class="strip">${c.weather.days.map((d, i) => `
        <div class="wx ${lvClass(lv[d.date] || "LOW")}"><div class="d">${i === 0 ? "Today" : esc(d.weekday)}</div><div class="i">${d.icon}</div>
        <div class="t">${d.high_f}°</div><div class="r">${d.rain_chance ?? 0}% · ${d.rain_mm} mm</div><div class="dot" title="Flood risk ${esc(lv[d.date] || "LOW")}"></div></div>`).join("")}</div>
        <div class="prov">Bar = flood risk that day (green low → red high).
          <button class="link" id="h-details">${state.showDetails ? "Hide details" : "Next 24 hours"}</button></div>
        ${state.showDetails ? hoursHtml() : ""}</div>`;
    }
    if (stormMode()) html += roadsCard();
    html += `<div class="grid">${historyTile()}${nearestTile()}${newsTile()}${planTile()}${phaseTile()}${alertsTile()}</div>`;
    el.innerHTML = html;
    bindGo(el);
    const det = $("#h-details"); if (det) det.addEventListener("click", () => { state.showDetails = !state.showDetails; renderHome(); });
    $$(".tl", el).forEach((b) => b.addEventListener("click", () => { state.horizon = +b.dataset.h; renderHome(); }));
    const ht = $("#t-history"); if (ht) ht.addEventListener("click", openHistory);
    if ($("#safety")) renderSafety($("#safety"));
    if (stormMode()) {
      ensureClosures();
      $("#h-closures").addEventListener("click", showClosuresNow);
      $("#h-route-shelter").addEventListener("click", () => routeToNearest("shelter"));
      $("#h-route-hosp").addEventListener("click", () => routeToNearest("hospital"));
    }
  }
  const stormMode = () => state.phase === "during" || state.check?.impact?.level === "heavy";
  function roadsCard() {
    const c = state.closures;
    return `<div class="card" id="roads-card"><h2>🚧 Roads right now ${badge("verified")}</h2>
      <div class="row2"><div><div style="font-size:2.2rem;font-weight:900;color:var(--official)">${c ? c.counts.closed : "…"}</div><div class="muted">closed or flooded</div></div>
        <div><div style="font-size:2.2rem;font-weight:900;color:var(--moderate)">${c ? c.counts.partial : "…"}</div><div class="muted">lane closures and incidents</div></div></div>
      <div class="map-tools" style="margin-top:14px"><button class="btn ghost" id="h-closures">🚧 Show road closures</button>
        <button class="btn" id="h-route-shelter">🧭 Best route to nearest shelter</button><button class="btn ghost" id="h-route-hosp">🏥 Route to nearest hospital</button></div>
      <p class="prov">Houston TranStar + City of Houston · routes avoid closed and flooded roads</p></div>`;
  }
  function hoursHtml() {
    const tl = state.data?.risk?.timeline;
    if (!tl) return "";
    const sel = tl.find((t) => t.horizon_h === state.horizon) || tl[0];
    return `<div class="timeline" style="margin-top:12px">${tl.map((t) => `<button class="tl ${lvClass(t.level)}" data-h="${t.horizon_h}"><div class="h">${t.horizon_h ? "+" + t.horizon_h + "h" : "Now"}</div><div class="p">${pct(t.probability)}</div></button>`).join("")}</div>
      <p class="small muted" style="margin:10px 0 0">${esc(sel.reasons[0] || "")}</p>`;
  }
  function historyTile() {
    const h = state.check?.history;
    if (!h) return `<div class="tile"><div class="k">Flood history</div><div class="big">…</div></div>`;
    const cl = h.claims;
    const bars = cl?.ok && cl.by_year.length ? (() => { const yrs = cl.by_year.filter(([y]) => y >= 2000); const max = Math.max(...yrs.map(([, n]) => n), 1);
      return `<div class="bars">${yrs.map(([y, n]) => `<div style="height:${Math.max(4, (n / max) * 100)}%" title="${y}: ${n}"></div>`).join("")}</div><div class="bars-x"><span>${yrs[0]?.[0] || ""}</span><span>${yrs.at(-1)?.[0] || ""}</span></div>`; })() : "";
    return `<button class="tile" id="t-history"><div class="k">Flood history <span class="chip lvl-${h.level}">${esc(h.level)}</span></div>
      <div class="big">${cl?.ok ? cl.claims.toLocaleString() : "–"}</div><div class="muted">${cl?.ok ? `flood claims in ZIP ${esc(cl.zip)}` : "claims data unavailable"}</div>
      ${bars}<div class="go">See history →</div></button>`;
  }
  function nearestTile() {
    const p = state.nearby?.places;
    const one = (t) => p?.[t]?.[0] ? `<div class="r" style="padding:6px 0;border:0"><span class="ic" style="width:34px;height:34px;font-size:1.2rem">${PLACE_ICON[t]}</span><div class="m"><div class="n clamp" style="font-size:0.95rem">${esc(p[t][0].name)}</div></div><span class="km" style="font-size:0.9rem">${km(p[t][0].km)}</span></div>` : "";
    return `<button class="tile" data-go="nearby"><div class="k">Closest to you</div>${p ? one("hospital") + one("pharmacy") + one("grocery") + one("fuel") || `<p class="empty">Outside the area we cover.</p>` : `<p class="empty">Loading...</p>`}<div class="go">All nearby →</div></button>`;
  }
  function newsTile() {
    const n = state.check?.news;
    const items = n?.ok ? n.items.slice(0, 3) : [];
    return `<div class="tile"><div class="k">Local flood news</div>${items.length ? `<div class="rows">${items.map((i) => `<a class="r" style="padding:8px 0" href="${esc(i.link)}" target="_blank" rel="noopener"><div class="m"><div class="n clamp" style="font-size:0.95rem">${esc(i.title)}</div><div class="s">${esc(i.source)} · ${esc(ago(i.published))}</div></div></a>`).join("")}</div>`
      : `<p class="empty">${n ? "No flood news in the last 30 days." : "Loading..."}</p>`}</div>`;
  }
  function planTile() {
    const p = state.profile;
    if (!p) return `<button class="tile" data-go="me"><div class="k">Your plan</div><div class="big" style="font-size:1.6rem">Tell us what you need</div><div class="go">Set up profile →</div></button>`;
    const [e, t] = ROLES[p.role];
    const pending = state.mine.offers.reduce((s, o) => s + o.requests.filter((r) => r.status === "pending").length, 0);
    const accepted = state.mine.requests.filter((r) => r.status === "accepted").length;
    const line = pending ? `${pending} request${pending > 1 ? "s" : ""} waiting for you` : accepted ? `${accepted} match${accepted > 1 ? "es" : ""} confirmed` : { need_shelter: "Find a place to stay", need_ride: "Find a ride", offer_shelter: "Post your space", offer_ride: "Offer seats", need_help: "Get help", informed: "You're all set" }[p.role];
    return `<button class="tile" data-go="${p.role === "informed" ? "me" : "help"}"><div class="k">Your plan</div><div class="big" style="font-size:1.6rem">${e} ${esc(t)}</div><div class="muted">${esc(line)}</div><div class="go">${p.role === "informed" ? "Profile" : "Open Help"} →</div></button>`;
  }
  function phaseTile() {
    const p = state.phase || "before";
    if (p === "after") {
      const g = nearestGauge(), now = state.data?.risk?.timeline?.[0];
      const ok = (b) => b ? "✅" : "❌";
      return `<div class="tile"><div class="k">Can I go back?</div><div style="font-size:1.05rem;font-weight:800;line-height:1.9">
        ${ok(!alertsNow().length)} No official alerts<br>${ok(g && g.trend !== "rising")} River not rising<br>${ok(now && now.probability < 0.2)} Low flood risk</div>
        <div class="muted small">Wait for the official all-clear.</div><button class="link" style="text-align:left;padding:6px 0" data-go="guides">Document damage →</button></div>`;
    }
    const [t, s] = p === "during" ? ["Stay safe", "Water, power, gas"] : ["Get ready", "Kit, plan, home"];
    return `<button class="tile" data-go="guides"><div class="k">Guide</div><div class="big" style="font-size:1.6rem">📘 ${t}</div><div class="muted">${s}</div><div class="go">Open guide →</div></button>`;
  }
  function alertsTile() {
    const on = state.inbox.subscriptions.length > 0, unread = state.inbox.notifications.filter((n) => !state.seen.has(n.id)).length;
    return `<button class="tile" data-go="alerts"><div class="k">Alerts</div><div class="big" style="font-size:1.6rem">🔔 ${on ? "On" : "Off"}</div><div class="muted">${unread ? `${unread} new` : on ? "We'll warn you up to 7 days ahead" : "Get warned up to 7 days ahead"}</div><div class="go">${on ? "Inbox" : "Turn on"} →</div></button>`;
  }
  function openHistory() {
    const h = state.check?.history;
    if (!h) return;
    const cl = h.claims, ds = h.disasters, ev = state.data?.evidence;
    $("#dlg-title").textContent = "Flood history";
    $("#dlg-body").innerHTML = `<p style="font-size:1.1rem"><strong class="lvl-${h.level}">${esc(h.level.toUpperCase())}</strong> flood history here.</p>
      <div class="rows">${cl?.ok ? `<div class="r"><span class="ic">📄</span><div class="m"><div class="n">${cl.claims.toLocaleString()} insurance claims</div><div class="s">ZIP ${esc(cl.zip)} · $${Math.round(cl.paid_usd / 1e6).toLocaleString()}M paid · worst: ${cl.worst_years.slice(0, 3).map((w) => `${w.year} (${w.claims})`).join(", ")}</div></div></div>` : ""}
      ${ds?.ok ? `<div class="r"><span class="ic">🏛️</span><div class="m"><div class="n">${ds.count_since_2000} federal disasters since 2000</div><div class="s">${ds.recent.slice(0, 3).map((d) => `${d.year} ${esc(d.title)}`).join(" · ")}</div></div></div>` : ""}
      ${state.data?.fema?.ok ? `<div class="r"><span class="ic">🗺️</span><div class="m"><div class="n">FEMA zone ${esc(state.data.fema.zone || "not mapped")}</div><div class="s">${state.data.fema.sfha ? "High-risk flood zone" : "Outside the high-risk zone"}</div></div></div>` : ""}
      ${ev?.count ? `<div class="r"><span class="ic">🛰️</span><div class="m"><div class="n">${ev.flooded} of ${ev.count} nearby aerial photos flooded</div><div class="s">Hurricane Harvey imagery, within ${ev.radius_km} km</div></div></div>` : ""}</div>
      ${ev?.count ? `<div class="thumbs" style="margin-top:12px">${ev.sites.slice(0, 8).map((s) => `<button class="${esc(s.label)}" data-site="${esc(s.image_id)}"><img src="/static/thumbs/${esc(s.image_id)}.jpg" alt=""><span>${s.label === "flood" ? "FLOOD" : "DRY"} ${esc(s.date.slice(0, 4))}</span></button>`).join("")}</div>` : ""}
      <p class="prov">OpenFEMA NFIP claims and disaster declarations · FEMA flood map · UTSA flood imagery</p>`;
    $$("[data-site]", $("#dlg-body")).forEach((b) => b.addEventListener("click", () => openSite(b.dataset.site)));
    if (!$("#site-dialog").open) $("#site-dialog").showModal();
  }

  // ---------- GET TO SAFETY (auto-connect) ----------
  async function renderSafety(box) {
    const heavy = state.check?.impact?.level === "heavy";
    const role = state.profile?.role;
    const wantShelter = heavy || role === "need_shelter";
    const wantRide = role === "need_ride" || ((heavy || role === "need_shelter") && needsRide());
    const p = state.profile || { people: 1 };
    box.innerHTML = `<div class="safety"><h2>${heavy ? "🚨 Get to safety" : "Your help options"}</h2>
      <div class="muted">${heavy ? "Flooding is likely here. Plan to leave early." : "Matched to your profile."}</div>
      <div class="calls"><a class="call" href="tel:911">911<small>Life in danger</small></a><a class="call blue" href="tel:211">2-1-1<small>Shelter + evacuation help</small></a>
        <a class="call blue" href="tel:18007332767">Red Cross<small>1-800-733-2767</small></a>${wantRide ? `<a class="call blue" href="tel:311">3-1-1<small>Houston ride help</small></a>` : ""}</div>
      ${heavy ? `<div class="map-tools" style="margin-bottom:6px"><button class="btn" id="s-route">🧭 Safest route to nearest shelter</button><button class="btn ghost" id="s-closures">🚧 Road closures</button></div>` : ""}
      ${wantShelter ? `<h3>🏠 Places to stay</h3><div class="rows" id="s-shelter"><p class="empty">Finding places...</p></div>` : ""}
      ${wantRide ? `<h3>🚗 Rides out</h3><p class="small muted" style="margin:0">No car? Register with Texas STEAR by dialing 2-1-1 for evacuation transport.</p><div class="rows" id="s-ride"><p class="empty">Finding drivers...</p></div>` : ""}
      ${role === "need_help" ? `<h3>🆘 Help near you</h3><div class="rows">${["hospital", "pharmacy"].map((t) => state.nearby?.places?.[t]?.[0]).filter(Boolean).map((x) => placeRow(x)).join("")}</div>` : ""}
      </div>`;
    const sr = $("#s-route"); if (sr) sr.addEventListener("click", () => routeToNearest("shelter"));
    const sc = $("#s-closures"); if (sc) sc.addEventListener("click", showClosuresNow);
    if (!state.place) return;
    const q = `lat=${state.place.lat}&lon=${state.place.lon}&people=${p.people || 1}&pets=${p.pets ? 1 : 0}&accessible=${p.accessible ? 1 : 0}`;
    if (wantShelter) {
      const official = (state.nearby?.places?.shelter || []).slice(0, 2);
      const { offers } = await api(`/api/shelter/offers?${q}&kind=shelter`).catch(() => ({ offers: [] }));
      const el = $("#s-shelter");
      if (el) { el.innerHTML = offers.slice(0, 3).map((o) => offerRow(o, "shelter")).join("") + official.map((x) => placeRow(x)).join("")
        + `<a class="r" href="https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html" target="_blank" rel="noopener"><span class="ic">🏫</span><div class="m"><div class="n">Open public shelters</div><div class="s">Red Cross live list</div></div><span class="km">→</span></a>`;
        bindAsk(el); }
    }
    if (wantRide) {
      const { offers } = await api(`/api/shelter/offers?${q}&kind=ride`).catch(() => ({ offers: [] }));
      const el = $("#s-ride");
      if (el) { el.innerHTML = offers.length ? offers.slice(0, 3).map((o) => offerRow(o, "ride")).join("") : `<p class="empty">No volunteer drivers nearby yet. Call 2-1-1.</p>`; bindAsk(el); }
    }
  }
  function placeRow(x) {
    return `<a class="r" href="${dirLink(x.lat, x.lon)}" target="_blank" rel="noopener"><span class="ic">${PLACE_ICON[x.type]}</span><div class="m"><div class="n">${esc(x.name)}</div><div class="s">${esc(x.address || PLACE_NAME[x.type])}</div></div><span class="km">${km(x.km)}</span></a>`;
  }
  const asked = () => new Set([...state.mine.requests.map((r) => r.offer_id), ...store.get("asked", [])]);
  function offerRow(o, kind) {
    const unit = kind === "ride" ? "seats" : "spots";
    return `<div class="offer"><span class="ic" style="font-size:1.5rem">${kind === "ride" ? "🚙" : "🏡"}</span><div class="m"><div class="n">${esc(o.area)}</div>
      <div class="s">${km(o.km)} · ${o.spots_left} ${unit} free${o.note ? " · " + esc(o.note) : ""}</div>
      <div class="tags">${o.pets ? `<span class="tag">Pets ok</span>` : ""}${o.accessible ? `<span class="tag">Wheelchair</span>` : ""}</div></div>
      ${asked().has(o.id) ? `<span class="status pending">Sent ✓</span>` : `<button class="btn small" data-ask="${esc(o.id)}" data-kind="${kind}">${kind === "ride" ? "Ask for ride" : "Ask to stay"}</button>`}</div>`;
  }
  function bindAsk(root) {
    $$("[data-ask]", root).forEach((b) => b.addEventListener("click", async () => {
      if (!profileReady()) { toast("Add your name and phone first"); setTab("me"); return; }
      b.disabled = true;
      try {
        const p = state.profile;
        const r = await api("/api/shelter/request", { offer_id: b.dataset.ask, people: p.people || 1, pets: p.pets, needs: p.medical || "", name: p.name, contact: p.contact });
        state.keys.requests.push({ id: r.id, token: r.token }); store.set("shelterKeys", state.keys);
        store.set("asked", [...store.get("asked", []), b.dataset.ask].slice(-100));
        b.textContent = "Sent ✓"; toast("Request sent. You'll see the reply in Help → Matches.");
        refreshMine();
      } catch (e) { b.disabled = false; toast(e.message); }
    }));
  }

  // ---------- NEARBY (always available): map, closures, best route ----------
  const CAT_COLOR = { hospital: "#00838f", pharmacy: "#7b1fa2", grocery: "#558b2f", fuel: "#6b4fbb", shelter: "#0b6e4f" };
  const gmaps = (x) => `https://www.google.com/maps/dir/?api=1${state.place ? `&origin=${state.place.lat},${state.place.lon}` : ""}&destination=${x.lat},${x.lon}&travelmode=driving`;
  const nearbyItems = () => state.nearby?.places?.[state.nearbyCat] || [];
  function drawNearbyLayer() {
    layers.places.clearLayers();
    nearbyItems().forEach((x, i) => L.marker([x.lat, x.lon], { zIndexOffset: i === state.nearbySel ? 1000 : 0,
      icon: L.divIcon({ className: "", html: `<div class="num-pin${i === state.nearbySel ? " sel" : ""}" style="background:${CAT_COLOR[state.nearbyCat]}"><span>${i + 1}</span></div>`,
        iconSize: i === state.nearbySel ? [36, 36] : [28, 28], iconAnchor: i === state.nearbySel ? [18, 36] : [14, 28] }) })
      .bindTooltip(`${i + 1}. ${x.name}`).on("click", () => selectPlace(i)).addTo(layers.places));
  }
  function drawClosures() {
    layers.closures.clearLayers();
    const list = state.showClosures && state.closures?.items ? state.closures.items
      : (state.route?.avoided || []).map((c) => ({ ...c, kind: "closed" }));
    list.forEach((c) => L.marker([c.lat, c.lon], { zIndexOffset: c.kind === "closed" ? 500 : 0,
      icon: L.divIcon({ className: "", html: `<div class="closure-x ${c.kind}">${c.kind === "closed" ? "✕" : "!"}</div>`, iconSize: c.kind === "closed" ? [22, 22] : [18, 18] }) })
      .bindPopup(`<strong>${c.kind === "closed" ? "🚫 Closed" : "⚠️ Partly closed"}</strong><br>${esc(c.title)}<br><span class="muted">${esc(c.detail)}<br>${esc(c.source)}</span>`)
      .addTo(layers.closures));
  }
  const ROUTE_COLORS = ["#0a66c2", "#7e57c2", "#00897b"];
  function drawRoutes() {
    layers.routes.clearLayers();
    const routes = state.route?.routes;
    if (!routes) return;
    routes.slice(1).forEach((r, i) => L.polyline(r.path, { color: ROUTE_COLORS[i + 1], weight: 5, opacity: 0.75, dashArray: "8 8" }).addTo(layers.routes));
    L.polyline(routes[0].path, { color: "#fff", weight: 11, opacity: 0.9 }).addTo(layers.routes);
    L.polyline(routes[0].path, { color: ROUTE_COLORS[0], weight: 7 }).addTo(layers.routes);
  }
  function fitMap() {
    if (!state.fitMap) return;
    state.fitMap = false;
    setTimeout(() => {
      map.invalidateSize();
      const pts = state.route?.routes ? state.route.routes.flatMap((r) => r.path)
        : [state.place && [state.place.lat, state.place.lon], ...nearbyItems().slice(0, 5).map((x) => [x.lat, x.lon])].filter(Boolean);
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.15));
      else if (state.place) map.setView([state.place.lat, state.place.lon], 12);
    }, 40);
  }
  function selectPlace(i) { state.nearbySel = i; state.route = null; state.fitMap = false; renderNearby(); }
  async function toggleClosures() {
    state.showClosures = !state.showClosures;
    if (state.showClosures) {
      renderNearby();
      try { state.closures = await api("/api/closures"); } catch (e) { toast("Road closure data unavailable"); state.showClosures = false; }
      if (state.showClosures) { map.setView([29.76, -95.45], 10); }
    }
    renderNearby();
  }
  async function bestRoute() { return routeTo(nearbyItems()[state.nearbySel]); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function routeToNearest(cat) {
    state.nearbyCat = cat; state.nearbySel = 0; state.route = null;
    setTab("nearby");
    for (let i = 0; i < 60 && !state.nearby; i++) await sleep(250);
    const dest = nearbyItems()[0];
    if (dest) routeTo(dest); else toast(`No ${PLACE_NAME[cat].toLowerCase()} found nearby. Call 2-1-1.`);
  }
  function showClosuresNow() { setTab("nearby"); if (!state.showClosures) toggleClosures(); }
  async function ensureClosures() {
    if (state.closures || state.closuresLoading) return;
    state.closuresLoading = true;
    try { state.closures = await api("/api/closures"); } catch { /* shown as unavailable */ }
    state.closuresLoading = false;
    if (state.tab === "home") renderHome();
  }
  // Location tracker: follow the phone's GPS; re-route if a route is open
  let watchId = null;
  const distKm = (a, b) => { const r = Math.PI / 180; return 6371 * Math.acos(Math.min(1, Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r))); };
  function toggleTracking() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; toast("Tracking off"); renderNearby(); return; }
    if (!("geolocation" in navigator)) { toast("This browser can't share location"); return; }
    watchId = navigator.geolocation.watchPosition((pos) => {
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      if (!inHouston(here.lat, here.lon)) { toast("You're outside Greater Houston"); return; }
      if (!state.place || distKm(state.place, here) > 0.3) setPlace(here.lat, here.lon, null);
      else if (pin) pin.setLatLng([here.lat, here.lon]);
    }, (err) => {
      if (err.code !== 1) return;            // brief GPS dropouts (no signal, timeout): keep tracking
      toast("Location is blocked. Allow it in your browser."); if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; renderNearby();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    toast("Tracking your location"); renderNearby();
  }
  async function routeTo(dest) {
    if (!dest || !state.place) return;
    state.route = { loading: true, dest };
    renderNearby();
    try {
      const r = await api(`/api/route?from_lat=${state.place.lat}&from_lon=${state.place.lon}&to_lat=${dest.lat}&to_lon=${dest.lon}`);
      state.route = { ...r, dest }; state.fitMap = true;
    } catch (e) { state.route = { error: e.message, dest }; }
    renderNearby();
  }
  function routeCard() {
    const r = state.route;
    if (!r) return "";
    if (r.loading) return `<div class="card route-card"><p class="empty">Finding the best route to ${esc(r.dest.name)}...</p></div>`;
    if (r.error) return `<div class="card route-card"><p class="msg err">${esc(r.error)}</p><a class="btn ghost" href="${gmaps(r.dest)}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;
    const best = r.routes[0];
    return `<div class="card route-card"><div class="k muted small" style="font-weight:800;text-transform:uppercase;letter-spacing:.06em">Best route to</div>
      <h2 style="margin:2px 0 8px">${esc(r.dest.name)}</h2>
      ${r.routes.map((x, i) => `<div class="opt"><span class="swatch" style="background:${ROUTE_COLORS[i]}${i ? ";opacity:.7" : ""}"></span>
        <div style="flex:1"><span class="${i ? "" : "big"}" style="font-weight:900">${x.minutes} min</span> <span class="muted">· ${x.km} km${i ? "" : " · fastest"}</span></div></div>`).join("")}
      <p class="small muted" style="margin:8px 0 12px">${r.avoided.length ? `🚫 Avoids ${r.avoided.length} closed road${r.avoided.length > 1 ? "s" : ""} (red ✕).` : "No full closures on the way."} Live traffic not included.</p>
      <div class="map-tools"><a class="btn" href="${gmaps(r.dest)}" target="_blank" rel="noopener">Open in Google Maps</a><button class="btn ghost" id="n-clear">Clear route</button></div></div>`;
  }
  function closuresCard() {
    if (!state.showClosures) return "";
    const c = state.closures;
    if (!c) return `<div class="card"><p class="empty">Loading road closures...</p></div>`;
    const closed = c.items.filter((x) => x.kind === "closed");
    return `<div class="card"><h2>🚧 Road closures ${badge("verified")}</h2>
      <div class="row2" style="margin-bottom:6px"><div><div class="big" style="font-size:2rem;font-weight:900;color:var(--official)">${c.counts.closed}</div><div class="muted">roads fully closed or flooded</div></div>
        <div><div class="big" style="font-size:2rem;font-weight:900;color:var(--moderate)">${c.counts.partial}</div><div class="muted">lane closures and incidents</div></div></div>
      ${closed.length ? `<div class="rows">${closed.map((x) => `<button class="r" data-fly="${x.lat},${x.lon}"><span class="ic">🚫</span><div class="m"><div class="n">${esc(x.title)}</div><div class="s clamp">${esc(x.detail)}</div></div></button>`).join("")}</div>` : ""}
      <p class="prov">Houston TranStar + City of Houston · updated every 5 min</p></div>`;
  }
  function renderNearby() {
    const top = $("#nearby-top"), list = $("#nearby-list"), shell = $("#map-shell");
    const n = state.nearby, items = nearbyItems();
    if (!(state.nearbySel < items.length)) state.nearbySel = 0;
    const dest = items[state.nearbySel];
    top.innerHTML = `<div><div class="title">Nearby</div><p class="sub">Closest to ${esc(placeName())}</p></div>
      <div class="chips" style="margin:12px 0">${Object.keys(PLACE_ICON).map((t) => `<button data-cat="${t}" aria-pressed="${state.nearbyCat === t}">${PLACE_ICON[t]} ${PLACE_NAME[t]}</button>`).join("")}</div>
      <div class="map-tools"><button class="btn ${state.showClosures ? "on" : "ghost"}" id="n-closures">🚧 ${state.showClosures ? "Hide road closures" : "Show all road closures"}</button>
        <button class="btn" id="n-route" ${dest && state.place ? "" : "disabled"}>🧭 Get me the best route${dest ? ` to #${state.nearbySel + 1}` : ""}</button>
        <button class="btn ${watchId !== null ? "on" : "ghost"}" id="n-track">📍 ${watchId !== null ? "Tracking on" : "Track me"}</button></div>`;
    shell.hidden = false;
    list.innerHTML = routeCard() + closuresCard() + `<div class="card">${!n ? `<p class="empty">Loading...</p>` : items.length
      ? `<div class="rows">${items.map((x, i) => `<button class="r${i === state.nearbySel ? " sel" : ""}" data-sel="${i}"><span class="num" style="background:${CAT_COLOR[state.nearbyCat]}">${i + 1}</span>
          <div class="m"><div class="n">${esc(x.name)}</div><div class="s">${esc(x.address || PLACE_NAME[x.type])}</div></div><span class="km">${km(x.km)}</span></button>`).join("")}</div>`
      : `<p class="empty">None within 30 km.${state.nearbyCat === "shelter" ? ` <a href="https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html" target="_blank" rel="noopener">Red Cross shelters</a>` : ""}</p>`}
      <p class="prov">${state.nearbyCat === "hospital" ? "Open status: call ahead." : "Open status and stock: unknown."} Tap a place, then "Get me the best route". OpenStreetMap.</p></div>`;
    $$("[data-cat]", top).forEach((b) => b.addEventListener("click", () => { state.nearbyCat = b.dataset.cat; state.nearbySel = 0; state.route = null; state.fitMap = true; renderNearby(); }));
    $("#n-closures").addEventListener("click", toggleClosures);
    $("#n-route").addEventListener("click", bestRoute);
    $("#n-track").addEventListener("click", toggleTracking);
    const clear = $("#n-clear"); if (clear) clear.addEventListener("click", () => { state.route = null; state.fitMap = true; renderNearby(); });
    $$("[data-sel]", list).forEach((b) => b.addEventListener("click", () => { selectPlace(+b.dataset.sel); window.scrollTo({ top: 0, behavior: "smooth" }); }));
    $$("[data-fly]", list).forEach((b) => b.addEventListener("click", () => { const [a, o] = b.dataset.fly.split(","); map.setView([+a, +o], 15); window.scrollTo({ top: 0, behavior: "smooth" }); }));
    drawNearbyLayer(); drawClosures(); drawRoutes(); fitMap();
  }

  // ---------- HELP: shelter + rides ----------
  async function refreshMine() {
    if (!state.keys.offers.length && !state.keys.requests.length) return;
    try { state.mine = await api("/api/shelter/mine", state.keys); updateCounts(); if (["help", "home"].includes(state.tab)) renderAll(); }
    catch (e) { console.warn("mine", e); }
  }
  async function loadHosts() {
    if (!state.place) return;
    layers.hosts.clearLayers();
    for (const kind of ["shelter", "ride"]) {
      const { offers } = await api(`/api/shelter/offers?lat=${state.place.lat}&lon=${state.place.lon}&kind=${kind}`).catch(() => ({ offers: [] }));
      offers.forEach((o) => L.circleMarker([o.lat, o.lon], { radius: 9, color: "#fff", weight: 2, fillColor: kind === "ride" ? "#6b4fbb" : "#0a66c2", fillOpacity: 0.95 })
        .bindPopup(`${kind === "ride" ? "🚙" : "🏡"} <strong>${esc(o.area)}</strong><br>${o.spots_left} ${kind === "ride" ? "seats" : "spots"} · ask in Help`).addTo(layers.hosts));
    }
  }
  function defaultHelp() {
    const r = state.profile?.role;
    if (!state.help.mode) {
      state.help.area = r === "need_ride" || r === "offer_ride" ? "ride" : "stay";
      state.help.mode = r === "offer_shelter" || r === "offer_ride" ? "offer" : "need";
    }
  }
  function renderHelp() {
    defaultHelp();
    const el = $("#tab-help"), h = state.help;
    const pending = state.mine.offers.reduce((s, o) => s + o.requests.filter((r) => r.status === "pending").length, 0);
    el.innerHTML = `<div><div class="title">Help</div><p class="sub">Places to stay and rides, from neighbors.</p></div>
      <div class="calls" style="margin:0"><a class="call blue" href="tel:211">2-1-1<small>Official shelters, rides</small></a><a class="call blue" href="tel:18007332767">Red Cross<small>1-800-733-2767</small></a><a class="call" href="tel:911">911<small>Emergency</small></a></div>
      <div class="seg"><button data-area="stay" aria-pressed="${h.area === "stay"}">🏠 Stay</button><button data-area="ride" aria-pressed="${h.area === "ride"}">🚗 Ride</button>
        <button data-area="matches" aria-pressed="${h.area === "matches"}">✉️ Matches${pending ? ` (${pending})` : ""}</button></div>
      ${h.area !== "matches" ? `<div class="toggle2"><button data-mode="need" aria-pressed="${h.mode === "need"}">${h.area === "ride" ? "🙋 I need a ride" : "🙋 I need a place"}</button>
        <button data-mode="offer" aria-pressed="${h.mode === "offer"}">${h.area === "ride" ? "🚙 I can drive" : "🤝 I can host"}</button></div>` : ""}
      <div id="help-body"></div>
      <div class="card"><details class="why"><summary>Stay safe</summary><ul style="margin:8px 0 0;padding-left:20px"><li><strong>Neighbors are not vetted.</strong> Official shelters are.</li><li>Meet in public first. Tell someone your plan.</li><li>Contacts are shared only after a match is accepted.</li></ul></details></div>`;
    $$("[data-area]", el).forEach((b) => b.addEventListener("click", () => { h.area = b.dataset.area; renderHelp(); }));
    $$("[data-mode]", el).forEach((b) => b.addEventListener("click", () => { h.mode = b.dataset.mode; renderHelp(); }));
    const body = $("#help-body");
    if (h.area === "matches") return helpMatches(body);
    const kind = h.area === "ride" ? "ride" : "shelter";
    return h.mode === "offer" ? helpOffer(body, kind) : helpFind(body, kind);
  }
  async function helpFind(box, kind) {
    const p = state.profile || { people: 1 };
    box.innerHTML = `<div class="card"><h2>${kind === "ride" ? "Drivers near you" : "Places near you"}</h2>
      <div class="small muted">For ${p.people || 1} ${(p.people || 1) > 1 ? "people" : "person"}${p.pets ? " + pets" : ""}${p.accessible ? " · wheelchair" : ""} · <button class="link" data-go="me" style="padding:0">edit</button></div>
      <div class="rows" id="find-list"><p class="empty">Searching...</p></div></div>`;
    bindGo(box);
    if (!state.place) { $("#find-list").innerHTML = `<p class="empty">Set your location first.</p>`; return; }
    try {
      const { offers } = await api(`/api/shelter/offers?lat=${state.place.lat}&lon=${state.place.lon}&people=${p.people || 1}&pets=${p.pets ? 1 : 0}&accessible=${p.accessible ? 1 : 0}&kind=${kind}`);
      const el = $("#find-list");
      if (!el) return;                       // user moved on while loading
      el.innerHTML = offers.length ? offers.map((o) => offerRow(o, kind)).join("") : `<p class="empty">Nobody nearby yet. Call 2-1-1${kind === "ride" ? " (STEAR evacuation rides)" : ""}.</p>`;
      bindAsk(el);
    } catch (e) { const el = $("#find-list"); if (el) el.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
  }
  function helpOffer(box, kind) {
    const p = state.profile || {};
    const ride = kind === "ride";
    box.innerHTML = `<div class="card"><h2>${ride ? "Offer rides" : "Offer a place"}</h2>
      <form class="form" id="offer-form">
        <div class="row2"><label class="field">${ride ? "Pickup area" : "Area"}<input name="area" required maxlength="80" placeholder="${ride ? "e.g. Katy, I-10 & Mason" : "e.g. Katy, near I-10"}"></label>
          <label class="field">${ride ? "Seats" : "Spots"}<input name="spots" type="number" min="1" max="50" value="${ride ? 3 : 2}" required></label></div>
        <div class="row2"><label class="check"><input type="checkbox" name="pets"> Pets ok</label><label class="check"><input type="checkbox" name="accessible"> ${ride ? "Wheelchair van" : "Wheelchair access"}</label></div>
        <div class="row2"><label class="field">Your name<input name="name" required maxlength="60" value="${esc(p.name || "")}"></label><label class="field">Phone<input name="contact" required maxlength="120" value="${esc(p.contact || "")}"></label></div>
        <label class="field">Note<input name="note" maxlength="300" placeholder="${ride ? "e.g. SUV, can tow" : "e.g. spare room, no stairs"}"></label>
        <button class="btn block" type="submit">Post</button><div class="msg" id="offer-msg"></div>
        <p class="small muted" style="margin:0">People see only your area (about 1 km), never your address or phone until you accept them.</p></form></div>`;
    $("#offer-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.place) { toast("Set your location first"); return; }
      const f = e.target;
      try {
        const r = await api("/api/shelter/offer", { kind, lat: state.place.lat, lon: state.place.lon, area: f.area.value, spots: f.spots.value,
          pets: f.pets.checked, accessible: f.accessible.checked, name: f.name.value, contact: f.contact.value, note: f.note.value });
        state.keys.offers.push({ id: r.id, token: r.token }); store.set("shelterKeys", state.keys);
        toast("Posted. Thank you!"); state.help.area = "matches"; await refreshMine(); renderHelp(); loadHosts();
      } catch (err) { $("#offer-msg").className = "msg err"; $("#offer-msg").textContent = err.message; }
    });
  }
  function helpMatches(box) {
    const { offers, requests } = state.mine;
    if (!offers.length && !requests.length) { box.innerHTML = `<div class="card"><p class="empty">No offers or requests yet.</p></div>`; return; }
    let html = "";
    if (requests.length) html += `<div class="card"><h2>You asked</h2><div class="rows">${requests.map((r) => `<div class="offer" style="display:block">
      <div style="display:flex;justify-content:space-between;gap:8px"><span class="n">${r.kind === "ride" ? "🚙" : "🏡"} ${esc(r.area)}</span><span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
      <div class="s">${r.people} ${r.people === 1 ? "person" : "people"} · ${esc(ago(r.created))}</div>
      ${r.status === "accepted" ? `<div class="contact">📞 ${esc(r.host_name)} · ${esc(r.host_contact)}</div>` : ""}</div>`).join("")}</div></div>`;
    for (const o of offers) html += `<div class="card"><h2>${o.kind === "ride" ? "🚙" : "🏡"} ${esc(o.area)}</h2><div class="muted">${o.spots_left} of ${o.spots} ${o.kind === "ride" ? "seats" : "spots"} free · ${o.active ? "listed" : "closed"}</div>
      <div class="rows">${o.requests.length ? o.requests.map((r) => `<div class="offer" style="display:block">
        <div style="display:flex;justify-content:space-between;gap:8px"><span class="n">${esc(r.name)} · ${r.people}</span><span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
        <div class="tags">${r.pets ? `<span class="tag">Pets</span>` : ""}${r.needs ? `<span class="tag">${esc(r.needs)}</span>` : ""}</div>
        ${r.status === "pending" ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn small" data-respond="accept" data-offer="${esc(o.id)}" data-req="${esc(r.id)}">Accept</button><button class="btn small ghost" data-respond="decline" data-offer="${esc(o.id)}" data-req="${esc(r.id)}">Decline</button></div>` : ""}
        ${r.contact ? `<div class="contact">📞 ${esc(r.contact)}</div>` : ""}</div>`).join("") : `<p class="empty">No requests yet.</p>`}</div>
      ${o.active ? `<button class="btn small danger" style="margin-top:10px" data-close="${esc(o.id)}">Close</button>` : ""}</div>`;
    box.innerHTML = html;
    $$("[data-respond]", box).forEach((b) => b.addEventListener("click", async () => {
      const key = state.keys.offers.find((k) => k.id === b.dataset.offer);
      try { await api("/api/shelter/respond", { offer_id: key.id, token: key.token, request_id: b.dataset.req, decision: b.dataset.respond });
        toast(b.dataset.respond === "accept" ? "Accepted. Contacts shared." : "Declined"); await refreshMine(); renderHelp(); } catch (e) { toast(e.message); }
    }));
    $$("[data-close]", box).forEach((b) => b.addEventListener("click", async () => {
      const key = state.keys.offers.find((k) => k.id === b.dataset.close);
      await api("/api/shelter/close", key).catch(() => {}); toast("Closed"); await refreshMine(); renderHelp(); loadHosts();
    }));
  }

  // ---------- ALERTS ----------
  async function refreshInbox() {
    if (!state.subs.length) { state.inbox = { subscriptions: [], notifications: [] }; updateCounts(); return; }
    try {
      state.inbox = await api("/api/alerts/inbox", { subs: state.subs });
      const known = new Set(state.inbox.subscriptions.map((s) => s.id));
      if (known.size !== state.subs.length) { state.subs = state.subs.filter((s) => known.has(s.id)); store.set("subs", state.subs); }
      const popped = store.get("popped", []);
      if ("Notification" in window && Notification.permission === "granted") {
        state.inbox.notifications.filter((n) => !state.seen.has(n.id) && !popped.includes(n.id)).slice(0, 3).forEach((n) => {
          new Notification(`Float · ${n.title}`, { body: n.message, tag: n.id }); popped.push(n.id); });
        store.set("popped", popped.slice(-200));
      }
      updateCounts();
      if (state.tab === "alerts") { markSeen(); renderAlerts(); }
    } catch (e) { console.warn("inbox", e); }
  }
  function markSeen() { state.inbox.notifications.forEach((n) => state.seen.add(n.id)); store.set("seenNotes", [...state.seen].slice(-500)); updateCounts(); }
  function updateCounts() {
    const unread = state.inbox.notifications.filter((n) => !state.seen.has(n.id)).length;
    const a = $("#alerts-count"); a.hidden = !unread; a.textContent = unread;
    const pending = state.mine.offers.reduce((s, o) => s + o.requests.filter((r) => r.status === "pending").length, 0);
    const h = $("#help-count"); h.hidden = !pending; h.textContent = pending;
  }
  function renderAlerts() {
    const el = $("#tab-alerts");
    const subs = state.inbox.subscriptions, notes = state.inbox.notifications;
    const here = subs.find((s) => state.place && Math.abs(s.lat - state.place.lat) < 0.005 && Math.abs(s.lon - state.place.lon) < 0.005);
    el.innerHTML = `<div><div class="title">Alerts</div><p class="sub">Warnings up to 7 days before a flood.</p></div>
      <div class="card"><div class="r" style="border:0;padding:0"><span class="ic">🔔</span><div class="m"><div class="n">${esc(placeName())}</div><div class="s">${here ? `On · ${esc(here.threshold.toLowerCase())} risk or higher` : "Off"}</div></div>
        <button class="switch" id="a-switch" aria-pressed="${!!here}" aria-label="Alerts for this place" ${state.place ? "" : "disabled"}></button></div>
        ${here ? "" : `<label class="field" style="margin-top:14px">Warn me at<select id="a-level"><option value="HIGH">High risk</option><option value="MODERATE">Moderate or higher</option></select></label>`}</div>
      ${subs.filter((s) => s !== here).length ? `<div class="card"><h2>Other places</h2><div class="rows">${subs.filter((s) => s !== here).map((s) => `<div class="r"><span class="ic">📍</span><div class="m"><div class="n">${esc(s.label)}</div><div class="s">${esc(s.threshold.toLowerCase())} or higher</div></div><button class="btn small danger" data-unsub="${esc(s.id)}">Remove</button></div>`).join("")}</div></div>` : ""}
      <div class="card"><h2>Inbox</h2>${notes.length ? `<div class="rows">${notes.map((n) => `<div class="r"><span class="ic">${n.kind === "official" ? "🚨" : "🌊"}</span><div class="m"><div class="n">${esc(n.title)}</div><div class="s">${esc(n.message)}</div></div><span class="s">${esc(ago(n.created))}</span></div>`).join("")}</div>`
        : `<p class="empty">Nothing yet. Checked every 3 hours.</p>`}<p class="prov">Pop-ups appear while Float is open.</p></div>`;
    const sw = $("#a-switch");
    sw.addEventListener("click", async () => {
      sw.disabled = true;
      try {
        if (here) {
          const key = state.subs.find((s) => s.id === here.id);
          await api("/api/alerts/unsubscribe", key); state.subs = state.subs.filter((s) => s.id !== here.id); toast("Alerts off");
        } else {
          if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
          const r = await api("/api/alerts/subscribe", { lat: state.place.lat, lon: state.place.lon, label: placeName(), threshold: $("#a-level").value, name: state.profile?.name || "" });
          state.subs.push({ id: r.id, token: r.token }); toast("Alerts on");
        }
        store.set("subs", state.subs); await refreshInbox(); renderAlerts();
      } catch (e) { toast(e.message); sw.disabled = false; }
    });
    $$("[data-unsub]", el).forEach((b) => b.addEventListener("click", async () => {
      const key = state.subs.find((s) => s.id === b.dataset.unsub);
      await api("/api/alerts/unsubscribe", key).catch(() => {}); state.subs = state.subs.filter((s) => s.id !== key.id); store.set("subs", state.subs);
      await refreshInbox(); renderAlerts();
    }));
  }

  // ---------- GUIDES (+ damage photos) ----------
  const GUIDES = {
    before: [["🎒", "Build a kit", ["Water: 1 gallon per person per day, 3 days", "Medicines for 7 days", "IDs and insurance in a waterproof bag", "Chargers, battery pack, flashlight", "Cash and first aid"]],
      ["🗺️", "Make a plan", ["Pick where you'd go (Help tab)", "One contact person everyone knows", "Plan for pets", "Plan for medical devices"]],
      ["🏡", "Protect your home", ["Photograph every room (below)", "Move valuables up high", "Clear drains and gutters", "Flood insurance takes 30 days to start"]]],
    during: [["🚪", "Evacuate", ["Leave when officials say so", "Take kit, medicines, pets", "Power off at the main if dry and safe", "Tell your contact where you're going"]],
      ["🚗", "Water and roads", ["<strong>Turn around, don't drown</strong>", "6 inches of moving water knocks you down", "1 foot can float a car", "Avoid underpasses"]],
      ["⚡", "Power and gas", ["Stay 35 ft from downed lines", "Smell gas? Leave on foot, no switches", "Call CenterPoint 1-888-876-5786 and 911 outside", "Generators outside only"]]],
    after: [["🔙", "Return safely", ["Wait for the official all-clear", "Check the river is falling (Home)", "Watch for snakes and debris", "Wet wiring? Electrician first"]],
      ["🧽", "Clean up", ["Gloves, boots, mask", "Dry out in 24–48 h to stop mold", "Toss food that touched flood water", "Boil water until told it's safe"]],
      ["📋", "Claims and aid", ["Photograph damage before cleaning (below)", "Call your insurer", "FEMA: DisasterAssistance.gov · 1-800-621-3362", "Local help: dial 2-1-1"]]],
  };
  async function loadEvidence() { try { state.evidence = (await api("/api/evidence")).records; } catch { state.evidence = []; } }
  function renderGuides() {
    const p = state.phase || "before", el = $("#tab-guides");
    const photo = p !== "during";
    el.innerHTML = `<div><div class="title">${{ before: "Get ready", during: "Stay safe", after: "Recover" }[p]}</div><p class="sub">${{ before: "Before a flood", during: "During a flood", after: "After a flood" }[p]}</p></div>
      ${GUIDES[p].map(([e, t, items], i) => `<details class="guide" ${i === 0 ? "open" : ""}><summary><span class="e">${e}</span>${esc(t)}</summary><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></details>`).join("")}
      ${photo ? `<div class="card no-print"><h2>📸 ${p === "after" ? "Document damage" : "Photograph your home"}</h2>
        <p class="muted" style="margin-top:0">${p === "after" ? "Before cleanup. Time-stamped and fingerprinted for claims." : "\"Before\" photos speed up claims."}</p>
        <form class="form" id="ev-form"><label class="field">Photo<input id="ev-file" type="file" accept="image/*" capture="environment" required></label>
          <label class="field">Note<input id="ev-note" maxlength="300" placeholder="Room, item, water line"></label>
          <div class="row2"><button class="btn" type="submit" id="ev-submit">Save photo</button><button class="btn ghost" type="button" id="ev-print">Print for insurance</button></div></form>
        ${state.evidence.length ? `<div style="margin-top:8px">${state.evidence.map((r) => `<div class="evidence-rec"><img src="/evidence/${esc(r.file)}" alt="">
          <div class="small"><strong>${esc(clock(r.captured_at))}</strong>${r.note ? " · " + esc(r.note) : ""}<br>AI: ${r.analysis.classifier.label === "flood" ? "flood damage" : "no flood"} (${pct(r.analysis.classifier.flood_probability)})<br>
          ${r.analysis.qwen ? esc(r.analysis.qwen.description) + "<br>" : ""}<span class="mono">SHA-256 ${esc(r.sha256.slice(0, 32))}…</span></div></div>`).join("")}</div>` : ""}</div>` : ""}`;
    if (!photo) return;
    const readFile = (f) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(f); });
    $("#ev-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = $("#ev-file").files[0]; if (!file) return;
      const btn = $("#ev-submit"); btn.disabled = true; btn.textContent = "Analyzing...";
      try {
        const body = { image: await readFile(file), note: $("#ev-note").value, use_qwen: true };
        if (state.place) Object.assign(body, { lat: state.place.lat, lon: state.place.lon });
        await api("/api/evidence", body); await loadEvidence(); renderGuides(); toast("Photo saved");
      } catch (err) { toast("Could not save: " + err.message); btn.disabled = false; btn.textContent = "Save photo"; }
    });
    $("#ev-print").addEventListener("click", () => window.print());
  }

  // ---------- ME (profile + settings) ----------
  async function saveProfile(fields, quiet) {
    const body = { ...fields, ...(state.profileKey || {}) };
    if (state.place) Object.assign(body, { lat: state.place.lat, lon: state.place.lon, label: placeName() });
    try {
      const r = await api("/api/profile/save", body);
      state.profileKey = { id: r.id, token: r.token }; store.set("profileKey", state.profileKey);
      const { token, ...pub } = r; state.profile = pub; store.set("profile", pub);
      if (!quiet) toast("Profile saved");
    } catch (e) {
      if (state.profileKey && /token|Unknown record/i.test(e.message)) { state.profileKey = null; store.set("profileKey", null); return saveProfile(fields, quiet); }
      state.profile = { ...fields }; store.set("profile", state.profile);
      if (!quiet) toast("Saved on this device (server unavailable)");
    }
    state.help.mode = null;
  }
  function renderMe() {
    const el = $("#tab-me"), p = state.profile || { role: "informed", people: 1, has_car: true };
    el.innerHTML = `<div><div class="title">Me</div><p class="sub">So Float can connect you to the right help.</p></div>
      <form class="card form" id="me-form"><h2>I'm here because...</h2>
        <div class="roles">${Object.entries(ROLES).map(([k, [e, t]]) => `<button type="button" class="role" data-role="${k}" aria-pressed="${p.role === k}"><span class="e">${e}</span><strong>${esc(t)}</strong></button>`).join("")}</div>
        <h2 style="margin-top:8px">My household</h2>
        <div class="row2"><label class="field">People<input name="people" type="number" min="1" max="50" value="${p.people || 1}"></label>
          <label class="field">Medical needs<input name="medical" maxlength="200" value="${esc(p.medical || "")}" placeholder="e.g. oxygen, insulin"></label></div>
        <div class="row2"><label class="check"><input type="checkbox" name="pets" ${p.pets ? "checked" : ""}> Pets</label><label class="check"><input type="checkbox" name="accessible" ${p.accessible ? "checked" : ""}> Wheelchair</label>
          <label class="check"><input type="checkbox" name="has_car" ${p.has_car !== false ? "checked" : ""}> Have a car</label></div>
        <h2 style="margin-top:8px">Contact</h2>
        <div class="row2"><label class="field">Name<input name="name" maxlength="60" value="${esc(p.name || "")}"></label><label class="field">Phone<input name="contact" maxlength="120" value="${esc(p.contact || "")}" inputmode="tel"></label></div>
        <p class="small muted" style="margin:0">Shared only with a host or driver after you're matched.</p>
        <button class="btn block" type="submit">Save</button></form>
      <div class="card settings"><h2>Settings</h2><div class="rows">
        <div class="r" id="set-loc"><span class="ic">📍</span><div class="m"><div class="n">Location</div><div class="s">${esc(placeName())}</div></div><span class="km">›</span></div>
        <div class="r"><span class="ic">🔁</span><div class="m"><div class="n">Auto Before/During/After</div><div class="s">Switches to During when flooding is likely</div></div><button class="switch" id="set-auto" aria-pressed="${!store.get("phaseManual", false)}" aria-label="Automatic phase"></button></div>
        <div class="r"><span class="ic">🔠</span><div class="m"><div class="n">Larger text</div></div><button class="switch" data-pref="large-text" aria-pressed="${document.body.classList.contains("large-text")}" aria-label="Larger text"></button></div>
        <div class="r"><span class="ic">🌓</span><div class="m"><div class="n">High contrast</div></div><button class="switch" data-pref="high-contrast" aria-pressed="${document.body.classList.contains("high-contrast")}" aria-label="High contrast"></button></div>
        <div class="r" data-go="manager"><span class="ic">📊</span><div class="m"><div class="n">Where to help first</div><div class="s">For emergency managers</div></div><span class="km">›</span></div>
        <div class="r" data-go="about"><span class="ic">ℹ️</span><div class="m"><div class="n">About Float</div><div class="s">Data sources and AI accuracy</div></div><span class="km">›</span></div></div></div>`;
    let role = p.role;
    $$("[data-role]", el).forEach((b) => b.addEventListener("click", () => { role = b.dataset.role; $$("[data-role]", el).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); }));
    $("#me-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      await saveProfile({ role, people: Math.max(1, +f.people.value || 1), medical: f.medical.value, pets: f.pets.checked, accessible: f.accessible.checked,
        has_car: f.has_car.checked, name: f.name.value, contact: f.contact.value });
      setTab("home");
    });
    bindGo(el);
    $("#set-loc").addEventListener("click", () => showWelcome("location"));
    $("#set-auto").addEventListener("click", (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; store.set("phaseManual", !on); e.currentTarget.setAttribute("aria-pressed", String(on)); if (on) autoPhase(); });
    $$("[data-pref]", el).forEach((b) => b.addEventListener("click", () => {
      const cls = b.dataset.pref, v = !document.body.classList.contains(cls);
      document.body.classList.toggle(cls, v); b.setAttribute("aria-pressed", String(v)); store.set(cls, v);
    }));
  }

  // ---------- MANAGER + ABOUT (from Me) ----------
  const back = `<button class="link" data-go="me" style="align-self:flex-start;padding:0">← Me</button>`;
  async function renderManager() {
    const el = $("#tab-manager");
    el.innerHTML = `${back}<div class="title">Where to help first</div><div class="card"><p class="empty">Loading...</p></div>`;
    bindGo(el);
    try {
      const p = await api("/api/priorities");
      el.innerHTML = `${back}<div><div class="title">Where to help first</div><p class="sub">Flooding × vulnerability × hospital access</p></div>
        <div class="card"><div class="rows">${p.areas.map((a, i) => `<div class="r"><span class="ic" style="font-weight:900;font-size:1.1rem">${i + 1}</span><div class="m"><div class="n">${esc(a.locality)}</div>
          <div class="s">${Math.round(a.flood_share * 100)}% flooded · vulnerability ${a.vulnerability.toFixed(2)}${a.in_essentials_area ? ` · ${a.hospitals_10km} hospitals ≤10 km` : ""}</div></div><span class="km">${a.score}</span></div>`).join("")}</div>
          <details class="why" style="margin-top:12px"><summary>How the score works</summary><p class="small">${esc(p.formula)}</p><p class="small muted">${esc(p.note)}</p></details></div>`;
      bindGo(el);
    } catch (e) { el.innerHTML += `<p class="msg err">${esc(e.message)}</p>`; }
  }
  async function renderAbout() {
    const el = $("#tab-about");
    try {
      const m = state.meta || (state.meta = await api("/api/meta"));
      const r = m.metrics.risk_model, im = m.metrics.image_model;
      el.innerHTML = `${back}<div><div class="title">About Float</div><p class="sub">Flood safety for Houston, built on the Dell Pro Max GB10.</p></div>
        <div class="grid"><div class="tile"><div class="k">Image AI</div><div class="big">${pct(im.hand_labeled_test.accuracy)}</div><div class="muted">correct on 100 hand-labeled flood photos</div></div>
          <div class="tile"><div class="k">Risk AI · new areas</div><div class="big">${pct(r.area_holdout.model.recall)}</div><div class="muted">of floods caught · ${pct(r.area_holdout.model.false_positive_rate)} false alarms</div></div></div>
        <div class="card"><h2>Sources</h2><div class="rows">
          <div class="r"><span class="ic">🚨</span><div class="m"><div class="n">Warnings</div><div class="s">National Weather Service</div></div>${badge("official")}</div>
          <div class="r"><span class="ic">🌧️</span><div class="m"><div class="n">Weather</div><div class="s">Open-Meteo</div></div>${badge("forecast")}</div>
          <div class="r"><span class="ic">📈</span><div class="m"><div class="n">River gauges</div><div class="s">USGS</div></div>${badge("verified")}</div>
          <div class="r"><span class="ic">📄</span><div class="m"><div class="n">Flood history</div><div class="s">OpenFEMA claims + disasters, FEMA flood map</div></div>${badge("historical")}</div>
          <div class="r"><span class="ic">📰</span><div class="m"><div class="n">News</div><div class="s">Google News</div></div>${badge("reference")}</div>
          <div class="r"><span class="ic">🧠</span><div class="m"><div class="n">Flood prediction</div><div class="s">Trained on ${r.training_rows} labeled flood photos + heavy-rain rule</div></div>${badge("experimental")}</div></div>
          <p class="small muted">AI predictions are experimental and weak on floods from upstream rain. Always follow official warnings. GB10 vision: ${m.gb10.enabled ? "on" : "off"}.</p></div>`;
      bindGo(el);
    } catch (e) { el.innerHTML = `${back}<p class="msg err">${esc(e.message)}</p>`; bindGo(el); }
  }

  // ---------- photo dialog ----------
  async function openSite(id) {
    const s = state.sites.find((x) => x.image_id === id);
    $("#dlg-title").textContent = s ? `${s.locality} · ${s.date}` : "Photo";
    $("#dlg-body").innerHTML = `<img src="/static/thumbs/${esc(id)}.jpg" alt="Aerial photo"><div id="dlg-analysis"><p class="empty">Asking the AI...</p></div>`;
    if (!$("#site-dialog").open) $("#site-dialog").showModal();
    try {
      const r = await api(`/api/site/${encodeURIComponent(id)}`);
      $("#dlg-analysis").innerHTML = `<p style="font-size:1.2rem;font-weight:900" class="${r.classifier.label === "flood" ? "lv-HIGH" : "lv-LOW"}">${r.classifier.label === "flood" ? "Flooded" : "No flood"} · ${pct(r.classifier.flood_probability)}</p>${r.qwen ? `<p>${esc(r.qwen.description)}</p>` : ""}<p class="prov">${badge("experimental")} Float image AI${r.qwen ? " + Qwen on the GB10" : ""}</p>`;
    } catch (e) { $("#dlg-analysis").innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
  }
  $("#dlg-close").addEventListener("click", () => $("#site-dialog").close());

  // ---------- start ----------
  async function start() {
    for (const cls of ["large-text", "high-contrast"]) document.body.classList.toggle(cls, store.get(cls, false));
    const [fromHash, phaseHash] = location.hash.slice(1).split("/");
    if (PHASES.includes(phaseHash)) { state.phase = phaseHash; store.set("phase", phaseHash); store.set("phaseManual", true); }
    if (!state.phase) state.phase = "before";
    updatePhaseUI();
    setTab(TABS.includes(fromHash) ? fromHash : "home");
    api("/api/meta").then((m) => { state.meta = m; }).catch(() => {});
    if (state.place) { $("#place-name").textContent = placeName(); pin = L.marker([state.place.lat, state.place.lon]).addTo(map); refreshPlace(); }
    else showWelcome("location");
    await Promise.allSettled([loadSites(), loadGauges(), refreshInbox(), refreshMine()]);
    if (state.tab === "home") renderHome();
    setInterval(loadGauges, 5 * 60 * 1000);
    setInterval(refreshInbox, 5 * 60 * 1000);
    setInterval(refreshMine, 2 * 60 * 1000);
  }
  start();
})();
