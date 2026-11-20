// Fixed facts the launch indexer needs (Worker, tests and dev/tools/backfill_launches.py read the same file:
// the Python script parses the FACTORIES addresses, the topic, MULTICALL3 and INDEX_FLOOR out of it, so keep
// each on one line in this exact shape).
//
// Everything here was checked read-only on Robinhood Chain (chain id 4663) on 2026-11-18.

// RPC endpoints: the site's list is the single source (official = logs + live state, drpc = archive,
// publicnode = last ~100 blocks). rpc.js reads it, so the Worker and the site share retries and backoff.
export { RPC, CHAIN_ID } from '../../site/src/data/constants.js';

// TokenLaunched(address indexed token, address indexed curve, address indexed creator,
//               address pairToken, uint256, uint256 graduationThreshold)
export const TOPIC_TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
// Factory graduation log (topic1 = the coin): the curve reached its threshold and the coin moved to a Uniswap v4 pool.
export const TOPIC_GRADUATED = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';

// Every contract seen emitting TokenLaunched. Index by this list, never by the topic alone.
// first/last = first and last launch block observed (last null = still launching). The ranges are notes only:
// the indexer asks every factory for every range, so a factory that wakes up again is still caught.
export const FACTORIES = [
  { address: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', label: 'Pons V2',     first: 27027321, last: null },     // 734k+ launches
  { address: '0x7e1eabd52ae29598e6483f72dcf1a70b14284db8', label: 'Pons early',  first: 24364906, last: 24672736 }, // 1,044
  { address: '0x99abe567f756fc33fff352501042e51772def04b', label: 'Pons test 1', first: 24383375, last: 24574863 }, // 4
  { address: '0xa7531a9d5f183bb199a1553ef9234273918306b7', label: 'Pons test 2', first: 23350512, last: 24398425 }, // 4
  { address: '0xb2efb7078bc184a8a44ab881855ca3174396920a', label: 'Pons test 3', first: 24568049, last: 24574853 }, // 5
  { address: '0xf839f09fda50c9c3fe4ef4869a5a7e312b5333ab', label: 'Pons test 4', first: 24378502, last: 24574879 }, // 14
  { address: '0x408f3c58e9de4dcf579b8ad3b3aa4b6880d3f99b', label: 'Pons test 5', first: 24720095, last: 26400456 }, // 2
  { address: '0x537a43002af36f14982a00a1d8749933130ae128', label: 'Pons test 6', first: 25318971, last: 25322512 }, // 3
];
export const FACTORY_ADDRESSES = FACTORIES.map((f) => f.address);

// No factory launched anything below this block (checked per factory over blocks 0 to 30M: the first launch
// is at 23,350,512). The backfill stops here; the index is complete when meta.oldest_block <= INDEX_FLOOR.
export const INDEX_FLOOR = 20000000;

// Multicall3 (canonical address, deployed on chain 4663: 3,808 bytes of code). Used two ways:
//  - it is the `creator` of 5,093+ launches (the factory was called through it), so the dev is tx.from;
//  - aggregate3 reads name()/symbol() for many tokens in one eth_call.
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

// Selectors
export const SEL_NAME = '0x06fdde03';         // name()
export const SEL_SYMBOL = '0x95d89b41';       // symbol()
export const SEL_AGGREGATE3 = '0x82ad56cb';   // aggregate3((address,bool,bytes)[])

// eth_getLogs limits on the official node: one address may span 10,000,000 blocks (to - from <= 9,999,999);
// a list of addresses may span only 100,000; at most 10,000 logs per answer (then split the range).
export const LOG_SPAN_ONE = 9999999;
export const LOG_SPAN_MANY = 99999;
export const LOG_CAP = 10000;

// Minute indexer defaults
export const CONFIRMATIONS = 20;           // stay this many blocks (~2 s) behind the head
export const DEFAULT_MAX_BLOCKS = 200000;  // blocks per run (~5.8 h of chain; a normal minute is ~575 blocks)
export const DEFAULT_MAX_ROWS = 400;       // launches written per run (cut at a block edge)
export const FIRST_RUN_LOOKBACK = 600;     // empty table, no fromBlock: start ~1 minute back (the backfill does the past)
export const NAMES_PER_CALL = 100;         // tokens per aggregate3 eth_call (2 calls each)
export const PENDING_NAMES_PER_RUN = 100;  // rows with an unread name/symbol retried per run
export const D1_BATCH = 100;               // statements per DB.batch()

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
