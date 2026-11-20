// Shared helpers for the launch-kit scripts: settings, live data, cards, rendering, file clean-up.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const at = (...p) => path.join(KIT, ...p);
const run = promisify(execFile);

// ---------------------------------------------------------------- settings
export function readConfig() { return JSON.parse(fs.readFileSync(at('config.json'), 'utf8')); }
export function writeConfig(c) { fs.writeFileSync(at('config.json'), JSON.stringify(c, null, 2) + '\n'); }
export const RECOMMENDED_LOGO = 'B';

// ---------------------------------------------------------------- live data (the site's own code, see fetch-live.mjs)
export async function fetchLive(address, window = '24h') {
  try {
    const { stdout } = await run(process.execPath, [at('tools/fetch-live.mjs'), address, window], { timeout: 150000, maxBuffer: 1 << 24 });
    const j = JSON.parse(stdout);
    if (!j.pi || j.pi.ok === false || !j.res || !j.res.ok) return { ok: false, why: (j.pi && (j.pi.code + (j.pi.detail ? ': ' + j.pi.detail : ''))) || 'no result' };
    j.fetchedAt = new Date().toISOString();
    return { ok: true, live: j };
  } catch (e) {
    return { ok: false, why: String(e.message || e).split('\n')[0] };
  }
}

const NY = 'America/New_York';
export const dateText = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', { timeZone: NY, month: 'short', day: 'numeric', year: 'numeric' });
export const isoDay = (unix) => new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: NY });

// A blame card from the site's own result object (site/src/core/verdict.js buildResult).
export function cardFromResult(r, { placeholder = false } = {}) {
  const stock = r.pair.short || r.pair.symbol || 'the pair';
  const pairNum = (r.numbers || []).find((n) => n.key === 'pair');
  let sub;
  if (['normal', 'mostly-pair', 'pair-bigger'].includes(r.caseName) && pairNum) sub = `${stock} moved ${pairNum.text} in the same ${r.windowLabel}.`;
  else sub = r.blame || r.verdict;
  if (r.warnings && r.warnings.length) sub += ' ' + r.warnings[0];
  return {
    address: r.coin.address,
    symbol: r.coin.symbol,
    stock,
    stockShare: r.bar ? r.bar.pair : 0,
    coinMove: r.c,
    coinMoveText: r.headline.text,
    caseName: r.caseName,
    sub,
    windowLabel: r.windowLabel,
    dateText: dateText(r.asOf),
    day: isoDay(r.asOf),
    asOfText: r.asOfText,
    verdict: r.verdict,
    link: r.link,
    placeholder,
  };
}

// Clearly marked stand-in numbers, used only if live data and the saved copy both fail.
export const PLACEHOLDER = {
  AI: { symbol: 'AI', stock: 'NVDA', stockShare: 0.5, coinMoveText: '−6.0%', coinMove: -0.06, sub: 'Example numbers, not live data.' },
  MEME: { symbol: 'MEME', stock: 'AMC', stockShare: 0.3, coinMoveText: '+5.0%', coinMove: 0.05, sub: 'Example numbers, not live data.' },
  BONER: { symbol: 'BONER', stock: 'HIMS', stockShare: 0.25, coinMoveText: '−12%', coinMove: -0.12, sub: 'Example numbers, not live data.' },
};

// ---------------------------------------------------------------- the OBSYN facts (read from Robinhood Chain,
// recorded in dev/tests/fixtures/obsyn and checked by dev/tests/copycheck.test.js)
export const OBSYN = {
  symbol: 'OBSYN',
  count: 4,
  copyShort: '0x7a2A…475E',
  realShort: '0x5D99…4351',
  gapText: '11m 45s',
  dumpSeconds: 71,
  dateText: 'Launched Nov 17, 2026',
  rows: [
    { addr: '0x0188…4503', note: 'same name', tag: 'other' },
    { addr: '0x7a2a…475e', note: 'launched 11m 45s before the real one', tag: 'copy' },
    { addr: '0x5d99…4351', note: 'the real one', tag: 'real' },
    { addr: '0x17e2…5121', note: 'same name', tag: 'other' },
  ],
};

