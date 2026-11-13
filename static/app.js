/* Flood IQ front end. Plain JavaScript + Leaflet. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("floodiq:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("floodiq:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const state = { mode: "during", point: null, data: null, horizon: 3, sites: [], gauges: [] };

  // ---------- helpers ----------
  function ago(iso) {
    if (!iso) return "time unknown";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h} h ago` : new Date(iso).toLocaleDateString();
  }
  const clock = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const badge = (t) => `<span class="badge ${esc(t)}">${esc({ official: "Official", verified: "Verified live", forecast: "Forecast", experimental: "Experimental AI", reference: "Reference", historical: "Historical" }[t] || t)}</span>`;
  function prov(p) {
    if (!p) return "";
    const obs = p.observed_at ? ` · data from ${esc(clock(p.observed_at))}` : "";
    return `<div class="prov">${badge(p.status_type)} ${esc(p.source)} · retrieved ${esc(ago(p.retrieved_at))}${obs}</div>`;
  }
  async function api(url, opts) {
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }
  const levelClass = (lv) => "lv-" + lv.replace(" ", "");

  // ---------- map ----------
  const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([29.78, -95.45], 10);
  const base = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const fema = L.tileLayer.wms("https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer", {
    layers: "28", format: "image/png", transparent: true, opacity: 0.5, attribution: "FEMA NFHL",
  });
  const layers = {
    evidence: L.layerGroup().addTo(map), gauges: L.layerGroup().addTo(map), hospital: L.layerGroup().addTo(map),
    grocery: L.layerGroup(), fuel: L.layerGroup(), shelter: L.layerGroup(),
  };
  L.control.layers({ "OpenStreetMap": base }, {
    "Harvey flood evidence (labeled images)": layers.evidence,
    "USGS river gauges (live)": layers.gauges,
    "FEMA flood hazard zones": fema,
    "Hospitals": layers.hospital, "Grocery stores": layers.grocery,
    "Fuel stations": layers.fuel, "Shelters (OSM)": layers.shelter,
  }, { collapsed: true }).addTo(map);
  let pin = null;
  map.on("click", (e) => choosePoint(e.latlng.lat, e.latlng.lng, null));

  const COLORS = { flood: "#d84315", not_flood: "#2e7d32", uncertain: "#b07d00" };
  const PLACE = { hospital: ["#00838f", "Hospital"], grocery: ["#0b5cad", "Grocery"], fuel: ["#6b4fbb", "Fuel"], shelter: ["#0b6e4f", "Shelter"] };

  async function loadSites() {
    const { sites } = await api("/api/sites");
    state.sites = sites;
    for (const s of sites) {
      L.circleMarker([s.lat, s.lon], { radius: 5, color: "#fff", weight: 1, fillColor: COLORS[s.label], fillOpacity: 0.9 })
        .bindPopup(() => `<img src="/static/thumbs/${esc(s.image_id)}.jpg" alt="">
          <strong>${esc(s.label.replace("_", " ").toUpperCase())}</strong> · ${esc(s.date)}<br>${esc(s.locality)}<br>
          <span class="muted">labeled by ${esc(s.labeled_by === "human" ? "a person" : "Qwen on the GB10")}</span><br>
          <button class="btn small" data-site="${esc(s.image_id)}">Analyze</button>`)
        .addTo(layers.evidence);
    }
  }
  async function loadEssentials() {
    const ess = await api("/api/essentials");
    for (const p of ess.places) {
      const [color, name] = PLACE[p.type];
      L.circleMarker([p.lat, p.lon], { radius: p.type === "hospital" ? 6 : 4, color, weight: 1, fillColor: color, fillOpacity: 0.7 })
        .bindPopup(`<strong>${esc(p.name)}</strong><br>${esc(name)}${p.address ? " · " + esc(p.address) : ""}<br>
          <span class="muted">${p.type === "hospital" ? "Operational status: no authorized live feed." : "Open status and stock: unknown."}<br>Location from OpenStreetMap.</span>`)
        .addTo(layers[p.type]);
    }
  }
  async function loadGauges() {
    layers.gauges.clearLayers();
    try {
      const g = await api("/api/gauges");
      if (!g.ok) throw new Error(g.error);
      state.gauges = g.gauges;
      for (const x of g.gauges) {
        const arrow = { rising: "▲", falling: "▼", steady: "■" }[x.trend];
        const color = { rising: "#d84315", falling: "#2e7d32", steady: "#5b6875" }[x.trend];
        L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "", html: `<div title="${esc(x.name)}" style="color:${color};font-size:15px;text-shadow:0 0 2px #fff,0 0 2px #fff">${arrow}</div>`, iconSize: [16, 16] }) })
          .bindPopup(`<strong>${esc(x.name)}</strong><br>Stage ${x.stage_ft.toFixed(2)} ft, ${esc(x.trend)} (${x.change_ft_per_hr >= 0 ? "+" : ""}${x.change_ft_per_hr} ft/h)<br>
            <span class="muted">USGS ${esc(x.site)} · reading ${esc(ago(x.observed_at))}<br>Gauge stage is the water level at the gauge, not street depth.</span>`)
          .addTo(layers.gauges);
      }
    } catch (e) { console.warn("gauges", e); }
  }
  map.on("popupopen", (e) => {
    const btn = e.popup.getElement().querySelector("[data-site]");
    if (btn) btn.addEventListener("click", () => openSite(btn.dataset.site));
  });

  // ---------- choose a location ----------
  async function choosePoint(lat, lon, label) {
    state.point = { lat, lon, label };
    if (pin) pin.remove();
    pin = L.marker([lat, lon]).addTo(map);
    $("#where").textContent = label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    $("#where-sub").textContent = "Loading live data...";
    try {
      const data = await api(`/api/point?lat=${lat}&lon=${lon}`);
      data.fetched_at = new Date().toISOString();
      data.label = label;
      store.set("last", data);
      setOnline(true);
      render(data);
    } catch (e) {
      const last = store.get("last");
      setOnline(false, last);
      if (last) render(last); else $("#where-sub").textContent = "Could not load data: " + e.message;
    }
  }

  function setOnline(ok, last) {
    const pill = $("#net-pill");
    pill.className = "pill " + (ok ? "ok" : "bad");
    pill.textContent = ok ? "Online" : "Offline";
    const banner = $("#offline-banner");
    banner.hidden = ok;
    if (!ok) banner.textContent = last ? `OFFLINE. Showing last verified update from ${clock(last.fetched_at)} for ${last.label || "the last place you checked"}. Conditions may have changed.` : "OFFLINE. No saved data yet.";
  }

  function render(d) {
    state.data = d;
    $("#where").textContent = d.label || `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`;
    $("#where-sub").textContent = `Updated ${clock(d.fetched_at)}`;
    renderAlerts(d.alerts);
    renderRisk(d.risk, d.rain);
    renderConditions(d);
    renderEssentials(d.essentials);
    renderEvidence(d.evidence);
    renderReturn(d);
  }

  function renderAlerts(a) {
    const el = $("#alerts");
    if (!a.ok) { el.innerHTML = `<div class="no-alert">Could not reach the National Weather Service (${esc(a.error)}). Check weather.gov or local radio.</div>${prov(a.provenance)}`; return; }
    if (!a.alerts.length) { el.innerHTML = `<div class="no-alert">No active NWS watches, warnings or advisories for this point.</div>${prov(a.provenance)}`; return; }
    el.innerHTML = a.alerts.map((x) => `<div class="alert"><strong>${esc(x.event.toUpperCase())}</strong>${x.expires ? ` until ${esc(clock(x.expires))}` : ""}
      <div class="small">${esc(x.headline || "")}</div>
      <details><summary class="small">Details and instructions</summary><p class="small">${esc(x.description)}</p>${x.instruction ? `<p class="small"><strong>${esc(x.instruction)}</strong></p>` : ""}</details></div>`).join("") + prov(a.provenance);
  }

  function renderRisk(risk, rain) {
    const el = $("#risk");
    if (!risk) { el.innerHTML = `<p class="empty">Rainfall data unavailable (${esc(rain && rain.error)}), so no prediction.</p>`; return; }
    const cells = risk.timeline.map((t) => {
      const pct = Math.round(t.probability * 100);
      return `<button class="tl ${levelClass(t.level)}" data-h="${t.horizon_h}" aria-pressed="${t.horizon_h === state.horizon}">
        <div class="h">${t.horizon_h ? "+" + t.horizon_h + " h" : "NOW"}</div><div class="p">${pct}%</div>
        <div class="lv">${esc(t.level)}</div><div class="bar"><span style="width:${pct}%"></span></div></button>`;
    }).join("");
    const sel = risk.timeline.find((t) => t.horizon_h === state.horizon) || risk.timeline[0];
    el.innerHTML = `<div class="timeline" role="group" aria-label="Risk by time">${cells}</div>
      <p style="margin:10px 0 0"><strong>${sel.horizon_h ? sel.horizon_h + " hours" : "Now"}: <span class="${levelClass(sel.level)}">${esc(sel.level)}</span> flood risk, ${Math.round(sel.probability * 100)}% experimental probability.</strong></p>
      <ul class="risk-reasons small">${sel.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <div class="prov">${badge("experimental")} Model ${esc(risk.version)} · inputs: rainfall, elevation, FEMA zone · <a href="#" data-goto="about">how it was trained</a></div>`;
    el.querySelectorAll(".tl").forEach((b) => b.addEventListener("click", () => { state.horizon = +b.dataset.h; renderRisk(risk, rain); }));
    el.querySelector("[data-goto]").addEventListener("click", (e) => { e.preventDefault(); setMode("about"); });
  }

  function rainChart(chart) {
    if (!chart || !chart.length) return "";
    const now = Date.now() / 1000;
    const max = Math.max(2, ...chart.map((c) => c[1]));
    const w = 100 / chart.length;
    const bars = chart.map((c, i) => {
      const h = (c[1] / max) * 66;
      const future = c[0] > now;
      return `<rect x="${i * w}%" y="${70 - h}" width="${w * 0.8}%" height="${h}" fill="${future ? "#6b4fbb" : "#0b5cad"}" opacity="${future ? 0.55 : 0.9}"></rect>`;
    }).join("");
    const nowIdx = chart.findIndex((c) => c[0] > now);
    const nowX = (nowIdx < 0 ? chart.length : nowIdx) * w;
    return `<svg class="rain" role="img" aria-label="Hourly rainfall, past 48 hours and next 24 hours">${bars}
      <line x1="${nowX}%" x2="${nowX}%" y1="0" y2="72" stroke="currentColor" stroke-dasharray="3 2"></line>
      <text x="${nowX}%" y="80" font-size="9" text-anchor="middle" fill="currentColor">now</text>
      <text x="0" y="9" font-size="9" fill="currentColor">max ${max.toFixed(1)} mm/h</text></svg>
      <div class="small muted">Past 48 h (solid) and next 24 h forecast (faded).</div>`;
  }

  function nearestGauges(lat, lon, n = 3) {
    const r = Math.PI / 180;
    const dist = (g) => 6371 * Math.acos(Math.min(1, Math.sin(lat * r) * Math.sin(g.lat * r) + Math.cos(lat * r) * Math.cos(g.lat * r) * Math.cos((g.lon - lon) * r)));
    return state.gauges.map((g) => ({ ...g, km: dist(g) })).sort((a, b) => a.km - b.km).slice(0, n);
  }

  function renderConditions(d) {
    const r = d.rain, f = d.fema;
    let html = "";
    if (r.ok) {
      const s = r.summary;
      html += `<div class="stats">
        <div class="stat"><div class="v">${s.past_1h_mm} mm</div><div class="k">this hour</div></div>
        <div class="stat"><div class="v">${s.past_24h_mm} mm</div><div class="k">past 24 h</div></div>
        <div class="stat"><div class="v">${s.next_6h_mm} mm</div><div class="k">next 6 h</div></div>
        <div class="stat"><div class="v">${s.next_24h_mm} mm</div><div class="k">next 24 h</div></div></div>
        ${rainChart(r.chart)}${prov(r.provenance)}`;
    } else html += `<p class="empty">Rainfall unavailable: ${esc(r.error)}</p>`;
    const g = nearestGauges(d.lat, d.lon);
    html += `<h3>Nearest river gauges ${badge("verified")}</h3>`;
    html += g.length ? g.map((x) => `<div class="gauge-row"><span>${esc(x.name)}<br><span class="muted small">${x.km.toFixed(1)} km away · reading ${esc(ago(x.observed_at))}</span></span>
        <span class="trend-${x.trend}">${x.stage_ft.toFixed(1)} ft ${{ rising: "▲ rising", falling: "▼ falling", steady: "■ steady" }[x.trend]}</span></div>`).join("")
      + `<div class="prov">USGS gauge height. A gauge reading is not street-level water depth.</div>`
      : `<p class="empty">No live USGS gauge data loaded.</p>`;
    html += `<h3>FEMA flood zone ${badge("reference")}</h3>`;
    if (!f.ok) html += `<p class="empty">FEMA map service unavailable.</p>`;
    else if (!f.mapped) html += `<p>No FEMA flood hazard area mapped at this point.</p>`;
    else html += `<p><strong>Zone ${esc(f.zone)}</strong> ${f.sfha ? "· inside the Special Flood Hazard Area (1% annual chance)" : "· outside the Special Flood Hazard Area"}${f.subtype ? `<br><span class="small muted">${esc(f.subtype)}</span>` : ""}</p>`;
    if (f.ok) html += prov(f.provenance).replace("</div>", " · regulatory map, not current flooding</div>");
    $("#conditions").innerHTML = html;
  }

  function renderEssentials(e) {
    const groups = [["hospital", "Hospitals", "Location verified. Operational status: no authorized live feed."],
      ["grocery", "Grocery stores", "Open status and stock: unknown."],
      ["fuel", "Fuel stations", "Open status and fuel availability: unknown."]];
    let html = "";
    for (const [type, title, note] of groups) {
      const list = e.places[type] || [];
      html += `<h3>${title}</h3>`;
      html += list.length ? `<ul class="places">${list.map((p) => `<li><span>${esc(p.name)}${p.address ? `<br><span class="muted small">${esc(p.address)}</span>` : ""}</span><span class="unknown">${p.km} km</span></li>`).join("")}</ul><div class="small muted">${note}</div>`
        : `<p class="empty">None within 10 km in the snapshot.</p>`;
    }
    html += `<div class="prov">${badge("reference")} ${esc(e.provenance.source)} · snapshot ${esc(clock(e.provenance.observed_at))}. Locations only.</div>`;
    $("#essentials").innerHTML = html;
  }

  function renderEvidence(ev) {
    const el = $("#evidence");
    if (!ev.count) { el.innerHTML = `<p class="empty">No labeled images within ${ev.radius_km} km. The image set covers parts of west Houston, Kingwood, the Brazos River and the Texas Hill Country.</p>`; return; }
    el.innerHTML = `<p><strong>${ev.flooded} of ${ev.count}</strong> labeled aerial images within ${ev.radius_km} km show flooding.</p>
      <div class="thumbs">${ev.sites.map((s) => `<button class="${esc(s.label)}" data-site="${esc(s.image_id)}" title="${esc(s.image_id)}">
        <img src="/static/thumbs/${esc(s.image_id)}.jpg" alt="${esc(s.label)} ${esc(s.date)}" loading="lazy"><span>${esc(s.label === "flood" ? "FLOOD" : s.label === "not_flood" ? "DRY" : "?")} ${esc(s.date.slice(0, 4))}</span></button>`).join("")}</div>
      <div class="prov">${badge("historical")} UTSA Texas flood imagery · 100 labeled by hand, the rest by Qwen3-VL on the GB10</div>`;
    el.querySelectorAll("[data-site]").forEach((b) => b.addEventListener("click", () => openSite(b.dataset.site)));
  }

  function renderReturn(d) {
    const alerts = d.alerts.ok ? (d.alerts.alerts.length ? `<span class="lv-HIGH">${d.alerts.alerts.length} active NWS alert(s): wait for officials.</span>` : "No active NWS alerts.") : "NWS unavailable: check local officials.";
    const g = nearestGauges(d.lat, d.lon, 1)[0];
    const gauge = g ? `${esc(g.name)} is <span class="trend-${g.trend}">${g.trend}</span> (${esc(ago(g.observed_at))}).` : "No nearby gauge loaded.";
    const now = d.risk ? d.risk.timeline[0] : null;
    $("#return-check").innerHTML = `<ul class="small">
      <li>${badge("official")} ${alerts}</li>
      <li>${badge("verified")} ${gauge}</li>
      ${now ? `<li>${badge("experimental")} Flood IQ risk now: <span class="${levelClass(now.level)}">${esc(now.level)}</span>.</li>` : ""}
      <li>Power: check the <a href="https://tracker.centerpointenergy.com/" target="_blank" rel="noopener">CenterPoint outage tracker</a> before re-entering. Have an electrician inspect anything that was under water.</li>
      <li>Water: follow your local water utility for boil-water notices (EPA data is not real-time).</li>
      <li>Only return when local officials say it is safe.</li></ul>`;
  }

  // ---------- site dialog ----------
  async function openSite(id) {
    const s = state.sites.find((x) => x.image_id === id);
    const dlg = $("#site-dialog");
    $("#dlg-title").textContent = `${id} · ${s ? s.locality : ""}`;
    $("#dlg-body").innerHTML = `<img src="/static/thumbs/${esc(id)}.jpg" alt="Aerial image ${esc(id)}">
      ${s ? `<p><strong>Label: ${esc(s.label.replace("_", " "))}</strong> (${s.labeled_by === "human" ? "labeled by a person" : "labeled by Qwen on the GB10"}) · ${esc(s.date)} · ${esc(s.source_agency)}<br>
      <span class="small muted">${esc(s.qwen_reason)}</span></p>` : ""}
      <div id="dlg-analysis"><p class="empty">Running the Flood IQ image model and asking Qwen on the GB10...</p></div>`;
    if (!dlg.open) dlg.showModal();
    try {
      const r = await api(`/api/site/${encodeURIComponent(id)}`);
      $("#dlg-analysis").innerHTML = analysisHtml(r);
    } catch (e) { $("#dlg-analysis").innerHTML = `<p class="empty">Analysis failed: ${esc(e.message)}</p>`; }
  }
  function analysisHtml(r) {
    const c = r.classifier;
    let h = `<h3>${badge("experimental")} Flood IQ image model</h3><p><strong class="${c.label === "flood" ? "lv-HIGH" : "lv-LOW"}">${c.label === "flood" ? "FLOOD" : "NO FLOOD"}</strong> · flood probability ${Math.round(c.flood_probability * 100)}%<br><span class="small muted">${esc(c.model)}</span></p>`;
    if (r.qwen) h += `<h3>${badge("experimental")} Qwen on the GB10</h3><p><strong>${esc(r.qwen.verdict.replace("_", " ").toUpperCase())}</strong><br>${esc(r.qwen.description)}</p><p class="small muted">${esc(r.qwen.model)}</p>`;
    else if (r.qwen_error) h += `<p class="small muted">GB10 vision model unavailable: ${esc(r.qwen_error)}</p>`;
    return h;
  }
  $("#dlg-close").addEventListener("click", () => $("#site-dialog").close());

  // ---------- recovery evidence ----------
  const readFile = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
  async function loadEvidence() {
    const { records } = await api("/api/evidence");
    $("#evidence-list").innerHTML = records.length ? records.map((r) => `<div class="evidence-rec">
      <img src="/evidence/${esc(r.file)}" alt="Evidence photo">
      <div class="small"><strong>${esc(clock(r.captured_at))}</strong>${r.lat != null ? ` · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : ""}<br>
      ${r.note ? esc(r.note) + "<br>" : ""}
      Image model: <strong>${r.analysis.classifier.label === "flood" ? "flood" : "no flood"}</strong> (${Math.round(r.analysis.classifier.flood_probability * 100)}%)<br>
      ${r.analysis.qwen ? `Qwen: ${esc(r.analysis.qwen.description)}<br>` : ""}
      <span class="mono">SHA-256 ${esc(r.sha256)}</span></div></div>`).join("") : `<p class="empty">No evidence saved yet.</p>`;
  }
  $("#evidence-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#ev-file").files[0];
    if (!file) return;
    const btn = $("#ev-submit");
    btn.disabled = true; btn.textContent = "Analyzing...";
    try {
      const body = { image: await readFile(file), note: $("#ev-note").value, use_qwen: true };
      if ($("#ev-loc").checked && state.point) Object.assign(body, { lat: state.point.lat, lon: state.point.lon });
      await api("/api/evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      e.target.reset();
      await loadEvidence();
    } catch (err) { alert("Could not save: " + err.message); }
    finally { btn.disabled = false; btn.textContent = "Analyze and save"; }
  });
  $("#ev-print").addEventListener("click", () => window.print());

  // ---------- prepare checklist ----------
  const PREP = ["Medications for at least 7 days", "ID, insurance policies and documents in a waterproof bag", "Phone chargers and battery packs charged",
    "Drinking water: 1 gallon per person per day for 3 days", "Evacuation contact and meeting place agreed", "Vehicle fuel tank at least half full",
    "Plan for pets", "Accessible transportation arranged if needed", "Backup power plan for electricity-dependent medical devices",
    "Photos of your home and belongings taken before the storm"];
  function renderPrep() {
    const done = store.get("prep", {});
    $("#prep-list").innerHTML = PREP.map((p, i) => `<label><input type="checkbox" data-i="${i}" ${done[i] ? "checked" : ""}> ${esc(p)}</label>`).join("");
    $("#prep-list").querySelectorAll("input").forEach((c) => c.addEventListener("change", () => { done[c.dataset.i] = c.checked; store.set("prep", done); }));
  }

  // ---------- manager & about ----------
  let mgrLayer = null;
  async function renderManager() {
    const p = await api("/api/priorities");
    $("#mgr-formula").textContent = p.formula;
    $("#mgr-note").textContent = p.note;
    const pct = (v) => v == null ? "–" : v.toFixed(1) + "%";
    $("#mgr-table").innerHTML = `<thead><tr><th>#</th><th>Area</th><th>Score</th><th>Images flooded</th><th>Vulnerability</th><th>Poverty</th><th>No vehicle</th><th>Age 65+</th><th>Disability</th><th>Hospitals ≤10 km</th></tr></thead>
      <tbody>${p.areas.map((a, i) => `<tr><td>${i + 1}</td><td><strong>${esc(a.locality)}</strong><br><span class="small muted">${esc(a.county)} · ${esc(a.event)}</span></td>
      <td class="score">${a.score}</td><td>${Math.round(a.flood_share * 100)}%<br><span class="small muted">${a.images} images</span></td><td>${a.vulnerability.toFixed(2)}</td>
      <td>${pct(a.poverty_pct)}</td><td>${pct(a.no_vehicle_pct)}</td><td>${pct(a.age65_pct)}</td><td>${pct(a.disability_pct)}</td>
      <td>${a.in_essentials_area ? a.hospitals_10km : "outside snapshot"}</td></tr>`).join("")}</tbody>`;
    if (mgrLayer) mgrLayer.remove();
    mgrLayer = L.layerGroup(p.areas.slice(0, 5).map((a, i) => L.marker([a.lat, a.lon], { title: a.locality })
      .bindTooltip(`#${i + 1} ${a.locality}`, { permanent: true, direction: "right" }))).addTo(map);
    setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(p.areas.slice(0, 5).map((a) => [a.lat, a.lon])).pad(0.3)); }, 100);
  }
  async function renderAbout() {
    const m = await api("/api/meta");
    const r = m.metrics.risk_model, im = m.metrics.image_model;
    const row = (k, s) => s ? `<tr><td>${esc(k)}</td><td>${s.pr_auc ?? "–"}</td><td>${s.recall}</td><td>${s.precision}</td><td>${s.false_positive_rate}</td><td>${s.brier}</td></tr>` : "";
    $("#about").innerHTML = `
      <div class="card"><h2>Flood-risk model ${badge("experimental")}</h2>
        <p class="small">Two layers, as in the research brief. <strong>Trained model:</strong> gradient-boosted trees (${esc(m.risk_model)}) trained on ${r.training_rows} labeled Texas sites. Inputs: rainfall over the previous 1, 3 and 7 days, ground elevation, FEMA flood-zone status; more rain can only raise the risk. <strong>Rainfall rule:</strong> a simple, uncalibrated rule on 6-hour, 24-hour and 3-day rain. The training data has almost no storms between "dry" and "Hurricane Harvey", so the trained model can under-rate moderate storms; Flood IQ shows whichever layer is higher. Live rainfall comes from Open-Meteo; the timeline re-runs both on observed + forecast rain.</p>
        <div class="table-wrap"><table><thead><tr><th>Test</th><th>PR-AUC</th><th>Recall</th><th>Precision</th><th>False-alarm rate</th><th>Brier</th></tr></thead><tbody>
        ${row("New areas (leave one locality out)", r.area_holdout.model)}
        ${row("New storm (train Harvey, test Hill Country 2025)", r.storm_holdout.model)}
        ${row("100 hand-labeled images", r.human_labeled_test.model)}
        ${row("Rule baseline on hand labels (3-day rain only)", r.human_labeled_test.rule_baseline)}</tbody></table></div>
        <p class="small muted">Weak on the Hill Country storm: those floods came from rain upstream, and local gauges recorded almost none, so local rainfall alone cannot predict them. Treat every number as experimental.</p></div>
      <div class="card"><h2>Image model ${badge("experimental")}</h2>
        <p class="small">${esc(im.architecture)}, ${im.epochs} epochs, ${im.training_images} labeled aerial images. Tested on 100 images labeled by hand that it never saw in training:</p>
        <p><strong>${Math.round(im.hand_labeled_test.accuracy * 100)}% accuracy</strong> · floods caught ${esc(im.hand_labeled_test.floods_caught)} · false alarms ${esc(im.hand_labeled_test.false_alarms)}</p>
        <p class="small muted">Aerial imagery only; phone photos are outside its training data, so Flood IQ also asks Qwen on the GB10 for a description.</p></div>
      <div class="card"><h2>Labels</h2>
        <p class="small">${m.sites} images (USDA NAIP 2016 baseline, NOAA Harvey 2017 response, Hill Country 2025). The first 100 were labeled by hand; the rest by Qwen3-VL-8B on the GB10, which agreed with the hand labels 94% of the time (no false alarms, 6 of 50 floods missed).</p></div>
      <div class="card"><h2>Live sources</h2><ul class="small">
        <li>${badge("official")} NWS alerts (api.weather.gov)</li>
        <li>${badge("verified")} USGS river gauges, Harris County (updated every 5 min)</li>
        <li>${badge("forecast")} Open-Meteo hourly rainfall and elevation</li>
        <li>${badge("reference")} FEMA National Flood Hazard Layer</li>
        <li>${badge("reference")} OpenStreetMap hospitals, grocery, fuel (snapshot ${esc(clock(m.essentials.osm_snapshot))})</li>
        <li>GB10 vision model: ${m.gb10.enabled ? "connected (" + esc(m.gb10.model) + ")" : "off (" + esc(m.gb10.reason) + ")"}</li></ul></div>`;
  }

  // ---------- modes ----------
  const MODES = ["before", "during", "after", "manager", "about"];
  function setMode(mode) {
    state.mode = mode;
    if (location.hash !== "#" + mode) history.replaceState(null, "", "#" + mode);
    document.querySelectorAll("nav.modes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    const page = mode === "manager" || mode === "about";
    $("#main-view").hidden = mode === "about";
    $("#manager-view").hidden = mode !== "manager";
    $("#about-view").hidden = mode !== "about";
    if (mode === "manager") {
      $("#main-view").hidden = false;
      $("#panel").hidden = true;
      $("#main-view").style.gridTemplateColumns = "1fr";
      $("#map-wrap").style.height = "45vh";
      $("#main-view").style.height = "auto";
      renderManager().catch((e) => { $("#mgr-formula").textContent = "Could not load: " + e.message; });
    } else {
      $("#panel").hidden = false;
      $("#main-view").style.gridTemplateColumns = "";
      $("#map-wrap").style.height = "";
      $("#main-view").style.height = "";
      if (mgrLayer) { mgrLayer.remove(); mgrLayer = null; }
    }
    if (mode === "about") renderAbout().catch((e) => { $("#about").textContent = "Could not load: " + e.message; });
    if (!page) {
      for (const m of ["before", "during", "after"]) document.querySelectorAll(".mode-" + m).forEach((el) => { el.hidden = true; });
      document.querySelectorAll(".mode-" + mode).forEach((el) => { el.hidden = false; });
      if (mode === "after") loadEvidence().catch(() => {});
    }
    setTimeout(() => map.invalidateSize(), 50);
    if (page) window.scrollTo(0, 0);
  }
  document.querySelectorAll("nav.modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // ---------- search ----------
  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#search-input").value.trim();
    const box = $("#search-results");
    if (!q) return;
    box.hidden = false;
    box.innerHTML = `<button disabled>Searching...</button>`;
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r, i) => `<button data-i="${i}">${esc(r.name)}</button>`).join("") : `<button disabled>No match. Try a street and city, or click the map.</button>`;
      box.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
        const r = results[+b.dataset.i];
        box.hidden = true;
        map.setView([r.lat, r.lon], 13);
        choosePoint(r.lat, r.lon, r.name.split(",").slice(0, 3).join(","));
      }));
    } catch (err) { box.innerHTML = `<button disabled>Search unavailable (${esc(err.message)}). Click the map instead.</button>`; }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#search-form")) $("#search-results").hidden = true; });

  // ---------- accessibility toggles ----------
  for (const [id, cls] of [["#btn-large", "large-text"], ["#btn-contrast", "high-contrast"]]) {
    const on = store.get(cls, false);
    document.body.classList.toggle(cls, on);
    $(id).setAttribute("aria-pressed", String(on));
    $(id).addEventListener("click", () => {
      const v = !document.body.classList.contains(cls);
      document.body.classList.toggle(cls, v);
      $(id).setAttribute("aria-pressed", String(v));
      store.set(cls, v);
    });
  }

  // ---------- start ----------
  async function start() {
    renderPrep();
    const fromHash = location.hash.slice(1);
    setMode(MODES.includes(fromHash) ? fromHash : "during");
    api("/api/meta").then((m) => {
      const p = $("#gb10-pill");
      p.className = "pill " + (m.gb10.enabled ? "ok" : "bad");
      p.textContent = m.gb10.enabled ? "GB10 vision: on" : "GB10 vision: off";
      p.title = m.gb10.reason || m.gb10.model;
    }).catch(() => setOnline(false, store.get("last")));
    await Promise.allSettled([loadSites(), loadEssentials(), loadGauges()]);
    setInterval(loadGauges, 5 * 60 * 1000);
    const last = store.get("last");
    if (last) choosePoint(last.lat, last.lon, last.label);
    else choosePoint(29.7752, -95.6303, "Addicks / Barker reservoirs, west Houston");
  }
  start();
})();
