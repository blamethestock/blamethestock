#!/usr/bin/python3 -I
"""Rebuilds site/src/features/board-list.js: the coins on the Stock-Paired Board.

A coin is on the list when its MAIN pool (the site's own rule from site/src/data/discover.js: the readable pool
with the most money on the PAIR side) is a Uniswap pool against one of Robinhood's official stock tokens, and that
pool holds at least $10k of the stock and had at least 50 trades in the last 24 hours.

How it finds them:
  1. Robinhood Chain: every Uniswap v4 pool created with a stock token on either side (PoolManager Initialize logs,
     one stock at a time), plus Uniswap v3 pools (factory PoolCreated logs). The other token in each pool is a
     candidate. Only stocks that have a dollar pool in site/src/data/stocks.js are scanned (the board needs one).
  2. DexScreener /tokens/v1 (30 candidates per call): which candidates DexScreener lists at all. Most never traded.
  3. DexScreener /token-pairs/v1 for each listed candidate: all its pools, ranked like the site ranks them.
     Kept when the top pool passes the rules above and answers a price read on Robinhood Chain.
  The file is only written when at least 10 coins pass (a broken scan never empties the board).

Usage:
  /usr/bin/python3 -I dev/tools/refresh_board.py
      Full scan of every stock with a dollar pool (slow: several thousand requests, roughly 30-60 minutes).
      Writes the file. A check on two stocks (HIMS, MSTR) took 78 s and 243 requests.
  /usr/bin/python3 -I dev/tools/refresh_board.py --stocks HIMS,MSTR
      Quick check on a few stocks. A partial scan never writes the file (it prints what it found).
Options:
  --stocks A,B         only these stock tickers (implies --dry-run)
  --dry-run            print the result, write nothing
  --min-stock-usd N    dollars of the stock in the main pool (default 10000)
  --min-trades N       trades in the main pool over 24h (default 50)
  --cache PATH         remember the pools already scanned (per stock, up to a block) so the next run only reads
                       newer blocks from the chain. Keep it outside site/ (it can be several MB).
  --out PATH           file to write (default site/src/features/board-list.js)
"""
import datetime, json, os, re, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STOCKS_JS = os.path.join(ROOT, 'site', 'src', 'data', 'stocks.js')
OUT_JS = os.path.join(ROOT, 'site', 'src', 'features', 'board-list.js')

OFFICIAL = 'https://rpc.mainnet.chain.robinhood.com'
DEXSCREENER = 'https://api.dexscreener.com'
HDR = {'User-Agent': 'build-tool/1.0', 'Accept': 'application/json'}

POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'   # Uniswap v4
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
# keccak256 of the event signatures (checked with dev/tools/keccak.py):
TOPIC_V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'  # Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
TOPIC_V3_POOL_CREATED = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'  # PoolCreated(address,address,uint24,int24,address)
SEL_GET_SLOT0 = '0xc815641c'     # StateView.getSlot0(bytes32)
SEL_SLOT0 = '0x3850c7bd'         # slot0() on a v3 pool

USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
ETH_NATIVE = '0x0000000000000000000000000000000000000000'
STABLES = {   # $1 coins (same list as site/src/data/constants.js)
    USDG, '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', '0xce24439f2d9c6a2289f741120fe202248b666666',
    '0x61a10e8556bed032ea176330e7f17d6a12a10000', '0x00000000d61733e7a393a10a5b48c311abe8f1e5',
}
NOT_COINS = STABLES | {WETH, ETH_NATIVE}

LOG_SPAN = 10_000_000            # the official node allows 10M-block getLogs ranges with single topic values
MIN_COINS_TO_WRITE = 10
STATS = {'rpc': 0, 'rpc429': 0, 'ds': 0, 'ds429': 0}


class OverCap(Exception):
    """eth_getLogs found too many logs in the range: split it."""


def log(*a):
    print(*a, flush=True)


