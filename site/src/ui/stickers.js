// Blame the Stock — stickers (SPEC 3.3).
// Pure functions: they return small inline SVG strings. No DOM, no network, no external files.
// Three original families: ticket stubs, price tags, rubber stamps.
// Colours: only #2433FF (blue), #FF4F1F (vermilion), #FFFFFF, #000000.
import { SETTINGS } from '../../settings.js';

export const STICKER_KINDS = ['ticket', 'tag', 'stamp'];

const BLUE = '#2433FF', VERM = '#FF4F1F', WHITE = '#FFFFFF', BLACK = '#000000';
export const STICKER_COLORS = [BLUE, VERM, WHITE, BLACK];

// paper = sticker colour, ink = main text, accent = ticket stub / tag ring,
// accentInk = text on the accent, stamp = rubber-stamp ink. Black paper gets a white outline.
export const PALETTES = {
  blue:         { paper: BLUE,  ink: WHITE, accent: VERM,  accentInk: BLACK, stamp: WHITE },
  vermilion:    { paper: VERM,  ink: BLACK, accent: BLUE,  accentInk: WHITE, stamp: BLACK },
  white:        { paper: WHITE, ink: BLACK, accent: VERM,  accentInk: BLACK, stamp: VERM },
  'white-blue': { paper: WHITE, ink: BLUE,  accent: BLUE,  accentInk: WHITE, stamp: BLUE },
  black:        { paper: BLACK, ink: WHITE, accent: VERM,  accentInk: BLACK, stamp: VERM, outline: WHITE },
};
export const PALETTE_NAMES = Object.keys(PALETTES);

export const MIN_WIDTH = 110, MAX_WIDTH = 220;

// Advance widths (em) of a heavy, extra-condensed grotesque. Used to size boxes;
// textLength then pins the drawn text to exactly that width, so it always fits.
const ADV = {
  A: .533, B: .502, C: .516, D: .513, E: .465, F: .405, G: .547, H: .517, I: .264, J: .456, K: .514, L: .435,
  M: .709, N: .522, O: .558, P: .488, Q: .558, R: .513, S: .472, T: .478, U: .507, V: .494, W: .733, X: .504,
  Y: .485, Z: .478, 0: .447, 1: .375, 2: .43, 3: .443, 4: .438, 5: .44, 6: .448, 7: .4, 8: .435, 9: .448,
  $: .403, '’': .205, ' ': .16, '·': .212, '.': .223, '-': .241, '#': .501, '(': .27, ')': .27, 'º': .3,
  '!': .26, '?': .44, '&': .56, '%': .7, '+': .45, ',': .22, ':': .22, '/': .33,
};
const CAP = 0.69;      // cap height / font size
const PITCH = 0.84;    // line pitch / font size (lines close together)
const TIGHT = -0.012;  // big text: letters squeezed
const TRACK = 0.11;    // small text: letters spaced out

// Small wording, written for this site.
const TICKET_STUB = 'ADMIT NOTHING';
const TICKET_TOP = ['ONE (1) EXCUSE', 'NO REFUNDS', 'VALID ANY DAY'];
const TAG_TOP = ['NO RETURNS', 'AS IS', 'FINAL SALE', 'MARKED DOWN'];
const STAMP_TOP_TICKER = ['BLAMED ON', 'IT WAS', 'BLAMED ON'];
const STAMP_TOP_LINE = ['CERTIFIED', 'OFFICIAL', 'APPROVED'];

const WDTH = { archivo: 62, robotoflex: 30 };

// ---------- small helpers ----------
const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const chars = (s) => Array.from(s);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function adv(s) { let a = 0; for (const ch of chars(s)) a += ADV[ch] !== undefined ? ADV[ch] : 0.56; return a; }
function measure(s, f, track = TIGHT) { const n = chars(s).length; return f * (adv(s) + track * Math.max(0, n - 1)); }
const blockH = (f, n) => f * (CAP + PITCH * (n - 1));

