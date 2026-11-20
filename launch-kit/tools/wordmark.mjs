// Turns the word "BLAME" into outlined shapes using the site's font at the site's headline cut
// (Archivo, width 62%, weight 900, tracking -0.018em), so logo SVG files never need the font installed.
import * as fontkit from 'fontkit';
import { fileURLToPath } from 'node:url';
const FONT = fileURLToPath(new URL('../video/public/fonts/archivo-wdth.woff2', import.meta.url));

// Returns { d, width } in a 100-unit-tall box: capitals from y=14 to y=86.
export function wordPath(text = 'BLAME', { capTop = 14, capBottom = 86 } = {}) {
  const base = fontkit.openSync(FONT);
  const font = base.getVariation({ wdth: 62, wght: 900 });
  const s = (capBottom - capTop) / font.capHeight;
  const run = font.layout(text);
  const track = -0.018 * font.unitsPerEm;
  let x = 0;
  const parts = [];
  run.glyphs.forEach((g, i) => {
    const p = g.path.scale(s, -s).translate(x * s, capBottom);
    parts.push(p.toSVG());
    x += run.positions[i].xAdvance + (i < run.glyphs.length - 1 ? track : 0);
  });
  // trim the last letter's right side bearing
  const last = run.glyphs[run.glyphs.length - 1];
  const width = (x - (last.advanceWidth - last.bbox.maxX)) * s;
  return { d: parts.join(' '), width: Math.round(width * 100) / 100 };
}
