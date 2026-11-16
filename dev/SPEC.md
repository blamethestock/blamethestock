# Blame the Stock — build spec

This is the single source of truth for everyone building the site. Read all of it before writing code.
The owner is not a developer. They are asleep; nothing may be published, deployed, pushed, or sent anywhere.

---------------------------------------------------------------------
## 0. The owner's brief (verbatim requirements, still binding)

WHAT: A one-page website, Blame the Stock (blamethestock.com). A visitor pastes the contract address of any
Robinhood Chain coin. The site shows how much of that coin's price move came from the asset it is paired with,
and how much came from the coin itself. Example: "You're down 12%. About 40% of that is the stock (NVDA)."
A memecoin $BLAME launches alongside it on Pons (Sat 14 Nov 2026 ~10am US Eastern).

HARD RULES
- The tool is on the homepage. No "Open app" step.
- Free for everyone. No wallet connection, no login, no payment. Nothing locked behind holding $BLAME.
- Static site on free hosting. No server.
- Never show a number you are not sure of. If data is missing or old, say so on the card instead.
- No real company logos or brand marks anywhere. Ticker text only (write "NVDA", never a logo; avoid company names).
  The X link is the text "X", not the X logo.
- Do not copy text, images or assets from any other website. Write all copy and draw all graphics yourself.
- Never ask for a private key or seed phrase.

LOGIC
1. Input: a Robinhood Chain token address (0x + 40 hex), typed in or passed as ?ca=ADDRESS&w=24h.
2. Find the coin's main pool on Robinhood Chain (chain id 4663). Read what it is paired with.
3. Pair types and wording: stock/fund token -> "the stock (NVDA)"; ETH -> "Ethereum"; dollar stablecoin (USDG) ->
   nothing to blame, "all the coin"; another coin (e.g. ORBIO) -> that coin's ticker.
4. Time windows: 1h, 6h, 24h (default), 7d. Same start and end time for the coin and for the pair.
5. Maths. c = coin's dollar change, q = pair's dollar change.
   Coin's own move: r = (1+c)/(1+q) - 1. Share from the pair: ln(1+q) / ln(1+c).
   Test case: c = -12%, q = -5% gives r = -7.4%, share = 40%.
6. Special cases, each with its own plain sentence: pair moved the opposite way; coin basically flat (under 0.5%);
   coin younger than the window (use since-launch, say so); very low liquidity (warn numbers are shaky);
   bad address, wrong chain, no pool found.
7. A stock token's price is its on-chain price on Robinhood Chain, not the real share price.
Show "Prices as of [time]" on every result.

RESULT CARD
- One plain verdict line, large.
- A split bar in two colours: the pair (blue) and the coin (vermilion).
- Three numbers: coin in dollars, the pair, coin versus pair.
- Tabs for the four time windows.
- Buttons: Post on X (prefilled text plus the result link), Save image (1200x675, looks good on X), Copy link.
- On appear: the number counts up, the bar splits from the middle.

PAGE SECTIONS, TOP TO BOTTOM
1. Floating pill menu: wordmark, X link, "Paste a coin" button.
2. Hero: giant two-line headline, paste box right under it, three example coins to tap.
3. Result card, appearing in place.
4. How it works, three scroll stops: "Your coin moved." / "So did what it's paired with." / "Here's the split."
5. One line of giant text sliding sideways as you scroll.
6. Token section: $BLAME, contract address, Pons, dev wallet, dev buy. Until the address is set show:
   "Not live yet. Any address claiming to be $BLAME is not ours." Also: "The tool is free. You never need to hold $BLAME."
7. Update log with dated entries.
8. Footer: huge wordmark, plus: not affiliated with Robinhood, Pons or any company named; not financial advice;
   prices can be delayed or wrong; data source credit.

LOOK
- Black background, white text, grey for small text, thin grey lines, lots of empty space. Restrained, like Vercel's site.
- Only two colours besides black, white and grey: deep blue #2433FF = the pair, vermilion #FF4F1F = the coin.
  Use them in the split bar, the stickers and tiny highlights only.
- Ups and downs shown with + / − and arrows in WHITE. No red or green anywhere.
- Headline: heavy, condensed, all capitals, letters squeezed tight, two lines that nearly fill the screen width,
  lines close together. One font family for the whole site. Rounded cards with a thin border.
- Headline text comes from settings (SETTINGS.headline.line1 / line2).

