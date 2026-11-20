// Fetches live numbers for blame cards using the SITE'S OWN code (site/src/data + site/src/core).
// Usage: node tools/fetch-live.mjs <address> [window]   -> prints JSON
import { fetchPriceInput } from '../../site/src/data/index.js';
import { buildResult } from '../../site/src/core/verdict.js';
const [addr, win = '24h'] = process.argv.slice(2);
const pi = await fetchPriceInput(addr, win);
let res = null;
try { res = pi.ok === false ? null : buildResult(pi); } catch (e) { res = { error: String(e) }; }
console.log(JSON.stringify({ pi, res }, null, 1));
