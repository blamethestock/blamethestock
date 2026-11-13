#!/usr/bin/python3 -I
"""Builds site/src/data/stocks.js: Robinhood's official stock tokens on Robinhood Chain and, for each one,
its deepest Uniswap v3/v4 pool against USDG (ranked by the USDG amount in the pool). The site uses that pool
to price a stock token in dollars.

Usage:
  /usr/bin/python3 -I dev/tools/build_stocks.py [official_list.json] [--report out.json]

Where the pools come from:
  1. DexScreener token-pairs for the stock (at most 30 pools; paced at ~3 calls per second).
  2. The Uniswap v3 factory's getPool(stock, USDG, fee) for the four standard fees, with the pool's real
     USDG balance (catches a deep v3 pool that DexScreener's 30-pool list left out).
  The deepest candidate that answers slot0() (v3) or StateView.getSlot0(id) (v4) with a non-zero price wins.
Only Uniswap pools are used (dexId "uniswap", label v3/v4), because the site can read them and fall back to
their Swap logs.
"""
import json, os, sys, time, datetime, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_LIST = ('<scratch>'
                '73b780b5-0b23-480d-8296-954c812cbf54/scratchpad/wf/addresses/data/robinhood_stock_tokens_4663.json')
OUT_JS = os.path.join(ROOT, 'site', 'src', 'data', 'stocks.js')

OFFICIAL = 'https://rpc.mainnet.chain.robinhood.com'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
SEL_GET_POOL = '0x1698ee82'      # getPool(address,address,uint24)
SEL_BALANCE_OF = '0x70a08231'    # balanceOf(address)
SEL_SLOT0 = '0x3850c7bd'         # slot0()
SEL_GET_SLOT0 = '0xc815641c'     # getSlot0(bytes32)
FEES = [100, 500, 3000, 10000]
MIN_USDG = 100     # a pool with less USDG than this is too thin to price a stock (site/src/data/discover.js uses the same floor)
HDR = {'User-Agent': 'build-tool/1.0', 'Accept': 'application/json'}


def _open(req, timeout=30):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(url, tries=6):
    for i in range(tries):
        try:
            return _open(urllib.request.Request(url, headers=HDR))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1.5 * (i + 1))
        except Exception:
            time.sleep(1.5 * (i + 1))
    raise RuntimeError('GET failed: ' + url)


def rpc_batch(calls, tries=8):
    """calls: list of (method, params). Returns list of result-or-None (None = JSON-RPC error)."""
    body = [{'jsonrpc': '2.0', 'id': i, 'method': m, 'params': p} for i, (m, p) in enumerate(calls)]
    for i in range(tries):
        try:
            req = urllib.request.Request(OFFICIAL, data=json.dumps(body).encode(),
                                         headers=dict(HDR, **{'Content-Type': 'application/json'}))
            out = _open(req)
            if isinstance(out, list):
                by_id = {x.get('id'): x for x in out}
                return [by_id.get(j, {}).get('result') for j in range(len(calls))]
        except Exception:
            pass
        time.sleep(0.6 * (i + 1))
    raise RuntimeError('RPC batch failed')


def word(addr_or_int):
    if isinstance(addr_or_int, int):
        return '%064x' % addr_or_int
    return addr_or_int.lower().replace('0x', '').rjust(64, '0')


def eth_call(to, data):
    return ('eth_call', [{'to': to, 'data': data}, 'latest'])


def first_word(res):
    if not res or len(res) < 66:
        return 0
    return int(res[2:66], 16)