# ---- network -------------------------------------------------------------------------------------
def _open(req, timeout=60):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def rpc(method, params, tries=8):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    err = None
    for i in range(tries):
        if i:
            time.sleep(min(30, 1.5 * 2 ** (i - 1)))
        try:
            STATS['rpc'] += 1
            out = _open(urllib.request.Request(OFFICIAL, data=body, headers=dict(HDR, **{'Content-Type': 'application/json'})), 120)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                STATS['rpc429'] += 1
            err = e
            continue
        except Exception as e:      # timeouts, resets
            err = e
            continue
        if 'error' in out:
            msg = str((out['error'] or {}).get('message', out['error']))
            if re.search(r'more than \d+|too many (results|logs)|response size|exceed|log response|query returned', msg, re.I):
                raise OverCap(msg)
            err = RuntimeError(msg)
            continue                # "invalid hex string" and friends come and go on this node
        return out.get('result')
    raise RuntimeError('RPC %s failed: %s' % (method, err))


def rpc_batch(calls, tries=6):
    """calls: [(method, params)] -> [result or None]. Batches of 6 (bigger ones draw 429s)."""
    out = []
    for k in range(0, len(calls), 6):
        chunk = calls[k:k + 6]
        body = json.dumps([{'jsonrpc': '2.0', 'id': j, 'method': m, 'params': p} for j, (m, p) in enumerate(chunk)]).encode()
        res = None
        for i in range(tries):
            if i:
                time.sleep(min(30, 1.5 * 2 ** (i - 1)))
            try:
                STATS['rpc'] += 1
                r = _open(urllib.request.Request(OFFICIAL, data=body, headers=dict(HDR, **{'Content-Type': 'application/json'})))
                if isinstance(r, list):
                    by_id = {x.get('id'): x for x in r}
                    res = [by_id.get(j, {}).get('result') for j in range(len(chunk))]
                    break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    STATS['rpc429'] += 1
            except Exception:
                pass
        if res is None:
            raise RuntimeError('RPC batch failed')
        out += res
    return out


def ds_get(path, tries=6):
    """DexScreener GET (about 4 calls a second at most; it allows 300 a minute). None on 404."""
    url = DEXSCREENER + path
    for i in range(tries):
        time.sleep(0.25 if i == 0 else 5 * i)
        try:
            STATS['ds'] += 1
            return _open(urllib.request.Request(url, headers=HDR))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                STATS['ds429'] += 1
        except Exception:
            pass
    raise RuntimeError('DexScreener failed: ' + url)


def logs(flt, lo, hi, span=LOG_SPAN):
    """Every log matching flt in [lo, hi]; ranges that hold too many logs are split in half."""
    out, b = [], lo
    while b <= hi:
        e = min(b + span - 1, hi)
        try:
            out += rpc('eth_getLogs', [dict(flt, fromBlock=hex(b), toBlock=hex(e))])
        except OverCap:
            if e == b:
                raise
            mid = (b + e) // 2
            out += logs(flt, b, mid, mid - b + 1)
            out += logs(flt, mid + 1, e, e - mid)
        b = e + 1
    return out


# ---- inputs ---------------------------------------------------------------------------------------
def load_stocks():
    """site/src/data/stocks.js -> {token: {symbol, pool}} (pool None = no dollar pool)."""
    src = open(STOCKS_JS).read()
    rows = re.search(r'const ROWS = `\n(.*?)\n`', src, re.S).group(1).strip().split('\n')
    out = {}
    for line in rows:
        sym, token, pool = line.split(' ')
        out['0x' + token] = {'symbol': sym, 'pool': None if pool == '-' else '0x' + pool}
    return out


def pad(addr):
    return '0x' + '0' * 24 + addr[2:]


