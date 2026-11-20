#!/usr/bin/env node
// Launch day: ONE command sets the official $BLAME contract address (and the dev wallet) everywhere.
//
//   node dev/tools/set_launch.mjs <CA> [DEV_WALLET] [--check-only]
//
// 1. Checks the CA on Robinhood Chain: it must be a contract whose name() is "Blame the Stock" and symbol() "BLAME".
//    Anything else stops here and changes nothing.
// 2. Writes it into: site/settings.js (token.contractAddress / token.devWallet: badge, Copy, Blockscout link,
//    Receipts, and the API's official coin), README.md (the "Official $BLAME CA" line) and launch-kit/config.json.
// Then run dev/tools/sync_mcp.sh and the tests, deploy the API and the site, and push.
// Read-only on the chain: it only calls name(), symbol() and eth_getCode. No wallet, no keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const RPCS = ['https://robinhood.drpc.org', 'https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'];
const WANT = { name: 'Blame the Stock', symbol: 'BLAME' };

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const checkOnly = process.argv.includes('--check-only');
const [ca, dev = ''] = args.map((a) => a.trim());
const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };
if (!ADDR.test(ca || '')) die(`That isn't a contract address (0x + 40 characters): ${ca || '(nothing)'}`);
if (dev && !ADDR.test(dev)) die(`That isn't a wallet address (0x + 40 characters): ${dev}`);
if (dev && dev.toLowerCase() === ca.toLowerCase()) die('The dev wallet is the same as the contract address.');

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Error(`Robinhood Chain didn't answer (${last && last.message})`);
}
function abiString(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 128) return null;
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

const code = await rpc('eth_getCode', [ca, 'latest']);
if (!code || code === '0x') die(`${ca} has no contract on Robinhood Chain. Wrong address, or the launch isn't confirmed yet.`);
const name = abiString(await rpc('eth_call', [{ to: ca, data: '0x06fdde03' }, 'latest']));
const symbol = abiString(await rpc('eth_call', [{ to: ca, data: '0x95d89b41' }, 'latest']));
console.log(`On chain: name "${name}", symbol "${symbol}"`);
const problems = [];
if (name !== WANT.name) problems.push(`name is "${name}", expected "${WANT.name}"`);
if (symbol !== WANT.symbol) problems.push(`symbol is "${symbol}", expected "${WANT.symbol}"`);
if (problems.length) die(`WRONG COIN, nothing changed: ${problems.join('; ')}.`);
console.log('✓ Name and symbol match.');
if (dev) {
  const devCode = await rpc('eth_getCode', [dev, 'latest']);
  if (devCode && devCode !== '0x') console.log('⚠ The dev wallet address is a contract, not a normal wallet. Double-check it.');
}
if (checkOnly) process.exit(0);

function edit(rel, fn) {
  const p = path.join(ROOT, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) die(`Couldn't find the place to write in ${rel}; nothing more changed.`);
  fs.writeFileSync(p, after);
  console.log('✓ ' + rel);
}
const sub = (re, val) => (s) => { if (!re.test(s)) die(`Pattern not found: ${re}`); return s.replace(re, val); };

edit('site/settings.js', (s) => {
  s = sub(/(\n    contractAddress: )"[^"]*"/, `$1"${ca}"`)(s);
  return dev ? sub(/(\n    devWallet: )"[^"]*"/, `$1"${dev}"`)(s) : s;
});
edit('README.md', sub(/\*\*Official \$BLAME CA:\*\*.*/,
  `**Official $BLAME CA:** \`${ca}\` ([Blockscout](https://robinhoodchain.blockscout.com/token/${ca}))`));
edit('launch-kit/config.json', (s) => {
  const cfg = JSON.parse(s);
  cfg.ca = ca;
  if (dev) cfg.receipts = { ...(cfg.receipts || {}), devWallet: dev };
  return JSON.stringify(cfg, null, 2) + '\n';
});
console.log('\nNext: sh dev/tools/sync_mcp.sh && sh dev/run-tests.sh');
