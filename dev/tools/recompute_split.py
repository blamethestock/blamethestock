#!/usr/bin/env python3
"""Recompute a Blame the Stock split by hand, straight from Robinhood Chain. Python 3 standard library only.

    python3 dev/tools/recompute_split.py COIN COIN_POOL PAIR PAIR_USD_POOL START_BLOCK END_BLOCK

  COIN           the coin's token address
  COIN_POOL      the coin's main pool: a Uniswap v4 pool id (0x + 64 hex) or a v3-style pool address (0x + 40 hex)
  PAIR           the token the coin is paired with (0x0000000000000000000000000000000000000000 = native ETH)
  PAIR_USD_POOL  a pool pricing PAIR in USDG ($1), same formats as COIN_POOL
  START_BLOCK / END_BLOCK   the blocks the site shows (its "start block" and "end block" links)

Worked example (the one in the README), $AI vs NVDA, 24h:
    python3 dev/tools/recompute_split.py 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18 \\
      0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27 \\
      0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec 0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 118383187 119216653

How: price of token0 in token1 = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1), read with StateView.getSlot0
(v4) or slot0() (v3) at each block. Then c = coin's dollar change, q = pair's dollar change,
r = (1 + c) / (1 + q) - 1, share from the pair = ln(1 + q) / ln(1 + c). Read-only: eth_call only.
"""
import json
import math
import sys
import urllib.request

RPC = 'https://robinhood.drpc.org'          # free archive node: eth_call at any past block
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
ETH = '0x' + '0' * 40


def rpc(method, params):
    for attempt in range(5):
        req = urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                     {'content-type': 'application/json', 'user-agent': 'recompute-split'})
        try:
            out = json.load(urllib.request.urlopen(req, timeout=30))
            if 'result' in out:
                return out['result']
        except Exception:
            pass
    sys.exit(f'Robinhood Chain did not answer {method}')


def call(to, data, block):
    return rpc('eth_call', [{'to': to, 'data': data}, hex(block)])


def decimals(token):
    if token == ETH:
        return 18
    return int(rpc('eth_call', [{'to': token, 'data': '0x313ce567'}, 'latest']), 16)


def sqrt_price(pool, block):
    if len(pool) == 66:                      # v4 pool id -> StateView.getSlot0(bytes32)
        word = call(STATE_VIEW, '0xc815641c' + pool[2:], block)
    else:                                    # v3-style pool -> slot0()
        word = call(pool, '0x3850c7bd', block)
    return int(word[2:66], 16)


def price(pool, base, quote, block):
    """Price of `base` in `quote` units in this pool at this block."""
    t0, t1 = sorted([base, quote], key=lambda a: int(a, 16))
    p0 = (sqrt_price(pool, block) / 2 ** 96) ** 2 * 10 ** (decimals(t0) - decimals(t1))   # token0 in token1
    return p0 if base == t0 else 1 / p0


def main():
    if len(sys.argv) != 7:
        sys.exit(__doc__)
    coin, coin_pool, pair, pair_pool = (a.lower() for a in sys.argv[1:5])
    start, end = int(sys.argv[5]), int(sys.argv[6])
    rows = {}
    for name, b in (('start', start), ('end', end)):
        coin_in_pair = price(coin_pool, coin, pair, b)
        pair_usd = 1.0 if pair == USDG else price(pair_pool, pair, USDG, b)
        rows[name] = (coin_in_pair, pair_usd, coin_in_pair * pair_usd)
        print(f'{name:5} block {b}: coin in pair {coin_in_pair:.10g}  pair in $ {pair_usd:.6f}  coin in $ {coin_in_pair * pair_usd:.10g}')
    c = rows['end'][2] / rows['start'][2] - 1
    q = rows['end'][1] / rows['start'][1] - 1
    r = (1 + c) / (1 + q) - 1
    share = math.log1p(q) / math.log1p(c)
    print(f'\nc (coin in $)   {c * 100:+.3f}%')
    print(f'q (pair in $)   {q * 100:+.3f}%')
    print(f'r (coin own)    {r * 100:+.3f}%   check: (1+q)(1+r)-1 = {((1 + q) * (1 + r) - 1) * 100:+.3f}%')
    print(f'share from pair ln(1+q)/ln(1+c) = {share * 100:.1f}%')


if __name__ == '__main__':
    main()
