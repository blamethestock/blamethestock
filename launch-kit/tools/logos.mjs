// The three original logo marks for Blame the Stock, drawn on a 100 x 100 grid.
// Every shape is plain geometry (no fonts, no images), so each mark works in pure black and white
// and stays clear at 32 px. Colour versions use the site's two accents: blue = the stock, orange = the coin.
//
// Which mark the kit uses is set in launch-kit/config.json ("logo": "A" | "B" | "C").

export const BRAND = {
  bg: '#000000',
  fg: '#FFFFFF',
  grey: '#8B8B8B',
  stock: '#2433FF',   // site: --pair
  coin: '#FF4F1F',    // site: --coin
};

// Each mark returns SVG shapes for the 100 x 100 box. `c` = { fg, stock, coin, bg } (pass fg for all three to get pure B/W).
export const LOGOS = {
  A: {
    name: 'Point',
    idea: 'A fist with its finger pointed straight at a candlestick: "it was the stock".',
    shapes: (c) => `
      <rect x="17" y="27" width="25" height="15" rx="7" fill="${c.fg}"/>
      <rect x="17" y="36.5" width="18" height="3" fill="${c.bg}"/>
      <rect x="4" y="38" width="40" height="46" rx="11" fill="${c.fg}"/>
      <rect x="34" y="38" width="40" height="14" rx="7" fill="${c.fg}"/>
      <rect x="15" y="56" width="31" height="4" fill="${c.bg}"/>
      <rect x="15" y="68" width="31" height="4" fill="${c.bg}"/>
      <rect x="85" y="10" width="6" height="80" fill="${c.stock}"/>
      <rect x="79" y="24" width="18" height="48" rx="2" fill="${c.stock}"/>`,
  },
  B: {
    name: 'B-arrow',
    idea: 'A heavy "B" whose spine shoots up into an arrow: the pump that left without you.',
    shapes: (c) => `
      <g transform="translate(7 0)">
      <polygon fill="${c.coin}" points="25,3 6,27 44,27"/>
      <rect x="15" y="26" width="20" height="10" fill="${c.coin}"/>
      <rect x="15" y="36" width="20" height="58" fill="${c.fg}"/>
      <path fill-rule="evenodd" fill="${c.fg}" d="M33 36 H59 A14 14 0 0 1 59 64 H33 Z M33 45 H57 A5 5 0 0 1 57 55 H33 Z"/>
      <path fill-rule="evenodd" fill="${c.fg}" d="M33 60 H62 A17 17 0 0 1 62 94 H33 Z M33 70 H60 A7 7 0 0 1 60 84 H33 Z"/>
      </g>`,
  },
  C: {
    name: 'Split candle',
    idea: 'One candlestick cut in two, like the site\'s split bar: the stock\'s part and the coin\'s part.',
    shapes: (c) => `
      <rect x="46.5" y="6" width="7" height="88" fill="${c.fg}"/>
      <rect x="22" y="22" width="56" height="56" fill="${c.bg}"/>
      <rect x="22" y="22" width="22" height="56" rx="3" fill="${c.stock}"/>
      <rect x="50" y="22" width="28" height="56" rx="3" fill="${c.coin}"/>`,
  },
};

const colours = (color) => (color
  ? { fg: BRAND.fg, stock: BRAND.stock, coin: BRAND.coin, bg: BRAND.bg }
  : { fg: BRAND.fg, stock: BRAND.fg, coin: BRAND.fg, bg: BRAND.bg });

// A complete SVG: the mark centred on a square, taking up `scale` of the side (0..1).
//   bg: background colour or null (transparent). round: corner radius as a fraction of the side.
export function markSvg(id, { size = 1000, scale = 0.62, color = true, bg = BRAND.bg, round = 0 } = {}) {
  const logo = LOGOS[id];
  if (!logo) throw new Error(`Unknown logo "${id}" (use A, B or C)`);
  const c = colours(color);
  if (bg === null) c.bg = BRAND.bg;     // knock-outs still need a colour; transparent marks sit on black anyway
  const off = (100 - 100 * scale) / 2 / scale;   // margin in mark units
  const vb = 100 + 2 * off;
  const back = bg === null ? '' : `<rect x="${-off}" y="${-off}" width="${vb}" height="${vb}" rx="${round * vb}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-off} ${-off} ${vb} ${vb}">${back}${logo.shapes(c)}</svg>`;
}

// Mark + outlined "BLAME" wordmark side by side (wordPath comes from tools/wordmark.mjs, already in mark units).
export function lockupSvg(id, word, { color = true, height = 200, bg = BRAND.bg } = {}) {
  const c = colours(color);
  const gap = 18, pad = 14;
  const w = 100 + gap + word.width;
  const vbW = w + pad * 2, vbH = 100 + pad * 2;
  const back = bg === null ? '' : `<rect x="${-pad}" y="${-pad}" width="${vbW}" height="${vbH}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(height * vbW / vbH)}" height="${height}" viewBox="${-pad} ${-pad} ${vbW} ${vbH}">${back}${LOGOS[id].shapes(c)}<path transform="translate(${100 + gap} 0)" fill="${c.fg}" d="${word.d}"/></svg>`;
}
