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

  // ---- Stock-Paired Board (shows when stockBoard above is true) ------
  board: {
    window: "24h",          // the time window it opens on: "1h", "6h", "24h" or "7d"
    maxRows: 25,            // show at most this many coins
    hide: [],               // coins to leave off, by ticker in quotes, for example ["MEME", "GAS"]
    wording: {
      title: "Stock-paired board",
      intro: "Coins paired with a stock token, ranked by their own move: what's left after taking out the stock's move.",
      tapHint: "Pick a coin to see its full split.",
      loading: "Reading {count} coins from Robinhood Chain…",
      failed: "Couldn't load the board right now.",
      ownMove: "Own move",
      listNote: "List of coins checked on {date}. Coins whose main pool is paired with a Robinhood stock token.",
    },
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
    opposite: "{Pair} went the other way ({pairPct}), so it's all the coin.",
    stable: "It's paired with a dollar coin, so there's nothing to blame. It's all the coin.",
    flatPairMoved: "{Pair} {pairMoved} in the same time.",
    flatPairFlat: "Neither did {pair}.",
    ownMove: "On its own, {coin} was {ownMove} against {pairShort}.",
    notes: {
      sinceLaunch: "This coin's pool is only {age} old, so this covers its whole life, not the full {window}.",
      noTrades: "Nobody traded {coin} in this window, so its price against {pairShort} stood still.",
      lowLiquidity: "Only {liquidity} on the {pairShort} side of its main pool, so these numbers are shaky.",
      lowLiquidityUnknown: "We couldn't measure how much money is in its main pool, so these numbers may be shaky.",
      stockToken: "{pairShort} here is its token price on Robinhood Chain, which can differ from the share price.",
      lookalike: "Heads up: this {pairShort} isn't Robinhood's {pairShort} stock token. It's another coin using the same name.",
      pool: "Measured in the {poolLabel} pool.",
      curve: "Measured on its Pons launch curve. It hasn't moved to a trading pool yet.",
      curveThenPool: "Measured on its Pons launch curve, then its {poolLabel} pool.",
      sinceLaunchCurve: "This coin is only {age} old, so this covers its whole life, not the full {window}.",
      lowLiquidityCurve: "Only {liquidity} has gone into its launch curve so far, so these numbers are shaky.",
    },
    asOf: "Prices as of {time}",
    shareText: "My {coinTag} is {move} ({window}). {blame}",
    // The X post speaks as the visitor, so "your coin" becomes "mine" there.
    sharePairBiggerDown: "{Pair} fell {pairPctAbs}, so mine actually held up better.",
    sharePairBiggerUp: "{Pair} rose {pairPctAbs}, so mine actually lagged behind.",
    errors: {
      "bad-address": "That doesn't look like a coin address. It starts with 0x and has 40 letters or numbers after it.",
      "not-a-token": "That address isn't a coin on Robinhood Chain.",
      "wrong-chain": "That coin isn't on Robinhood Chain. This only works for Robinhood Chain coins.",
      "no-pool": "We couldn't find a trading pool for this coin. If it just launched on Pons, it may still be on its launch curve.",
      "is-pair-asset": "That's {symbol} itself. Paste a coin that trades against it.",
      "unsupported-pool": "This coin trades in a kind of pool we can't read yet.",
      "stale": "Robinhood Chain data looks delayed right now, so we're not showing numbers. Try again in a minute.",
      "rpc-failed": "We couldn't reach Robinhood Chain just now. Try again in a minute.",
      "search-failed": "We couldn't reach the pool search just now. Try again in a minute.",
      "pair-too-new": "What this coin is paired with is too new to measure over this window. Try a shorter one.",
    },
    // Off-hours mode (switch: features.offHoursMode). A small block under the three numbers.
    // "US stock market" = the regular session, 9:30 AM to 4:00 PM New York time on trading days.
    offHours: {
      title: "Off-hours",
      checking: "Checking market hours…",
      unavailable: "We couldn't check market hours right now.",
      allClosed: "The US stock market was closed for this whole window.",
      allOpen: "The US stock market was open for this whole window.",
      almostAllClosed: "Almost all of this move happened while the US stock market was closed.",
      mostlyClosed: "Most of this move happened while the US stock market was closed.",
      even: "This move was split about evenly between market hours and closed hours.",
      mostlyOpen: "Most of this move happened while the US stock market was open.",
      almostAllOpen: "Almost all of this move happened while the US stock market was open.",
      opposite: "{coin} {closedWay} while the US stock market was closed and {openWay} while it was open.",
      flat: "{coin} barely moved, whether the US stock market was open or closed.",
      numbers: "While closed: {closed}. While open: {open}.",
      side: "{coin} {coinPct}",                    // for coins paired with ETH, a dollar coin or another coin
      sideStock: "{coin} {coinPct}, {pair} {pairPct}",   // for coins paired with a stock
      closedLabel: "Market closed",
      openLabel: "Market open",
    },
  },
};