def candidates_for(stock):
    cands = {}
    # 1. DexScreener
    pairs = get('https://api.dexscreener.com/token-pairs/v1/robinhood/' + stock) or []
    for p in pairs:
        b = p['baseToken']['address'].lower()
        q = p['quoteToken']['address'].lower()
        if {b, q} != {stock, USDG}:
            continue
        labels = p.get('labels') or []
        if p.get('dexId') != 'uniswap' or not ({'v3', 'v4'} & set(labels)):
            continue
        pid = p['pairAddress'].lower()
        version = 'v4' if len(pid) == 66 else 'v3'
        amount = ((p.get('liquidity') or {}).get('quote' if q == USDG else 'base')) or 0
        cands[pid] = {'id': pid, 'version': version, 'usdg': float(amount), 'from': 'dexscreener'}
    # 2. Uniswap v3 factory, with the pool's real USDG balance
    a, b = sorted([stock, USDG], key=lambda x: int(x, 16))
    res = rpc_batch([eth_call(V3_FACTORY, SEL_GET_POOL + word(a) + word(b) + word(f)) for f in FEES])
    pools = ['0x' + r[-40:] for r in res if r and int(r, 16) != 0]
    if pools:
        bals = rpc_batch([eth_call(USDG, SEL_BALANCE_OF + word(pl)) for pl in pools])
        for pl, bal in zip(pools, bals):
            usdg = int(bal, 16) / 1e6 if bal else 0
            prev = cands.get(pl)
            cands[pl] = {'id': pl, 'version': 'v3', 'usdg': usdg,
                         'from': 'dexscreener+factory' if prev else 'factory'}
    return sorted(cands.values(), key=lambda c: -c['usdg'])


def answers(c):
    if c['version'] == 'v4':
        res = rpc_batch([eth_call(STATE_VIEW, SEL_GET_SLOT0 + c['id'][2:])])[0]
    else:
        res = rpc_batch([eth_call(c['id'], SEL_SLOT0)])[0]
    return first_word(res) != 0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    report_path = None
    if '--report' in sys.argv:
        report_path = sys.argv[sys.argv.index('--report') + 1]
        args = [a for a in args if a != report_path]
    src = args[0] if args else DEFAULT_LIST
    data = json.load(open(src))
    tokens = data['tokens']
    rows, report = [], []
    for i, t in enumerate(tokens):
        stock = t['address'].lower()
        sym = t['symbol']
        assert ' ' not in sym and len(stock) == 42
        t0 = time.time()
        cands = candidates_for(stock)
        chosen = None
        for c in cands[:4]:
            if c['usdg'] < MIN_USDG:
                break
            if answers(c):
                chosen = c
                break
        rows.append((sym, stock, chosen['id'] if chosen else None))
        report.append({'symbol': sym, 'token': stock, 'pool': chosen, 'candidates': cands[:5]})
        print('%3d/%d %-12s %s %s' % (i + 1, len(tokens), sym,
              chosen['id'] if chosen else '-', ('$%.0f USDG (%s)' % (chosen['usdg'], chosen['from'])) if chosen else ''),
              flush=True)
        time.sleep(max(0, 0.34 - (time.time() - t0)))   # ~3 DexScreener calls per second at most

    built = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'
    lines = ['%s %s %s' % (s, a[2:], p[2:] if p else '-') for s, a, p in rows]
    js = (
        '// GENERATED by dev/tools/build_stocks.py on %s. Do not edit by hand: run the tool again.\n'
        '// Robinhood\'s official stock tokens on Robinhood Chain (%d tokens) and, for each, its deepest\n'
        '// Uniswap v3/v4 pool against USDG by USDG amount (used to price the stock in dollars).\n'
        '// Row: SYMBOL token pool   (hex without 0x; "-" = no readable USDG pool with at least $%d of USDG at build time)\n'
        'const ROWS = `\n%s\n`;\n\n'
        'export const STOCKS_BUILT_AT = \'%s\';\n'
        'export const STOCKS = new Map();   // token address -> { symbol, pool }\n'
        'for (const line of ROWS.trim().split(\'\\n\')) {\n'
        '  const [symbol, token, pool] = line.split(\' \');\n'
        '  STOCKS.set(\'0x\' + token, { symbol, pool: pool === \'-\' ? null : \'0x\' + pool });\n'
        '}\n'
    ) % (built[:10], len(rows), MIN_USDG, '\n'.join(lines), built)
    open(OUT_JS, 'w').write(js)
    print('wrote', OUT_JS, len(js), 'bytes;', sum(1 for r in rows if r[2]), 'of', len(rows), 'have a USDG pool')
    if report_path:
        json.dump({'built': built, 'source': src, 'rows': report}, open(report_path, 'w'), indent=1)


if __name__ == '__main__':
    main()
