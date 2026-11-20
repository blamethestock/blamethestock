// Screenshot a live page area at 1200x675 for X (readable on a phone: a 640 px wide view, scaled up).
//   node tools/shot.mjs <url> <out.png> <css selector to show at the top> [ready JS expression] [extra scroll px]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, out, selector, ready = 'true', extra = '0'] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '../node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const W = 640, H = 360, SCALE = 1200 / 640;
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(BIN, [`--remote-debugging-port=${port}`, '--no-first-run', '--hide-scrollbars', `--user-data-dir=/tmp/shot-${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* not up yet */ }
}
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url });
let ok = false;
for (let i = 0; i < 120 && !ok; i++) { await sleep(1000); ok = !!(await evalJs(`(() => { try { return !!(${ready}); } catch (e) { return false; } })()`)); }
if (!ok) { console.error('Page never got ready: ' + ready); proc.kill(); process.exit(1); }
await sleep(1500);
await evalJs(`(() => { const st = document.createElement('style'); st.textContent = '#menu, .menu { display: none !important; }'; document.head.appendChild(st); })()`);
await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const y = el.getBoundingClientRect().top + scrollY - 16 + ${Number(extra)}; window.dispatchEvent(new WheelEvent('wheel')); document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, y); })()`);
await sleep(1200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
ws.close(); proc.kill();
process.exit(0);
