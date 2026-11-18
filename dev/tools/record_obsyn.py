#!/usr/bin/python3 -I
"""Records the OBSYN copy-check fixtures ONCE from Robinhood Chain and Blockscout, so the copy-check tests
(dev/tests/copycheck.test.js) run offline through an injected fetch.

Read-only: eth_getBlockByNumber / eth_getLogs / eth_call / eth_getTransactionByHash / eth_getTransactionReceipt
on the official RPC (backs off on HTTP 429 and rate-limit errors) and plain GETs on Blockscout's /api/v2 with
'Accept: application/json' and a generic User-Agent. On a Cloudflare challenge or repeated 429 it stops and says
the explorer is unavailable; it never tries to get around a challenge. Nothing personal is sent or stored.

How it works:
  1. Pins the head block, then builds index.json: every Pons launch (token.curve() answers) among Blockscout's
     token search for "OBSYN", as launch-index rows (TokenLaunched log + tx sender + block time + name/symbol).
  2. Runs the copy-check scenarios in dev/tests/fixtures/obsyn/replay.js with jsc in record mode: every request
     that isn't recorded yet is printed as a miss, fetched once here, saved to rpc.json / explorer.json, and the
     scenarios run again, until nothing is missing. The tests replay exactly these answers.

Usage:  /usr/bin/python3 -I dev/tools/record_obsyn.py            (writes dev/tests/fixtures/obsyn/*.json)
        /usr/bin/python3 -I dev/tools/record_obsyn.py --fresh    (forgets the old recording first)
Re-recording changes live numbers (unclaimed fees, holders, liquidity): update the expected values in the test.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'dev', 'tests', 'fixtures', 'obsyn')
REPLAY_JS = os.path.join(OUT, 'replay.js')
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'
RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
EXPLORER = 'https://robinhoodchain.blockscout.com'
UA = 'Mozilla/5.0 (compatible; blamethestock)'
TOPIC_TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
SEL_CURVE, SEL_NAME, SEL_SYMBOL = '0x7165485d', '0x06fdde03', '0x95d89b41'
HEAD_KEY = 'eth_getBlockByNumber|["latest",false]'


class Unavailable(Exception):
    pass


# ---- network ------------------------------------------------------------------------------------------------
def _post(body):
    data = json.dumps(body).encode()
    waits = [1, 2, 4, 8, 15, 30]
    for i, w in enumerate(waits + [None]):
        try:
            req = urllib.request.Request(RPC_URL, data, {'content-type': 'application/json', 'user-agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 502, 503, 504) or w is None:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if w is None:
                raise
        time.sleep(w)


def _rate_limited(err):
    msg = str((err or {}).get('message', '')).lower()
    return (err or {}).get('code') in (-32005, 429) or 'rate' in msg or 'too many requests' in msg or 'busy' in msg


def rpc_many(calls):
    """calls: [(method, params)] -> [{'result': ...} | {'error': ...}] (rate-limit errors retried)."""
    out = [None] * len(calls)
    todo = list(range(len(calls)))
    for attempt in range(8):
        if not todo:
            break
        if attempt:
            time.sleep(min(30, 2 ** attempt))
        again = []
        for k in range(0, len(todo), 5):
            chunk = todo[k:k + 5]
            res = _post([{'jsonrpc': '2.0', 'id': i, 'method': calls[i][0], 'params': calls[i][1]} for i in chunk])
            res = res if isinstance(res, list) else [res]
            by_id = {x.get('id'): x for x in res if isinstance(x, dict)}
            for i in chunk:
                x = by_id.get(i)
                if x is None or ('error' in x and _rate_limited(x['error'])):
                    again.append(i)
                elif 'error' in x:
                    out[i] = {'error': x['error']}
                else:
                    out[i] = {'result': x.get('result')}
            time.sleep(0.25)
        todo = again
    if todo:
        raise SystemExit('the RPC kept rate-limiting; try again in a few minutes')
    return out


def rpc1(method, params):
    r = rpc_many([(method, params)])[0]
    if 'error' in r:
        raise SystemExit('%s failed: %s' % (method, r['error']))
    return r['result']


def explorer_get(path):
    """-> {'status', 'json'}; 404 is an answer. Raises Unavailable on a challenge or repeated 429/5xx."""
    for w in (5, 15, 30, None):
        try:
            req = urllib.request.Request(EXPLORER + path, headers={'accept': 'application/json', 'user-agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                ctype = r.headers.get('content-type', '')
                if 'json' not in ctype:
                    raise Unavailable('explorer answered %s (not JSON) for %s' % (ctype, path))
                return {'status': r.status, 'json': json.load(r)}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                try:
                    body = json.load(e)
                except Exception:
                    body = {'message': 'Not found'}
                return {'status': 404, 'json': body}
            if e.code == 403 or 'challenge' in (e.headers.get('cf-mitigated') or ''):
                raise Unavailable('explorer sent a challenge (HTTP %d); not getting around it' % e.code)
            if e.code not in (429, 500, 502, 503, 504) or w is None:
                raise Unavailable('explorer HTTP %d for %s' % (e.code, path))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if w is None:
                raise Unavailable('explorer unreachable: %s' % e)
        time.sleep(w)


# ---- trimming (keep only what the code reads, so the fixtures stay small) ---------------------------------------
def t_log(l):
    return {k: l.get(k) for k in ('address', 'topics', 'data', 'blockNumber', 'logIndex', 'transactionHash')}


def trim_rpc(method, params, res):
    if 'error' in res:
        return {'__error': {'code': res['error'].get('code'), 'message': res['error'].get('message')}}
    r = res['result']
    if r is None:
        return None
    if method == 'eth_getBlockByNumber':
        return {k: r.get(k) for k in ('number', 'timestamp', 'hash')}
    if method == 'eth_getTransactionByHash':
        out = {k: r.get(k) for k in ('hash', 'from', 'to', 'value', 'blockNumber', 'type')}
        out['input'] = (r.get('input') or '0x')[:10]
        return out
    if method == 'eth_getTransactionReceipt':
        out = {k: r.get(k) for k in ('transactionHash', 'blockNumber', 'from', 'to', 'status')}
        out['logs'] = [t_log(l) for l in r.get('logs') or []]
        return out
    if method == 'eth_getLogs':
        return [t_log(l) for l in r]
    if method == 'eth_getCode':
        return r[:66]                       # only "is there code?" is read
    return r


def trim_explorer(path, got):
    j = got['json']
    if got['status'] != 200 or not isinstance(j, dict):
        return got
    if path.startswith('/api/v2/tokens/'):
        keep = ('address_hash', 'name', 'symbol', 'decimals', 'holders_count', 'total_supply', 'type')
        return {'status': 200, 'json': {k: j.get(k) for k in keep}}
    if '/transactions' in path and isinstance(j.get('items'), list):
        items = []
        for it in j['items']:
            items.append({
                'hash': it.get('hash'), 'timestamp': it.get('timestamp'), 'status': it.get('status'),
                'value': it.get('value'), 'block_number': it.get('block_number'), 'method': it.get('method'),
                'from': {'hash': (it.get('from') or {}).get('hash')},
                'to': {'hash': (it.get('to') or {}).get('hash')} if it.get('to') else None,
            })
        return {'status': 200, 'json': {'items': items, 'next_page_params': j.get('next_page_params')}}
    return got


# ---- files ------------------------------------------------------------------------------------------------------
def load(name, default):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        return default
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save(name, obj):
    p = os.path.join(OUT, name)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        f.write('\n')
    os.replace(tmp, p)


# ---- step 1: the index ------------------------------------------------------------------------------------------
def decode_text(h):
    h = (h or '0x')[2:]
    try:
        if len(h) == 64:
            b = bytes.fromhex(h).rstrip(b'\x00')
        else:
            if len(h) < 128:
                return ''
            n = int(h[64:128], 16)
            if not 0 < n <= 256:
                return ''
            b = bytes.fromhex(h[128:128 + 2 * n])
        s = b.decode('utf-8', 'replace')
        return ''.join(ch for ch in s if ord(ch) >= 32 and ord(ch) != 127).strip()
    except ValueError:
        return ''


def addr(word):
    return '0x' + word[-40:].lower()


def build_index(head):
    found = explorer_get('/api/v2/tokens?q=OBSYN')
    items = (found['json'] or {}).get('items') or []
    rows, skipped = [], []
    for it in items:
        token = it['address_hash'].lower()
        c = rpc_many([('eth_call', [{'to': token, 'data': SEL_CURVE}, 'latest'])])[0]
        res = c.get('result') or '0x'
        if len(res) < 66 or int(res[2:66], 16) == 0:
            skipped.append(token)
            continue
        info = explorer_get('/api/v2/addresses/' + token)['json'] or {}
        ctx = info.get('creation_transaction_hash') or info.get('creation_tx_hash')
        if not ctx:
            skipped.append(token)
            continue
        rc = rpc1('eth_getTransactionReceipt', [ctx])
        log = next((l for l in rc['logs'] if l['topics'][0] == TOPIC_TOKEN_LAUNCHED and addr(l['topics'][1]) == token), None)
        if not log:
            skipped.append(token)
            continue
        tx = rpc1('eth_getTransactionByHash', [ctx])
        block = int(log['blockNumber'], 16)
        blk = rpc1('eth_getBlockByNumber', [hex(block), False])
        nm, sy = rpc_many([('eth_call', [{'to': token, 'data': SEL_NAME}, 'latest']), ('eth_call', [{'to': token, 'data': SEL_SYMBOL}, 'latest'])])
        data = log['data'][2:]
        rows.append({
            'token': token, 'factory': log['address'].lower(), 'curve': addr(log['topics'][2]),
            'creator': addr(log['topics'][3]), 'tx_from': tx['from'].lower(), 'pair_token': addr(data[0:64]),
            'graduation_threshold': str(int(data[128:192], 16)), 'block': block, 'log_index': int(log['logIndex'], 16),
            'time': int(blk['timestamp'], 16), 'tx': ctx.lower(),
            'name': decode_text(nm.get('result')), 'symbol': decode_text(sy.get('result')),
        })
    rows.sort(key=lambda r: r['block'])
    return {
        'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'head': {'number': int(head['number'], 16), 'time': int(head['timestamp'], 16)},
        'search': 'Blockscout /api/v2/tokens?q=OBSYN; Pons launches kept, others: ' + ', '.join(skipped),
        'rows': rows,
    }


# ---- step 2: replay with jsc until nothing is missing -----------------------------------------------------------
DRIVER = r'''
import { loadFixture, runScenario, SCENARIOS } from '%s';
async function main() {
  const fx = await loadFixture();
  const misses = { rpc: new Map(), explorer: new Set() };
  const log = [];
  for (const sc of SCENARIOS) {
    try { await runScenario(sc, fx, { misses, log }); } catch (e) { print('ERROR ' + sc.name + ': ' + e + '\n' + (e && e.stack)); }
  }
  print('USED ' + JSON.stringify([...new Set(log)]));
  print('MISSES ' + JSON.stringify({ rpc: [...misses.rpc.values()], explorer: [...misses.explorer] }));
}
main().catch((e) => print('CRASH ' + e + '\n' + (e && e.stack)));
'''


def run_driver(work):
    path = os.path.join(work, 'driver.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(DRIVER % REPLAY_JS.replace('\\', '/'))
    out = subprocess.run([JSC, '-m', path], capture_output=True, text=True, timeout=600)
    text = out.stdout + out.stderr
    line = next((l for l in reversed(text.splitlines()) if l.startswith('MISSES ')), None)
    for l in text.splitlines():
        if l.startswith(('ERROR', 'CRASH')):
            print(l)
    used = next((l for l in reversed(text.splitlines()) if l.startswith('USED ')), None)
    if line is None or used is None:
        raise SystemExit('the replay run did not finish:\n' + text[-3000:])
    miss = json.loads(line[len('MISSES '):])
    miss['used'] = json.loads(used[len('USED '):])
    return miss


def main():
    os.makedirs(OUT, exist_ok=True)
    fresh = '--fresh' in sys.argv
    rpc = {} if fresh else load('rpc.json', {})
    explorer = {} if fresh else load('explorer.json', {})
    index = None if fresh else load('index.json', None)
    try:
        if not index or HEAD_KEY not in rpc:
            head = rpc1('eth_getBlockByNumber', ['latest', False])
            rpc[HEAD_KEY] = trim_rpc('eth_getBlockByNumber', None, {'result': head})
            index = build_index(head)
            save('index.json', index)
            save('rpc.json', rpc)
            print('index: %d Pons launches, head block %d' % (len(index['rows']), index['head']['number']))
        with tempfile.TemporaryDirectory() as work:
            for round_ in range(1, 41):
                miss = run_driver(work)
                n = len(miss['rpc']) + len(miss['explorer'])
                print('round %d: %d rpc + %d explorer requests to record' % (round_, len(miss['rpc']), len(miss['explorer'])))
                if not n:
                    # Drop answers the final run never asked for (detours taken while answers were still missing).
                    used = set(miss['used'])
                    rpc = {k: v for k, v in rpc.items() if k in used}
                    explorer = {k: v for k, v in explorer.items() if 'GET ' + k in used}
                    save('rpc.json', rpc)
                    save('explorer.json', explorer)
                    break
                todo = miss['rpc']
                for k in range(0, len(todo), 20):
                    part = todo[k:k + 20]
                    for m, res in zip(part, rpc_many([(m['method'], m['params']) for m in part])):
                        rpc[m['key']] = trim_rpc(m['method'], m['params'], res)
                for path in miss['explorer']:
                    explorer[path] = trim_explorer(path, explorer_get(path))
                save('rpc.json', rpc)
                save('explorer.json', explorer)
            else:
                raise SystemExit('still missing requests after 40 rounds')
    except Unavailable as e:
        save('rpc.json', rpc)
        save('explorer.json', explorer)
        raise SystemExit('Blockscout unavailable (%s). Saved what was recorded; run again later.' % e)
    print('done: %d rpc answers, %d explorer answers in %s' % (len(rpc), len(explorer), OUT))


if __name__ == '__main__':
    main()
