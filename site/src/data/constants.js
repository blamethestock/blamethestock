// Fixed facts about Robinhood Chain used by the data code. Every hash below is checked by
// dev/tools/keccak.py (run it after any change here).

export const CHAIN_ID = 4663;
export const BLOCK_SECONDS = 0.1045;          // average block time, used only for first guesses

// RPC endpoints. maxInFlight = requests at once; batchMax = calls per JSON-RPC batch.
export const RPC = {
  official:   { url: 'https://rpc.mainnet.chain.robinhood.com', maxInFlight: 3, batchMax: 6 },   // live; state ~10 min back; logs
                                                                   // (allows 10 per batch, but bigger batches draw 429s)
  drpc:       { url: 'https://robinhood.drpc.org',              maxInFlight: 4, batchMax: 3 },   // full archive eth_call
  publicnode: { url: 'https://robinhood-rpc.publicnode.com',    maxInFlight: 3, batchMax: 10 },  // last ~100 blocks only
};
export const DEXSCREENER = 'https://api.dexscreener.com';
export const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2';

// Contracts
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';   // Uniswap v4 (all 32-byte pool ids)
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const STOCK_FACTORY = '0x4783c67b63de2b358ac5951a7d41f47a38f3c046';

// Tokens
export const ETH_NATIVE = '0x0000000000000000000000000000000000000000';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const WETH_USDG_POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';   // v3, token0 WETH, token1 USDG, fee 100

// Dollar stablecoins treated as exactly $1. (NOT $1: syrupUSDG, steakUSDG, sUSDe; fake 18-decimal "USDG"s.)
export const STABLES = {
  [USDG]: 'USDG',
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34': 'USDe',
  '0xce24439f2d9c6a2289f741120fe202248b666666': 'U',
  '0x61a10e8556bed032ea176330e7f17d6a12a10000': 'UUSD',
  '0x00000000d61733e7a393a10a5b48c311abe8f1e5': 'frxUSD',
};
export const ETH_TOKENS = { [ETH_NATIVE]: 'ETH', [WETH]: 'WETH' };
export const KNOWN_DECIMALS = { [USDG]: 6, [WETH]: 18, [ETH_NATIVE]: 18 };

// Event topics (keccak256 of the signature) — verified by dev/tools/keccak.py
export const TOPIC_V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
export const TOPIC_V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
export const TOPIC_V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
export const TOPIC_V3_INITIALIZE = '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95';

// Function selectors — verified by dev/tools/keccak.py
export const SEL_SLOT0 = '0x3850c7bd';          // slot0()            v3-style pools
export const SEL_GET_SLOT0 = '0xc815641c';      // getSlot0(bytes32)  StateView
export const SEL_GET_LIQUIDITY = '0xfa6793d5';  // getLiquidity(bytes32) StateView (in-range liquidity of a v4 pool)
export const SEL_LIQUIDITY = '0x1a686502';      // liquidity()        v3-style pools
export const SEL_DECIMALS = '0x313ce567';       // decimals()
export const SEL_SYMBOL = '0x95d89b41';         // symbol()
export const SEL_UID = '0xf514ce36';            // uid()              Robinhood stock token
export const SEL_TOKEN_ADDRESS = '0x97bb3ce9';  // tokenAddress(bytes32) StockFactory

export const WINDOW_SECONDS = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };

export const POOL_CACHE_SECONDS = 300;   // pools per coin
export const HEAD_CACHE_SECONDS = 15;    // window tabs clicked within this time share the same end block
