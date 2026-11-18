#!/usr/bin/python3 -I
"""Backfill of the Pons launch index, newest first, into a local SQLite file (same tables as api/schema.sql).

Read-only on Robinhood Chain. Paced for the public RPCs (backs off on HTTP 429). Resumable: progress lives in
the file's own `meta` table (last_block / oldest_block, like D1), so running `run` again carries on where it
stopped. Python 3.9 standard library only; skeletons come from site/src/trust/skeleton.js run with jsc, so they
are identical to the Worker's and the copy check's.

Usage (DB = path of the local SQLite file, e.g. a scratch folder):
  python3 -I dev/tools/backfill_launches.py DB run [--days D | --down-to BLOCK] [--to BLOCK] [--minutes M] [--pace S]
      Index from the head (or --to) down to --down-to (default: INDEX_FLOOR = everything), newest first.
      A later run first fills the gap from its last top up to the new head, then carries on down.
  python3 -I dev/tools/backfill_launches.py DB export OUT_DIR [--rows 5000] [--per-insert 100]
      Writes D1-ready SQL files (INSERT OR REPLACE, newest first, ~5,000 rows per file) plus meta.sql,
      which moves D1's cursor only where it joins on. Run meta.sql last:
        wrangler d1 execute bts --remote --file=OUT_DIR/launches-0001.sql   (… each file, then meta.sql)
  python3 -I dev/tools/backfill_launches.py DB reskel [--all]
      Fills missing skeletons (or recomputes all with --all, e.g. after skeleton.js changed).
  python3 -I dev/tools/backfill_launches.py DB status
  python3 -I dev/tools/backfill_launches.py DB add-block BLOCK
      Adds the launches of one block without moving the progress cursor (used for test fixtures).
  python3 -I dev/tools/backfill_launches.py DB fixture OUT.json --tokens 0xa,0xb [--n 50]
      Saves ~n rows around the given tokens (plus one Multicall3 launch) and their raw logs as a test fixture.
  python3 -I dev/tools/backfill_launches.py WORKDIR check
      Offline self-check (no network): runs the Worker's SQL from api/src/indexer.js on a real SQLite with
      api/schema.sql (the fake D1 in dev/tests/indexer.test.js copies these rules), and this script's decoding
      against the test fixture. WORKDIR is a scratch folder for one small helper file.
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ENV_JS = os.path.join(ROOT, 'api', 'src', 'env.js')
CONSTANTS_JS = os.path.join(ROOT, 'site', 'src', 'data', 'constants.js')
SCHEMA = os.path.join(ROOT, 'api', 'schema.sql')
SKELETON_JS = os.path.join(ROOT, 'site', 'src', 'trust', 'skeleton.js')
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'
UA = 'Mozilla/5.0 (compatible; blamethestock)'

# ---- constants: read from the Worker's env.js (one source of truth) ---------------------------------------


def _load_constants():
    env = open(ENV_JS, encoding='utf-8').read()
    consts = open(CONSTANTS_JS, encoding='utf-8').read()

    def one(pattern, text, what):
        m = re.search(pattern, text, re.S)
        if not m:
            sys.exit('could not read %s from %s' % (what, ENV_JS))
        return m.group(1)
    block = one(r'export const FACTORIES = \[(.*?)\n\];', env, 'FACTORIES').replace('\n', ' ')
    factories = re.findall(r"address: '(0x[0-9a-f]{40})'", block)
    rpc = dict(re.findall(r"(\w+):\s*\{\s*url:\s*'(https://[^']+)'", consts))
    return {
        'factories': factories,
        'topic': one(r"TOPIC_TOKEN_LAUNCHED = '(0x[0-9a-f]{64})'", env, 'TOPIC_TOKEN_LAUNCHED'),
        'multicall3': one(r"MULTICALL3 = '(0x[0-9a-f]{40})'", env, 'MULTICALL3'),
        'floor': int(one(r'INDEX_FLOOR = (\d+)', env, 'INDEX_FLOOR')),
        'confirmations': int(one(r'CONFIRMATIONS = (\d+)', env, 'CONFIRMATIONS')),
        'span_one': int(one(r'LOG_SPAN_ONE = (\d+)', env, 'LOG_SPAN_ONE')),
        'span_many': int(one(r'LOG_SPAN_MANY = (\d+)', env, 'LOG_SPAN_MANY')),
        'cap': int(one(r'LOG_CAP = (\d+)', env, 'LOG_CAP')),
        'names_per_call': int(one(r'NAMES_PER_CALL = (\d+)', env, 'NAMES_PER_CALL')),
        'rpc': rpc,
    }


C = _load_constants()
SEL_NAME, SEL_SYMBOL, SEL_AGGREGATE3 = '0x06fdde03', '0x95d89b41', '0x82ad56cb'
COLUMNS = ['token', 'factory', 'curve', 'creator', 'tx_from', 'pair_token', 'graduation_threshold',
           'block', 'log_index', 'time', 'tx', 'name', 'symbol', 'sym_skel', 'name_skel']
MAX_TEXT = 200


def log(msg):
    print(time.strftime('%H:%M:%S ') + msg, flush=True)

# ---- JSON-RPC with pacing and backoff --------------------------------------------------------------------


class RpcError(Exception):
    def __init__(self, msg, over_cap=False, retryable=False):
        Exception.__init__(self, msg)
        self.over_cap = over_cap
        self.retryable = retryable


RETRYABLE = re.compile(r'unknown state|first available state|timeout|timed out|rate|too many requests|busy|'
                       r'temporar|try again|internal|header not found|upstream|unavailable|overload|capacity|'
                       r'throttl|429|gateway')
OVER_CAP = re.compile(r'more than \d+ (results|logs)|too many (results|logs)|response size|'
                      r'exceed(s|ed)? .*(results|logs|limit)|log response')


class Rpc:
    """Small JSON-RPC client: one request at a time per endpoint, a minimum gap between requests,
    3+2i s waits after HTTP 429, retries on the same retryable errors the site's rpc.js knows."""

    def __init__(self, pace=0.35):
        self.pace = {'official': pace, 'drpc': max(0.15, pace / 2), 'publicnode': pace}
        self.batch_max = {'official': 8, 'drpc': 3, 'publicnode': 10}
        self.last = {}
        self.requests = 0
        self.waits_429 = 0

    def _post(self, ep, body, tries=8):
        url = C['rpc'][ep]
        data = json.dumps(body).encode()
        for i in range(tries):
            gap = self.pace[ep] - (time.time() - self.last.get(ep, 0))
            if gap > 0:
                time.sleep(gap)
            self.last[ep] = time.time()
            self.requests += 1
            req = urllib.request.Request(url, data=data, headers={'content-type': 'application/json', 'user-agent': UA})
            try:
                with urllib.request.urlopen(req, timeout=40) as res:
                    return json.loads(res.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                if e.code == 400:
                    try:
                        parsed = json.loads(e.read().decode('utf-8'))
                        items = parsed if isinstance(parsed, list) else [parsed]
                        if items and all(isinstance(x, dict) and 'error' in x for x in items):
                            return parsed
                    except Exception:
                        pass
                if e.code == 429:
                    self.waits_429 += 1
                    wait = 3 + 2 * i
                    log('  %s said 429 (too many requests); waiting %d s' % (ep, wait))
                    time.sleep(wait)
                    continue
                if e.code >= 500 or e.code == 408:
                    time.sleep(1 + i)
                    continue
                raise RpcError('HTTP %d from %s' % (e.code, ep))
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                time.sleep(1 + i)
                continue
        raise RpcError('%s did not answer after %d tries' % (ep, tries), retryable=True)

    def call(self, ep, method, params, tries=8):
        """One call; JSON-RPC errors that are retryable are retried, over-cap raises RpcError(over_cap)."""
        for i in range(tries):
            res = self._post(ep, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, tries)
            if isinstance(res, list):
                res = res[0] if res else {}
            if 'error' not in res:
                return res.get('result')
            msg = str(res['error'].get('message', res['error']))
            low = msg.lower()
            if OVER_CAP.search(low):
                raise RpcError(msg, over_cap=True)
            if RETRYABLE.search(low) and 'revert' not in low:
                time.sleep(0.5 + i)
                continue
            raise RpcError('%s: %s' % (ep, msg))
        raise RpcError('%s kept failing: %s' % (ep, method), retryable=True)

    def batch(self, ep, calls, tries=6):
        """calls: [(method, params)] -> results (None where the node gave an error)."""
        out = [None] * len(calls)
        size = self.batch_max[ep]
        for start in range(0, len(calls), size):
            pending = list(range(start, min(len(calls), start + size)))
            for i in range(tries):
                if not pending:
                    break
                body = [{'jsonrpc': '2.0', 'id': k, 'method': calls[k][0], 'params': calls[k][1]} for k in pending]
                res = self._post(ep, body, tries)
                res = res if isinstance(res, list) else [res]
                by_id = {r.get('id'): r for r in res if isinstance(r, dict)}
                again = []
                for k in pending:
                    r = by_id.get(k)
                    if r is not None and 'error' not in r and 'result' in r:
                        out[k] = r['result']
                    elif r is None or RETRYABLE.search(str(r.get('error', '')).lower()):
                        again.append(k)
                pending = again
                if pending:
                    time.sleep(0.5 + i)
        return out

# ---- decoding (mirrors api/src/indexer.js) ---------------------------------------------------------------


def addr(word):
    return '0x' + word.lower().replace('0x', '').rjust(64, '0')[-40:]


def word_at(data, i):
    h = data[2:] if data.startswith('0x') else data
    w = h[64 * i:64 * i + 64]
    return int(w, 16) if len(w) == 64 else 0


def decode_launch_log(lg):
    t = lg.get('topics') or []
    if lg.get('removed') or len(t) != 4 or t[0].lower() != C['topic'] or lg['address'].lower() not in C['factories']:
        return None
    data = lg.get('data') or '0x'
    if len(data.replace('0x', '')) < 192:
        return None
    return {
        'token': addr(t[1]), 'factory': lg['address'].lower(), 'curve': addr(t[2]), 'creator': addr(t[3]),
        'pair_token': addr(data[2:66]), 'graduation_threshold': str(word_at(data, 2)),
        'block': int(lg['blockNumber'], 16), 'log_index': int(lg['logIndex'], 16), 'tx': lg['transactionHash'].lower(),
    }


CONTROL = re.compile('[\x00-\x1f\x7f]')


def clean_text(s):
    t = CONTROL.sub('', s).strip(' ')
    return t[:MAX_TEXT]


def decode_text(hexdata):
    h = (hexdata or '').lower()
    h = h[2:] if h.startswith('0x') else h
    if not re.fullmatch('[0-9a-f]*', h) or len(h) % 2:
        return ''
    raw = bytes.fromhex(h)
    n = len(raw)
    if n >= 64:
        off = int.from_bytes(raw[0:32], 'big')
        if off % 32 == 0 and off + 32 <= n:
            ln = int.from_bytes(raw[off:off + 32], 'big')
            if ln <= 4096 and off + 32 + ln <= n:
                return clean_text(raw[off + 32:off + 32 + ln].decode('utf-8', 'replace'))
    if n == 32:
        end = raw.find(b'\x00')
        return clean_text((raw if end < 0 else raw[:end]).decode('utf-8', 'replace'))
    return ''


def _w(n):
    return '%064x' % n


def encode_aggregate3(calls):
    tuples = []
    for target, data in calls:
        d = data.replace('0x', '')
        padded = d.ljust(-(-len(d) // 64) * 64, '0')
        tuples.append(_w(int(target, 16)) + _w(1) + _w(0x60) + _w(len(d) // 2) + padded)
    head, off = '', 32 * len(tuples)
    for t in tuples:
        head += _w(off)
        off += len(t) // 2
    return SEL_AGGREGATE3 + _w(0x20) + _w(len(tuples)) + head + ''.join(tuples)


def decode_aggregate3(hexdata):
    h = hexdata[2:] if hexdata.startswith('0x') else hexdata

    def at(b):
        return int(h[b * 2:b * 2 + 64] or '0', 16)
    arr = at(0)
    n = at(arr)
    base = arr + 32
    out = []
    for i in range(n):
        t = base + at(base + 32 * i)
        ok = at(t) != 0
        b = t + at(t + 32)
        ln = at(b)
        if (b + 32 + ln) * 2 > len(h):
            raise RpcError('aggregate3: short answer')
        out.append((ok, '0x' + h[(b + 32) * 2:(b + 32 + ln) * 2]))
    return out

# ---- skeletons via jsc (the same skeleton.js the Worker imports) -----------------------------------------


class Skeleton:
    def __init__(self, workdir):
        self.ok = os.path.exists(SKELETON_JS) and os.path.exists(JSC)
        self.workdir = workdir
        self.warned = False
        self.runner = os.path.join(workdir, 'skel_runner.mjs')
        if self.ok:
            with open(self.runner, 'w', encoding='utf-8') as f:
                f.write("import { skeleton } from %s;\n" % json.dumps(SKELETON_JS))
                f.write("const list = JSON.parse(read(arguments[0]));\n")
                f.write("print(JSON.stringify(list.map((s) => (s === null ? null : skeleton(s)))));\n")

    def many(self, texts):
        """list of str|None -> list of skeletons (None where the text is None, or when skeleton.js is missing)."""
        if not texts:
            return []
        if not self.ok:
            if not self.warned:
                log('  note: %s not found yet; skeleton columns stay empty (run "reskel" later)' % SKELETON_JS)
                self.warned = True
            return [None] * len(texts)
        fd, path = tempfile.mkstemp(suffix='.json', dir=self.workdir)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(texts, f, ensure_ascii=True)
            res = subprocess.run([JSC, '-m', self.runner, '--', path], capture_output=True, timeout=300)
            if res.returncode != 0:
                raise RuntimeError('jsc failed: ' + res.stderr.decode('utf-8', 'replace')[:300])
            out = json.loads(res.stdout.decode('utf-8'))
            if len(out) != len(texts):
                raise RuntimeError('jsc returned %d skeletons for %d texts' % (len(out), len(texts)))
            return out
        finally:
            os.unlink(path)

# ---- the chain side ----------------------------------------------------------------------------------------


class Chain:
    def __init__(self, rpc):
        self.rpc = rpc

    def head(self):
        return int(self.rpc.call('official', 'eth_blockNumber', []), 16)

    def block_time(self, n):
        b = self.rpc.call('official', 'eth_getBlockByNumber', [hex(n), False])
        return int(b['timestamp'], 16)

    def logs_split(self, address, a, b, depth=0):
        flt = {'address': address, 'topics': [C['topic']], 'fromBlock': hex(a), 'toBlock': hex(b)}
        try:
            res = self.rpc.call('official', 'eth_getLogs', [flt])
            if res is None or len(res) >= C['cap']:
                raise RpcError('at the cap', over_cap=True)
            return res
        except RpcError as e:
            if not e.over_cap or b <= a or depth > 40:
                raise
            mid = (a + b) // 2
            return self.logs_split(address, a, mid, depth + 1) + self.logs_split(address, mid + 1, b, depth + 1)

    def launch_logs(self, a, b):
        """All factories, [a, b]. Short ranges in one call, long ones per factory in 10M pieces."""
        if b - a <= C['span_many']:
            return self.logs_split(C['factories'], a, b)
        out = []
        for f in C['factories']:
            x = a
            while x <= b:
                out += self.logs_split(f, x, min(b, x + C['span_one']))
                x += C['span_one'] + 1
        return out

    def tx_from(self, hashes):
        hashes = sorted(set(hashes))
        out = {}
        for ep in ('official', 'drpc'):
            todo = [h for h in hashes if h not in out]
            if not todo:
                break
            res = self.rpc.batch(ep, [('eth_getTransactionByHash', [h]) for h in todo])
            for h, r in zip(todo, res):
                if r and r.get('from'):
                    out[h] = r['from'].lower()
        missing = [h for h in hashes if h not in out]
        if missing:
            raise RpcError('launch transactions unavailable (%d)' % len(missing), retryable=True)
        return out

    def times(self, blocks):
        blocks = sorted(set(blocks))
        out = {}
        for ep in ('official', 'drpc'):
            todo = [n for n in blocks if n not in out]
            if not todo:
                break
            res = self.rpc.batch(ep, [('eth_getBlockByNumber', [hex(n), False]) for n in todo])
            for n, r in zip(todo, res):
                if r and r.get('timestamp'):
                    out[n] = int(r['timestamp'], 16)
        missing = [n for n in blocks if n not in out]
        if missing:
            raise RpcError('block headers unavailable (%d)' % len(missing), retryable=True)
        return out

    def names(self, tokens, block):
        """token -> [name, symbol]; text, '' (nothing readable) or None (not known yet)."""
        out = {t: [None, None] for t in tokens}
        size = C['names_per_call']
        for i in range(0, len(tokens), size):
            chunk = tokens[i:i + size]
            data = encode_aggregate3([(t, s) for t in chunk for s in (SEL_NAME, SEL_SYMBOL)])
            for ep, at, final in (('drpc', hex(block), True), ('official', 'latest', False)):
                try:
                    res = decode_aggregate3(self.rpc.call(ep, 'eth_call', [{'to': C['multicall3'], 'data': data}, at], tries=5) or '0x')
                except RpcError:
                    continue
                if len(res) != 2 * len(chunk):
                    continue
                open_items = 0
                for j, t in enumerate(chunk):
                    cur = out[t]
                    for k in (0, 1):
                        if cur[k] is not None:
                            continue
                        ok, rd = res[2 * j + k]
                        if not ok:
                            cur[k] = ''
                        elif rd == '0x' and not final:
                            open_items += 1
                        else:
                            cur[k] = decode_text(rd)
                if not open_items:
                    break
        return out

    def rows(self, a, b, skel):
        """Every launch in [a, b] as table rows (sorted by block, log index)."""
        seen, launches = set(), []
        for lg in self.launch_logs(a, b):
            d = decode_launch_log(lg)
            if d and d['token'] not in seen:
                seen.add(d['token'])
                launches.append(d)
        launches.sort(key=lambda d: (d['block'], d['log_index']))
        if not launches:
            return []
        mc = [d['tx'] for d in launches if d['creator'] == C['multicall3']]
        senders = self.tx_from(mc) if mc else {}
        names = self.names([d['token'] for d in launches], b)
        times = self.times([d['block'] for d in launches])
        texts = []
        for d in launches:
            texts += names[d['token']]
        skels = skel.many(texts)
        rows = []
        for i, d in enumerate(launches):
            nm, sy = names[d['token']]
            row = dict(d)
            row.update(tx_from=senders.get(d['tx']), time=times[d['block']], name=nm, symbol=sy,
                       name_skel=skels[2 * i], sym_skel=skels[2 * i + 1])
            rows.append(row)
        return rows

# ---- the local database --------------------------------------------------------------------------------------


def open_db(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(open(SCHEMA, encoding='utf-8').read())
    return db


def meta_get(db, key):
    r = db.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
    return int(r[0]) if r and re.fullmatch(r'-?\d+', r[0]) else None


def meta_set(db, key, value):
    db.execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
               (key, str(value)))


def save_rows(db, rows):
    db.executemany('INSERT OR REPLACE INTO launches (%s) VALUES (%s)' % (', '.join(COLUMNS), ', '.join('?' * len(COLUMNS))),
                   [tuple(r.get(c) for c in COLUMNS) for r in rows])


def fmt_time(t):
    return time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(t)) if t else '?'

# ---- commands ------------------------------------------------------------------------------------------------


def block_at_time(chain, target, hi):
    """Last block with timestamp <= target (binary search between INDEX_FLOOR and hi)."""
    lo = C['floor']
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if chain.block_time(mid) <= target:
            lo = mid
        else:
            hi = mid - 1
    return lo


def cmd_run(db, args, chain, skel):
    head = chain.head() - C['confirmations']
    top = min(int(args.get('--to', head)), head)
    if '--days' in args:
        down_to = block_at_time(chain, chain.block_time(top) - float(args['--days']) * 86400, top)
    else:
        down_to = int(args.get('--down-to', C['floor']))
    down_to = max(down_to, C['floor'])
    deadline = time.time() + float(args.get('--minutes', 1e9)) * 60
    target_rows = int(args.get('--window-rows', 1500))
    last, oldest = meta_get(db, 'last_block'), meta_get(db, 'oldest_block')
    total = db.execute('SELECT COUNT(*) FROM launches').fetchone()[0]
    log('head %d; indexing down to block %d; table has %d launches (covered %s-%s)' % (head, down_to, total, oldest, last))
    span = 200000
    t0 = time.time()

    # 1) New blocks since the last run (oldest first, so the range never has a hole).
    if last is not None and top > last:
        a = last + 1
        while a <= top and time.time() < deadline:
            b = min(top, a + span - 1)
            try:
                rows = chain.rows(a, b, skel)
            except RpcError as e:
                log('  new blocks %d-%d failed (%s); waiting 20 s and trying again' % (a, b, e))
                time.sleep(20)
                continue
            save_rows(db, rows)
            meta_set(db, 'last_block', b)
            db.commit()
            log('  new blocks %d-%d: %d launches' % (a, b, len(rows)))
            a = b + 1
    # 2) History, newest first.
    if last is None:
        nxt = top
    else:
        nxt = (oldest if oldest is not None else last + 1) - 1
    done_rows = 0
    while nxt >= down_to and time.time() < deadline:
        a = max(down_to, nxt - span + 1)
        try:
            rows = chain.rows(a, nxt, skel)
        except RpcError as e:
            log('  blocks %d-%d failed (%s); waiting 20 s and trying again' % (a, nxt, e))
            time.sleep(20)
            continue
        save_rows(db, rows)
        if meta_get(db, 'last_block') is None:
            meta_set(db, 'last_block', top)
        meta_set(db, 'oldest_block', a)
        db.commit()
        done_rows += len(rows)
        total += len(rows)
        oldest_t = rows[0]['time'] if rows else None
        rate = done_rows / max(1.0, time.time() - t0)
        log('  blocks %d-%d: %d launches (%d via Multicall3), %d in table, back to %s, %.1f rows/s, %d requests, %d waits'
            % (a, nxt, len(rows), sum(1 for r in rows if r['creator'] == C['multicall3']), total,
               fmt_time(oldest_t), rate, chain.rpc.requests, chain.rpc.waits_429))
        density = len(rows) / float(nxt - a + 1)
        span = int(min(C['span_one'] + 1, max(2000, target_rows / density if density > 0 else span * 4)))
        nxt = a - 1
    oldest = meta_get(db, 'oldest_block')
    if oldest is not None and oldest <= down_to:
        log('done: covered blocks %s-%s' % (oldest, meta_get(db, 'last_block')))
    else:
        log('stopped (time limit); run the same command again to carry on from block %s' % ((oldest or 0) - 1))


def cmd_add_block(db, args, chain, skel):
    n = int(args['_'][0])
    rows = chain.rows(n, n, skel)
    save_rows(db, rows)
    db.commit()
    log('block %d: added %d launches (progress cursor unchanged)' % (n, len(rows)))


def cmd_reskel(db, args, skel):
    if not skel.ok:
        sys.exit('skeleton.js or jsc missing: %s' % SKELETON_JS)
    where = '' if '--all' in args else ' WHERE (name IS NOT NULL AND name_skel IS NULL) OR (symbol IS NOT NULL AND sym_skel IS NULL)'
    rows = db.execute('SELECT token, name, symbol FROM launches' + where).fetchall()
    for i in range(0, len(rows), 5000):
        part = rows[i:i + 5000]
        sk = skel.many([x for r in part for x in (r[1], r[2])])
        db.executemany('UPDATE launches SET name_skel = ?, sym_skel = ? WHERE token = ?',
                       [(sk[2 * j], sk[2 * j + 1], r[0]) for j, r in enumerate(part)])
        db.commit()
        log('  skeletons: %d of %d' % (i + len(part), len(rows)))


def sql_value(v):
    if v is None:
        return 'NULL'
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def cmd_export(db, args):
    out_dir = args['_'][0]
    per_file = int(args.get('--rows', 5000))
    per_insert = int(args.get('--per-insert', 100))     # D1 caps one statement at 100 KB; 100 rows is ~40 KB
    os.makedirs(out_dir, exist_ok=True)
    missing = db.execute('SELECT COUNT(*) FROM launches WHERE (name IS NOT NULL AND name_skel IS NULL) OR '
                         '(symbol IS NOT NULL AND sym_skel IS NULL)').fetchone()[0]
    if missing:
        sys.exit('%d rows have no skeleton yet; run "reskel" first' % missing)
    cur = db.execute('SELECT %s FROM launches ORDER BY block DESC, log_index DESC' % ', '.join(COLUMNS))
    n_file, n_rows = 0, 0
    while True:
        rows = cur.fetchmany(per_file)
        if not rows:
            break
        n_file += 1
        path = os.path.join(out_dir, 'launches-%04d.sql' % n_file)
        with open(path, 'w', encoding='utf-8') as f:
            f.write('-- Pons launches, blocks %d-%d (%d rows). Made by dev/tools/backfill_launches.py.\n'
                    % (rows[-1][7], rows[0][7], len(rows)))
            for i in range(0, len(rows), per_insert):
                part = rows[i:i + per_insert]
                f.write('INSERT OR REPLACE INTO launches (%s) VALUES\n' % ', '.join(COLUMNS))
                f.write(',\n'.join('(' + ', '.join(sql_value(v) for v in r) + ')' for r in part) + ';\n')
        n_rows += len(rows)
    last, oldest = meta_get(db, 'last_block'), meta_get(db, 'oldest_block')
    with open(os.path.join(out_dir, 'meta.sql'), 'w', encoding='utf-8') as f:
        f.write('-- Run AFTER every launches-*.sql file. Moves the cursor only where this backfill joins on.\n')
        if last is not None and oldest is not None:
            f.write("INSERT INTO meta (key, value) VALUES ('last_block', '%d') ON CONFLICT(key) DO NOTHING;\n" % last)
            f.write("INSERT INTO meta (key, value) VALUES ('oldest_block', '%d') ON CONFLICT(key) DO NOTHING;\n" % oldest)
            f.write("UPDATE meta SET value = '%d' WHERE key = 'oldest_block' AND CAST(value AS INTEGER) > %d"
                    " AND CAST(value AS INTEGER) <= %d;\n" % (oldest, oldest, last + 1))
    log('wrote %d rows in %d files to %s (+ meta.sql: blocks %s-%s)' % (n_rows, n_file, out_dir, oldest, last))


def cmd_status(db):
    n = db.execute('SELECT COUNT(*), MIN(block), MAX(block), MIN(time), MAX(time) FROM launches').fetchone()
    mc = db.execute('SELECT COUNT(*) FROM launches WHERE creator = ?', (C['multicall3'],)).fetchone()[0]
    pend = db.execute('SELECT COUNT(*) FROM launches WHERE name IS NULL OR symbol IS NULL').fetchone()[0]
    noskel = db.execute('SELECT COUNT(*) FROM launches WHERE (name IS NOT NULL AND name_skel IS NULL) OR '
                        '(symbol IS NOT NULL AND sym_skel IS NULL)').fetchone()[0]
    print('launches: %d (blocks %s-%s, %s to %s)' % (n[0], n[1], n[2], fmt_time(n[3]), fmt_time(n[4])))
    print('via Multicall3: %d; names not read yet: %d; skeletons missing: %d' % (mc, pend, noskel))
    print('cursor: oldest_block %s, last_block %s (complete when oldest <= %d)'
          % (meta_get(db, 'oldest_block'), meta_get(db, 'last_block'), C['floor']))


def cmd_fixture(db, args, chain):
    out = args['_'][0]
    want = [t.strip().lower() for t in args.get('--tokens', '').split(',') if t.strip()]
    n = int(args.get('--n', 50))
    cols = ', '.join(COLUMNS)
    pick = {}
    for t in want:
        r = db.execute('SELECT %s FROM launches WHERE token = ?' % cols, (t,)).fetchone()
        if not r:
            sys.exit('token %s is not in the table' % t)
        pick[t] = r
    mc = db.execute('SELECT %s FROM launches WHERE creator = ? ORDER BY block DESC LIMIT 1' % cols, (C['multicall3'],)).fetchone()
    if mc:
        pick[mc[0]] = mc
    # Fill up with the launches nearest the wanted ones (same hours: realistic neighbours).
    for t in want:
        b = pick[t][7]
        for r in db.execute('SELECT %s FROM launches ORDER BY ABS(block - ?) LIMIT ?' % cols, (b, n)).fetchall():
            if len(pick) >= n:
                break
            pick.setdefault(r[0], r)
    rows = sorted((dict(zip(COLUMNS, r)) for r in pick.values()), key=lambda r: (r['block'], r['log_index']))
    raw_logs, raw_names = [], {}
    special = set(want) | ({mc[0]} if mc else set())
    for r in rows:
        if r['token'] not in special:
            continue
        for lg in chain.logs_split(r['factory'], r['block'], r['block']):
            d = decode_launch_log(lg)
            if d and d['token'] == r['token']:
                raw_logs.append({k: lg[k] for k in ('address', 'topics', 'data', 'blockNumber', 'transactionHash', 'logIndex')})
        res = decode_aggregate3(chain.rpc.call('drpc', 'eth_call', [{'to': C['multicall3'], 'data': encode_aggregate3(
            [(r['token'], SEL_NAME), (r['token'], SEL_SYMBOL)])}, hex(r['block'])]))
        raw_names[r['token']] = {'name': res[0][1], 'symbol': res[1][1]}
    fixture = {
        'about': 'Real Pons launches read from Robinhood Chain by dev/tools/backfill_launches.py (%s). rows = table rows '
                 '(api/schema.sql); raw.logs = the TokenLaunched logs and raw.names = the name()/symbol() return data for '
                 'the special tokens (OBSYN launches and one Multicall3 launch). Skeleton columns were made with '
                 'site/src/trust/skeleton.js at that time.' % time.strftime('%Y-%m-%d', time.gmtime()),
        'multicall3_token': mc[0] if mc else None,
        'rows': rows,
        'raw': {'logs': raw_logs, 'names': raw_names},
    }
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(fixture, f, indent=1, ensure_ascii=False)
        f.write('\n')
    log('fixture: %d rows (%d with raw logs) -> %s' % (len(rows), len(raw_logs), out))


SQL_DUMP_JS = """import * as IX from %s;
print(JSON.stringify({ upsert: IX.SQL_UPSERT, all: IX.SQL_META_ALL, advance: IX.SQL_META_ADVANCE,
  oldest: IX.SQL_META_OLDEST_INIT, set: IX.SQL_META_SET, pending: IX.SQL_PENDING_NAMES, names: IX.SQL_SET_NAMES,
  columns: IX.COLUMNS }));
"""


def cmd_check(workdir):
    """Offline self-check: the Worker's SQL (api/src/indexer.js) on a real SQLite with api/schema.sql (the fake D1
    in dev/tests/indexer.test.js copies these rules), and this script's decoding against the test fixture."""
    runner = os.path.join(workdir, 'sql_dump.mjs')
    with open(runner, 'w', encoding='utf-8') as f:
        f.write(SQL_DUMP_JS % json.dumps(os.path.join(ROOT, 'api', 'src', 'indexer.js')))
    res = subprocess.run([JSC, '-m', runner], capture_output=True, timeout=60)
    if res.returncode != 0:
        sys.exit('jsc failed: ' + res.stderr.decode('utf-8', 'replace')[:300])
    S = json.loads(res.stdout.decode('utf-8'))
    if S['columns'] != COLUMNS:
        sys.exit('column lists differ: indexer.js %s, this script %s' % (S['columns'], COLUMNS))
    db = sqlite3.connect(':memory:')
    db.executescript(open(SCHEMA, encoding='utf-8').read())

    def row(**kw):
        base = dict(token='0x01', factory='0x02', curve='0x03', creator='0x04', tx_from='0x05', pair_token='0x00',
                    graduation_threshold='42', block=10, log_index=1, time=1000, tx='0x06', name='Obsyn',
                    symbol='OBSYN', sym_skel='obsyn', name_skel='obsyn')
        base.update(kw)
        return tuple(base[c] for c in COLUMNS)

    def table():
        return db.execute('SELECT * FROM launches ORDER BY token').fetchall()

    def meta(key):
        r = db.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
        return r[0] if r else None
    checks = []

    def expect(name, got, want):
        checks.append((name, got == want, got, want))
    db.execute(S['upsert'], row())
    first = table()
    db.execute(S['upsert'], row())
    expect('upsert twice = same table', table(), first)
    db.execute(S['upsert'], row(tx_from=None, time=None, name=None, symbol=None, sym_skel=None, name_skel=None))
    expect('a NULL never wipes a stored value', table(), first)
    db.execute(S['upsert'], row(symbol='X', sym_skel='x'))
    expect('a new symbol replaces symbol and sym_skel only',
           db.execute('SELECT symbol, sym_skel, name, name_skel, tx_from FROM launches').fetchone(),
           ('X', 'x', 'Obsyn', 'obsyn', '0x05'))
    db.execute(S['advance'], ('100', 50))
    expect('first cursor', meta('last_block'), '100')
    db.execute(S['advance'], ('200', 101))
    expect('cursor joins on', meta('last_block'), '200')
    db.execute(S['advance'], ('300', 250))
    expect('cursor never jumps a gap', meta('last_block'), '200')
    db.execute(S['advance'], ('150', 120))
    expect('cursor never goes back', meta('last_block'), '200')
    db.execute(S['oldest'], ('50',))
    db.execute(S['oldest'], ('99',))
    expect('oldest_block set once', meta('oldest_block'), '50')
    db.execute(S['set'], ('last_run', '7'))
    db.execute(S['set'], ('last_run', '8'))
    expect('meta set', sorted(db.execute(S['all']).fetchall()), [('last_block', '200'), ('last_run', '8'), ('oldest_block', '50')])
    db.execute(S['upsert'], row(token='0x09', block=11, name=None, symbol=None, sym_skel=None, name_skel=None))
    expect('pending names', db.execute(S['pending'], (10,)).fetchall(), [('0x09', 11)])
    db.execute(S['names'], ('0x09', 'Late', None, 'late', None))
    db.execute(S['names'], ('0x09', None, 'LT', None, 'lt'))
    expect('names filled one at a time', db.execute("SELECT name, symbol, name_skel, sym_skel FROM launches WHERE token = '0x09'").fetchone(),
           ('Late', 'LT', 'late', 'lt'))
    plan = ' '.join(str(x) for x in db.execute('EXPLAIN QUERY PLAN SELECT token FROM launches WHERE sym_skel = ?', ('x',)).fetchall())
    expect('sym_skel lookups use the index', 'idx_launches_sym_skel' in plan, True)
    plan = ' '.join(str(x) for x in db.execute('EXPLAIN QUERY PLAN ' + S['pending'], (100,)).fetchall())
    expect('unread-name retries use the small partial index (no table walk)', 'idx_launches_pending' in plan, True)
    fx = json.load(open(os.path.join(ROOT, 'dev', 'tests', 'fixtures', 'launches', 'sample.json'), encoding='utf-8'))
    by = {r['token']: r for r in fx['rows']}
    for lg in fx['raw']['logs']:
        d = decode_launch_log(lg)
        expect('fixture log ' + d['token'], d, {k: by[d['token']][k] for k in d})
    for t, raw in fx['raw']['names'].items():
        expect('fixture names ' + t, (decode_text(raw['name']), decode_text(raw['symbol'])), (by[t]['name'], by[t]['symbol']))
    bad = [c for c in checks if not c[1]]
    for name, good, got, want in checks:
        print(('  ok   ' if good else '  FAIL ') + name + ('' if good else ': got %r, want %r' % (got, want)))
    print('%d of %d checks passed (SQLite %s)' % (len(checks) - len(bad), len(checks), sqlite3.sqlite_version))
    return 1 if bad else 0


def parse_args(argv):
    args = {'_': []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith('--'):
            if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
                args[a] = argv[i + 1]
                i += 2
                continue
            args[a] = True
        else:
            args['_'].append(a)
        i += 1
    return args


def main(argv):
    if len(argv) < 2 or argv[1] not in ('run', 'export', 'reskel', 'status', 'add-block', 'fixture', 'check'):
        print(__doc__)
        return 2
    path, cmd = argv[0], argv[1]
    args = parse_args(argv[2:])
    if cmd == 'check':
        return cmd_check(path)
    db = open_db(path)
    workdir = os.path.dirname(os.path.abspath(path))
    rpc = Rpc(pace=float(args.get('--pace', 0.35)))
    chain = Chain(rpc)
    skel = Skeleton(workdir)
    try:
        if cmd == 'run':
            cmd_run(db, args, chain, skel)
        elif cmd == 'add-block':
            cmd_add_block(db, args, chain, skel)
        elif cmd == 'reskel':
            cmd_reskel(db, args, skel)
        elif cmd == 'export':
            cmd_export(db, args)
        elif cmd == 'status':
            cmd_status(db)
        elif cmd == 'fixture':
            cmd_fixture(db, args, chain)
    except KeyboardInterrupt:
        db.commit()
        log('stopped; progress is saved, run the same command again to carry on')
        return 1
    finally:
        db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
