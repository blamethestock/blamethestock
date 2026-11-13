// Tests for site/src/ui/stickers.js (SPEC 3.3). Registered with harness.js; run by dev/run-tests.sh or dev/tests/.
import { suite, test, eq, ok } from './harness.js';
import { SETTINGS } from '../../site/settings.js';
import {
  STICKER_KINDS, STICKER_COLORS, PALETTES, PALETTE_NAMES, MIN_WIDTH, MAX_WIDTH,
  makeSticker, randomSticker, stickerTexts,
} from '../../site/src/ui/stickers.js';

suite('stickers');

// --- a tiny XML checker: every tag closes, attributes quoted and unique, entities valid ---
function xmlProblem(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m, pos = 0;
  while ((m = re.exec(svg))) {
    if (m.index !== pos) return `junk at ${pos}: ${svg.slice(pos, pos + 30)}`;
    pos = re.lastIndex;
    if (m[5] !== undefined) {
      if (/&(?!amp;|lt;|gt;|quot;|#\d+;)/.test(m[5])) return 'bad entity in text';
      continue;
    }
    const names = m[3].match(/[\w:-]+(?==")/g) || [];
    if (new Set(names).size !== names.length) return `duplicate attribute on <${m[2]}>`;
    if (m[1]) { if (stack.pop() !== m[2]) return `mismatched </${m[2]}>`; }
    else if (!m[4]) stack.push(m[2]);
  }
  if (pos !== svg.length) return `trailing junk at ${pos}`;
  return stack.length ? `unclosed ${stack.join(',')}` : null;
}

const ALLOWED = new Set(STICKER_COLORS);
const rootAttr = (svg, name) => { const m = svg.match(new RegExp(`^<svg[^>]*\\s${name}="([^"]*)"`)); return m && m[1]; };
const shownText = (svg) => [...svg.matchAll(/lengthAdjust="spacingAndGlyphs"[^>]*>([^<]*)</g)].map((m) => m[1]).join(' ');
const escaped = (t) => String(t).trim().replace(/\s+/g, ' ').toUpperCase().replace(/'/g, '’')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Throws (via ok/eq) with the sticker's label in the message.
function checkSticker(label, st, { kind, palette, text } = {}) {
  const { svg, width, height } = st;
  const say = (what) => `${label}: ${what}`;
  ok(typeof svg === 'string', say('svg is a string'));
  ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), say('starts with <svg xmlns'));
  ok(svg.endsWith('</svg>'), say('ends with </svg>'));
  eq(xmlProblem(svg), null, say('well-formed'));
  ok(svg.length < 3072, say(`under 3 KB (${svg.length} bytes)`));
  ok(Number.isInteger(width) && Number.isInteger(height), say(`integer size ${width}x${height}`));
  ok(width >= MIN_WIDTH && width <= MAX_WIDTH, say(`width ${width} within ${MIN_WIDTH}-${MAX_WIDTH}`));
  ok(height >= 50 && height <= 130, say(`height ${height} within 50-130`));
  eq([rootAttr(svg, 'width'), rootAttr(svg, 'height')], [String(width), String(height)], say('width/height attributes'));
  eq(rootAttr(svg, 'viewBox'), `0 0 ${width} ${height}`, say('viewBox'));
  ok(!/NaN|Infinity|undefined|null/.test(svg), say('no NaN/Infinity/undefined'));
  // colours: every hex is one of the four; every fill/stroke is one of them or none; no tints
  const bad = (svg.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => !ALLOWED.has(h));
  eq(bad, [], say('only #2433FF #FF4F1F #FFFFFF #000000'));
  const paints = [...svg.matchAll(/\s(fill|stroke)="([^"]*)"/g)].map((m) => m[2]).filter((p) => p !== 'none' && !ALLOWED.has(p));
  eq(paints, [], say('fill/stroke values'));
  ok(!/opacity|rgb\(|hsl\(|Gradient|currentColor|="(?:red|green|blue|white|black)"/i.test(svg), say('no opacity, rgb(), named colours or gradients'));
  // self-contained and safe to inline a dozen times on one page
  ok(!/\sid=|url\(|<image|href|<script|<foreignObject|filter|<style/i.test(svg), say('no ids, urls, images, scripts, filters'));
  ok(/font-family:var\(--font,'Arial Narrow'\)[^;"]*sans-serif/.test(svg), say('site font with fallback'));
  ok(/^<svg[^>]*aria-hidden="true"/.test(svg), say('aria-hidden'));
  // text fits: unrotated runs stay inside the sticker; rotated (stamp) runs are narrower than it
  const runs = [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*textLength="([\d.]+)"([^>]*)>/g)];
  ok(runs.length >= 2, say('has text'));
  for (const r of runs) {
    const x = +r[1], tl = +r[3];
    if (/transform/.test(r[4]) || kind === 'stamp') ok(tl <= width - 16, say(`rotated text ${tl} narrower than ${width}`));
    else ok(x >= 0 && x + tl <= width + 0.05, say(`text ${x}+${tl} inside width ${width}`));
  }
  // characters XML does not allow (controls, lone surrogates) never reach the markup
  ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/u.test(svg), say('only XML-legal characters'));
  // tag string loop (a closed cubic from the hole) stays inside the sticker, casing included
  const loop = svg.match(/<path d="M([-\d.]+) ([-\d.]+)C([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)" fill="none" stroke="[^"]+" stroke-width="([\d.]+)"/);
  if (loop) {
    const [x0, y0, x1, y1, x2, y2, x3, y3, sw] = loop.slice(1).map(Number);
    let lo = Infinity, hi = -Infinity, top = Infinity, bot = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const u = i / 100, a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, d = u ** 3;
      const px = a * x0 + b * x1 + c * x2 + d * x3, py = a * y0 + b * y1 + c * y2 + d * y3;
      lo = Math.min(lo, px); hi = Math.max(hi, px); top = Math.min(top, py); bot = Math.max(bot, py);
    }
    ok(lo - sw / 2 >= 0 && hi + sw / 2 <= width && top - sw / 2 >= 0 && bot + sw / 2 <= height,
      say(`tag string ${(lo - sw / 2).toFixed(2)}..${(hi + sw / 2).toFixed(2)} x ${(top - sw / 2).toFixed(2)}..${(bot + sw / 2).toFixed(2)} inside ${width}x${height}`));
  }
  if (text !== undefined) eq(shownText(svg), escaped(text), say('shows its text'));
  const pal = typeof palette === 'string' ? PALETTES[palette] : null;
  if (pal && pal.paper === '#000000') ok(/stroke="#FFFFFF" stroke-width="2"/.test(svg), say('black sticker has a white outline'));
}

test('the checker catches broken markup', () => {
  ok(xmlProblem('<svg><g></svg>') !== null, 'unclosed tag');
  ok(xmlProblem('<svg><text>A & B</text></svg>') !== null, 'raw &');
  ok(xmlProblem('<svg width=10></svg>') !== null, 'unquoted attribute');
  ok(xmlProblem('<svg a="1" a="2"></svg>') !== null, 'duplicate attribute');
  eq(xmlProblem('<svg a="1"><path d="M0 0"/><text>A &amp; B</text></svg>'), null, 'good markup');
});

test('exports', () => {
  eq(STICKER_KINDS, ['ticket', 'tag', 'stamp']);
  eq(STICKER_COLORS, ['#2433FF', '#FF4F1F', '#FFFFFF', '#000000']);
  ok(PALETTE_NAMES.length >= 4, 'at least four palettes');
  for (const n of PALETTE_NAMES) {
    ok(Object.values(PALETTES[n]).every((c) => ALLOWED.has(c)), `palette ${n} uses only the four colours`);
    if (PALETTES[n].paper === '#000000') eq(PALETTES[n].outline, '#FFFFFF', `palette ${n} has a white outline`);
  }
  eq(stickerTexts(), [...SETTINGS.stickers.tickers, ...SETTINGS.stickers.lines], 'texts come from settings');
});

const texts = stickerTexts();
for (const kind of STICKER_KINDS) {
  test(`${kind}: every palette x text x seed is valid SVG in brand colours and size`, () => {
    for (const palette of PALETTE_NAMES) {
      for (const text of texts) {
        for (const seed of [0, 1, 42]) {
          checkSticker(`${kind}/${palette}/${text}/${seed}`, makeSticker({ kind, text, palette, seed }), { kind, palette, text });
        }
      }
    }
  });
  test(`${kind}: awkward text still fits`, () => {
    for (const text of ['X', 'BLAME THE STOCK NOT THE HOLDER EVER', 'WWWWWWWWWWWWWWWWWWWWWW', "it's a & <b>", '  spaced   out  ']) {
      checkSticker(`${kind}/${text}`, makeSticker({ kind, text, palette: 'black', seed: 3 }), { kind, palette: 'black', text });
    }
  });
}

test('long lines stack onto two lines', () => {
  const st = makeSticker({ kind: 'ticket', text: 'IT WAS THE STOCK', palette: 'blue' });
  eq((st.svg.match(/spacingAndGlyphs/g) || []).length, 2);
  eq(shownText(st.svg), 'IT WAS THE STOCK');
});

test('bad inputs fall back safely', () => {
  const odd = makeSticker({ kind: 'balloon', text: '', palette: 'rainbow', seed: 'x' });
  checkSticker('unknown kind/palette/empty text', odd, { text: '$BLAME' });
  const custom = makeSticker({ kind: 'tag', text: 'GME', palette: { paper: '#00ff00', ink: '#ff0000', accent: '#2433ff', stamp: 'red' } });
  checkSticker('palette object with off-brand colours', custom, { kind: 'tag', text: 'GME' });
  ok(!/#00ff00|#ff0000/i.test(custom.svg), 'off-brand colours replaced');
  ok(custom.svg.includes('#2433FF'), 'lowercase brand colour accepted');
  const blackObj = makeSticker({ kind: 'stamp', text: 'SPY', palette: { paper: '#000000', ink: '#FFFFFF' } });
  ok(/stroke="#FFFFFF" stroke-width="2"/.test(blackObj.svg), 'black palette object gets a white outline');
  const noArgs = makeSticker();
  checkSticker('no arguments', noArgs, { text: '$BLAME' });
  // control characters (e.g. pasted into settings by accident) become spaces, so the SVG stays valid XML
  for (const kind of STICKER_KINDS) {
    const ctl = makeSticker({ kind, text: 'NOT\u0007MY\u0000FAULT\u001b', palette: 'white', seed: 4 });
    checkSticker(`${kind} with control characters`, ctl, { kind, palette: 'white', text: 'NOT MY FAULT' });
    const lone = makeSticker({ kind, text: 'GME\uD800', palette: 'blue', seed: 4 });
    checkSticker(`${kind} with a lone surrogate`, lone, { kind, palette: 'blue', text: 'GME' });
  }
});

test('tag string never pokes outside the sticker', () => {
  // checkSticker measures the loop; run it over many seeds because its angle and length are random
  for (const text of texts) for (let seed = 0; seed < 120; seed++) {
    const st = makeSticker({ kind: 'tag', text, palette: PALETTE_NAMES[seed % PALETTE_NAMES.length], seed });
    ok(/stroke-width="3.4"/.test(st.svg), `tag/${text}/${seed} has its string`);
    checkSticker(`tag/${text}/${seed}`, st, { kind: 'tag', text });
  }
});

test('deterministic per seed', () => {
  for (const seed of [0, 1, 7, 123456, 2 ** 31 + 5, -3, 0.5, 0.987654, 'abc', '']) {
    const a = randomSticker(seed), b = randomSticker(seed);
    const label = `randomSticker(${JSON.stringify(seed)})`;
    ok(a.svg === b.svg && a.kind === b.kind && a.text === b.text && a.width === b.width, label + ' repeats exactly');
    ok(STICKER_KINDS.includes(a.kind) && texts.includes(a.text), label + ' reports kind and text');
    checkSticker(label, a, { kind: a.kind, palette: a.palette, text: a.text });
  }
  const args = { kind: 'stamp', text: 'NVDA', palette: 'white', seed: 9 };
  eq(makeSticker(args).svg, makeSticker({ ...args }).svg, 'makeSticker repeats exactly');
  ok(makeSticker({ ...args, seed: 1 }).svg !== makeSticker({ ...args, seed: 2 }).svg, 'different seeds change the details');
});

test('varies nicely', () => {
  const seen = { kind: new Set(), palette: new Set(), text: new Set(), combo: new Set() };
  let repeats = 0, prev = null;
  for (let n = 0; n < 1000; n++) {
    const s = randomSticker(n);
    if (n < 300) { seen.kind.add(s.kind); seen.palette.add(s.palette); seen.text.add(s.text); seen.combo.add(s.kind + '/' + s.palette); }
    if (prev && (prev.kind === s.kind || prev.palette === s.palette || prev.text === s.text)) repeats++;
    prev = s;
  }
  eq(seen.kind.size, STICKER_KINDS.length, 'all kinds appear');
  eq(seen.palette.size, PALETTE_NAMES.length, 'all palettes appear');
  eq(seen.text.size, texts.length, 'all texts appear');
  eq(seen.combo.size, STICKER_KINDS.length * PALETTE_NAMES.length, 'every kind x palette pairing appears');
  eq(repeats, 0, 'consecutive seeds never repeat kind, palette or text');
  const kinds = new Set();
  for (let i = 0; i < 60; i++) kinds.add(randomSticker(i / 61).kind);
  eq(kinds.size, 3, 'fractional seeds (like Math.random()) still vary');
});

test('settings drive the text', () => {
  const mine = { ...SETTINGS, stickers: { ...SETTINGS.stickers, tickers: ['AAPL'], lines: ['MY BAD'] } };
  const got = new Set();
  for (let n = 0; n < 10; n++) got.add(randomSticker(n, mine).text);
  eq([...got].sort(), ['AAPL', 'MY BAD']);
  eq(randomSticker(5, { stickers: { tickers: [], lines: [] } }).text, '$BLAME', 'empty lists fall back to $BLAME');
  eq(randomSticker(5, {}).text, '$BLAME', 'missing stickers settings fall back to $BLAME');
});
