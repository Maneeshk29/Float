// Drives a real headless Chrome through Float's main flows via the DevTools protocol.
// Usage: node ui_flow_test.mjs http://localhost:8091
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "float-ui-"))}`, "--window-size=1280,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (name, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + JSON.stringify(detail))); ok &&= !!cond; };
const post = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

try {
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const page = targets.find((t) => t.type === "page");
  const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const connect = async (url) => {
    const ws = new WebSocket(url); await new Promise((r) => ws.addEventListener("open", r));
    let id = 0; const pending = new Map(); const errors = [];
    ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text); });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    return { ws, send, errors };
  };
  const browser = await connect(browserWs);
  await browser.send("Browser.grantPermissions", { origin: BASE, permissions: ["geolocation"] });
  const { ws, send, errors } = await connect(page.webSocketDebuggerUrl);
  const evalJS = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const waitFor = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evalJS(expr)) return true; await sleep(300); } return false; };
  const text = (sel) => evalJS(`document.querySelector('${sel}')?.innerText || ''`);
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setGeolocationOverride", { latitude: 29.7752, longitude: -95.6303, accuracy: 50 });

  // A neighbor offers a place to stay near the user (as another person, through the API)
  const HOST_AREA = `Test host ${Date.now() % 100000}`;
  const host = await post("/api/shelter/offer", { kind: "shelter", lat: 29.781, lon: -95.637, area: HOST_AREA, spots: 4, pets: true, name: "Neighbor Host", contact: "555-0111" });

  // 1. Welcome asks for location
  await send("Page.navigate", { url: `${BASE}/` });
  check("welcome asks for location", await waitFor(`!document.querySelector('#welcome').hidden && !!document.querySelector('#w-gps')`), null);
  await evalJS(`document.querySelector('#w-gps').click()`);
  check("after location: asks why you're here", await waitFor(`!!document.querySelector('#welcome [data-role]')`), await text("#welcome-box"));
  await evalJS(`document.querySelector('#welcome [data-role="need_shelter"]').click()`);
  check("need-shelter without contact goes to Me", await waitFor(`!document.querySelector('#tab-me').hidden && document.querySelector('#welcome').hidden`), null);
  await evalJS(`(() => { const f = document.querySelector('#me-form'); f.name.value = 'Test Evacuee'; f.contact.value = '555-0222'; f.people.value = 2; f.pets.checked = true; f.has_car.checked = false; f.requestSubmit(); })()`);
  check("profile saved -> Home", await waitFor(`!document.querySelector('#tab-home').hidden`), null);

  // 2. Verdict from weather + history + news
  check("verdict shown", await waitFor(`/No flooding expected|Flooding possible|Heavy flooding likely/.test(document.querySelector('.hero .headline')?.innerText || '')`, 45000), await text(".hero"));
  check("place name from GPS (city + ZIP)", await waitFor(`/\\d{5}/.test(document.querySelector('#place-name').innerText)`), await text("#place-name"));
  check("weather strip has 8 days", await evalJS(`document.querySelectorAll('.strip .wx').length === 8`), null);
  check("flood history tile shows claims", await evalJS(`/flood claims in ZIP/.test(document.querySelector('#t-history')?.innerText || '')`), await text("#t-history"));
  check("nearest tile lists a hospital", await waitFor(`document.querySelector('[data-go="nearby"].tile')?.innerText.includes('km')`), null);
  check("news tile has headlines", await evalJS(`document.querySelectorAll('.tile a.r').length > 0`), null);

  // 3. Auto-connect: need_shelter profile -> help panel with the host + rides (no car)
  check("help panel shows nearby host", await waitFor(`document.querySelector('#s-shelter')?.innerText.includes('${HOST_AREA}')`), await text("#safety"));
  check("ride section shown (no car)", await evalJS(`!!document.querySelector('#s-ride')`), null);
  await evalJS(`[...document.querySelectorAll('#s-shelter .offer')].find(o => o.innerText.includes('${HOST_AREA}')).querySelector('[data-ask]').click()`);
  check("one-tap request sent", await waitFor(`/sent/i.test([...document.querySelectorAll('#s-shelter .offer')].find(o => o.innerText.includes('${HOST_AREA}'))?.innerText || '')`), await text("#s-shelter"));
  const mine = await post("/api/shelter/mine", { offers: [{ id: host.id, token: host.token }] });
  const req = mine.offers[0].requests[0];
  check("host got the request with profile details", req && req.name === "Test Evacuee" && req.people === 2 && req.pets, req);
  await post("/api/shelter/respond", { offer_id: host.id, token: host.token, request_id: req.id, decision: "accept" });

  // 4. Help -> Matches shows host contact
  await evalJS(`document.querySelector('nav.tabs [data-tab="help"]').click()`);
  await evalJS(`document.querySelector('[data-area="matches"]').click()`);
  await evalJS(`window.dispatchEvent(new Event('focus'))`);
  check("accepted match shows host phone", await waitFor(`(async () => { document.querySelector('[data-area="stay"]').click(); document.querySelector('[data-area="matches"]').click(); return document.querySelector('#help-body').innerText.includes('555-0111'); })()`, 150000), await text("#help-body"));

  // 5. Offer rides through the UI
  await evalJS(`document.querySelector('[data-area="ride"]').click()`);
  await evalJS(`document.querySelector('[data-mode="offer"]').click()`);
  await evalJS(`(() => { const f = document.querySelector('#offer-form'); f.area.value = 'Ride test, Katy'; f.spots.value = 3; f.requestSubmit(); })()`);
  check("ride offer listed in matches", await waitFor(`document.querySelector('#help-body').innerText.includes('Ride test, Katy')`), await text("#help-body"));

  // 6. Nearby always available
  await evalJS(`document.querySelector('nav.tabs [data-tab="nearby"]').click()`);
  check("nearby hospitals listed", await waitFor(`document.querySelectorAll('#nearby-list .r').length >= 3`), await text("#nearby-list"));
  await evalJS(`document.querySelector('[data-cat="grocery"]').click()`);
  check("nearby grocery listed", await waitFor(`document.querySelectorAll('#nearby-list .r').length >= 3`), null);
  check("map always visible with numbered pins", await evalJS(`!document.querySelector('#map-shell').hidden && document.querySelectorAll('.num-pin').length >= 3`), null);
  await evalJS(`document.querySelector('#n-closures').click()`);
  check("road closures shown on map", await waitFor(`document.querySelectorAll('.closure-x').length > 5 && /fully closed/.test(document.querySelector('#nearby-list').innerText)`), await text("#nearby-list"));
  await evalJS(`document.querySelector('[data-cat="hospital"]').click()`);
  await evalJS(`document.querySelector('[data-sel="1"]').click()`);
  check("selecting a place updates route button", await evalJS(`document.querySelector('#n-route').innerText.includes('#2')`), await text("#n-route"));
  await evalJS(`document.querySelector('#n-route').click()`);
  check("best route drawn with route card", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '') && document.querySelectorAll('#leaflet-map path.leaflet-interactive, #leaflet-map canvas').length > 0`), await text("#nearby-list"));
  check("route card has Google Maps link", await evalJS(`!!document.querySelector('.route-card a[href*="google.com/maps/dir"]')`), null);
  await evalJS(`document.querySelector('#n-closures').click()`);

  // 7. Alerts switch
  await evalJS(`document.querySelector('nav.tabs [data-tab="alerts"]').click()`);
  await evalJS(`document.querySelector('#a-switch').click()`);
  check("alerts turned on", await waitFor(`document.querySelector('#a-switch')?.getAttribute('aria-pressed') === 'true'`), await text("#tab-alerts"));

  // 8. One tab at a time + phases
  for (const t of ["home", "nearby", "help", "alerts", "guides", "me"]) {
    await evalJS(`document.querySelector('nav.tabs [data-tab="${t}"]').click()`);
    const vis = await evalJS(`[...document.querySelectorAll('main > section')].filter(s => !s.hidden).map(s => s.id)`);
    check(`only ${t} visible`, vis.length === 1 && vis[0] === "tab-" + t, vis);
  }
  await evalJS(`document.querySelector('[data-phase="after"]').click(); document.querySelector('nav.tabs [data-tab="home"]').click()`);
  check("after phase: 'Can I go back?'", await waitFor(`/can i go back\?/i.test(document.querySelector('#tab-home').innerText)`), (await text("#tab-home")).slice(0, 600) + " | phase=" + await evalJS(`document.querySelector('.phase [aria-pressed="true"]')?.innerText`));
  await evalJS(`document.querySelector('nav.tabs [data-tab="me"]').click(); document.querySelector('[data-go="manager"]').click()`);
  check("manager page from Me", await waitFor(`document.querySelector('#tab-manager').innerText.includes('Bevil Oaks')`), null);

  // ===== Feature checklist =====
  const lsPlace = () => evalJS(`JSON.parse(localStorage.getItem("float:place"))`);
  await evalJS(`document.querySelector('[data-phase="before"]').click(); document.querySelector('nav.tabs [data-tab="home"]').click()`);
  // Weather
  check("WEATHER: liquid-glass card with 8 days, temps and rain chance", await waitFor(`!!document.querySelector('.glass-wx') && [...document.querySelectorAll('.glass-wx .wx')].filter(w => /°/.test(w.innerText) && /%/.test(w.innerText)).length === 8`), await text(".glass-wx"));
  // News
  check("NEWS: headlines link to articles", await evalJS(`[...document.querySelectorAll('.tile a.r')].filter(a => a.href.startsWith('http') && a.innerText.length > 20).length >= 1`), null);
  // Rain prediction
  await evalJS(`document.querySelector('#h-details').click()`);
  check("RAIN PREDICTION: next-24h risk tiles (now..+24h)", await waitFor(`document.querySelectorAll('.glass-wx .tl').length === 6 && [...document.querySelectorAll('.glass-wx .tl')].every(t => /%/.test(t.innerText))`), await text(".glass-wx"));
  const pt = await (await fetch(BASE + "/api/point?lat=29.7752&lon=-95.6303")).json();
  check("RAIN PREDICTION: 8-day outlook from rain forecast", pt.risk?.outlook?.days?.length === 8 && pt.risk.outlook.days.every(d => typeof d.rain_mm === "number" && d.level), pt.risk?.outlook);
  // Before / During / After
  const phaseText = async (ph) => { await evalJS(`document.querySelector('[data-phase="${ph}"]').click(); document.querySelector('nav.tabs [data-tab="guides"]').click()`); return await text("#tab-guides .title"); };
  check("BEFORE guide: Get ready", (await phaseText("before")) === "Get ready", await text("#tab-guides .title"));
  check("DURING guide: Stay safe", (await phaseText("during")) === "Stay safe", await text("#tab-guides .title"));
  check("AFTER guide: Recover + damage photos", (await phaseText("after")) === "Recover" && await evalJS(`!!document.querySelector('#ev-form')`), await text("#tab-guides"));
  // During a storm: road closures + best route from Home
  await evalJS(`document.querySelector('[data-phase="during"]').click(); document.querySelector('nav.tabs [data-tab="home"]').click()`);
  check("STORM: Home shows 'Roads right now' with live counts", await waitFor(`/Roads right now/.test(document.querySelector('#roads-card')?.innerText || '') && (() => { const x = document.querySelector('#roads-card').innerText.split(String.fromCharCode(10)); const i = x.indexOf('closed or flooded'); return i > 0 && /^[0-9]+$/.test(x[i - 1]); })()`), await text("#roads-card"));
  await evalJS(`document.querySelector('#h-route-shelter').click()`);
  check("STORM: 'Best route to nearest shelter' draws a route", await waitFor(`!document.querySelector('#tab-nearby').hidden && /min/.test(document.querySelector('.route-card')?.innerText || '') && document.querySelector('[data-cat="shelter"]').getAttribute('aria-pressed') === 'true'`), await text("#nearby-list"));
  check("STORM: Nearby shows road closures automatically", await waitFor(`/fully closed/.test(document.querySelector('#nearby-list').innerText) && document.querySelectorAll('.closure-x').length > 5`), null);
  await evalJS(`document.querySelector('nav.tabs [data-tab="home"]').click()`);
  await waitFor(`!!document.querySelector('#h-route-hosp')`);
  await evalJS(`document.querySelector('#h-route-hosp').click()`);
  check("STORM: route to nearest hospital", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '') && document.querySelector('[data-cat="hospital"]').getAttribute('aria-pressed') === 'true'`), await text("#nearby-list"));
  // Location tracker: move the phone, Float follows and re-routes
  await evalJS(`document.querySelector('#n-track').click()`);
  check("TRACKER: tracking turns on", await waitFor(`/Tracking on/.test(document.querySelector('#n-track').innerText)`), await text("#n-track"));
  await send("Emulation.setGeolocationOverride", { latitude: 29.7604, longitude: -95.3698, accuracy: 20 });
  check("TRACKER: place follows the phone (downtown)", await waitFor(`(() => { const p = JSON.parse(localStorage.getItem("float:place")); return Math.abs(p.lat - 29.7604) < 0.001 && Math.abs(p.lon + 95.3698) < 0.001; })()`, 30000), await lsPlace());
  check("TRACKER: route re-planned from the new spot", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '')`), await text("#nearby-list"));
  await send("Emulation.setGeolocationOverride", { latitude: 32.7767, longitude: -96.797, accuracy: 20 });   // Dallas
  await sleep(2500);
  check("TRACKER: ignores positions outside Houston", Math.abs((await lsPlace()).lat - 29.7604) < 0.001, await lsPlace());
  await evalJS(`document.querySelector('#n-track').click()`);
  // Welcome GPS outside Houston falls back to Houston
  await evalJS(`document.querySelector('#place-chip').click()`);
  await waitFor(`!!document.querySelector('#w-gps')`);
  await evalJS(`document.querySelector('#w-gps').click()`);
  check("LOCATION: GPS outside Houston -> Houston", await waitFor(`(() => { const p = JSON.parse(localStorage.getItem("float:place")); return p.label === "Houston" && Math.abs(p.lat - 29.7604) < 0.001; })()`), await lsPlace());
  await evalJS(`document.querySelector('#welcome').hidden = true`);

  check("no JavaScript errors", errors.length === 0, errors);
  ws.close(); browser.ws.close();
} catch (e) { console.log("FAIL exception", e); ok = false; }
finally { chrome.kill(); }
console.log(ok ? "ALL UI PASS" : "UI FAILURES");
process.exit(ok ? 0 : 1);
