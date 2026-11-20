-- Blame the Stock API: the Pons launch index (Cloudflare D1, which is SQLite).
-- One row per TokenLaunched event from any known Pons factory (list in api/src/env.js).
-- The same file builds the local SQLite file used by dev/tools/backfill_launches.py,
-- so the backfill and the Worker always share one table layout.
--
-- Run once on a new database:  wrangler d1 execute bts --remote --file=api/schema.sql
-- Safe to run again (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS launches (
  token                TEXT PRIMARY KEY,   -- launched coin, lowercase 0x address (TokenLaunched topic1)
  factory              TEXT NOT NULL,      -- factory that emitted the event (log address)
  curve                TEXT NOT NULL,      -- bonding curve (topic2)
  creator              TEXT NOT NULL,      -- direct caller of the factory (topic3); Multicall3 for 5k+ launches
  tx_from              TEXT,               -- sender of the launch tx; always filled when creator is Multicall3
                                           -- (then it is the dev), may be NULL otherwise (then dev = creator)
  pair_token           TEXT NOT NULL,      -- data word 0; 0x000…000 = native ETH
  graduation_threshold TEXT NOT NULL,      -- data word 2, uint256 as a decimal string (pair-token units)
  block                INTEGER NOT NULL,   -- launch block
  log_index            INTEGER,            -- position of the event in the block (same-block order)
  time                 INTEGER,            -- launch block timestamp, unix seconds (logs carry none)
  tx                   TEXT NOT NULL,      -- launch transaction hash
  name                 TEXT,               -- name() as read from the chain (hidden characters kept);
                                           -- NULL = not read yet (retried), '' = the token returns none
  symbol               TEXT,               -- symbol(), same rules as name
  sym_skel             TEXT,               -- skeleton(symbol) from site/src/trust/skeleton.js
  name_skel            TEXT                -- skeleton(name), same function
);

CREATE INDEX IF NOT EXISTS idx_launches_sym_skel  ON launches (sym_skel);
CREATE INDEX IF NOT EXISTS idx_launches_name_skel ON launches (name_skel);
CREATE INDEX IF NOT EXISTS idx_launches_creator   ON launches (creator);
CREATE INDEX IF NOT EXISTS idx_launches_tx_from   ON launches (tx_from);
CREATE INDEX IF NOT EXISTS idx_launches_block     ON launches (block);
-- Rows whose name or symbol is not read yet (the minute indexer retries them). Partial, so it stays tiny and the
-- retry query reads only those rows instead of walking the whole table every minute (D1 bills rows read).
-- The WHERE must stay word for word the same as SQL_PENDING_NAMES in api/src/indexer.js, or SQLite won't use it.
CREATE INDEX IF NOT EXISTS idx_launches_pending   ON launches (block) WHERE name IS NULL OR symbol IS NULL;

-- Small key/value table for the indexer's progress. Values are text; block numbers are decimal strings.
--   last_block    newest block whose launches are all in the table (the minute indexer moves it up)
--   oldest_block  oldest block of the unbroken indexed range (the backfill moves it down)
--   last_run      unix seconds of the last indexer run that wrote its progress
-- The index is complete when oldest_block <= INDEX_FLOOR (api/src/env.js).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pons graduations (factory graduation logs): the copycat-alert feed compares new launches with these coins.
CREATE TABLE IF NOT EXISTS graduations (token TEXT PRIMARY KEY, block INTEGER NOT NULL, tx TEXT NOT NULL,
  symbol TEXT, name TEXT, sym_skel TEXT, name_skel TEXT);
CREATE INDEX IF NOT EXISTS idx_grad_sym_skel ON graduations (sym_skel);
CREATE INDEX IF NOT EXISTS idx_grad_name_skel ON graduations (name_skel);