MOTION
- Desktop cursor trail, hero only: stickers pop along the cursor path, about one every 90px, each slightly rotated.
  Each is gone within 2.5 s (fully visible ~2 s, then a gentle 0.5 s fade). Max 12 on screen (drop the oldest).
  They must never block or cover the paste box (and never intercept clicks: pointer-events none).
- Stickers are original designs: ticket stubs, price tags and stamps with ticker text (NVDA, TSLA, SPY, GME, ETH, USDG,
  $BLAME) and lines like "NOT MY FAULT", "IT WAS THE STOCK", "WASN'T ME". Blue, vermilion, white and black only.
- Phones: a few stickers pop where the visitor taps in the hero (not when tapping the input or buttons).
- Headline reveals on load with a white block wiping across.
- Sections fade and rise slightly as they scroll into view. Scroll motion works on desktop and phone.
- prefers-reduced-motion: turn the trail, slides and count-up off (show final states immediately).
- No video, no 3D. Must load fast on an ordinary phone. No frameworks, no build step, no npm.

---------------------------------------------------------------------
## 1. Decisions made since the brief

- Fonts (both free, Google Fonts, variable): "archivo" = Archivo (axes wdth 62..125, wght 100..900);
  "robotoflex" = Roboto Flex (axes opsz 8..144, wdth 25..151, wght 100..1000). SETTINGS.font picks one; the page
  loads only that one. Headline: the narrowest/heaviest cut that looks like the reference (Archivo ~wdth 62-70,
  wght 800-900; Roboto Flex ~wdth 25-40, wght 900-1000 — tune by eye). Body text: same family at normal width.
- Headline reference: screenshot of ugly.cash at
  <scratch>
  (proportions ONLY — do not copy anything). Observed: very heavy, squeezed letter-spacing (letters almost touch),
  the gap between the two lines is ~1/5 of the cap height (line-height ~0.85-0.9), an "O" is ~3/4 as wide as tall.
  Ours: white on black, two lines each ~SETTINGS.headline.widthOfScreen (0.9) of the viewport width; fit by measuring
  the rendered text and scaling the font-size so the WIDER line hits the target width (both lines same size).
- Sticker lifetime: SETTINGS.stickers (lifetimeSeconds 2.5, fadeSeconds 0.5, spacingPx 90, maxOnScreen 12).
- Pair wording uses tickers, not company names: "the stock (NVDA)".
- Share text (no $BLAME, no handle): "My $ZOLVA is down 12% (24h). About 40% of that is Ethereum." + the result link.
- "Prices as of" uses the visitor's local time with a short zone name, e.g. "Prices as of 12:37 AM EST".
- X link preview is one fixed picture for every link (site/assets/og.png); per-result previews would need a server.
- Data: every number comes from Robinhood Chain itself (see §5). DexScreener is only used to find the coin's pools;
  GeckoTerminal is a backup for that. Report: <project folder>/reports/1-data-check.md

---------------------------------------------------------------------
## 2. Files and who owns them

Project root: <project folder>   (note the literal "$" — quote paths in shell)
Upload folder (what goes online): site/   — everything else is dev-only.

