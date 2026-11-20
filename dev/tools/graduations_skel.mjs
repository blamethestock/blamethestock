// Adds name skeletons to every graduation row, so the alert feed can match new launches against graduated coins by an
// index (no scan). Names come from the local launch index when it has the coin, else from the chain (read-only).
//   python3 dev/tools/graduations.py > dev/out/graduations.sql
//   node dev/tools/graduations_skel.mjs dev/out/graduations.sql dev/out/index/launches.sqlite > dev/out/graduations-skel.sql
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readNames } from '../../api/src/indexer.js';
import { headBlock } from '../../site/src/data/chain.js';
import { skeleton } from '../../site/src/trust/skeleton.js';

const [sqlFile, dbFile] = process.argv.slice(2);
const rows = [...fs.readFileSync(sqlFile, 'utf8').matchAll(/VALUES \('(0x[0-9a-f]{40})', (\d+), '(0x[0-9a-f]{64})'\)/g)]
  .map((m) => ({ token: m[1], block: Number(m[2]), tx: m[3] }));
const known = new Map();
if (dbFile) {
  const out = execFileSync('sqlite3', ['-json', dbFile, 'SELECT token, name, symbol FROM launches WHERE token IN (SELECT token FROM json_each(?))'.replace('?', "'" + JSON.stringify(rows.map((r) => r.token)) + "'")], { maxBuffer: 1 << 28 }).toString();
  for (const r of (out.trim() ? JSON.parse(out) : [])) known.set(r.token, r);
}
const todo = rows.map((r) => r.token).filter((t) => !known.has(t));
console.error(`${rows.length} graduations; ${known.size} names from the local index, ${todo.length} from the chain`);
const head = (await headBlock()).number - 20;
for (let i = 0; i < todo.length; i += 400) {
  const got = await readNames(todo.slice(i, i + 400), head);
  for (const [t, v] of got) known.set(t, { token: t, name: v.name, symbol: v.symbol });
  console.error(`  read ${Math.min(i + 400, todo.length)} / ${todo.length}`);
}
const q = (v) => (v == null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'");
console.log('DROP TABLE IF EXISTS graduations;');
console.log('CREATE TABLE graduations (token TEXT PRIMARY KEY, block INTEGER NOT NULL, tx TEXT NOT NULL, symbol TEXT, name TEXT, sym_skel TEXT, name_skel TEXT);');
console.log('CREATE INDEX IF NOT EXISTS idx_grad_sym_skel ON graduations (sym_skel);');
console.log('CREATE INDEX IF NOT EXISTS idx_grad_name_skel ON graduations (name_skel);');
for (const r of rows) {
  const k = known.get(r.token) || {};
  const ss = k.symbol == null ? null : skeleton(k.symbol);
  const ns = k.name == null ? null : skeleton(k.name);
  console.log(`INSERT OR IGNORE INTO graduations (token, block, tx, symbol, name, sym_skel, name_skel) VALUES ('${r.token}', ${r.block}, '${r.tx}', ${q(k.symbol)}, ${q(k.name)}, ${q(ss)}, ${q(ns)});`);
}