# ---- step 1: pools with a stock on one side ---------------------------------------------------------
def counterparts_of(stock, lo, hi):
    """Tokens paired with `stock` in Uniswap v4 and v3 pools created in blocks [lo, hi] -> (set, v4 count, v3 count)."""
    found = set()
    v4 = logs({'address': POOL_MANAGER, 'topics': [TOPIC_V4_INITIALIZE, None, pad(stock)]}, lo, hi) + \
        logs({'address': POOL_MANAGER, 'topics': [TOPIC_V4_INITIALIZE, None, None, pad(stock)]}, lo, hi)
    for l in v4:
        c0, c1 = '0x' + l['topics'][2][-40:], '0x' + l['topics'][3][-40:]
        found.add(c1 if c0 == stock else c0)
    v3 = logs({'address': V3_FACTORY, 'topics': [TOPIC_V3_POOL_CREATED, pad(stock)]}, lo, hi) + \
        logs({'address': V3_FACTORY, 'topics': [TOPIC_V3_POOL_CREATED, None, pad(stock)]}, lo, hi)
    for l in v3:
        t0, t1 = '0x' + l['topics'][1][-40:], '0x' + l['topics'][2][-40:]
        found.add(t1 if t0 == stock else t0)
    return found, len(v4), len(v3)


# ---- step 3: the site's own main-pool rule (site/src/data/discover.js parseDexScreener + rankCandidates) ----
def num(x):
    try:
        n = float(x)
        return n if n == n and n not in (float('inf'), float('-inf')) else 0.0
    except (TypeError, ValueError):
        return 0.0


def amount(x):
    if x is None or x == '':
        return None
    n = num(x)
    return n if n >= 0 else None