site/index.html            PAGE builder
site/styles.css            PAGE builder
site/settings.js           (exists; owner-edited. Do not restructure. You may ADD fields if truly needed — say so.)
site/src/app.js            CARD builder  (boot: reads URL, wires paste form/examples/tabs, calls data+core, renders card)
site/src/core/math.js      CORE builder
site/src/core/verdict.js   CORE builder
site/src/core/format.js    CORE builder
site/src/data/*.js         DATA builder
site/src/ui/page.js        PAGE builder  (fills sections from SETTINGS: menu, hero text, examples, how-it-works, marquee,
                                          token section, update log, footer; loads the chosen font)
site/src/ui/motion.js      PAGE builder  (headline fit + wipe, scroll reveals, marquee slide, how-it-works stops, reduced motion)
site/src/ui/trail.js       PAGE builder  (cursor trail + tap stickers, hero only)
site/src/ui/stickers.js    STICKERS builder
site/src/ui/card.js        CARD builder  (renders Result / ErrorResult / loading into #result)
site/src/ui/card.css       CARD builder  (linked from index.html by PAGE builder)
site/src/ui/share.js       CARD builder  (X intent, copy link, 1200x675 image)
site/assets/               CARD builder makes og.png (1200x630), icon.svg, icon-32.png, icon-180.png
dev/tests/…                each builder adds its own tests: dev/tests/<area>.test.js (+ fixtures)
dev/tests/run.js           CORE builder creates the runner (imports every *.test.js listed in it; others add their line)
dev/run-tests.sh           CORE builder: runs dev/tests/run.js with jsc, exits non-zero on failure
dev/tests/index.html       CORE builder: same tests in a browser, shows ticks/crosses
dev/previews/*.html        any builder: visual preview pages (fonts, stickers, card states)

Never edit another builder's files. If you need something from another area, code against the contract below and
note it in your final report.

---------------------------------------------------------------------
## 3. Contracts (exact)

All modules are plain ES modules (`<script type="module">`), relative imports with ".js" extensions. No globals
except what is listed. Settings: `import { SETTINGS } from '../../settings.js'` (path relative to the file).

### 3.1 Data -> PriceInput   (site/src/data/index.js)
export async function fetchPriceInput(address, window, opts = {}) -> PriceInput | ErrorResult
  opts.onProgress?(text)      optional progress messages ("Finding the pool…", "Reading prices…")
  opts.endBlock?              pin the end block (tests)
export function clearDataCache()

PriceInput = {
  ok: true,
  coin:  { address, symbol, name },
  pair:  { address, symbol, kind: 'stock'|'eth'|'stable'|'coin' },
  pool:  { id, dex, label /* 'ZOLVA/ETH' */, pairSideUsd /* number|null */, createdAt /* unix s|null */, source: 'dexscreener'|'geckoterminal' },
  window: '1h'|'6h'|'24h'|'7d',
  windowSeconds: number,
  start: { block, time },          // block actually used; time = its timestamp (unix s)
  end:   { block, time },
  sinceLaunch: boolean,            // start moved forward because the pool is younger than the window
  coinInPair: { start, end },      // coin priced in the pair token (human units) at start/end blocks
  pairUsd: { start, end } | null,  // pair priced in USD (USDG=1) at the SAME blocks; null for kind 'stable'
  pairVia: { id, label } | null,   // pool used to price the pair in USD
  tradedInWindow: boolean,         // false when the coin pool's price is identical at start and end
}
ErrorResult = { ok: false, code, symbol?, detail? }
  code ∈ 'bad-address' | 'not-a-token' | 'wrong-chain' | 'no-pool' | 'is-pair-asset' | 'unsupported-pool' |
         'stale' | 'rpc-failed' | 'pair-too-new'
  ('is-pair-asset' carries symbol, e.g. NVDA, when the pasted address is a stock token, USDG, WETH or another stablecoin.)

### 3.2 Core   (site/src/core/*.js — pure functions, no DOM, no network)
math.js
  export function changes({ coinInPair, pairUsd }) -> { c, q, r }   // q = 0 when pairUsd is null
  export function shareFromPair(c, q) -> number|null                 // ln(1+q)/ln(1+c); null if not finite
  export function classify({ c, q, r }, limits) -> caseName
     caseName ∈ 'flat' | 'stable' | 'opposite' | 'none' | 'normal' | 'mostly-pair' | 'pair-bigger'
     rules: stable pair -> 'stable'; |c| < limits.flatPercent/100 -> 'flat'; q and c of opposite signs with |q| >= 0.001
     -> 'opposite'; share rounds to 0% -> 'none'; 0 < share < 0.95 -> 'normal'; 0.95 <= share <= 1.05 -> 'mostly-pair';
     share > 1.05 -> 'pair-bigger'. (classify receives kind via an extra field: classify({c,q,r,kind}, limits).)
  export function bar(caseName, share) -> { pair, coin } | null      // fractions 0..1 summing to 1; null for 'flat'
     normal: pair=share; mostly-pair: pair=min(share,1); pair-bigger: pair=1; none/opposite/stable: pair=0.
  export function validateAddress(str) -> lowercase '0x…' | null     // trims spaces; accepts any case
  export function parseWindow(str) -> '1h'|'6h'|'24h'|'7d'           // falls back to SETTINGS.defaultWindow
  export const WINDOW_SECONDS = { '1h':3600, '6h':21600, '24h':86400, '7d':604800 }