// ---------------------------------------------------------------- rendering with Remotion
let bundled = null;
export async function bundleOnce() {
  if (bundled) return bundled;
  const { bundle } = await import('@remotion/bundler');
  bundled = await bundle({ entryPoint: at('video/src/index.jsx'), publicDir: at('video/public'), onProgress: () => {} });
  return bundled;
}
export function writeProps(props) {
  fs.mkdirSync(at('data'), { recursive: true });
  fs.writeFileSync(at('data/props.json'), JSON.stringify(props, null, 1));
}

// Remotion's browser now and then stalls while starting (a timeout, not a code error); try up to 3 times.
export async function retry(fn, label = '') {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 3 || !/delayRender|timeout|Target closed|Protocol error/i.test(String(e && e.message))) throw e;
      console.log(`  (${label || 'render'} stalled, trying again: ${i + 1} of 3)`);
    }
  }
}

export async function renderStillTo(id, out, inputProps) {
  return retry(() => renderStillOnce(id, out, inputProps), path.basename(out));
}
async function renderStillOnce(id, out, inputProps) {
  const { renderStill, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundleOnce();
  const composition = await selectComposition({ serveUrl, id, inputProps, timeoutInMilliseconds: 120000 });
  const tmp = out + '.tmp.png';
  let audit = null;
  await renderStill({ composition, serveUrl, timeoutInMilliseconds: 120000, output: tmp, inputProps, imageFormat: 'png', overwrite: true,
    onBrowserLog: (l) => { if (l.text.startsWith('AUDIT')) audit = JSON.parse(l.text.slice(5)); } });
  await cleanPng(tmp, out, composition.width, composition.height);
  fs.unlinkSync(tmp);
  recordAudit(path.relative(KIT, out), audit);
  return out;
}

// Text measurements from the browser (see Audit in video/src/brand.jsx), kept in data/audit.json.
export function recordAudit(file, audit) {
  const f = at('data/audit.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  all[file] = audit;
  fs.writeFileSync(f, JSON.stringify(all, null, 1));
}
// Many frames -> one summary: smallest text, the box all text stayed inside, anything outside the frame.
export function summarizeAudits(list) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  let minFont = Infinity; const outside = new Set(); const frames = new Set();
  for (const a of list) {
    if (!a) continue;
    frames.add(a.frame);
    if (Number.isFinite(a.minFont)) minFont = Math.min(minFont, a.minFont);
    if (a.box.every(Number.isFinite)) { box[0] = Math.min(box[0], a.box[0]); box[1] = Math.min(box[1], a.box[1]); box[2] = Math.max(box[2], a.box[2]); box[3] = Math.max(box[3], a.box[3]); }
    a.outside.forEach((t) => outside.add(`frame ${a.frame}: ${t}`));
  }
  const w = list.find(Boolean);
  return { frames: frames.size, width: w && w.width, height: w && w.height, minFont, box, outside: [...outside].slice(0, 20) };
}

// Re-save a PNG: sRGB, no metadata (sharp drops EXIF/XMP/ICC unless asked), checked size.
export async function cleanPng(src, out, w, h) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const img = sharp(src);
  const m = await img.metadata();
  if (w && (m.width !== w || m.height !== h)) throw new Error(`${path.basename(out)} is ${m.width}x${m.height}, expected ${w}x${h}`);
  await img.toColourspace('srgb').png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(out);
}

// ---------------------------------------------------------------- ffmpeg / ffprobe shipped with Remotion
export const FFDIR = path.dirname(fileURLToPath(import.meta.resolve('@remotion/compositor-darwin-arm64/package.json')));
export async function ff(bin, args) {
  const { stdout, stderr } = await run(path.join(FFDIR, bin), args, { env: { ...process.env, DYLD_LIBRARY_PATH: FFDIR }, maxBuffer: 1 << 26 });
  return stdout || stderr;
}
