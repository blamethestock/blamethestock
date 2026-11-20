// Makes a fresh blame card for ANY Robinhood Chain coin, in both post sizes, from live chain data.
//
//   npm run card -- 0xCOIN_ADDRESS          (24 hours)
//   npm run card -- 0xCOIN_ADDRESS 7d       (1h, 6h, 24h or 7d)
//
// Saves cards/<date>/blame-<COIN>-<window>-1200x675.png and -1080x1080.png and prints a ready-to-post line.
// It uses the site's own code to read the chain, so the numbers match blamethestock.com.
// If the chain can't be read it stops and says why; it never makes up numbers.
import fs from 'node:fs';
import { at, readConfig, RECOMMENDED_LOGO, fetchLive, cardFromResult, OBSYN, writeProps, renderStillTo } from './lib.mjs';
import { lockupSvg, LOGOS } from './logos.mjs';
import { wordPath } from './wordmark.mjs';
import { xLength } from './check.mjs';

const [address, window = '24h'] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
  console.error('Give a coin address, like:  npm run card -- 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18');
  process.exit(1);
}
if (!['1h', '6h', '24h', '7d'].includes(window)) { console.error('Time window must be 1h, 6h, 24h or 7d.'); process.exit(1); }

console.log(`Reading ${address} from Robinhood Chain (${window})…`);
const got = await fetchLive(address, window);
if (!got.ok) {
  console.error(`Couldn't read that coin: ${got.why}. No card was made.`);
  process.exit(1);
}
const r = got.live.res;
const card = cardFromResult(r);
if (card.caseName === 'flat' || card.caseName === 'stable') console.log(`Note: ${r.verdict} (the card says so).`);

const cfg = readConfig();
const word = wordPath();
const props = {
  kit: { ...cfg, recommended: RECOMMENDED_LOGO }, cards: [card], card, copy: OBSYN, ai: { ...card }, sfx: false,
  word: Object.fromEntries(Object.keys(LOGOS).map((id) => [id, lockupSvg(id, word, { height: 200 })])),
};
// The kit's own props file is put back afterwards, so this never changes the launch images.
const propsFile = at('data/props.json');
const saved = fs.existsSync(propsFile) ? fs.readFileSync(propsFile) : null;
writeProps(props);
try {
  const dir = `cards/${card.day}`;
  const safe = card.symbol.replace(/[^A-Za-z0-9_-]/g, '') || 'COIN';
  const wide = await renderStillTo('blame-wide', at(`${dir}/blame-${safe}-${window}-1200x675.png`), { ...props, card, square: false });
  const sq = await renderStillTo('blame-square', at(`${dir}/blame-${safe}-${window}-1080x1080.png`), { ...props, card, square: true });
  const s = Math.round(card.stockShare * 100);
  const post = `$${card.symbol} ${card.coinMoveText} (${window}).\n${card.stock}'s fault: ${s}%. The coin's fault: ${100 - s}%.\n\nBlame yours: ${r.link}`;
  console.log(`\nSaved:\n  ${wide}\n  ${sq}\n\nPost text (${xLength(post)}/280):\n\n${post}\n`);
} finally {
  if (saved) fs.writeFileSync(propsFile, saved);
}