format.js
  export function pct(x, { sign=true } = {}) -> '−12%' | '+4.6%' | '−7.4%' | '0.0%'
     U+2212 minus; |x| < 10% -> 1 decimal, else 0 decimals; |x| < 0.05% -> '0.0%'
  export function pctAbs(x) -> '12%'
  export function arrow(x) -> '↑' | '↓' | '→'   (→ when |x| < 0.05%)
  export function moveWords(x) -> 'down 12%' | 'up 4.6%' | 'flat'
  export function usd(n) -> '$26k' | '$1.4M' | '$950'
  export function age(seconds) -> '3 hours' | '40 minutes' | '2 days'
  export function asOfTime(unixSeconds, locale?, timeZone?) -> '12:37 AM EST'
verdict.js
  export function buildResult(priceInput, settings = SETTINGS) -> Result
  export function buildError(errorResult, settings = SETTINGS) -> { ok:false, code, message }

Result = {
  ok: true,
  coin: { address, symbol }, pair: { address, symbol, kind, name /* 'the stock (NVDA)' */, short /* 'NVDA' */ },
  window, windowLabel /* '24h' or 'since launch' */,
  c, q, r, share /* raw or null */, sharePct /* integer or null */, caseName,
  bar: { pair, coin } | null,
  lead /* "You're down 12%." */, blame /* "About 40% of that is the stock (NVDA)." */,
  verdict /* lead + ' ' + blame */, subline /* ownMove sentence or '' */,
  headline: { value: c, text: '−12%' },          // the number that counts up
  numbers: [ { key:'coin', label:'ZOLVA in $', value:c, text, arrow },
             { key:'pair', label:'NVDA', value:q, text, arrow },
             { key:'own',  label:'ZOLVA vs NVDA', value:r, text, arrow } ],
  notes: [string], warnings: [string],           // warnings = low liquidity; notes = since launch, no trades, pool
  asOf: unix s, asOfText: 'Prices as of 12:37 AM EST',
  shareText: string, link: 'https://blamethestock.com/?ca=0x…&w=24h',
  pool: { label, pairSideUsd }
}
Invariant: (1+c) = (1+q)(1+r) to 1e-12. Wording comes from SETTINGS.wording (templates with {placeholders}).

### 3.3 Stickers   (site/src/ui/stickers.js — pure, returns SVG strings)
  export const STICKER_KINDS = ['ticket', 'tag', 'stamp']
  export function makeSticker({ kind, text, palette, seed }) -> { svg, width, height }
  export function randomSticker(seed, settings = SETTINGS) -> { svg, width, height, kind, text }
  Sizes ~110-220 px wide. Palettes only from #2433FF, #FF4F1F, #FFFFFF, #000000. Black stickers need a white
  outline so they read on the black page. Text in the site font family (font-family: var(--font), fallback
  'Arial Narrow', sans-serif) — SVG must not depend on external files.

