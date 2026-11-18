-- Blame the Stock API: launch reports and wallet links, built in small steps (Cloudflare D1, which is SQLite).
-- Works next to api/schema.sql (the launch index). Nothing here is about visitors: rows are keyed by coin or wallet.
--
-- Run once on a new database:  wrangler d1 execute bts --remote --file=api/schema-reports.sql
-- Safe to run again (IF NOT EXISTS everywhere).

-- One row per piece of heavy work, so a free-plan request (50 subrequests, 10 ms CPU) never has to do it all:
-- each request (or the minute cron) runs a few steps, saves the state here and answers "building" until done.
CREATE TABLE IF NOT EXISTS report_jobs (
  key         TEXT PRIMARY KEY,     -- 'report:<token>' or 'links:<token>' (token = lowercase 0x address)
  kind        TEXT NOT NULL,        -- 'report' | 'links'
  token       TEXT NOT NULL,        -- the coin
  status      TEXT NOT NULL,        -- 'queued' | 'building' | 'done' | 'failed'
  step        TEXT,                 -- last step run (launch, graduation, snipers, dev, fees, bridges, activity, ...)
  progress    REAL NOT NULL DEFAULT 0,   -- 0..1, shown while building
  state       TEXT NOT NULL,        -- JSON working state (facts read so far and how far each part has read)
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,     -- unix seconds
  updated_at  INTEGER NOT NULL,     -- unix seconds
  lease_until INTEGER               -- unix seconds: a request or cron run is working on it until then (NULL = free)
);
-- The cron picks up unfinished jobs, oldest first.
CREATE INDEX IF NOT EXISTS idx_report_jobs_queue ON report_jobs (kind, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_report_jobs_updated ON report_jobs (updated_at);

-- Finished answers and small facts that are expensive to read again:
--   'report:<token>'    the ReportResult (served REPORT_TTL seconds, then refreshed; an error answer for an hour)
--   'links:<token>'     the wallet-links result
--   'funder:<wallet>'   who first sent the wallet ETH (fixed once seen; Blockscout is rate-limited)
--   'fanout:<funder>:<YYYY-MM-DD>'  how many wallets that funder paid on that day (public-service check)
CREATE TABLE IF NOT EXISTS report_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,         -- JSON
  created_at INTEGER NOT NULL,      -- unix seconds (freshness is measured from here)
  expires_at INTEGER                -- unix seconds after which the row may be purged; NULL = keep
);
-- Purging expired rows reads only those rows.
CREATE INDEX IF NOT EXISTS idx_report_cache_expires ON report_cache (expires_at) WHERE expires_at IS NOT NULL;
