#!/usr/bin/env python3
"""Every Pons graduation so far (factory graduation logs), for the copycat-alert feed.

    python3 dev/tools/graduations.py > dev/out/graduations.sql     then: npx wrangler d1 execute bts --remote --file=...

Read-only: eth_getLogs on the official node, 9M blocks per call. Prints INSERT OR IGNORE rows for the graduations table.
"""
import json, re, sys, time, urllib.request, os
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = open(os.path.join(HERE, '../../api/src/env.js')).read()
FACTORIES = re.findall(r"address: '(0x[0-9a-f]{40})'", ENV)
FLOOR = int(re.search(r'INDEX_FLOOR = (\d+)', ENV).group(1))
G = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259'
RPC = 'https://rpc.mainnet.chain.robinhood.com'

def rpc(m, p):
    for i in range(8):
        time.sleep(0.4 * (2 ** i) if i else 0.3)   # the official node 429s in bursts: back off
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(RPC, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                {'content-type': 'application/json', 'user-agent': 'bts-graduations'}), timeout=90))
            if 'result' in r: return r['result']
            err = r.get('error')
        except Exception as e:
            err = e
    sys.exit(f'{m} failed: {err}')

head = int(rpc('eth_blockNumber', []), 16) - 20
rows = {}
for fac in FACTORIES:                         # one address per call: the node allows big ranges only then
    a = FLOOR
    while a <= head:
        b = min(head, a + 9_000_000 - 1)
        for l in rpc('eth_getLogs', [{'address': fac, 'topics': [G], 'fromBlock': hex(a), 'toBlock': hex(b)}]):
            tok = '0x' + l['topics'][1][-40:].lower()
            rows.setdefault(tok, (int(l['blockNumber'], 16), l['transactionHash'].lower()))
        a = b + 1
print('-- Pons graduations up to block %d: %d coins' % (head, len(rows)))
print('CREATE TABLE IF NOT EXISTS graduations (token TEXT PRIMARY KEY, block INTEGER NOT NULL, tx TEXT NOT NULL);')
for tok, (blk, tx) in sorted(rows.items(), key=lambda x: x[1][0]):
    print(f"INSERT OR IGNORE INTO graduations (token, block, tx) VALUES ('{tok}', {blk}, '{tx}');")
