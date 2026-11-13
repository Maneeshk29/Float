/* Float front end. Plain JavaScript + Leaflet. One tab is visible at a time; the Before/During/After
   phase changes what every tab shows. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("float:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("float:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const TABS = ["home", "outlook", "alerts", "shelter", "guides", "recovery", "map", "manager", "about"];
  const PHASES = ["before", "during", "after"];
  const state = {
    tab: "home", phase: store.get("phase", null), point: null, data: null, horizon: 3,
    sites: [], gauges: [], meta: null, shelterView: "find", offersFound: null,
    subs: store.get("subs", []), keys: store.get("shelterKeys", { offers: [], requests: [] }),
    inbox: { subscriptions: [], notifications: [] }, mine: { offers: [], requests: [] },
    seen: new Set(store.get("seenNotes", [])), evidence: [],
  };

  // ---------- helpers ----------
  function ago(iso) {
    if (!iso) return "unknown";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : new Date(iso).toLocaleDateString();
  }
  const clock = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const BADGE = { official: "Official", verified: "Verified live", forecast: "Forecast", experimental: "Experimental AI", reference: "Reference", historical: "Past floods" };
  const badge = (t) => `<span class="badge ${esc(t)}">${esc(BADGE[t] || t)}</span>`;
  const prov = (p, extra = "") => p ? `<div class="prov">${esc(p.source)} · ${esc(ago(p.retrieved_at))}${extra}</div>` : "";
  const lvClass = (lv) => "lv-" + String(lv).replace(" ", "");
  const pct = (p) => Math.round(p * 100) + "%";
  async function api(url, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const placeName = () => state.point ? (state.point.label || `${state.point.lat.toFixed(3)}, ${state.point.lon.toFixed(3)}`) : "No place set";
  const placeLine = () => `<div class="place-line">Your place: <strong>${esc(placeName())}</strong> <button class="link-btn" data-go="map">Change</button></div>`;
  function bindGo(root) {
    $$("[data-go]", root).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setTab(b.dataset.go); }));
  }

  // ---------- map ----------
  const map = L.map("leaflet-map", { preferCanvas: true }).setView([29.78, -95.45], 10);
  const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const fema = L.tileLayer.wms("https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer",
    { layers: "28", format: "image/png", transparent: true, opacity: 0.5, attribution: "FEMA NFHL" });
  const layers = {
    evidence: L.layerGroup().addTo(map), gauges: L.layerGroup().addTo(map), hospital: L.layerGroup().addTo(map),
    hosts: L.layerGroup().addTo(map), grocery: L.layerGroup(), fuel: L.layerGroup(), shelter: L.layerGroup(), manager: L.layerGroup().addTo(map),
  };
  L.control.layers({ "Street map": base }, {
    "Past floods (labeled photos)": layers.evidence, "River gauges (live)": layers.gauges, "FEMA flood zones": fema,
    "Shelter hosts": layers.hosts, "Hospitals": layers.hospital, "Grocery": layers.grocery, "Fuel": layers.fuel,
  }, { collapsed: true }).addTo(map);
  let pin = null;
  map.on("click", (e) => { choosePoint(e.latlng.lat, e.latlng.lng, null); toast("Place set"); });
  map.on("popupopen", (e) => {
    const b = e.popup.getElement().querySelector("[data-site]");
    if (b) b.addEventListener("click", () => openSite(b.dataset.site));
  });
  const COLORS = { flood: "#d84315", not_flood: "#2e7d32", uncertain: "#b07d00" };
  const PLACE = { hospital: "#00838f", grocery: "#6d8a00", fuel: "#6b4fbb", shelter: "#0b6e4f" };

  async function loadSites() {
    const { sites } = await api("/api/sites");
    state.sites = sites;
    for (const s of sites) {
      L.circleMarker([s.lat, s.lon], { radius: 5, color: "#fff", weight: 1, fillColor: COLORS[s.label], fillOpacity: 0.9 })
        .bindPopup(() => `<img src="/static/thumbs/${esc(s.image_id)}.jpg" alt=""><strong>${s.label === "flood" ? "FLOODED" : s.label === "not_flood" ? "DRY" : "UNSURE"}</strong> · ${esc(s.date)}<br>${esc(s.locality)}<br><button class="btn small" data-site="${esc(s.image_id)}">Analyze</button>`)
        .addTo(layers.evidence);
    }
  }
  async function loadEssentials() {
    const ess = await api("/api/essentials");
    for (const p of ess.places) {
      L.circleMarker([p.lat, p.lon], { radius: p.type === "hospital" ? 6 : 4, color: PLACE[p.type], weight: 1, fillColor: PLACE[p.type], fillOpacity: 0.7 })
        .bindPopup(`<strong>${esc(p.name)}</strong><br>${esc(p.address || p.type)}<br><span class="muted">${p.type === "hospital" ? "Status: no live feed" : "Open / stock: unknown"}</span>`)
        .addTo(layers[p.type]);
    }
  }
  async function loadGauges() {
    try {
      const g = await api("/api/gauges");
      if (!g.ok) throw new Error(g.error);
      state.gauges = g.gauges;
      layers.gauges.clearLayers();
      for (const x of g.gauges) {
        const [arrow, color] = { rising: ["▲", "#d84315"], falling: ["▼", "#2e7d32"], steady: ["■", "#5d6b78"] }[x.trend];
        L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "", html: `<div style="color:${color};font-size:15px;text-shadow:0 0 2px #fff,0 0 2px #fff">${arrow}</div>`, iconSize: [16, 16] }) })
          .bindPopup(`<strong>${esc(x.name)}</strong><br>${x.stage_ft.toFixed(1)} ft · ${esc(x.trend)}<br><span class="muted">USGS · ${esc(ago(x.observed_at))}</span>`)
          .addTo(layers.gauges);
      }
      if (state.data) renderHome();
    } catch (e) { console.warn("gauges", e); }
  }
  function nearestGauges(lat, lon, n = 3) {
    const r = Math.PI / 180;
    const d = (g) => 6371 * Math.acos(Math.min(1, Math.sin(lat * r) * Math.sin(g.lat * r) + Math.cos(lat * r) * Math.cos(g.lat * r) * Math.cos((g.lon - lon) * r)));
    return state.gauges.map((g) => ({ ...g, km: d(g) })).sort((a, b) => a.km - b.km).slice(0, n);
  }

  // ---------- place + data ----------
  async function choosePoint(lat, lon, label) {
    state.point = { lat, lon, label };
    if (pin) pin.remove();
    pin = L.marker([lat, lon]).addTo(map);
    state.offersFound = null;
    renderAll();
    try {
      const data = await api(`/api/point?lat=${lat}&lon=${lon}`);
      data.fetched_at = new Date().toISOString();
      data.label = label;
      store.set("last", data);
      setOnline(true);
      state.data = data;
    } catch (e) {
      const last = store.get("last");
      setOnline(false, last);
      if (last) state.data = last;
    }
    autoPhase();
    renderAll();
    loadHosts();
  }
  function setOnline(ok, last) {
    const pill = $("#net-pill");
    pill.className = "pill " + (ok ? "ok" : "bad");
    pill.textContent = ok ? "Online" : "Offline";
    $("#offline-banner").hidden = ok;
    if (!ok) $("#offline-banner").textContent = last ? `OFFLINE · Showing last update from ${clock(last.fetched_at)}. Conditions may have changed.` : "OFFLINE · No saved data yet.";
  }
  const floodAlerts = () => (state.data?.alerts?.alerts || []);
  const riskNow = () => state.data?.risk?.timeline?.[0];
  function autoPhase() {
    if (store.get("phaseManual", false) && state.phase) return updatePhaseUI();
    const now = riskNow();
    const urgent = floodAlerts().some((a) => /flood|hurricane|tropical|surge/i.test(a.event || "")) || (now && now.probability >= 0.5);
    state.phase = urgent ? "during" : "before";
    updatePhaseUI();
  }

  // ---------- phase + tabs ----------
  function updatePhaseUI() {
    $$(".phase button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.phase === state.phase)));
    $("#phase-note").innerHTML = store.get("phaseManual", false)
      ? `<button class="link-btn small" id="phase-auto">Use auto</button>` : "Auto · from current conditions";
    const auto = $("#phase-auto");
    if (auto) auto.addEventListener("click", () => { store.set("phaseManual", false); autoPhase(); renderAll(); });
  }
  function setPhase(p) {
    state.phase = p;
    store.set("phase", p);
    store.set("phaseManual", true);
    updatePhaseUI();
    if (p === "during" && state.shelterView === "offer") state.shelterView = "find";
    renderAll();
  }
  function setTab(tab) {
    if (!TABS.includes(tab)) tab = "home";
    state.tab = tab;
    if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
    $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    TABS.forEach((t) => { $("#tab-" + t).hidden = t !== tab; });
    renderTab(tab);
    if (tab === "map") setTimeout(() => { map.invalidateSize(); if (state.point) map.setView([state.point.lat, state.point.lon], Math.max(map.getZoom(), 11)); }, 30);
    if (tab === "alerts") markSeen();
    if (tab === "recovery") loadEvidence().then(() => { if (state.tab === "recovery") renderRecovery(); });
    window.scrollTo(0, 0);
  }
  $$(".phase button").forEach((b) => b.addEventListener("click", () => setPhase(b.dataset.phase)));
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  function renderAll() { renderTab(state.tab); }
  function renderTab(tab) {
    const fn = { home: renderHome, outlook: renderOutlook, alerts: renderAlerts, shelter: renderShelter, guides: renderGuides,
      recovery: renderRecovery, map: renderMapTab, manager: renderManager, about: renderAbout }[tab];
    fn();
  }

  // ---------- HOME ----------
  const HOME = {
    before: { title: "Get ready", actions: [["alerts", "Turn on alerts", "Up to 7 days ahead", true], ["shelter", "Plan where to go", "Find or offer a place"], ["guides", "Check your kit", "2-minute checklist"]] },
    during: { title: "Stay safe", actions: [["shelter", "Need shelter", "Hosts + official shelters", true], ["guides", "Safety guide", "Water, power, gas"], ["map", "Live map", "Gauges, hospitals"]] },
    after: { title: "Recover", actions: [["recovery", "Document damage", "Photos for claims", true], ["shelter", "Place to stay", "Temporary housing"], ["guides", "Clean up safely", "Power, water, mold"]] },
  };
  function alertBanner() {
    return floodAlerts().map((a) => `<div class="alert">${badge("official")} <strong>${esc((a.event || "").toUpperCase())}</strong>${a.expires ? ` · until ${esc(clock(a.expires))}` : ""}
      <div class="small">${esc(a.headline || "")}</div>
      ${a.instruction ? `<details><summary>What to do</summary><p class="small">${esc(a.instruction)}</p></details>` : ""}</div>`).join("");
  }
  function weekMini(look) {
    if (!look) return "";
    const bars = look.days.map((d) => `<div class="${lvClass(d.level)}" style="height:${Math.max(6, d.probability * 100)}%" title="${esc(d.label)}: ${esc(d.level)}"></div>`).join("");
    const labels = look.days.map((d, i) => `<span>${i === 0 ? "Today" : esc(d.weekday)}</span>`).join("");
    return `<div class="week-mini">${bars}</div><div class="week-mini-labels">${labels}</div>`;
  }
  function renderHome() {
    const el = $("#tab-home");
    const d = state.data, cfg = HOME[state.phase || "before"];
    if (!d) { el.innerHTML = `${placeLine()}<div class="card"><p class="empty">Loading your place...</p></div>`; bindGo(el); return; }
    const now = riskNow(), look = d.risk?.outlook;
    const peak = look?.peak;
    const g = nearestGauges(d.lat, d.lon, 1)[0];
    const rain = d.rain?.ok ? d.rain.summary : null;
    const fz = d.fema?.ok ? (d.fema.mapped ? `Zone ${d.fema.zone}` : "Not mapped") : "Unavailable";
    let html = placeLine() + alertBanner();
    html += `<div class="card"><div class="hero">
        <div><div class="label">Flood risk now</div><div class="big ${now ? lvClass(now.level) : ""}">${now ? esc(now.level) : "–"}</div>
          <div class="small muted">${now ? pct(now.probability) + " · " : ""}${badge("experimental")}</div></div>
        <div><div class="label">Next 7 days${peak ? ` · peak <span class="${lvClass(peak.level)}">${esc(peak.level)}</span> ${esc(peak.weekday)}` : ""}</div>${weekMini(look)}</div>
      </div></div>`;
    html += `<div class="card"><h2>${esc(cfg.title)}</h2><div class="actions">${cfg.actions.map(([tab, t, s, primary]) =>
      `<button class="action${primary ? " primary" : ""}" data-go="${tab}"><strong>${esc(t)}</strong><span>${esc(s)}</span></button>`).join("")}</div></div>`;
    if (state.phase === "after") {
      const ok = (b) => b ? `<span class="lv-LOW">✓</span>` : `<span class="lv-HIGH">✗</span>`;
      const noAlerts = d.alerts?.ok && !floodAlerts().length;
      const falling = g && g.trend !== "rising";
      const lowRisk = now && now.probability < 0.2;
      html += `<div class="card"><h2>Can I return?</h2><div class="list">
        <div class="item"><span>${ok(noAlerts)} <strong>No flood alerts</strong></span>${badge("official")}</div>
        <div class="item"><span>${ok(falling)} <strong>River not rising</strong>${g ? `<div class="d">${esc(g.name)}</div>` : ""}</span>${badge("verified")}</div>
        <div class="item"><span>${ok(lowRisk)} <strong>Low flood risk</strong></span>${badge("experimental")}</div>
        <div class="item"><span>➜ <strong>Wait for the official all-clear</strong><div class="d">Electrician before power on if water got inside.</div></span></div></div></div>`;
    }
    html += `<div class="facts">
      <div class="fact"><div class="k">Rain next 24 h</div><div class="v">${rain ? rain.next_24h_mm + " mm" : "–"}</div><div class="s">${rain ? rain.past_24h_mm + " mm past 24 h" : "unavailable"}</div></div>
      <div class="fact"><div class="k">Nearest river</div><div class="v">${g ? `${esc(g.trend)}` : "–"}</div><div class="s">${g ? `${esc(g.name.split(" at ")[0].split(" nr ")[0])} · ${esc(ago(g.observed_at))}` : "no gauge loaded"}</div></div>
      <div class="fact"><div class="k">FEMA zone</div><div class="v">${esc(fz)}</div><div class="s">${d.fema?.sfha ? "High-risk zone" : d.fema?.ok ? "Outside high-risk zone" : ""}</div></div></div>`;
    if (state.phase === "before" && d.evidence?.count) {
      const ev = d.evidence;
      html += `<div class="card"><h2>Past floods here ${badge("historical")}</h2>
        <p><strong>${ev.flooded} of ${ev.count}</strong> aerial photos within ${ev.radius_km} km flooded in past storms.</p>
        <div class="thumbs">${ev.sites.slice(0, 8).map((s) => `<button class="${esc(s.label)}" data-site="${esc(s.image_id)}"><img src="/static/thumbs/${esc(s.image_id)}.jpg" alt="" loading="lazy"><span>${s.label === "flood" ? "FLOOD" : "DRY"} ${esc(s.date.slice(0, 4))}</span></button>`).join("")}</div></div>`;
    }
    el.innerHTML = html;
    bindGo(el);
    $$("[data-site]", el).forEach((b) => b.addEventListener("click", () => openSite(b.dataset.site)));
  }

  // ---------- OUTLOOK ----------
  function renderOutlook() {
    const el = $("#tab-outlook");
    const d = state.data;
    if (!d) { el.innerHTML = placeLine() + `<div class="card"><p class="empty">Loading...</p></div>`; bindGo(el); return; }
    if (!d.risk) { el.innerHTML = placeLine() + `<div class="card"><p class="empty">Rain forecast unavailable, so no outlook right now.</p></div>`; bindGo(el); return; }
    const look = d.risk.outlook;
    const week = `<div class="card"><h2>Next 7 days ${badge("experimental")}</h2><div class="days">${look.days.map((x, i) => `
      <div class="day ${lvClass(x.level)}"><div class="name">${i === 0 ? "Today" : esc(x.weekday)}<small>${esc(x.label.slice(4))}</small></div>
        <div><span class="chip">${esc(x.level)}</span></div>
        <div class="meter"><span style="width:${Math.max(3, x.probability * 100)}%"></span></div>
        <div class="mm">${x.rain_mm.toFixed(0)} mm</div></div>`).join("")}</div>
      <div class="prov">Peak risk per day · rain forecast · confidence drops after day 2</div></div>`;
    const tl = d.risk.timeline;
    const sel = tl.find((t) => t.horizon_h === state.horizon) || tl[0];
    const hours = `<div class="card"><h2>Next 24 hours ${badge("experimental")}</h2>
      <div class="timeline">${tl.map((t) => `<button class="tl ${lvClass(t.level)}" data-h="${t.horizon_h}" aria-pressed="${t.horizon_h === state.horizon}">
        <div class="h">${t.horizon_h ? "+" + t.horizon_h + " h" : "NOW"}</div><div class="p">${pct(t.probability)}</div><div class="lv">${esc(t.level)}</div></button>`).join("")}</div>
      <h3>${sel.horizon_h ? "In " + sel.horizon_h + " h" : "Now"}: <span class="${lvClass(sel.level)}">${esc(sel.level)}</span></h3>
      <ul class="tight small">${sel.reasons.slice(0, 3).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
    const rain = d.rain?.ok ? `<div class="card"><h2>Rain ${badge("forecast")}</h2>${rainChart(d.rain.chart)}
      ${prov(d.rain.provenance)}</div>` : "";
    const why = `<div class="card"><details class="why"><summary>How is this calculated?</summary>
      <ul class="tight small"><li><strong>Trained model:</strong> learned from 1,204 labeled flood photos (rain, elevation, FEMA zone).</li>
      <li><strong>Rain rule:</strong> heavy rain always raises the risk.</li><li>Float shows the higher of the two.</li>
      <li><strong>Not an official warning.</strong> Follow NWS and local officials.</li></ul>
      <button class="link-btn small" data-go="about">Model details</button></details></div>`;
    const order = state.phase === "before" ? [week, hours, rain, why] : [hours, week, rain, why];
    el.innerHTML = `<div><div class="page-title">Outlook</div>${placeLine()}</div>` + order.join("");
    bindGo(el);
    $$(".tl", el).forEach((b) => b.addEventListener("click", () => { state.horizon = +b.dataset.h; renderOutlook(); }));
  }
  function rainChart(chart) {
    if (!chart || !chart.length) return "";
    const now = Date.now() / 1000, max = Math.max(2, ...chart.map((c) => c[1])), w = 100 / chart.length;
    const bars = chart.map((c, i) => { const h = (c[1] / max) * 66, f = c[0] > now;
      return `<rect x="${i * w}%" y="${70 - h}" width="${w * 0.8}%" height="${h}" fill="${f ? "#6b4fbb" : "#0a66c2"}" opacity="${f ? 0.55 : 0.9}"></rect>`; }).join("");
    const ni = chart.findIndex((c) => c[0] > now), nx = (ni < 0 ? chart.length : ni) * w;
    return `<svg width="100%" height="84" role="img" aria-label="Hourly rain">${bars}<line x1="${nx}%" x2="${nx}%" y1="0" y2="72" stroke="currentColor" stroke-dasharray="3 2"></line>
      <text x="${nx}%" y="82" font-size="9" text-anchor="middle" fill="currentColor">now</text><text x="0" y="9" font-size="9" fill="currentColor">max ${max.toFixed(1)} mm/h</text></svg>
      <div class="small muted">Past 48 h · next 24 h (faded)</div>`;
  }

  // ---------- ALERTS ----------
  async function refreshInbox() {
    if (!state.subs.length) { state.inbox = { subscriptions: [], notifications: [] }; updateCounts(); return; }
    try {
      state.inbox = await api("/api/alerts/inbox", { subs: state.subs });
      const known = new Set(state.inbox.subscriptions.map((s) => s.id));
      if (known.size !== state.subs.length) { state.subs = state.subs.filter((s) => known.has(s.id)); store.set("subs", state.subs); }
      const fresh = state.inbox.notifications.filter((n) => !state.seen.has(n.id));
      if (fresh.length && "Notification" in window && Notification.permission === "granted") {
        for (const n of fresh.slice(0, 3)) {
          if (store.get("popped", []).includes(n.id)) continue;
          new Notification(`Float · ${n.title}`, { body: n.message, tag: n.id });
          store.set("popped", [...store.get("popped", []), n.id].slice(-200));
        }
      }
      updateCounts();
      if (state.tab === "alerts") { markSeen(); renderAlerts(); }
    } catch (e) { console.warn("inbox", e); }
  }
  function markSeen() {
    state.inbox.notifications.forEach((n) => state.seen.add(n.id));
    store.set("seenNotes", [...state.seen].slice(-500));
    updateCounts();
  }
  function updateCounts() {
    const unread = state.inbox.notifications.filter((n) => !state.seen.has(n.id)).length;
    const a = $("#alerts-count"); a.hidden = !unread; a.textContent = unread;
    const pending = state.mine.offers.reduce((s, o) => s + o.requests.filter((r) => r.status === "pending").length, 0);
    const s = $("#shelter-count"); s.hidden = !pending; s.textContent = pending;
  }
  function renderAlerts() {
    const el = $("#tab-alerts");
    const subs = state.inbox.subscriptions, notes = state.inbox.notifications;
    const sub = {
      before: "Get warned up to 7 days before a flood.", during: "Keep alerts on. Official warnings come first.", after: "Stay subscribed: rivers can rise again.",
    }[state.phase || "before"];
    el.innerHTML = `<div><div class="page-title">Alerts</div><p class="page-sub">${sub}</p></div>
      <div class="card"><h2>Turn on alerts</h2>
        <form class="form" id="sub-form">${placeLine()}
          <div class="row"><label class="field">Alert me at<select name="threshold"><option value="HIGH">High risk</option><option value="MODERATE">Moderate or higher</option></select></label>
          <label class="field">Your name (optional)<input name="name" maxlength="60"></label></div>
          <div><button class="btn" type="submit" ${state.point ? "" : "disabled"}>Turn on alerts</button> <span class="form-msg" id="sub-msg"></span></div>
        </form></div>
      <div class="card"><h2>Your places</h2>${subs.length ? `<div class="list">${subs.map((s) => `
        <div class="item"><div><div class="t">${esc(s.label)}</div><div class="d">Alert at ${esc(s.threshold.toLowerCase())} · checked ${esc(ago(s.last_checked))}${s.last_peak ? ` · this week: <span class="${lvClass(s.last_peak.level)}">${esc(s.last_peak.level)}</span>` : ""}</div></div>
        <button class="btn small danger" data-unsub="${esc(s.id)}">Remove</button></div>`).join("")}</div>` : `<p class="empty">None yet.</p>`}</div>
      <div class="card"><h2>Inbox</h2>${notes.length ? `<div class="list">${notes.map((n) => `
        <div class="item"><div>${badge(n.kind)} <span class="t">${esc(n.title)}</span><div class="d">${esc(n.message)}</div></div><span class="d">${esc(ago(n.created))}</span></div>`).join("")}</div>`
        : `<p class="empty">No alerts. Float checks every 3 hours.</p>`}
        <div class="prov">Pop-ups need Float open in a browser tab.</div></div>`;
    bindGo(el);
    $("#sub-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, msg = $("#sub-msg");
      if (!state.point) return;
      f.querySelector("button").disabled = true; msg.className = "form-msg"; msg.textContent = "Checking...";
      try {
        if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
        const r = await api("/api/alerts/subscribe", { lat: state.point.lat, lon: state.point.lon, label: placeName(), threshold: f.threshold.value, name: f.name.value });
        state.subs.push({ id: r.id, token: r.token }); store.set("subs", state.subs);
        await refreshInbox();
        renderAlerts();
        toast("Alerts on");
      } catch (err) { msg.className = "form-msg err"; msg.textContent = err.message; f.querySelector("button").disabled = false; }
    });
    $$("[data-unsub]", el).forEach((b) => b.addEventListener("click", async () => {
      const s = state.subs.find((x) => x.id === b.dataset.unsub);
      if (!s) return;
      await api("/api/alerts/unsubscribe", s).catch(() => {});
      state.subs = state.subs.filter((x) => x.id !== s.id); store.set("subs", state.subs);
      await refreshInbox(); renderAlerts(); toast("Removed");
    }));
  }

  // ---------- SHELTER ----------
  async function refreshMine() {
    if (!state.keys.offers.length && !state.keys.requests.length) return;
    try { state.mine = await api("/api/shelter/mine", state.keys); updateCounts(); if (state.tab === "shelter" && state.shelterView === "mine") renderShelter(); }
    catch (e) { console.warn("mine", e); }
  }
  async function loadHosts() {
    if (!state.point) return;
    try {
      const { offers } = await api(`/api/shelter/offers?lat=${state.point.lat}&lon=${state.point.lon}`);
      layers.hosts.clearLayers();
      offers.forEach((o) => L.circleMarker([o.lat, o.lon], { radius: 9, color: "#fff", weight: 2, fillColor: "#0a66c2", fillOpacity: 0.95 })
        .bindPopup(`<strong>${esc(o.area)}</strong><br>${o.spots_left} spots${o.pets ? " · pets ok" : ""}${o.accessible ? " · wheelchair" : ""}<br><span class="muted">Approximate area · ask in the Shelter tab</span>`).addTo(layers.hosts));
    } catch (e) { console.warn("hosts", e); }
  }
  function renderShelter() {
    const el = $("#tab-shelter");
    const head = { before: ["Plan where you'd go", "Line up a place now, or offer one."], during: ["Need shelter now?", "Official shelters first. Hosts nearby below."],
      after: ["Place to stay", "Temporary housing while you recover."] }[state.phase || "before"];
    const pendingIn = state.mine.offers.reduce((s, o) => s + o.requests.filter((r) => r.status === "pending").length, 0);
    const view = state.shelterView;
    el.innerHTML = `<div><div class="page-title">${esc(head[0])}</div><p class="page-sub">${esc(head[1])}</p></div>
      <div class="callout official"><strong>Official shelters:</strong> Red Cross <strong>1-800-733-2767</strong> · Dial <strong>2-1-1</strong>${state.phase === "after" ? " · FEMA housing: <strong>DisasterAssistance.gov</strong>" : ""}
        · <a href="https://www.redcross.org/get-help/disaster-relief-and-recovery-services/find-an-open-shelter.html" target="_blank" rel="noopener">Find open shelters</a></div>
      <div class="seg" role="group"><button data-view="find" aria-pressed="${view === "find"}">Find a host</button>
        <button data-view="offer" aria-pressed="${view === "offer"}">Offer a place</button>
        <button data-view="mine" aria-pressed="${view === "mine"}">My matches${pendingIn ? ` (${pendingIn})` : ""}</button></div>
      <div id="shelter-view"></div>
      <div class="card"><details class="why"><summary>Stay safe</summary><ul class="tight small">
        <li><strong>Hosts are not vetted.</strong> Official shelters are.</li><li>Meet first in a public place.</li>
        <li>Tell someone where you're going.</li><li>Exact addresses are shared only after a host accepts.</li></ul></details></div>`;
    $$(".seg button", el).forEach((b) => b.addEventListener("click", () => { state.shelterView = b.dataset.view; renderShelter(); }));
    ({ find: shelterFind, offer: shelterOffer, mine: shelterMine })[view]($("#shelter-view"));
  }
  function shelterFind(box) {
    const f = store.get("findPrefs", { people: 1, pets: false, accessible: false });
    box.innerHTML = `<div class="card"><h2>Find a host</h2>${placeLine()}
      <form class="form" id="find-form"><div class="row">
        <label class="field">People<input name="people" type="number" min="1" max="50" value="${f.people}"></label>
        <label class="check"><input type="checkbox" name="pets" ${f.pets ? "checked" : ""}> Pets</label>
        <label class="check"><input type="checkbox" name="accessible" ${f.accessible ? "checked" : ""}> Wheelchair access</label></div>
        <div><button class="btn" type="submit" ${state.point ? "" : "disabled"}>Search nearby</button></div></form></div>
      <div id="find-results"></div>`;
    bindGo(box);
    const form = $("#find-form");
    const run = async () => {
      const prefs = { people: Math.max(1, +form.people.value || 1), pets: form.pets.checked, accessible: form.accessible.checked };
      store.set("findPrefs", prefs);
      const res = $("#find-results");
      res.innerHTML = `<div class="card"><p class="empty">Searching...</p></div>`;
      try {
        const { offers } = await api(`/api/shelter/offers?lat=${state.point.lat}&lon=${state.point.lon}&people=${prefs.people}&pets=${prefs.pets ? 1 : 0}&accessible=${prefs.accessible ? 1 : 0}`);
        res.innerHTML = `<div class="card"><h2>${offers.length} ${offers.length === 1 ? "host" : "hosts"} within 80 km</h2>${offers.length ? `<div class="list">${offers.map((o) => `
          <div class="item" style="display:block"><div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><div><div class="t">${esc(o.area)}</div>
            <div class="d">${o.km} km · ${o.spots_left} of ${o.spots} spots free${o.available_from ? ` · from ${esc(o.available_from)}` : ""}${o.available_to ? ` to ${esc(o.available_to)}` : ""}</div>
            <div class="tags">${o.pets ? `<span class="tag">Pets ok</span>` : ""}${o.accessible ? `<span class="tag">Wheelchair</span>` : ""}</div>
            ${o.note ? `<div class="small" style="margin-top:4px">${esc(o.note)}</div>` : ""}</div>
            <button class="btn small" data-ask="${esc(o.id)}">Ask to stay</button></div>
            <form class="form ask-form" data-offer="${esc(o.id)}" hidden style="margin-top:10px"><div class="row">
              <label class="field">Your name<input name="name" required maxlength="60"></label>
              <label class="field">Phone or email<input name="contact" required maxlength="120"></label></div>
              <label class="field">Needs (optional)<input name="needs" maxlength="200" placeholder="e.g. medicine fridge, crib"></label>
              <div><button class="btn small" type="submit">Send request</button> <span class="form-msg"></span></div></form></div>`).join("")}</div>`
          : `<p class="empty">No hosts match yet. Try fewer filters, or call 2-1-1.</p>`}</div>`;
        $$("[data-ask]", res).forEach((b) => b.addEventListener("click", () => { res.querySelector(`.ask-form[data-offer="${b.dataset.ask}"]`).hidden = false; b.hidden = true; }));
        $$(".ask-form", res).forEach((af) => af.addEventListener("submit", async (e) => {
          e.preventDefault();
          const msg = af.querySelector(".form-msg");
          try {
            const r = await api("/api/shelter/request", { offer_id: af.dataset.offer, people: prefs.people, pets: prefs.pets,
              needs: af.needs.value, name: af.name.value, contact: af.contact.value });
            state.keys.requests.push({ id: r.id, token: r.token }); store.set("shelterKeys", state.keys);
            af.innerHTML = `<p class="form-msg ok">Request sent. Check <button class="link-btn" type="button" data-view-mine>My matches</button>.</p>`;
            af.querySelector("[data-view-mine]").addEventListener("click", () => { state.shelterView = "mine"; renderShelter(); });
            refreshMine();
          } catch (err) { msg.className = "form-msg err"; msg.textContent = err.message; }
        }));
      } catch (err) { res.innerHTML = `<div class="card"><p class="form-msg err">${esc(err.message)}</p></div>`; }
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
    if (state.point) run();
  }
  function shelterOffer(box) {
    box.innerHTML = `<div class="card"><h2>Offer a place</h2>
      <form class="form" id="offer-form">${placeLine()}
        <p class="small muted" style="margin:0">Others see only an area about 1 km wide. Your contact is shared when you accept someone.</p>
        <div class="row"><label class="field">Area name<input name="area" required maxlength="80" placeholder="e.g. Katy, near I-10"></label>
          <label class="field">Spots<input name="spots" type="number" min="1" max="50" value="2" required></label></div>
        <div class="row"><label class="check"><input type="checkbox" name="pets"> Pets ok</label><label class="check"><input type="checkbox" name="accessible"> Wheelchair accessible</label></div>
        <div class="row"><label class="field">Available from<input name="available_from" type="date"></label><label class="field">Until<input name="available_to" type="date"></label></div>
        <div class="row"><label class="field">Your name<input name="name" required maxlength="60"></label><label class="field">Phone or email<input name="contact" required maxlength="120"></label></div>
        <label class="field">Note (optional)<input name="note" maxlength="300" placeholder="e.g. spare room, sofa, no stairs"></label>
        <div><button class="btn" type="submit" ${state.point ? "" : "disabled"}>Post offer</button> <span class="form-msg" id="offer-msg"></span></div></form></div>`;
    bindGo(box);
    $("#offer-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, msg = $("#offer-msg");
      try {
        const r = await api("/api/shelter/offer", { lat: state.point.lat, lon: state.point.lon, area: f.area.value, spots: f.spots.value,
          pets: f.pets.checked, accessible: f.accessible.checked, available_from: f.available_from.value, available_to: f.available_to.value,
          name: f.name.value, contact: f.contact.value, note: f.note.value });
        state.keys.offers.push({ id: r.id, token: r.token }); store.set("shelterKeys", state.keys);
        toast("Offer posted. Thank you!");
        state.shelterView = "mine";
        await refreshMine(); renderShelter(); loadHosts();
      } catch (err) { msg.className = "form-msg err"; msg.textContent = err.message; }
    });
  }
  function shelterMine(box) {
    const { offers, requests } = state.mine;
    if (!offers.length && !requests.length) { box.innerHTML = `<div class="card"><p class="empty">No offers or requests yet.</p></div>`; return; }
    let html = "";
    if (requests.length) html += `<div class="card"><h2>Your requests</h2><div class="list">${requests.map((r) => `
      <div class="item" style="display:block"><div style="display:flex;justify-content:space-between"><span class="t">${esc(r.area)}</span><span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
      <div class="d">${r.people} ${r.people === 1 ? "person" : "people"} · sent ${esc(ago(r.created))}</div>
      ${r.status === "accepted" ? `<div class="contact">Host: ${esc(r.host_name)} · ${esc(r.host_contact)}<br><span class="small">Call or text to arrange.</span></div>` : ""}</div>`).join("")}</div></div>`;
    for (const o of offers) html += `<div class="card"><h2>Your offer: ${esc(o.area)}</h2>
      <div class="d">${o.spots_left} of ${o.spots} spots free · ${o.active ? "<strong>listed</strong>" : "closed"}</div>
      ${o.requests.length ? `<div class="list">${o.requests.map((r) => `<div class="item" style="display:block">
        <div style="display:flex;justify-content:space-between"><span class="t">${esc(r.name)} · ${r.people} ${r.people === 1 ? "person" : "people"}</span><span class="status ${esc(r.status)}">${esc(r.status)}</span></div>
        <div class="tags">${r.pets ? `<span class="tag">Pets</span>` : ""}${r.needs ? `<span class="tag">${esc(r.needs)}</span>` : ""}</div>
        ${r.status === "pending" ? `<div style="margin-top:8px;display:flex;gap:8px"><button class="btn small" data-respond="accept" data-offer="${esc(o.id)}" data-req="${esc(r.id)}">Accept</button>
          <button class="btn small ghost" data-respond="decline" data-offer="${esc(o.id)}" data-req="${esc(r.id)}">Decline</button></div>` : ""}
        ${r.contact ? `<div class="contact">Contact: ${esc(r.contact)}</div>` : ""}</div>`).join("")}</div>` : `<p class="empty">No requests yet.</p>`}
      ${o.active ? `<div style="margin-top:10px"><button class="btn small danger" data-close="${esc(o.id)}">Close offer</button></div>` : ""}</div>`;
    box.innerHTML = html;
    $$("[data-respond]", box).forEach((b) => b.addEventListener("click", async () => {
      const key = state.keys.offers.find((k) => k.id === b.dataset.offer);
      try { await api("/api/shelter/respond", { offer_id: key.id, token: key.token, request_id: b.dataset.req, decision: b.dataset.respond });
        toast(b.dataset.respond === "accept" ? "Accepted. Contacts shared." : "Declined"); await refreshMine(); renderShelter(); }
      catch (err) { toast(err.message); }
    }));
    $$("[data-close]", box).forEach((b) => b.addEventListener("click", async () => {
      const key = state.keys.offers.find((k) => k.id === b.dataset.close);
      await api("/api/shelter/close", key).catch(() => {}); toast("Offer closed"); await refreshMine(); renderShelter(); loadHosts();
    }));
  }

  // ---------- GUIDES ----------
  const GUIDES = {
    before: [
      ["Build a kit", ["Water: 1 gallon per person per day, 3 days", "Medicines for 7 days", "IDs + insurance in a waterproof bag", "Chargers, battery pack, flashlight", "Cash and a first-aid kit"]],
      ["Make a plan", ["Pick where you'd go (Shelter tab)", "Agree on one contact person", "Plan for pets", "Plan for medical devices and mobility"]],
      ["Protect your home", ["Photograph every room (Recovery tab)", "Move valuables up high", "Clear drains and gutters", "Flood insurance takes 30 days to start"]],
      ["Know your risk", ["Check your FEMA zone (Home)", "Turn on alerts (Alerts tab)", "Learn your nearest high ground"]],
    ],
    during: [
      ["Evacuate", ["Leave when officials say so", "Take kit, medicines, pets", "Turn off power at the main, if dry and safe", "Tell your contact where you're going"]],
      ["Water and roads", ["<strong>Turn around, don't drown</strong>", "6 in of moving water knocks you down", "1 ft can float a car", "Avoid underpasses and low crossings"]],
      ["Power and gas", ["Stay 35 ft from downed lines", "Smell gas? Leave on foot. No switches or phones inside", "Then call CenterPoint 1-888-876-5786 and 911", "Generators outside only (carbon monoxide)"]],
      ["Stay informed", ["Official alerts: Home tab", "Local radio or TV", "Charge your phone; save battery"]],
    ],
    after: [
      ["Return safely", ["Wait for the official all-clear", "Check the river is falling (Home)", "Watch for snakes, debris, weak floors", "Wet wiring? Electrician before power on"]],
      ["Clean up", ["Gloves, boots, mask", "Dry out within 24–48 h to stop mold", "Throw out food that touched flood water", "Boil water until your utility says it's safe"]],
      ["Claims and aid", ["Photograph damage before cleaning (Recovery)", "List damaged items with prices", "Call your insurer", "FEMA: DisasterAssistance.gov · 1-800-621-3362"]],
      ["Get help", ["Dial 2-1-1 for local services", "Red Cross 1-800-733-2767", "Find a place to stay (Shelter tab)"]],
    ],
  };
  function renderGuides() {
    const p = state.phase || "before";
    $("#tab-guides").innerHTML = `<div><div class="page-title">Guides</div><p class="page-sub">${{ before: "Before a flood", during: "During a flood", after: "After a flood" }[p]}</p></div>
      ${GUIDES[p].map(([t, items], i) => `<details class="guide" ${i === 0 ? "open" : ""}><summary>${esc(t)}</summary><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul></details>`).join("")}`;
  }

  // ---------- RECOVERY ----------
  async function loadEvidence() { try { state.evidence = (await api("/api/evidence")).records; } catch { state.evidence = []; } }
  function renderRecovery() {
    const el = $("#tab-recovery");
    const head = { before: ["Photograph your home now", "\"Before\" photos make claims faster."], during: ["Safety first", "Document damage only when it's safe."],
      after: ["Document damage", "Photos before cleanup. Each one is time-stamped and fingerprinted."] }[state.phase || "before"];
    el.innerHTML = `<div><div class="page-title">${esc(head[0])}</div><p class="page-sub">${esc(head[1])}</p></div>
      <div class="card no-print"><h2>Add a photo ${badge("experimental")}</h2>
        <form class="form" id="ev-form"><label class="field">Photo<input id="ev-file" type="file" accept="image/*" capture="environment" required></label>
          <label class="field">Note<input id="ev-note" maxlength="300" placeholder="Room, item, water line height"></label>
          <label class="check"><input type="checkbox" id="ev-loc" checked> Attach my place</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="submit" id="ev-submit">Analyze and save</button>
          <button class="btn ghost" type="button" id="ev-print">Print claim packet</button></div></form></div>
      <div class="card"><h2>Your photos (${state.evidence.length})</h2>${state.evidence.length ? state.evidence.map((r) => `<div class="evidence-rec">
        <img src="/evidence/${esc(r.file)}" alt="Evidence photo"><div class="small"><strong>${esc(clock(r.captured_at))}</strong>${r.note ? " · " + esc(r.note) : ""}<br>
        AI: <strong>${r.analysis.classifier.label === "flood" ? "flood" : "no flood"}</strong> (${pct(r.analysis.classifier.flood_probability)})<br>
        ${r.analysis.qwen ? esc(r.analysis.qwen.description) + "<br>" : ""}<span class="mono">SHA-256 ${esc(r.sha256)}</span></div></div>`).join("") : `<p class="empty">No photos yet.</p>`}</div>
      ${state.phase === "after" ? `<div class="card"><h2>Get help</h2><div class="list">
        <div class="item"><span><strong>FEMA aid</strong><div class="d">1-800-621-3362</div></span><a href="https://www.disasterassistance.gov/" target="_blank" rel="noopener">DisasterAssistance.gov</a></div>
        <div class="item"><span><strong>Flood insurance claim</strong><div class="d">NFIP</div></span><a href="https://www.floodsmart.gov/" target="_blank" rel="noopener">FloodSmart.gov</a></div>
        <div class="item"><span><strong>Disaster declarations</strong></span><a href="https://www.fema.gov/disaster/declarations" target="_blank" rel="noopener">FEMA.gov</a></div></div></div>` : ""}`;
    const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
    $("#ev-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = $("#ev-file").files[0];
      if (!file) return;
      const btn = $("#ev-submit"); btn.disabled = true; btn.textContent = "Analyzing...";
      try {
        const body = { image: await readFile(file), note: $("#ev-note").value, use_qwen: true };
        if ($("#ev-loc").checked && state.point) Object.assign(body, { lat: state.point.lat, lon: state.point.lon });
        await api("/api/evidence", body);
        await loadEvidence(); renderRecovery(); toast("Photo saved");
      } catch (err) { toast("Could not save: " + err.message); btn.disabled = false; btn.textContent = "Analyze and save"; }
    });
    $("#ev-print").addEventListener("click", () => window.print());
  }

  // ---------- MAP tab ----------
  function renderMapTab() { $("#map-place").innerHTML = `Your place: <strong>${esc(placeName())}</strong> · tap the map to change it`; }

  // ---------- MANAGER ----------
  async function renderManager() {
    const el = $("#tab-manager");
    el.innerHTML = `<div><div class="page-title">Where to help first</div><p class="page-sub">Areas ranked by flooding, vulnerability and hospital access.</p></div><div class="card"><p class="empty">Loading...</p></div>`;
    try {
      const p = await api("/api/priorities");
      el.innerHTML = `<div><div class="page-title">Where to help first</div><p class="page-sub">Areas ranked by flooding, vulnerability and hospital access.</p></div>
        <div class="card"><div class="table-wrap"><table><thead><tr><th>#</th><th>Area</th><th>Score</th><th>Flooded</th><th>Vulnerability</th><th>Hospitals ≤10 km</th></tr></thead><tbody>
        ${p.areas.map((a, i) => `<tr><td>${i + 1}</td><td><strong>${esc(a.locality)}</strong><div class="small muted">${esc(a.county)}</div></td><td><strong>${a.score}</strong></td>
          <td>${Math.round(a.flood_share * 100)}%</td><td>${a.vulnerability.toFixed(2)}</td><td>${a.in_essentials_area ? a.hospitals_10km : "–"}</td></tr>`).join("")}</tbody></table></div>
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn small" id="mgr-map">Show top 5 on map</button></div>
        <details class="why" style="margin-top:10px"><summary>How the score works</summary><p class="small">${esc(p.formula)}</p><p class="small muted">${esc(p.note)}</p></details></div>`;
      $("#mgr-map").addEventListener("click", () => {
        layers.manager.clearLayers();
        p.areas.slice(0, 5).forEach((a, i) => L.marker([a.lat, a.lon]).bindTooltip(`#${i + 1} ${a.locality}`, { permanent: true, direction: "right" }).addTo(layers.manager));
        setTab("map");
        setTimeout(() => map.fitBounds(L.latLngBounds(p.areas.slice(0, 5).map((a) => [a.lat, a.lon])).pad(0.3)), 80);
      });
    } catch (e) { el.innerHTML += `<p class="form-msg err">${esc(e.message)}</p>`; }
  }

  // ---------- ABOUT ----------
  async function renderAbout() {
    const el = $("#tab-about");
    try {
      const m = state.meta || (state.meta = await api("/api/meta"));
      const r = m.metrics.risk_model, im = m.metrics.image_model;
      const row = (k, s) => `<tr><td>${esc(k)}</td><td>${s.pr_auc ?? "–"}</td><td>${s.recall}</td><td>${s.precision}</td><td>${s.false_positive_rate}</td></tr>`;
      el.innerHTML = `<div><div class="page-title">About Float</div><p class="page-sub">Flood safety for Houston, built on the Dell Pro Max GB10.</p></div>
        <div class="card"><h2>Labels on every number</h2><div class="list">
          <div class="item"><span>${badge("official")} Government warnings (NWS)</span></div>
          <div class="item"><span>${badge("verified")} Live measurements (USGS gauges)</span></div>
          <div class="item"><span>${badge("forecast")} Weather models (Open-Meteo)</span></div>
          <div class="item"><span>${badge("experimental")} Float's AI predictions</span></div>
          <div class="item"><span>${badge("reference")} Maps and places (FEMA, OpenStreetMap)</span></div></div></div>
        <div class="card"><h2>Flood-risk model ${badge("experimental")}</h2>
          <p class="small">Trained on <strong>${r.training_rows}</strong> labeled flood photos + a heavy-rain rule. Float shows the higher.</p>
          <div class="table-wrap"><table><thead><tr><th>Test</th><th>PR-AUC</th><th>Recall</th><th>Precision</th><th>False alarms</th></tr></thead><tbody>
          ${row("New areas", r.area_holdout.model)}${row("New storm (Hill Country 2025)", r.storm_holdout.model)}${row("100 hand-labeled photos", r.human_labeled_test.model)}</tbody></table></div>
          <p class="small muted">Weak on floods from upstream rain. Experimental only.</p></div>
        <div class="card"><h2>Image model ${badge("experimental")}</h2><p><strong>${pct(im.hand_labeled_test.accuracy)}</strong> correct on 100 hand-labeled photos · floods caught ${esc(im.hand_labeled_test.floods_caught)} · false alarms ${esc(im.hand_labeled_test.false_alarms)}</p></div>
        <div class="card"><h2>Built with</h2><ul class="tight small">
          <li><strong>${m.sites}</strong> Texas flood photos: 100 labeled by hand, the rest by Qwen3-VL on the GB10</li>
          <li>GB10 vision: <strong>${m.gb10.enabled ? "connected" : "off"}</strong></li>
          <li>Map data © OpenStreetMap contributors</li></ul></div>`;
    } catch (e) { el.innerHTML = `<div class="card"><p class="form-msg err">Could not load: ${esc(e.message)}</p></div>`; }
  }

  // ---------- photo dialog ----------
  async function openSite(id) {
    const s = state.sites.find((x) => x.image_id === id);
    $("#dlg-title").textContent = s ? `${s.locality} · ${s.date}` : id;
    $("#dlg-body").innerHTML = `<img src="/static/thumbs/${esc(id)}.jpg" alt="Aerial photo">
      ${s ? `<p><strong>${s.label === "flood" ? "Flooded" : s.label === "not_flood" ? "Dry" : "Unsure"}</strong> · labeled by ${s.labeled_by === "human" ? "a person" : "Qwen on the GB10"}</p>` : ""}
      <div id="dlg-analysis"><p class="empty">Asking the AI models...</p></div>`;
    if (!$("#site-dialog").open) $("#site-dialog").showModal();
    try {
      const r = await api(`/api/site/${encodeURIComponent(id)}`);
      const c = r.classifier;
      $("#dlg-analysis").innerHTML = `<h3>${badge("experimental")} Float image model</h3><p><strong class="${c.label === "flood" ? "lv-HIGH" : "lv-LOW"}">${c.label === "flood" ? "FLOOD" : "NO FLOOD"}</strong> · ${pct(c.flood_probability)}</p>
        ${r.qwen ? `<h3>${badge("experimental")} Qwen on the GB10</h3><p>${esc(r.qwen.description)}</p>` : r.qwen_error ? `<p class="small muted">GB10 vision off.</p>` : ""}`;
    } catch (e) { $("#dlg-analysis").innerHTML = `<p class="form-msg err">${esc(e.message)}</p>`; }
  }
  $("#dlg-close").addEventListener("click", () => $("#site-dialog").close());

  // ---------- search ----------
  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#search-input").value.trim(), box = $("#search-results");
    if (!q) return;
    box.hidden = false; box.innerHTML = `<button disabled>Searching...</button>`;
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r, i) => `<button data-i="${i}">${esc(r.name)}</button>`).join("") : `<button disabled>No match. Try street + city, or use the Map tab.</button>`;
      $$("[data-i]", box).forEach((b) => b.addEventListener("click", () => {
        const r = results[+b.dataset.i];
        box.hidden = true; $("#search-input").value = "";
        map.setView([r.lat, r.lon], 13);
        choosePoint(r.lat, r.lon, r.name.split(",").slice(0, 2).join(","));
      }));
    } catch (err) { box.innerHTML = `<button disabled>Search unavailable. Use the Map tab.</button>`; }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#search-form")) $("#search-results").hidden = true; });

  // ---------- accessibility ----------
  for (const [id, cls] of [["#btn-large", "large-text"], ["#btn-contrast", "high-contrast"]]) {
    const on = store.get(cls, false);
    document.body.classList.toggle(cls, on); $(id).setAttribute("aria-pressed", String(on));
    $(id).addEventListener("click", () => { const v = !document.body.classList.contains(cls);
      document.body.classList.toggle(cls, v); $(id).setAttribute("aria-pressed", String(v)); store.set(cls, v); });
  }

  // ---------- start ----------
  async function start() {
    const [fromHash, phaseHash] = location.hash.slice(1).split("/");
    if (PHASES.includes(phaseHash)) { state.phase = phaseHash; store.set("phase", phaseHash); store.set("phaseManual", true); }
    updatePhaseUI();
    setTab(TABS.includes(fromHash) ? fromHash : "home");
    api("/api/meta").then((m) => {
      state.meta = m;
      const p = $("#gb10-pill"); p.className = "pill " + (m.gb10.enabled ? "ok" : "bad");
      p.textContent = m.gb10.enabled ? "GB10 on" : "GB10 off"; p.title = m.gb10.reason || m.gb10.model;
    }).catch(() => setOnline(false, store.get("last")));
    loadEvidence();
    const last = store.get("last");
    choosePoint(last ? last.lat : 29.7752, last ? last.lon : -95.6303, last ? last.label : "Addicks / Barker, west Houston");
    await Promise.allSettled([loadSites(), loadEssentials(), loadGauges(), refreshInbox(), refreshMine()]);
    setInterval(loadGauges, 5 * 60 * 1000);
    setInterval(refreshInbox, 5 * 60 * 1000);
    setInterval(refreshMine, 2 * 60 * 1000);
  }
  start();
})();
