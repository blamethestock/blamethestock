// Blame the Stock: sharing. X intent link, copy link, and the 1200x675 share picture drawn on a canvas.
import { SETTINGS } from '../../settings.js';

export const IMAGE_W = 1200;
export const IMAGE_H = 675;

const C = { bg: '#000000', fg: '#FFFFFF', grey: '#8B8B8B', dim: '#5E5E5E', line: '#262626', edge: '#3A3A3A',
  pair: '#2433FF', coin: '#FF4F1F' };

// ---- X and the link ---------------------------------------------------------------------------
export function xIntentUrl(result) {
  const text = (result && (result.shareText || result.verdict)) || '';
  const url = (result && result.link) || '';
  return 'https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url);
}

export async function copyLink(result) {
  const text = (result && result.link) || location.href;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back below */ }
  const active = document.activeElement;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
    return !!ok;
  } catch (e) {
    return false;
  }
}

// ---- Fonts ------------------------------------------------------------------------------------
// The page loads one family (settings.font). Canvas needs it loaded before drawing.
const FONTS = {
  archivo: { family: 'Archivo', narrow: 'extra-condensed' },      // wdth 62.5
  robotoflex: { family: 'Roboto Flex', narrow: 'ultra-condensed' }, // wdth 50
};

export function fontInfo(settings = SETTINGS) {
  const f = FONTS[settings && settings.font] || FONTS.archivo;
  return { family: f.family, narrow: f.narrow, stack: `"${f.family}", "Arial Narrow", Arial, sans-serif` };
}

export async function waitForFonts(settings = SETTINGS, ms = 3000) {
  if (!document.fonts) return;
  const { stack, narrow } = fontInfo(settings);
  const wanted = [`500 22px ${stack}`, `700 60px ${stack}`, `${narrow} 900 40px ${stack}`];
  const loads = wanted.map((f) => document.fonts.load(f).catch(() => null));
  let timer;
  await Promise.race([
    Promise.all([document.fonts.ready, ...loads]),
    new Promise((r) => { timer = setTimeout(r, ms); }),
  ]);
  clearTimeout(timer);
}

// ctx.font with an optional width keyword (also mirrored to ctx.fontStretch where the browser has it).
export function useFont(ctx, settings, { size, weight = 400, narrow = false }) {
  const f = fontInfo(settings);
  const stretch = narrow ? f.narrow : 'normal';
  ctx.font = `${narrow ? stretch + ' ' : ''}${weight} ${size}px ${f.stack}`;
  if ('fontStretch' in ctx) { try { ctx.fontStretch = stretch; } catch (e) { /* ignore */ } }
}

// ---- Drawing helpers --------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// The site mark: a rounded black square split 40/60, blue (the pair) and vermilion (the coin).
export function drawMark(ctx, x, y, size, { radius = size * 0.24, split = 0.4, gap = Math.max(1, size * 0.07) } = {}) {
  ctx.save();
  roundRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  ctx.fillStyle = C.bg;
  ctx.fillRect(x, y, size, size);
  const cut = x + size * split;
  ctx.fillStyle = C.pair;
  ctx.fillRect(x, y, cut - gap / 2 - x, size);
  ctx.fillStyle = C.coin;
  ctx.fillRect(cut + gap / 2, y, x + size - cut - gap / 2, size);
  ctx.restore();
}

// Mark + "BLAME THE STOCK". (x, top) is the top-left; capSize is the mark's size. Returns the width.
export function drawWordmark(ctx, settings, x, top, capSize, color = C.fg) {
  const name = String((settings && settings.site && settings.site.name) || SETTINGS.site.name).toUpperCase();
  drawMark(ctx, x, top, capSize);
  useFont(ctx, settings, { size: Math.round(capSize * 1.42), weight: 900, narrow: true });
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const tx = x + capSize + Math.round(capSize * 0.42);
  ctx.fillText(name, tx, top + capSize);
  return tx - x + ctx.measureText(name).width;
}

function tracked(ctx, text, x, y, tracking, align = 'left') {
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cx = align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + tracking; });
  ctx.textAlign = prev;
  return total;
}

