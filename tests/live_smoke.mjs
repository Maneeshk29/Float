// Read-only browser check of a deployed Float (posts no offers, profiles or alerts).
// Usage: node tests/live_smoke.mjs https://your-float.vercel.app
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE = process.argv[2], port = 9337;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "float-live-"))}`, "--window-size=1280,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d).slice(0, 400))); ok &&= !!c; };
try {
  let t; for (let i = 0; i < 50; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const conn = async (u) => { const ws = new WebSocket(u); await new Promise((r) => ws.addEventListener("open", r)); let id = 0; const p = new Map(); const errors = [];
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); }
      if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    return { ws, errors, send: (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; };
  const b = await conn((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await b.send("Browser.grantPermissions", { origin: BASE, permissions: ["geolocation"] });
  const { ws, send, errors } = await conn(t.find((x) => x.type === "page").webSocketDebuggerUrl);
  const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const waitFor = async (e, ms = 40000) => { const s = Date.now(); while (Date.now() - s < ms) { if (await ev(e)) return true; await sleep(400); } return false; };
  const text = (sel) => ev(`document.querySelector('${sel}')?.innerText || ''`);
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setGeolocationOverride", { latitude: 29.7752, longitude: -95.6303, accuracy: 50 });
  await send("Page.navigate", { url: BASE + "/" });
  check("welcome asks for location", await waitFor(`!!document.querySelector('#w-gps') && !document.querySelector('#welcome').hidden`), null);
  await ev(`document.querySelector('#w-gps').click()`);
  check("asks why you're here", await waitFor(`!!document.querySelector('#welcome [data-role]')`), null);
  await ev(`document.querySelector('#w-later').click()`);
  check("verdict", await waitFor(`/No flooding expected|Flooding possible|Heavy flooding likely/.test(document.querySelector('.hero .headline')?.innerText || '')`, 60000), await text(".hero"));
  check("place from GPS", await waitFor(`/[0-9]{5}/.test(document.querySelector('#place-name').innerText)`), await text("#place-name"));
  check("weather: glass card, 8 days", await ev(`document.querySelectorAll('.glass-wx .wx').length === 8`), null);
  check("flood history", await ev(`/flood claims in ZIP/.test(document.querySelector('#t-history')?.innerText || '')`), await text("#t-history"));
  check("news headlines", await ev(`document.querySelectorAll('.tile a.r').length > 0`), null);
  await ev(`document.querySelector('#h-details').click()`);
  check("rain prediction: next 24 h", await waitFor(`document.querySelectorAll('.glass-wx .tl').length === 6`), null);
  for (const [ph, title] of [["before", "Get ready"], ["during", "Stay safe"], ["after", "Recover"]]) {
    await ev(`document.querySelector('[data-phase="${ph}"]').click(); document.querySelector('nav.tabs [data-tab="guides"]').click()`);
    check(`${ph}: ${title}`, (await text("#tab-guides .title")) === title, await text("#tab-guides .title"));
  }
  await ev(`document.querySelector('[data-phase="during"]').click(); document.querySelector('nav.tabs [data-tab="home"]').click()`);
  check("storm: roads right now", await waitFor(`/closed or flooded/.test(document.querySelector('#roads-card')?.innerText || '') && !/…/.test(document.querySelector('#roads-card').innerText)`), await text("#roads-card"));
  await ev(`document.querySelector('#h-route-shelter').click()`);
  check("storm: best route to nearest shelter", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '')`), await text("#nearby-list"));
  check("storm: road closures on map", await waitFor(`document.querySelectorAll('.closure-x').length > 5`), null);
  await ev(`document.querySelector('[data-cat="hospital"]').click()`);
  check("nearby hospitals with numbered pins", await waitFor(`document.querySelectorAll('#nearby-list [data-sel]').length >= 3 && document.querySelectorAll('.num-pin').length >= 3`), null);
  await ev(`document.querySelector('#n-route').click()`);
  check("best route to hospital", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '')`), await text("#nearby-list"));
  await ev(`document.querySelector('#n-track').click()`);
  await sleep(1500);
  await send("Emulation.setGeolocationOverride", { latitude: 29.7604, longitude: -95.3698, accuracy: 20 });
  check("location tracker follows the phone", await waitFor(`Math.abs(JSON.parse(localStorage.getItem("float:place")).lat - 29.7604) < 0.001`), await ev(`localStorage.getItem("float:place")`));
  check("route re-planned while tracking", await waitFor(`/min/.test(document.querySelector('.route-card')?.innerText || '')`), null);
  await ev(`document.querySelector('#n-track').click()`);
  for (const tab of ["help", "alerts", "me"]) { await ev(`document.querySelector('nav.tabs [data-tab="${tab}"]').click()`); check(`${tab} tab opens`, await ev(`!document.querySelector('#tab-${tab}').hidden && document.querySelector('#tab-${tab}').innerText.length > 50`), null); }
  check("no JavaScript errors", errors.length === 0, errors);
  ws.close(); b.ws.close();
} catch (e) { console.log("FAIL exception", e); ok = false; } finally { chrome.kill(); }
console.log(ok ? "LIVE OK" : "LIVE FAILURES"); process.exit(ok ? 0 : 1);
