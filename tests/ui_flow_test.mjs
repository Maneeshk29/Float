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
  const host = await post("/api/shelter/offer", { kind: "shelter", lat: 29.79, lon: -95.70, area: "Test host, Barker", spots: 4, pets: true, name: "Neighbor Host", contact: "555-0111" });

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
  check("help panel shows nearby host", await waitFor(`document.querySelector('#s-shelter')?.innerText.includes('Test host, Barker')`), await text("#safety"));
  check("ride section shown (no car)", await evalJS(`!!document.querySelector('#s-ride')`), null);
  await evalJS(`[...document.querySelectorAll('#s-shelter [data-ask]')][0].click()`);
  check("one-tap request sent", await waitFor(`/sent/i.test(document.querySelector('#s-shelter')?.innerText || '')`), await text("#s-shelter"));
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
  await evalJS(`document.querySelector('#nearby-top [data-view="map"]').click()`);
  check("map view opens", await evalJS(`!document.querySelector('#map-shell').hidden`), null);

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

  check("no JavaScript errors", errors.length === 0, errors);
  ws.close(); browser.ws.close();
} catch (e) { console.log("FAIL exception", e); ok = false; }
finally { chrome.kill(); }
console.log(ok ? "ALL UI PASS" : "UI FAILURES");
process.exit(ok ? 0 : 1);