### 3.4 Card / app / share   (site/src/app.js, site/src/ui/card.js, site/src/ui/share.js)
DOM hooks created by the PAGE builder in index.html:
  #paste-form (form), #ca-input (input), #paste-submit (button), .example-coin[data-ca] (buttons),
  #result (empty section; card renders inside), #how (how-it-works), #token, #updates, #site-footer,
  [data-action="paste-a-coin"] (menu button: scroll to + focus #ca-input)
app.js: on load read ?ca & ?w; on submit/example tap: validate, history.replaceState the URL, show loading card,
  call fetchPriceInput -> buildResult/buildError -> card.render. Window tabs re-run for the same coin (cache helps).
  Ignore stale responses (if the user started another lookup).
card.js: export function renderLoading(el, text), renderResult(el, result, { onWindow }), renderError(el, err)
share.js: export function xIntentUrl(result) -> 'https://x.com/intent/post?text=…&url=…'
          export async function copyLink(result) -> boolean
          export async function renderShareImage(result, settings) -> HTMLCanvasElement (1200x675)
          export async function saveImage(result, settings)  // downloads blame-<SYMBOL>-<window>.png

### 3.5 Page   (index.html)
- <head>: charset, viewport, title "Blame the Stock", meta description, Open Graph + Twitter card tags using
  absolute URLs from SETTINGS.site.url (og:image = <url>/assets/og.png, 1200x630; twitter:card summary_large_image),
  icons (assets/icon.svg, assets/icon-32.png, assets/icon-180.png apple-touch-icon), theme-color #000,
  <link rel="stylesheet" href="styles.css"> and <link rel="stylesheet" href="src/ui/card.css">,
  <script type="module" src="src/ui/page.js"></script> and <script type="module" src="src/app.js"></script>.
  Because meta tags must be static for X's crawler, write them literally in index.html (not via JS) using the
  values currently in settings.js, and leave a comment saying they mirror settings.js.
- CSS custom properties on :root: --bg #000, --fg #fff, --grey #8b8b8b (small text), --line #262626,
  --pair #2433FF, --coin #FF4F1F, --radius 20px, --font (set by page.js to the chosen family).

---------------------------------------------------------------------
## 4. Tools you can use (and limits)

- JavaScript without a browser: /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
  Run modules with `jsc -m file.js`. It has print(), no fetch, no DOM, no console (use print). Intl works.
- Python 3.9 standard library only: /usr/bin/python3 (run with -I). No node, no npm, no pip installs.
- Local preview server is ALREADY RUNNING: http://localhost:8765/  (serves the project root, so the site is at
  http://localhost:8765/site/ and tests at http://localhost:8765/dev/tests/). POST
  http://localhost:8765/__save?path=site/assets/<file>.png saves a body (only site/assets/ and dev/out/ allowed).
  Do not start another server.
- SVG to PNG for a quick look: `qlmanage -t -s 600 -o <outdir> file.svg` then Read the PNG.
- Built-in browser (tools mcp__Claude_Browser__*): ONLY if your task says you may. It is shared: create your OWN tab
  with tabs_create and pass that tabId on EVERY call; never touch other tabs; never use preview_start; close your tab
  when done.
- Scratch files: <scratch>
- Network: only the data sources in §5 and fonts.googleapis.com/fonts.gstatic.com. Never send personal data.
- Do NOT run git commands (the orchestrator commits). Do NOT publish, deploy, upload, or create accounts.

---------------------------------------------------------------------
## 5. Data method (DATA builder; others for context)

Chain: Robinhood Chain, id 4663, ~0.1045 s per block.
RPCs (all CORS-ok for browsers):
  OFFICIAL https://rpc.mainnet.chain.robinhood.com  — live head; state only ~10 min back; getLogs up to 10,000,000 blocks
     with address + single topic values (100,000 with OR-lists), 10,000-log cap (over cap = error); batch up to 10;
     bursts get HTTP 429 whose CORS header is malformed ("*,*") so the browser sees a network error -> retry with backoff;
     keep ≤ 3 requests in flight. Old block headers (eth_getBlockByNumber) work at any depth.
  DRPC     https://robinhood.drpc.org  — FULL ARCHIVE eth_call at any past block (the only free one). Batch ≤ 3 calls.
     Sometimes returns errors like "Unknown state. First available state is 1" -> retry (up to 4, backoff 0.4/0.8/1.6 s).
     getLogs limited to 101-block ranges (don't use it for logs).
  PUBLICNODE https://robinhood-rpc.publicnode.com — only the latest ~100 blocks; last-resort for head/eth_call latest.
Contracts:
  Uniswap v4 PoolManager 0x8366a39cc670b4001a1121b8f6a443a643e40951 (all 32-byte pool ids incl. Pons pools)
  StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b  getSlot0(bytes32) selector 0xc815641c
     -> returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee); sqrtPrice = first word.
  v3-style pools (20-byte address): slot0() selector 0x3850c7bd -> first word = sqrtPriceX96.
  Swap topics: v4 Swap 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f (topic1 = poolId; data words:
     amount0, amount1, sqrtPriceX96, liquidity, tick, fee -> sqrtPrice = word 2);
     v3 Swap 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67 (emitted by the pool; word 2 = sqrtPriceX96).
     Initialize topics: VERIFY with your own keccak before hard-coding (v4 Initialize(bytes32,address,address,uint24,int24,
     address,uint160,int24) — sqrtPrice is data word 3; v3 Initialize(uint160,int24) — word 0).
  Robinhood StockFactory 0x4783c67b63de2b358ac5951a7d41f47a38f3c046: real stock token iff tokenAddress(uid()) == token
     (uid() 0xf514ce36, tokenAddress(bytes32) 0x97bb3ce9). Official list of 212 tokens (snapshot):
     <scratch>
Tokens: USDG 0x5fc5360d0400a0fd4f2af552add042d716f1d168 (6 decimals; treat as exactly $1);
  WETH 0x0bd7d308f8e1639fab988df18a8011f41eacad73 (18); native ETH = 0x0000000000000000000000000000000000000000 in v4 pools;
  other $1 stables: USDe 0x5d3a…, U 0xce24…, UUSD 0x61a1…, frxUSD 0x00000000d61733e7a393a10a5b48c311abe8f1e5 — full addresses
  are in the addresses report: <scratch>
  (JSON; result[0].result.core_tokens). NOT $1: syrupUSDG, steakUSDG, sUSDe. Fake 18-decimal "USDG" tokens exist.
ETH in USD: WETH/USDG v3 pool 0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca (token0 WETH, token1 USDG, fee 100).
Stock in USD: its deepest USDG pool on uniswap v3/v4 by USDG amount (precompute for all 212 into stocks.js where
  possible; e.g. NVDA 0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 (v3, token0 USDG), TSLA 0xf4acdaeeb7022862a763c9b1b885e11191c889e3,
  SPY 0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd (v4)). Runtime fallback via DexScreener.
Token order: token0/currency0 is the numerically smaller address (native ETH 0x0 is always currency0).
  price of token0 in token1 = (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1).  Use BigInt to parse, then Number.

Discovery of the coin's main pool:
  1. DexScreener GET https://api.dexscreener.com/token-pairs/v1/robinhood/<coin>  (≤30 pools, unsorted, may omit
     quiet pools). If empty: GeckoTerminal GET https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/<coin>/pools
     (rate limit ~5/min/IP; 429 has no CORS -> treat as unavailable). If still nothing: DexScreener
     /latest/dex/tokens/<coin> (all chains) -> pairs elsewhere => 'wrong-chain'; eth_getCode empty => 'not-a-token';
     else 'no-pool'.
  2. Rank candidate pools by the USD value of the PAIR side only (DexScreener liquidity.usd counts the coin's own side at
     its own price and can be fake: one pool shows $1.41M with $1.4k of real NVDA). pairSideUsd = amount of pair token in
     the pool × pair token USD price. Only uniswap v4 (32-byte id) and v3-style pools that answer slot0 are readable.
  3. Classify the pair: stable list -> 'stable'; WETH or native ETH -> 'eth'; official stock list -> 'stock'; else 'coin'.
     For 'coin' pairs, price the pair coin in USD through ITS main pool (one level deep; deeper = 'unsupported-pool').
  4. If the pasted address itself is USDG/stable/WETH/ETH/a stock token -> 'is-pair-asset' with its symbol.
