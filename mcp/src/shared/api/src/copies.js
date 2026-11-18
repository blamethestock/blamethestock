// Copy check ("Is this the real one?") on the API Worker: the launch index part only.
//
//   copyMatches({ query, db, settings, now, hint }) -> listing | ErrorResult
//     query   a ticker ('OBSYN', '$obsyn') or a token address (0x + 40 hex)
//     db      the D1 binding with the launch index (api/schema.sql), or an index object
//             { findByToken(addr), findBySkeletons(keys, limit), state() } (tests use one)
//     hint    { name, symbol } for an address the index doesn't have yet (the browser read them from the chain)
//
// The listing holds every same-name Pons launch from D1 (token, names, match kind, official, factory, curve,
// launch tx/block/time, launch creator and tx sender, pair token, proof links) with status 'done' and
// facts: 'client'. No chain facts: the official Robinhood Chain RPC answers HTTP 429 to every call from
// Cloudflare's network, so the website reads them in the visitor's browser (site/src/trust/copycheck.js
// completeCopies) and the local MCP package reads them on the user's machine.
//
// copyCheck (both halves, reading the chain from wherever it runs) is re-exported for the tests.
import { listMatches, FACTS_NOTE } from '../../site/src/trust/copycheck.js';

export { copyCheck, listMatches, completeCopies, runCopyCheck, MAX_ROWS, PRERANK_ROWS, MAX_KEYS, FACTS_NOTE } from '../../site/src/trust/copycheck.js';

const COLS = 'token, factory, curve, creator, tx_from, pair_token, block, log_index, time, tx, name, symbol, sym_skel, name_skel';
const BLOCK_SECONDS = 0.1045;

// The D1 launch index (api/schema.sql) as an index object.
export function d1Index(db) {
  return {
    async findByToken(addr) {
      return (await db.prepare('SELECT ' + COLS + ' FROM launches WHERE token = ?1').bind(addr).first()) || null;
    },
    async findBySkeletons(keys, limit = 500) {
      if (!keys.length) return [];
      const ph = keys.map((_, i) => '?' + (i + 1)).join(', ');
      const sql = 'SELECT ' + COLS + ' FROM launches WHERE sym_skel IN (' + ph + ') OR name_skel IN (' + ph + ')'
        + ' ORDER BY block DESC LIMIT ' + Math.max(1, Math.floor(limit));
      const res = await db.prepare(sql).bind(...keys).all();
      return (res && res.results) || [];
    },
    async state() {
      const res = await db.prepare('SELECT key, value FROM meta').all();
      const m = {};
      for (const r of (res && res.results) || []) m[r.key] = Number(r.value);
      const ok = (v) => (Number.isFinite(v) ? v : null);
      // the first launch of the unbroken indexed range (a stray older row doesn't count), same as /v1/health
      const oldest = Number.isFinite(m.oldest_block)
        ? await db.prepare('SELECT block, time FROM launches WHERE block >= ?1 ORDER BY block ASC LIMIT 1').bind(m.oldest_block).first()
        : await db.prepare('SELECT block, time FROM launches ORDER BY block ASC LIMIT 1').first();
      // about when last_block was made: the newest launch at or before it, plus ~0.1 s a block since
      let lastBlockTime = null;
      if (Number.isFinite(m.last_block)) {
        try {
          const r = await db.prepare('SELECT block, time FROM launches WHERE block <= ?1 ORDER BY block DESC LIMIT 1').bind(m.last_block).first();
          if (r && Number.isFinite(Number(r.time))) lastBlockTime = Math.round(Number(r.time) + (m.last_block - Number(r.block)) * BLOCK_SECONDS);
        } catch (e) { lastBlockTime = null; }
      }
      return { lastBlock: ok(m.last_block), oldestBlock: ok(m.oldest_block), lastRun: ok(m.last_run), oldestTime: oldest ? ok(Number(oldest.time)) : null, lastBlockTime };
    },
  };
}
const asIndex = (db) => (!db ? null : typeof db.findBySkeletons === 'function' ? db : typeof db.prepare === 'function' ? d1Index(db) : null);

export async function copyMatches({ query, db, settings = null, now = Date.now(), hint = null } = {}) {
  const r = await listMatches({ query, index: asIndex(db), settings, now, hint });
  if (!r || r.ok !== true) return r;
  return { ...r, facts: 'client', factsNote: FACTS_NOTE };
}