function hash(str) { // FNV-1a, 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function rng(seed) { // mulberry32
  let a = (hash('stk:' + String(seed)) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = (arr, rnd) => arr[Math.floor(rnd() * arr.length) % arr.length];

function cleanText(text) {
  // control characters and lone surrogates are not allowed in XML: turn them into spaces
  let s = String(text == null ? '' : text).replace(/[\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDFFF]/gu, ' ')
    .toUpperCase().replace(/['`]/g, '’').replace(/\s+/g, ' ').trim();
  if (!s) s = '$BLAME';
  if (chars(s).length > 40) s = chars(s).slice(0, 40).join('');
  return s;
}

function splitLines(s, stackAbove) {
  if (!s.includes(' ') || adv(s) <= stackAbove) return [s];
  const words = s.split(' ');
  let best = [s], bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(adv(a), adv(b));
    if (w < bestW) { bestW = w; best = [a, b]; }
  }
  return best;
}

function colour(c, fallback) {
  const u = String(c || '').toUpperCase();
  return STICKER_COLORS.includes(u) ? u : fallback;
}
function resolvePalette(palette) {
  if (palette && typeof palette === 'object') {
    const p = {
      paper: colour(palette.paper, BLUE), ink: colour(palette.ink, WHITE),
      accent: colour(palette.accent, VERM), accentInk: colour(palette.accentInk, BLACK),
      stamp: colour(palette.stamp, colour(palette.ink, WHITE)),
    };
    if (palette.outline) p.outline = colour(palette.outline, WHITE);
    if (p.paper === BLACK) p.outline = WHITE;
    return p;
  }
  return PALETTES[palette] || PALETTES.blue;
}

// Big text: squeezed, glyphs scaled to exactly the measured width.
function bigText(s, x, y, f, fill) {
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${r1(f)}" textLength="${r1(measure(s, f))}" lengthAdjust="spacingAndGlyphs" fill="${fill}">${esc(s)}</text>`;
}
// Small text: lighter, spaced out; extra attrs for rotation.
function smallText(s, x, y, f, fill, extra = '') {
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${f}" font-weight="700" textLength="${r1(measure(s, f, TRACK))}" fill="${fill}"${extra}>${esc(s)}</text>`;
}
// Lines of big text, horizontally centred on cx (or left-aligned at x0), vertically centred in [top, bottom].
function textBlock(lines, f, { cx, x0, top, bottom, fill }) {
  const y0 = (top + bottom) / 2 - blockH(f, lines.length) / 2 + CAP * f;
  return lines.map((l, i) => {
    const x = x0 !== undefined ? x0 : cx - measure(l, f) / 2;
    return bigText(l, x, y0 + i * PITCH * f, f, fill);
  }).join('');
}
function fitFont(lines, maxF, availW) {
  const widest = Math.max(...lines.map((l) => measure(l, 1)));
  return Math.min(maxF, availW / widest);
}

// ---------- 1. ticket stub ----------
function ticket(s, pal, rnd) {
  const lines = splitLines(s, 4.5);
  const p = 2, SW = 24, padX = 10, top = 23, bot = 9, rc = 7, rn = 6;
  const fixedW = 2 * p + SW + 2 * padX;
  const f = fitFont(lines, lines.length > 1 ? 30 : 40, MAX_WIDTH - fixedW);
  const tw = Math.max(...lines.map((l) => measure(l, f)));
  const W = Math.ceil(clamp(fixedW + tw, 150, MAX_WIDTH));
  const H = Math.ceil(Math.max(74, 2 * p + top + blockH(f, lines.length) + bot));
  const xs = p + SW, R = W - p, Bt = H - p;
  const A = (r, x, y) => `A${r} ${r} 0 0 0 ${r1(x)} ${r1(y)}`;
  const full = `M${p + rc} ${p}H${xs - rn}${A(rn, xs + rn, p)}H${R - rc}${A(rc, R, p + rc)}V${Bt - rc}${A(rc, R - rc, Bt)}` +
    `H${xs + rn}${A(rn, xs - rn, Bt)}H${p + rc}${A(rc, p, Bt - rc)}V${p + rc}${A(rc, p + rc, p)}Z`;
  const stub = `M${p + rc} ${p}H${xs - rn}${A(rn, xs, p + rn)}V${Bt - rn}${A(rn, xs - rn, Bt)}H${p + rc}${A(rc, p, Bt - rc)}V${p + rc}${A(rc, p + rc, p)}Z`;
  let o = `<path d="${full}" fill="${pal.paper}"/><path d="${stub}" fill="${pal.accent}"/>`;
  // perforation: a row of punched dots on the tear line
  o += `<path d="M${xs} ${p + rn + 4}V${Bt - rn - 3}" stroke="${BLACK}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="0 4.4"/>`;
  if (pal.outline) o += `<path d="${full}" fill="none" stroke="${pal.outline}" stroke-width="2"/>`;
  // stub: sideways small print
  const fsS = 7, scx = p + SW / 2, scy = H / 2, sw = measure(TICKET_STUB, fsS, TRACK);
  o += smallText(TICKET_STUB, scx - sw / 2, scy + CAP * fsS / 2, fsS, pal.accentInk, ` transform="rotate(-90 ${r1(scx)} ${r1(scy)})"`);
  // top row: small print left, serial right, thin rule under
  const mx0 = xs + padX, mx1 = R - padX, fs = 7, ty = p + 13;
  const serial = 'Nº ' + String(Math.floor(rnd() * 9000) + 1000);
  const serW = measure(serial, fs, TRACK);
  const left = pickOf(TICKET_TOP, rnd);
  if (measure(left, fs, TRACK) + serW + 8 <= mx1 - mx0) o += smallText(left, mx0, ty, fs, pal.ink);
  o += smallText(serial, mx1 - serW, ty, fs, pal.ink);
  o += `<path d="M${mx0} ${ty + 4.5}H${mx1}" stroke="${pal.ink}" stroke-width="1"/>`;
  o += textBlock(lines, f, { cx: (mx0 + mx1) / 2, top: p + top, bottom: Bt - bot, fill: pal.ink });
  return { W, H, body: o };
}

// ---------- 2. price tag ----------
function tag(s, pal, rnd) {
  const lines = splitLines(s, 4.5);
  const p = 2, L = 15, cut = 17, padL = 29, padR = 11, top = 20, bot = 9, rr = 6;
  const fixedW = L + padL + padR + p;
  const f = fitFont(lines, lines.length > 1 ? 30 : 40, MAX_WIDTH - fixedW);
  const tw = Math.max(...lines.map((l) => measure(l, f)));
  const W = Math.ceil(clamp(fixedW + tw, 120, MAX_WIDTH));
  const H = Math.ceil(Math.max(64, 2 * p + top + blockH(f, lines.length) + bot));
  const R = W - p, Bt = H - p, hx = L + 12, hy = H / 2, hr = 4.2;
  const shape = `M${L + cut} ${p}H${R - rr}A${rr} ${rr} 0 0 1 ${R} ${p + rr}V${Bt - rr}A${rr} ${rr} 0 0 1 ${R - rr} ${Bt}` +
    `H${L + cut}L${L} ${Bt - cut}V${p + cut}Z`;
  const hole = `M${hx - hr} ${r1(hy)}a${hr} ${hr} 0 1 0 ${2 * hr} 0a${hr} ${hr} 0 1 0 ${-2 * hr} 0Z`;
  let o = `<path d="${shape}${hole}" fill="${pal.paper}" fill-rule="evenodd"${pal.outline ? ` stroke="${pal.outline}" stroke-width="2"` : ''}/>`;
  // reinforcement ring around the punched hole
  o += `<circle cx="${hx}" cy="${r1(hy)}" r="6.7" fill="none" stroke="${pal.accent}" stroke-width="2.4"/>`;
  // text: small print on top, big ticker under it, both left-aligned
  const x0 = L + padL, fs = 7;
  o += smallText(pickOf(TAG_TOP, rnd), x0, p + 13, fs, pal.ink);
  o += textBlock(lines, f, { x0, top: p + top, bottom: Bt - bot, fill: pal.ink });
  // a small loop of string through the hole, drifting up-left past the cut corner
  // (dark casing under a white line so it reads on any paper and on the black page;
  // short enough that the casing never pokes past the sticker's left edge)
  const th = (196 + rnd() * 18) * Math.PI / 180, len = 22.5 + rnd() * 3, wd = 15;
  const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx, k = len * 1.3;
  const loop = `M${hx} ${r1(hy)}C${r1(hx + dx * k + nx * wd)} ${r1(hy + dy * k + ny * wd)} ${r1(hx + dx * k - nx * wd)} ${r1(hy + dy * k - ny * wd)} ${hx} ${r1(hy)}`;
  o += `<path d="${loop}" fill="none" stroke="${BLACK}" stroke-width="3.4" stroke-linecap="round"/>` +
    `<path d="${loop}" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>`;
  return { W, H, body: o };
}

// ---------- 3. rubber stamp ----------
function stamp(s, pal, rnd, isTicker) {
  const lines = splitLines(s, 3.6);
  const p = 2, m = 6, bIn = 5, padIn = 7, fs = 7;
  const small = pickOf(isTicker ? STAMP_TOP_TICKER : STAMP_TOP_LINE, rnd);
  const smallW = measure(small, fs, TRACK) + 26; // room for the little rules either side
  const deg = (rnd() < 0.5 ? -1 : 1) * (2.5 + rnd() * 2.5), rad = Math.abs(deg) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  let f = lines.length > 1 ? 28 : 36, sw, sh, W, H;
  for (let i = 0; i < 40; i++) {
    const tw = Math.max(...lines.map((l) => measure(l, f)));
    sw = 2 * (bIn + padIn) + Math.max(tw, smallW, 70);
    sh = 2 * (bIn + padIn) + CAP * fs + 5 + blockH(f, lines.length);
    W = Math.ceil(sw * cos + sh * sin + 2 * (p + m));
    H = Math.ceil(sw * sin + sh * cos + 2 * (p + m));
    if (W <= MAX_WIDTH) break;
    f *= 0.95;
  }
  W = Math.max(W, MIN_WIDTH);
  let o = `<rect x="${p}" y="${p}" width="${W - 2 * p}" height="${H - 2 * p}" rx="6" fill="${pal.paper}"${pal.outline ? ` stroke="${pal.outline}" stroke-width="2"` : ''}/>`;
  const ink = pal.stamp, hw = sw / 2, hh = sh / 2;
  let g = '';
  // double border; the outer one has a few tiny breaks like a worn rubber edge
  const gaps = [r1(20 + rnd() * 40), r1(1 + rnd() * 1.5), r1(30 + rnd() * 50), r1(0.8 + rnd()), r1(15 + rnd() * 30), r1(1 + rnd() * 2)].join(' ');
  g += `<rect x="${r1(-hw + 1.5)}" y="${r1(-hh + 1.5)}" width="${r1(sw - 3)}" height="${r1(sh - 3)}" rx="3" fill="none" stroke="${ink}" stroke-width="3" stroke-dasharray="${gaps}"/>`;
  g += `<rect x="${r1(-hw + bIn)}" y="${r1(-hh + bIn)}" width="${r1(sw - 2 * bIn)}" height="${r1(sh - 2 * bIn)}" rx="1.5" fill="none" stroke="${ink}" stroke-width="1.2"/>`;
  // small print with a short rule either side
  const ty = -hh + bIn + padIn + CAP * fs, smW = measure(small, fs, TRACK);
  const in0 = -hw + bIn + padIn, in1 = hw - bIn - padIn, ry = r1(ty - CAP * fs / 2);
  g += smallText(small, -smW / 2, ty, fs, ink);
  g += `<path d="M${r1(in0)} ${ry}H${r1(-smW / 2 - 5)}M${r1(smW / 2 + 5)} ${ry}H${r1(in1)}" stroke="${ink}" stroke-width="1.2"/>`;
  g += textBlock(lines, f, { cx: 0, top: ty + 5, bottom: hh - bIn - padIn, fill: ink });
  // worn ink: little paper-coloured nicks on the border and through the letters
  let nicks = '';
  for (let i = 0; i < 12; i++) {
    const t = rnd() * 2 * (sw + sh);
    let x, y;
    if (t < sw) { x = -hw + t; y = -hh + 1.5; } else if (t < sw + sh) { x = hw - 1.5; y = -hh + t - sw; } else if (t < 2 * sw + sh) { x = hw - (t - sw - sh); y = hh - 1.5; } else { x = -hw + 1.5; y = hh - (t - 2 * sw - sh); }
    nicks += `M${r1(x)} ${r1(y)}l${r1(rnd() * 2 - 1)} ${r1(rnd() * 2 - 1)}`;
  }
  const bt = ty + 5, bb = hh - bIn - padIn;
  for (let i = 0; i < 9; i++) {
    nicks += `M${r1(-hw * 0.8 + rnd() * sw * 0.8)} ${r1(bt + rnd() * (bb - bt))}l${r1(rnd() * 3 - 1.5)} ${r1(rnd() * 1.6 - 0.8)}`;
  }
  g += `<path d="${nicks}" stroke="${pal.paper}" stroke-width="1.3" stroke-linecap="round"/>`;
  o += `<g transform="translate(${r1(W / 2)} ${r1(H / 2)}) rotate(${r1(deg)})">${g}</g>`;
  return { W, H, body: o };
}

const BUILDERS = { ticket, tag, stamp };

function wrap(W, H, body, settings) {
  const wd = WDTH[(settings && settings.font) || 'archivo'] || 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `style="font-family:var(--font,'Arial Narrow'),'Arial Narrow',sans-serif;font-weight:900;font-variation-settings:'wdth' ${wd}" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`;
}

// makeSticker({ kind, text, palette, seed }) -> { svg, width, height }
// palette: a name from PALETTE_NAMES or an object { paper, ink, accent, accentInk, stamp }.
export function makeSticker({ kind = 'ticket', text = '$BLAME', palette = 'blue', seed = 0, settings = SETTINGS } = {}) {
  const k = BUILDERS[kind] ? kind : 'ticket';
  const s = cleanText(text);
  const pal = resolvePalette(palette);
  const rnd = rng(k + '|' + s + '|' + String(seed));
  const { W, H, body } = BUILDERS[k](s, pal, rnd, !s.includes(' '));
  return { svg: wrap(W, H, body, settings), width: W, height: H };
}

export function stickerTexts(settings = SETTINGS) {
  const st = (settings && settings.stickers) || {};
  const list = [...(st.tickers || []), ...(st.lines || [])].map((t) => String(t)).filter((t) => t.trim());
  return list.length ? list : ['$BLAME'];
}

// Walks a list so that consecutive seeds never repeat an item (when the list has 3+ items).
function walk(n, len) {
  if (len <= 1) return 0;
  if (len === 2) return n % 2;
  return (n + Math.floor(n / len)) % len;
}

// randomSticker(seed) -> { svg, width, height, kind, text, palette }
// Same seed -> same sticker. Consecutive integer seeds (0, 1, 2, …) change kind, palette and text every time.
export function randomSticker(seed = 0, settings = SETTINGS) {
  const n = Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31 ? seed : hash(String(seed)) % 2 ** 30;
  const texts = stickerTexts(settings);
  // fixed shuffle so the same kind of text doesn't come in runs
  const r = rng('order|' + texts.join('|'));
  const order = texts.map((t, i) => [r(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const kind = STICKER_KINDS[walk(n, STICKER_KINDS.length)];
  const palette = PALETTE_NAMES[walk(n, PALETTE_NAMES.length)];
  const text = texts[order[walk(n, texts.length)]];
  const st = makeSticker({ kind, text, palette, seed: n, settings });
  return { ...st, kind, text, palette };
}