Blocks and windows:
  end block = latest - 5; if (now - end.time) > SETTINGS.limits.staleSeconds -> 'stale'.
  start time = end.time - windowSeconds; find the last block with timestamp ≤ start time (estimate with 0.1045 s/block,
  refine with a few eth_getBlockByNumber calls on OFFICIAL). Cache timestamps.
  If the pool was created after the start time: start at the pool's creation (sinceLaunch = true). If the pair's USD pool
  is younger than the start -> 'pair-too-new'.
Reads: coin pool and pair USD pool at the SAME start block and the SAME end block. End block reads: OFFICIAL (fallback
  DRPC). Start block reads: DRPC archive eth_call; fallback = last Swap log at or before the start block via OFFICIAL
  getLogs (search backwards: 20k, 200k, 2M, 10M block ranges), and if no swap since creation, the Initialize log price.
  Both methods were verified bit-identical overnight.
Budget: a lookup should take a few seconds and ~10-20 requests. Cache pools per coin (5 min) and reads per (pool,block).

Reference values (one moment, 24h ending 2026-11-13T05:37:28Z, end block 113120530, start block 112293925),
computed in Python with exactly this method — the JS must reproduce them when pinned to the same blocks:
  ZOLVA/ETH  c −15.797%  q −6.392%  r −10.047%     SHRP/ORBIO c −22.026% q −22.031% r +0.0075%
  ORBIO/USDG c −22.031%  q 0        r −22.031%     NOVUS/ETH  c −6.864%  q −6.392%  r −0.504%
  AI/NVDA    c −13.574%  q +2.094%  r −15.347%     STRATEGY/MSTR c −1.764% q −6.067% r +4.581%
  (prototype: <scratch>)

---------------------------------------------------------------------
## 6. Quality bar
- Correct first, then pretty. Every number on screen must trace to chain reads at stated blocks.
- No console errors. No layout overflow at 360px wide. Works in current Chrome and Safari.
- Keep total JS small (aim < 60 KB unminified for all of site/src). No external JS libraries.
- Plain, friendly copy; short sentences. No red/green. No logos. Nothing copied from other sites.
- In your final report: what you built, what you tested and how, anything you could not finish, and any decision the
  owner should make.
