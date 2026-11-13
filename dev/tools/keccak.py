#!/usr/bin/python3 -I
"""Pure-Python Keccak-256 (the Ethereum hash, NOT hashlib.sha3_256) and a check of every
topic hash and function selector hard-coded in site/src/data/constants.js.

Usage:  /usr/bin/python3 -I dev/tools/keccak.py          -> prints each signature, its hash, and OK/MISMATCH
        exit code 1 if anything does not match.
"""
import re, sys, os

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)                      # Keccak padding (SHA3 would use 0x06)
    while len(msg) % rate:
        msg.append(0)
    msg[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            A[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], 'little')
        A = _f(A)
    out = b''
    for i in range(4):
        x, y = i % 5, i // 5
        out += A[x][y].to_bytes(8, 'little')
    return out


def khex(text: str) -> str:
    return '0x' + keccak256(text.encode()).hex()


# Every hash the data code relies on: (constants.js name, signature, length in hex chars incl. 0x)
CHECKS = [
    ('TOPIC_V4_SWAP',       'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)', 66),
    ('TOPIC_V4_INITIALIZE', 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)', 66),
    ('TOPIC_V3_SWAP',       'Swap(address,address,int256,int256,uint160,uint128,int24)', 66),
    ('TOPIC_V3_INITIALIZE', 'Initialize(uint160,int24)', 66),
    ('SEL_SLOT0',           'slot0()', 10),
    ('SEL_GET_SLOT0',       'getSlot0(bytes32)', 10),
    ('SEL_DECIMALS',        'decimals()', 10),
    ('SEL_SYMBOL',          'symbol()', 10),
    ('SEL_UID',             'uid()', 10),
    ('SEL_TOKEN_ADDRESS',   'tokenAddress(bytes32)', 10),
]


def main():
    assert keccak256(b'').hex() == 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak self-test failed'
    assert keccak256(b'abc').hex() == '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', 'keccak self-test failed'
    print('keccak256(b"") self-test OK')
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    src = open(os.path.join(root, 'site', 'src', 'data', 'constants.js')).read()
    bad = 0
    for name, sig, n in CHECKS:
        want = khex(sig)[:n]
        m = re.search(r'\b' + name + r"\s*=\s*'(0x[0-9a-f]+)'", src)
        got = m.group(1) if m else None
        ok = got == want
        bad += not ok
        print(('OK       ' if ok else 'MISMATCH ') + name.ljust(20) + ' ' + want + '  ' + sig + ('' if ok else '  (constants.js has %s)' % got))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