def ranked_pools(coin, pairs, stocks):
    out = []
    for p in pairs if isinstance(pairs, list) else []:
        if not p or not p.get('baseToken') or not p.get('quoteToken') or not p.get('pairAddress'):
            continue
        if p.get('chainId') and p.get('chainId') != 'robinhood':
            continue
        base, quote = p['baseToken']['address'].lower(), p['quoteToken']['address'].lower()
        liq = p.get('liquidity') or {}
        pn, pu = num(p.get('priceNative')), num(p.get('priceUsd'))
        if base == coin and quote != coin:
            coin_tok, pair_tok, amt, pair_usd = p['baseToken'], p['quoteToken'], amount(liq.get('quote')), (pu / pn if pn > 0 else 0)
        elif quote == coin and base != coin:
            coin_tok, pair_tok, amt, pair_usd = p['quoteToken'], p['baseToken'], amount(liq.get('base')), pu
        else:
            continue
        pair = pair_tok['address'].lower()
        if pair in STABLES:
            pair_usd = 1
        pid = p['pairAddress'].lower()
        labels = p.get('labels') or []
        version = 'v4' if len(pid) == 66 else ('v3' if len(pid) == 42 and 'v3' in labels else None)
        if not version:
            continue                                  # the site can't read it, so it can't be the main pool
        tx = ((p.get('txns') or {}).get('h24') or {})
        created = num(p.get('pairCreatedAt'))
        out.append({
            'id': pid, 'version': version, 'uniswap': p.get('dexId') == 'uniswap',
            'symbol': str(coin_tok.get('symbol') or '').strip(), 'pair': pair,
            'pairSideUsd': (amt or 0) * pair_usd, 'created': int(created // 1000) if created > 0 else 0,
            'trades': int(num(tx.get('buys')) + num(tx.get('sells'))),
        })
    out.sort(key=lambda c: (-c['pairSideUsd'], c['created']))
    return out


def clean_symbol(s):
    s = re.sub(r'[\x00-\x1f\x7f  ]', '', s).strip()
    return s[:32]


def answers_price(rows):
    """Keeps the rows whose pool gives a non-zero price on Robinhood Chain now."""
    calls = []
    for r in rows:
        to, data = (STATE_VIEW, SEL_GET_SLOT0 + r['pool'][2:]) if len(r['pool']) == 66 else (r['pool'], SEL_SLOT0)
        calls.append(('eth_call', [{'to': to, 'data': data}, 'latest']))
    res = rpc_batch(calls)
    return [r for r, x in zip(rows, res) if x and len(x) >= 66 and int(x[2:66], 16) != 0]


def render_js(kept, min_usd, min_trades, now):
    """The text of board-list.js for these coins (same shape the site reads)."""
    money = '%gk' % (min_usd / 1000) if min_usd >= 1000 else '%g' % min_usd
    rows = ',\n'.join('  ' + json.dumps({k: r[k] for k in ('symbol', 'address', 'pool', 'stock', 'stockAddress', 'stockSideUsd')})
                      for r in kept)
    return (
        '// Stock-Paired Board: coins whose main pool is paired with an official Robinhood stock token.\n'
        '// Found by scanning Robinhood Chain on %s (%s UTC). Filter: at least $%s of the stock in the pool\n'
        '// and at least %d trades in 24h. Refresh: /usr/bin/python3 -I dev/tools/refresh_board.py\n'
        'export const BOARD_SCANNED_AT = "%s";\n'
        'export const BOARD_COINS = [\n%s,\n];\n'
    ) % (now.strftime('%Y-%m-%d'), now.strftime('%H:%M'), money, min_trades, now.isoformat() + 'Z', rows)


# ---- main -------------------------------------------------------------------------------------------
def main():
    argv = sys.argv[1:]

    def opt(name, default=None):
        if name in argv:
            i = argv.index(name)
            if i + 1 >= len(argv):
                sys.exit('missing value after ' + name)
            return argv[i + 1]
        return default

    only = [s.strip().upper().lstrip('$') for s in (opt('--stocks') or '').split(',') if s.strip()]
    dry = '--dry-run' in argv or bool(only)
    min_usd = float(opt('--min-stock-usd', 10000))
    min_trades = int(opt('--min-trades', 50))
    cache_path = opt('--cache')
    out_path = opt('--out', OUT_JS)
    t_start = time.time()

    stocks = load_stocks()
    usable = {a: s for a, s in stocks.items() if s['pool']}
    if only:
        by_sym = {s['symbol']: a for a, s in usable.items()}
        missing = [s for s in only if s not in by_sym]
        if missing:
            sys.exit('not a stock with a dollar pool in stocks.js: ' + ', '.join(missing))
        usable = {by_sym[s]: usable[by_sym[s]] for s in only}
    head = int(rpc('eth_blockNumber', []), 16)
    log('Robinhood Chain head %d. Scanning %d stock%s%s.' % (head, len(usable), '' if len(usable) == 1 else 's',
        ' (' + ', '.join(s['symbol'] for s in usable.values()) + ')' if only else ''))

    cache = {}
    if cache_path and os.path.exists(cache_path):
        cache = json.load(open(cache_path)).get('stocks', {})

    # 1. pools with a stock on one side
    candidates, n_v4, n_v3 = set(), 0, 0
    for i, (stock, s) in enumerate(sorted(usable.items(), key=lambda kv: kv[1]['symbol'])):
        t0 = time.time()
        prev = cache.get(stock) or {}
        lo = prev.get('upto', -1) + 1
        found, a, b = counterparts_of(stock, lo, head)
        found |= set(prev.get('counterparts', []))
        cache[stock] = {'upto': head, 'counterparts': sorted(found)}
        n_v4 += a; n_v3 += b
        candidates |= found
        log('  %3d/%d %-6s %6d new v4 pools, %4d new v3 pools, %6d paired tokens  (%.0fs)' % (
            i + 1, len(usable), s['symbol'], a, b, len(found), time.time() - t0))
    if cache_path:
        json.dump({'saved': head, 'stocks': cache}, open(cache_path, 'w'))
    candidates -= NOT_COINS
    candidates -= set(stocks)
    log('Step 1: %d v4 + %d v3 pools read, %d tokens paired with a stock.' % (n_v4, n_v3, len(candidates)))

    # 2. which of them DexScreener lists at all
    listed = set()
    todo = sorted(candidates)
    for k in range(0, len(todo), 30):
        batch = todo[k:k + 30]
        pairs = ds_get('/tokens/v1/robinhood/' + ','.join(batch)) or []
        want = set(batch)
        for p in pairs if isinstance(pairs, list) else []:
            for side in ('baseToken', 'quoteToken'):
                a = ((p or {}).get(side) or {}).get('address', '').lower()
                if a in want:
                    listed.add(a)
        if (k // 30) % 100 == 99:
            log('  DexScreener: %d of %d checked, %d listed' % (k + 30, len(todo), len(listed)))
    log('Step 2: %d of them are listed on DexScreener.' % len(listed))

    # 3. each listed coin's main pool, by the site's own rule
    kept, why = [], {}
    for k, coin in enumerate(sorted(listed)):
        ranked = ranked_pools(coin, ds_get('/token-pairs/v1/robinhood/' + coin), stocks)
        main = ranked[0] if ranked else None
        reason = None
        if not main:
            reason = 'no readable pool'
        elif main['pair'] not in stocks:
            reason = 'main pool not against a stock'
        elif not stocks[main['pair']]['pool']:
            reason = 'stock has no dollar pool'
        elif not main['uniswap']:
            reason = 'main pool not on Uniswap'
        elif main['pairSideUsd'] < min_usd:
            reason = 'under $%d of the stock' % min_usd
        elif main['trades'] < min_trades:
            reason = 'under %d trades in 24h' % min_trades
        if reason:
            why[reason] = why.get(reason, 0) + 1
            continue
        kept.append({
            'symbol': clean_symbol(main['symbol']) or coin[:6] + '…' + coin[-4:], 'address': coin, 'pool': main['id'],
            'stock': stocks[main['pair']]['symbol'], 'stockAddress': main['pair'], 'stockSideUsd': int(round(main['pairSideUsd'])),
            'trades24h': main['trades'],
        })
        if k % 100 == 99:
            log('  pools: %d of %d coins checked, %d kept' % (k + 1, len(listed), len(kept)))
    before = len(kept)
    kept = answers_price(kept) if kept else []
    if len(kept) < before:
        why['pool gave no price on chain'] = before - len(kept)
    kept.sort(key=lambda r: (-r['stockSideUsd'], r['symbol'], r['address']))
    log('Step 3: %d coins pass (main pool against a stock, >= $%d of it, >= %d trades in 24h).' % (len(kept), min_usd, min_trades))
    for reason, n in sorted(why.items(), key=lambda kv: -kv[1]):
        log('  left out: %5d  %s' % (n, reason))

    # summary
    log('')
    log('  #  %-14s %-6s %10s %7s  %s' % ('coin', 'stock', 'stock $', 'trades', 'address'))
    for i, r in enumerate(kept):
        log('%3d  %-14s %-6s %10s %7d  %s' % (i + 1, r['symbol'][:14], r['stock'], '{:,}'.format(r['stockSideUsd']), r['trades24h'], r['address']))
    by_stock = {}
    for r in kept:
        by_stock[r['stock']] = by_stock.get(r['stock'], 0) + 1
    log('By stock: ' + (', '.join('%s %d' % kv for kv in sorted(by_stock.items(), key=lambda kv: (-kv[1], kv[0]))) or 'none'))
    log('Requests: %d chain (%d rate-limited), %d DexScreener (%d rate-limited). %.0f s.' % (
        STATS['rpc'], STATS['rpc429'], STATS['ds'], STATS['ds429'], time.time() - t_start))

    if dry:
        log('Dry run%s: nothing written.' % (' (only some stocks scanned)' if only else ''))
        return 0
    if len(kept) < MIN_COINS_TO_WRITE:
        log('Only %d coins found (need at least %d): %s left as it was.' % (len(kept), MIN_COINS_TO_WRITE, out_path))
        return 1

    js = render_js(kept, min_usd, min_trades, datetime.datetime.utcnow().replace(microsecond=0))
    tmp = out_path + '.tmp'
    open(tmp, 'w').write(js)
    os.replace(tmp, out_path)
    log('Wrote %s (%d coins, %d bytes).' % (out_path, len(kept), len(js)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