// Cut text to fit maxW with "…". tracking = extra space per letter (for letter-spaced text).
function ellipsize(ctx, text, maxW, tracking = 0) {
  const width = (t) => ctx.measureText(t).width + tracking * Math.max(0, [...t].length - 1);
  if (width(text) <= maxW) return text;
  const s = [...text];
  while (s.length > 1 && width(s.join('') + '…') > maxW) s.pop();
  return s.join('').trimEnd() + '…';
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    // A single word wider than the line (a long coin name) is broken up.
    while (ctx.measureText(word).width > maxW && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > maxW) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Wrap like CSS text-wrap: balance (same number of lines, evener lengths).
function balancedWrap(ctx, text, maxW) {
  const lines = wrap(ctx, text, maxW);
  if (lines.length < 2) return lines;
  let lo = maxW * 0.5, hi = maxW, best = lines;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const t = wrap(ctx, text, mid);
    if (t.length <= lines.length) { best = t; hi = mid; } else lo = mid;
  }
  return best;
}

// Biggest size (from `sizes`) at which the text fits the box; the smallest size truncates if it still can't.
function fitText(ctx, settings, text, maxW, maxH, sizes, lineHeight, weight) {
  for (const size of sizes) {
    useFont(ctx, settings, { size, weight });
    const lines = balancedWrap(ctx, text, maxW);
    if (lines.length * size * lineHeight <= maxH) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  useFont(ctx, settings, { size, weight });
  let lines = wrap(ctx, text, maxW);
  const max = Math.max(1, Math.floor(maxH / (size * lineHeight)));
  if (lines.length > max) {
    lines = lines.slice(0, max);
    lines[max - 1] = ellipsize(ctx, lines[max - 1] + '…', maxW);
  }
  return { size, lines };
}

function hash(str) {
  let x = 2166136261;
  for (const ch of String(str)) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

function loadSvg(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('sticker image'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// One small sticker in the top-right corner, carrying the pair's own ticker. Only drawn when the verdict
// puts some of the move on the pair, so a sticker never blames something the card says isn't to blame.
// SVG pictures can't use the page's web font, so its font-family var(--font) is swapped for system faces.
const PAIR_TO_BLAME = ['normal', 'mostly-pair', 'pair-bigger'];

async function drawSticker(ctx, result, settings) {
  if (!PAIR_TO_BLAME.includes(result.caseName)) return false;
  if (result.caseName === 'normal' && !(result.sharePct >= 20)) return false;   // "blamed on NVDA" for 5% is a stretch
  const ticker = String((result.pair && (result.pair.short || result.pair.symbol)) || '').toUpperCase();
  if (!ticker) return false;
  let mod;
  try { mod = await import('./stickers.js'); } catch (e) { return false; }
  if (!mod || typeof mod.makeSticker !== 'function') return false;
  const seed = hash(`${result.coin && result.coin.address}|${result.window}`);
  const kinds = mod.STICKER_KINDS || ['ticket', 'tag', 'stamp'];
  const palettes = mod.PALETTE_NAMES || ['blue', 'vermilion', 'white'];
  const s = mod.makeSticker({
    kind: kinds[seed % kinds.length], text: ticker, palette: palettes[(seed >>> 4) % palettes.length], seed, settings,
  });
  if (!s || !s.svg) return false;
  const sysFont = `'Arial Narrow', 'Avenir Next Condensed', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif`;
  let svg = String(s.svg).replace(/var\(--font[^)]*\)/g, sysFont);
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const img = await loadSvg(svg);
  const w0 = s.width || img.naturalWidth || 160, h0 = s.height || img.naturalHeight || 80;
  const k = Math.min(1, 210 / w0, 92 / h0);
  const w = w0 * k, h = h0 * k;
  const angle = ((seed % 2 ? 1 : -1) * (4 + (seed % 5))) * Math.PI / 180;
  ctx.save();
  ctx.translate(IMAGE_W - 64 - w / 2, 34 + h / 2 + 12);
  ctx.rotate(angle);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}

function canvasOk(cv) {
  try { cv.getContext('2d').getImageData(0, 0, 1, 1); return true; } catch (e) { return false; }
}

// ---- The share picture ------------------------------------------------------------------------
export async function renderShareImage(result, settings = SETTINGS, opts = {}) {
  const S = settings || SETTINGS;
  await waitForFonts(S);
  const cv = document.createElement('canvas');
  cv.width = IMAGE_W;
  cv.height = IMAGE_H;
  const ctx = cv.getContext('2d');
  const W = IMAGE_W, H = IMAGE_H, PAD = 64, inner = W - PAD * 2;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Wordmark, top-left
  drawWordmark(ctx, S, PAD, 56, 28);

  // Sticker, top-right (optional; skipped if it can't be drawn cleanly)
  let stickered = false;
  if (opts.sticker !== false) {
    try { stickered = await drawSticker(ctx, result, S); } catch (e) { stickered = false; }
    if (stickered && !canvasOk(cv)) return renderShareImage(result, S, { ...opts, sticker: false });
  }

  // "ZOLVA VS ETH · 24H"
  const coin = (result.coin && result.coin.symbol) || '';
  const pair = (result.pair && (result.pair.short || result.pair.symbol)) || '';
  const win = result.windowLabel || result.window || '';
  useFont(ctx, S, { size: 22, weight: 600 });
  ctx.fillStyle = C.grey;
  const pairLine = ellipsize(ctx, `${coin} vs ${pair} · ${win}`.toUpperCase(), stickered ? inner - 270 : inner, 2.4);
  tracked(ctx, pairLine, PAD, 142, 2.4);

  // Bottom-up: footer, warning, numbers, bar
  const footY = H - 52;
  const warning = (result.warnings || []).find(Boolean);
  const warnY = footY - 46;
  const valueY = (warning ? warnY - 64 : footY - 64);
  const labelY = valueY - 58;
  const legendY = labelY - 56;
  const barH = 24;
  const barTop = legendY - 30 - barH;
  const verdictTop = 178;
  const verdictBottom = barTop - 36;

  // Verdict, as large as fits
  const text = result.verdict || [result.lead, result.blame].filter(Boolean).join(' ');
  const LH = 1.08;
  const sizes = [];
  for (let s = 84; s >= 38; s -= 2) sizes.push(s);
  const fit = fitText(ctx, S, text, inner, verdictBottom - verdictTop, sizes, LH, 700);
  useFont(ctx, S, { size: fit.size, weight: 700 });
  ctx.fillStyle = C.fg;
  fit.lines.forEach((line, i) => ctx.fillText(line, PAD, verdictTop + fit.size * 0.86 + i * fit.size * LH));

  // Split bar + legend
  const b = result.bar;
  useFont(ctx, S, { size: 22, weight: 500 });
  if (!b || !Number.isFinite(b.pair)) {
    ctx.fillStyle = C.edge;
    roundRectPath(ctx, PAD, barTop + barH / 2 - 3, inner, 6, 3);
    ctx.fill();
    ctx.fillStyle = C.grey;
    ctx.fillText('Nothing to split.', PAD, legendY);
  } else {
    const pairPct = Math.round(Math.min(1, Math.max(0, b.pair)) * 100);
    const coinPct = 100 - pairPct;
    const gap = pairPct === 0 || coinPct === 0 ? 0 : 5;
    const pw = (inner - gap) * pairPct / 100;
    ctx.save();
    roundRectPath(ctx, PAD, barTop, inner, barH, barH / 2);
    ctx.clip();
    ctx.fillStyle = C.pair;
    ctx.fillRect(PAD, barTop, pw, barH);
    ctx.fillStyle = C.coin;
    ctx.fillRect(PAD + pw + gap, barTop, inner - pw - gap, barH);
    ctx.restore();
    legendKey(ctx, S, PAD, legendY, C.pair, pair, `${pairPct}%`, 'left');
    legendKey(ctx, S, W - PAD, legendY, C.coin, 'The coin', `${coinPct}%`, 'right');
  }

  // Three numbers
  const nums = (result.numbers || []).slice(0, 3);
  const colGap = 40;
  const colW = (inner - colGap * 2) / 3;
  nums.forEach((n, i) => {
    const x = PAD + i * (colW + colGap);
    useFont(ctx, S, { size: 22, weight: 500 });
    ctx.fillStyle = C.grey;
    ctx.fillText(ellipsize(ctx, String(n.label || ''), colW), x, labelY);
    const value = `${n.arrow || ''} ${n.text || ''}`.trim();
    let size = 56;
    useFont(ctx, S, { size, weight: 700 });
    while (size > 30 && ctx.measureText(value).width > colW) { size -= 2; useFont(ctx, S, { size, weight: 700 }); }
    ctx.fillStyle = C.fg;
    ctx.fillText(value, x, valueY);
  });

  // Low-liquidity warning (white with a small vermilion dot)
  if (warning) {
    useFont(ctx, S, { size: 21, weight: 500 });
    ctx.fillStyle = C.coin;
    ctx.beginPath();
    ctx.arc(PAD + 5, warnY - 7, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.fg;
    ctx.fillText(ellipsize(ctx, warning, inner - 22), PAD + 22, warnY);
  }

  // Footer: time left, site right
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, footY - 40.5);
  ctx.lineTo(W - PAD, footY - 40.5);
  if (!warning) ctx.stroke();
  useFont(ctx, S, { size: 21, weight: 500 });
  ctx.fillStyle = C.grey;
  ctx.fillText(ellipsize(ctx, String(result.asOfText || ''), inner - 320), PAD, footY);
  const host = String((S.site && S.site.url) || SETTINGS.site.url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  useFont(ctx, S, { size: 22, weight: 700 });
  ctx.fillStyle = C.fg;
  ctx.textAlign = 'right';
  ctx.fillText(host, W - PAD, footY);
  ctx.textAlign = 'left';
  return cv;
}

function legendKey(ctx, S, x, y, color, name, pctText, align) {
  useFont(ctx, S, { size: 22, weight: 500 });
  const nameW = ctx.measureText(name).width;
  useFont(ctx, S, { size: 22, weight: 700 });
  const pctW = ctx.measureText(pctText).width;
  const dot = 12, gap = 10;
  const total = dot + gap + nameW + gap + pctW;
  let cx = align === 'right' ? x - total : x;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx + dot / 2, y - 7, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  cx += dot + gap;
  useFont(ctx, S, { size: 22, weight: 500 });
  ctx.fillStyle = C.grey;
  ctx.fillText(name, cx, y);
  cx += nameW + gap;
  useFont(ctx, S, { size: 22, weight: 700 });
  ctx.fillStyle = C.fg;
  ctx.fillText(pctText, cx, y);
}

// ---- Save ---------------------------------------------------------------------------------------
const blobs = new WeakMap(); // result -> Promise<Blob>

function toBlob(cv) {
  return new Promise((resolve, reject) => {
    try { cv.toBlob((b) => (b ? resolve(b) : reject(new Error('empty image'))), 'image/png'); } catch (e) { reject(e); }
  });
}

function imageBlob(result, settings) {
  let p = blobs.get(result);
  if (!p) {
    p = renderShareImage(result, settings).then(toBlob);
    p.catch(() => blobs.delete(result));
    blobs.set(result, p);
  }
  return p;
}

// Draws the picture ahead of time (phones: the share sheet must open right after the tap).
export function prepareShareImage(result, settings = SETTINGS) {
  if (result) imageBlob(result, settings).catch(() => {});
}

export function imageFileName(result) {
  const sym = String((result && result.coin && result.coin.symbol) || 'coin').replace(/[^A-Za-z0-9]+/g, '') || 'coin';
  const win = String((result && result.window) || '').replace(/[^A-Za-z0-9]+/g, '') || 'window';
  return `blame-${sym}-${win}.png`;
}

// Downloads blame-<SYMBOL>-<window>.png (phones get the share sheet so it can go to Photos).
// Resolves true when saved or shared, null if the visitor closed the share sheet, false on failure.
export async function saveImage(result, settings = SETTINGS) {
  let blob;
  try { blob = await imageBlob(result, settings); } catch (e) { return false; }
  const name = imageFileName(result);
  let coarse = false;
  try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) { coarse = false; }
  if (coarse && navigator.canShare && navigator.share && typeof File === 'function') {
    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // NotAllowedError etc.: fall back to a plain download
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (e) {
    return false;
  }
}
