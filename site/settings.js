// =====================================================================
//  BLAME THE STOCK  —  SETTINGS
//
//  Every blank on the site lives in this one file.
//  How to change something:
//    1. Change the text between the quotes (keep the quotes).
//    2. Save the file.
//    3. Upload the "site" folder again.
//  true / false switches have no quotes.
// =====================================================================

export const SETTINGS = {

  // ---- The big headline at the top -----------------------------------
  headline: {
    line1: "IT WASN'T",
    line2: "YOUR COIN",
    // How much of the screen width the headline fills (0.9 = 90%).
    widthOfScreen: 0.9,
  },

  // ---- Font for the whole site: "archivo" or "robotoflex" ------------
  font: "archivo",

  // ---- Site and X ----------------------------------------------------
  site: {
    name: "Blame the Stock",
    url: "https://blamethestock.xyz",       // no slash at the end
    description: "Paste a Robinhood Chain coin. See how much of its move came from what it's paired with.",
  },
  xHandle: "",              // your X handle without the @. Empty = the X link is hidden.

  // ---- $BLAME token --------------------------------------------------
  token: {
    launched: false,        // switch to true at launch
    ticker: "$BLAME",
    contractAddress: "",    // 0x... (shown only when launched is true)
    ponsUrl: "",            // link to $BLAME on Pons
    devWallet: "",          // 0x...
    devBuy: "",             // for example "0.5 ETH"
  },

  // ---- Feature switches ----------------------------------------------
  features: {
    offHoursMode: false,    // Sunday: shows if the move happened while the US market was closed
    stockBoard: false,      // Monday: the Stock-Paired Board
  },

  // ---- Example coins under the paste box (tap to try) ----------------
  examples: [
    { label: "AI",    address: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18" },  // paired with NVDA
    { label: "ZOLVA", address: "0x8e04549484d0612be8373a0263b11928a5f7681f" },  // paired with ETH
    { label: "SHRP",  address: "0xb961886115fb9e4f732e20e89efd6d0406c3527f" },  // paired with ORBIO
  ],

  // ---- Time windows --------------------------------------------------
  windows: ["1h", "6h", "24h", "7d"],
  defaultWindow: "24h",

  // ---- Stickers that follow the cursor in the top section ------------
  stickers: {
    spacingPx: 90,          // one sticker roughly every 90px of mouse movement
    lifetimeSeconds: 2.5,   // gone within 2.5 seconds
    fadeSeconds: 0.5,       // the last half second is a gentle fade
    maxOnScreen: 12,
    tapCount: 3,            // phones: stickers per tap
    tickers: ["NVDA", "TSLA", "SPY", "GME", "ETH", "USDG", "$BLAME"],
    lines: ["NOT MY FAULT", "IT WAS THE STOCK", "WASN'T ME"],
  },

  // ---- The giant sliding line of text --------------------------------
  marquee: "IT WAS THE STOCK  ·  NOT MY FAULT  ·  WASN'T ME  ·  ",

  // ---- Update log (newest first) -------------------------------------
  updates: [
    { date: "2026-11-14", text: "Blame the Stock is live. Paste any Robinhood Chain coin." },
  ],

  // ---- Safety limits (change only if you know why) -------------------
  limits: {
    flatPercent: 0.5,       // a coin that moved less than this is "basically flat"
    lowLiquidityUsd: 5000,  // less than this on the pair's side of the pool = "numbers are shaky"
    staleSeconds: 120,      // chain data older than this = don't show numbers
  },

  // ---- Wording (advanced) --------------------------------------------
  // Words in {curly brackets} are filled in automatically.
  wording: {
    pairNames: {
      stock: "the stock ({ticker})",
      eth: "Ethereum",
      stable: "the dollar",
      coin: "{symbol}",
    },
    lead: "You're {move}.",
    leadFlat: "Your coin barely moved ({coinPct}).",
    normal: "About {share} of that is {pair}.",
    mostlyPair: "Almost all of that is {pair}.",
    none: "None of that is {pair}. It's all the coin.",
    pairBiggerDown: "{Pair} fell {pairPctAbs}, so your coin actually held up better.",
    pairBiggerUp: "{Pair} rose {pairPctAbs}, so your coin actually lagged behind.",
    opposite: "{Pair} went the other way ({pairPct}), so none of it is {pair}. It's all the coin.",
    stable: "It's paired with a dollar coin, so there's nothing to blame. It's all the coin.",
    flatPairMoved: "{Pair} moved {pairPct} in the same time.",
    flatPairFlat: "Neither did {pair}.",
    ownMove: "On its own, {coin} was {ownMove} against {pairShort}.",
    notes: {
      sinceLaunch: "This coin's pool is only {age} old, so this covers its whole life, not the full {window}.",
      noTrades: "Nobody traded {coin} in this window, so its price against {pairShort} stood still.",
      lowLiquidity: "Only {liquidity} on the {pairShort} side of its main pool, so these numbers are shaky.",
      pool: "Measured in the {poolLabel} pool.",
    },
    asOf: "Prices as of {time}",
    shareText: "My {coinTag} is {move} ({window}). {blame}",
    errors: {
      "bad-address": "That doesn't look like a coin address. It starts with 0x and has 40 letters or numbers after it.",
      "not-a-token": "That address isn't a coin on Robinhood Chain.",
      "wrong-chain": "That coin isn't on Robinhood Chain. This only works for Robinhood Chain coins.",
      "no-pool": "We couldn't find a trading pool for this coin. If it just launched on Pons, it may still be on its launch curve.",
      "is-pair-asset": "That's {symbol} itself. Paste a coin that trades against it.",
      "unsupported-pool": "This coin trades in a kind of pool we can't read yet.",
      "stale": "Robinhood Chain data looks delayed right now, so we're not showing numbers. Try again in a minute.",
      "rpc-failed": "We couldn't reach Robinhood Chain just now. Try again in a minute.",
      "pair-too-new": "What this coin is paired with is too new to measure over this window. Try a shorter one.",
    },
  },
};
