# Blame the Stock

**Your coin didn't pump. The stock did.** Paste any Robinhood Chain coin and see how much of its move was what it's paired with.

**Site:** [blamethestock.com](https://blamethestock.com) · **X:** [@blamethestock](https://x.com/blamethestock)

**Official $BLAME CA:** `0xc15402eadae17fe62ac6bb6c135451a5584b2e82` ([Blockscout](https://robinhoodchain.blockscout.com/token/0xc15402eadae17fe62ac6bb6c135451a5584b2e82))

> Read-only. No wallet connect. Not financial advice.

## What it does

- **Blame split.** Paste a coin's address. The site shows how much of its price move over 1h, 6h, 24h or 7d came from its pair (a stock token, ETH or another coin) and how much came from the coin itself. Every number links to its proof on the Robinhood Chain explorer: the coin, the pool or launch curve, and the start and end blocks.
- **Fake-copy warning ("Is this the real one?").** Paste an address or a ticker. It lists every Pons launch using the same name, including look-alike letters and hidden characters, with launch time, dev wallet, what the dev bought and sold, fees claimed, money bridged out and graduation. It flags patterns such as "launched just before", "dev dumped fast" and "took fees and left", and labels the coin that clearly leads on holders, graduation and money in it. It never declares which coin is "real". Only the official $BLAME address gets a ✅ badge.
- **Copycat alerts.** A live list of new Pons coins (last 24 hours) that use the name or ticker of a Pons coin that already graduated, with both addresses and a ready-to-post warning. Graduation is the reference because it takes real buys; trading-volume numbers on Robinhood Chain are easy to fake.
- **Graduation radar.** The ETH-paired Pons coins of the last 48 hours closest to graduating: ETH in the launch curve against its 4.2 ETH threshold, with holders, the dev's buy and the first buyers' share, each linking to its launch report.
- **Launch report.** For any Pons coin: what the dev did (buy, sends, burns, sells, fee claims), who bought in the first ~5 seconds and whether they sold, and wallet links (shared funders) loaded separately.

## How the split is calculated

1. We find the coin's main pool (the one with the most real money on the pair's side) or its Pons launch curve.
2. We read two prices straight from Robinhood Chain at the **same start and end blocks**: the coin priced in its pair, and the pair priced in dollars.
3. The coin's dollar move is the pair's move combined with the coin's own move against its pair: `(1 + coin) = (1 + pair) × (1 + coin vs pair)`.
4. The pair's share of the move is `ln(1 + pair) ÷ ln(1 + coin)`. The rest is the coin's own.
5. Special cases get plain sentences instead of a split: a dollar-paired coin (nothing to blame), a nearly flat coin, a pair that moved the opposite way, or a pair that moved more than the coin.

DexScreener and GeckoTerminal are only used to find which pool a coin trades in. Prices never come from them.

## How the math works

Full write-up with a worked example: **[blamethestock.com/math](https://blamethestock.com/math)**. The code is [`site/src/core/math.js`](site/src/core/math.js) (formula) and [`site/src/data/`](site/src/data/) (on-chain reads).

- `c` = coin's change in $, `q` = pair's change in $, `r` = coin's change against its pair.
- `(1 + c) = (1 + q) × (1 + r)`, and the pair's share = `ln(1 + q) ÷ ln(1 + c)`. The logs make the two parts add up exactly.
- Prices: the coin's main pool (most real money on the pair's side) read on-chain with `sqrtPriceX96` (`(sqrtPriceX96 / 2^96)^2 × 10^(dec0 − dec1)`), and the pair's USDG pool, both at the **same start and end blocks**. End = latest block − 5; start = last block at or before end − window (1h, 6h, 24h, 7d).

**Worked example ($AI vs NVDA, 24h, blocks [118,383,187](https://robinhoodchain.blockscout.com/block/118383187) → [119,216,653](https://robinhoodchain.blockscout.com/block/119216653)):**

| | AI in NVDA | NVDA in $ | AI in $ |
|---|---|---|---|
| Start | 0.000148170423 | 148.967791 | 0.02207262 |
| End | 0.0001306960964 | 135.933826 | 0.01776602 |

`c = −19.511%`, `q = −8.750%`, `r = −11.793%`, share from NVDA = `ln(0.91250) ÷ ln(0.80489) = −0.091600 ÷ −0.217078 = 42%`.

Recompute it yourself (Python standard library, read-only):

```sh
python3 dev/tools/recompute_split.py 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18 \
  0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27 \
  0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec 0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 118383187 119216653
```

## Limits

- **Thin pools and short windows are less reliable.** Under $5,000 on the pair's side of the pool, the card says the numbers are shaky. A coin younger than the window is measured over its whole life, and the card says so.
- A stock token's price on Robinhood Chain can differ from the real share price.
- If chain data is missing or delayed, the site shows a message instead of a number.
- The copy check only covers **Pons launches**. Our launch index currently reaches back to Oct 28, 2026, and older history is still being added.
- Wallet links can't follow money through exchanges, bridges or privacy tools, and the explorer is sometimes unavailable.

## Roadmap

| Feature | Status |
|---|---|
| Blame split with proof links | **Live** |
| Fake-copy warning, with the same-name coin that leads on holders, graduation and money labelled | **Live** |
| Launch report with wallet links | **Live** |
| Share to X on every result (blame split, copy check, launch report) | **Live** |
| Copycat alerts: Pons launches of the last 24 h using the name or ticker of a coin that already graduated, with a ready-to-post warning | **Live** |
| Graduation radar: ETH-paired Pons coins of the last 48 h closest to graduating (% of 4.2 ETH), with holders, dev % and first-buyer % | **Live** |
| Live counter: blames run, coins checked and copies flagged, today (UTC) and all time; one number per day, nothing about visitors | **Live** |
| MCP server, hosted at `https://api.blamethestock.com/mcp` (tools: `blame_split`, `check_copycats`, `launch_report`) | **Live** |
| MCP npm package (`npx blamethestock-mcp`) and directory listings | Planned |
| $BLAME receipts on the site (dev buy, sells, burns, fee claims, live from the chain) | **Live** |

## $BLAME

- **Fixed supply**, launched on Pons.
- **Dev buy: 1.59% of supply** at launch (0.028 ETH, [launch tx](https://robinhoodchain.blockscout.com/tx/0x2ebfad04a4ed91e0be1dcf3f43e41bc1effd2b8062e6133af03e3a9efbb48277)). Dev wallet: [`0xfbA600991E6d76a17e45Fec9F68b002c97def19D`](https://robinhoodchain.blockscout.com/address/0xfbA600991E6d76a17e45Fec9F68b002c97def19D).
- **The dev never sells.**
- **Burned:** the dev burned 7,954,731.84 $BLAME (half the dev buy, 0.80% of supply) on Nov 20 ([burn tx](https://robinhoodchain.blockscout.com/tx/0x6c5cc29292ed99ca16bbf6d48efc4ee7112cffed92e2e2383bde3408720a5818)). The dev now holds 0.80% of supply and has sold nothing.
- **Creator fees buy back and burn $BLAME.**
- **Receipts posted.** Once the dev wallet is set, the site's Receipts section reads it live from the chain: the dev buy, every sell, burn and fee claim, each linked to its transaction. You don't have to trust us; check the wallet.

The only official contract address is the one on [blamethestock.com](https://blamethestock.com). There is no presale, airdrop or claim. See [SECURITY.md](SECURITY.md).

## What's in this repo

| Folder | What it is |
|---|---|
| `site/` | The website. Static files; `site/settings.js` holds every text and switch. |
| `api/` | The Cloudflare Worker at `api.blamethestock.com`: the Pons launch index, copy check, launch report, a blame counter (no personal data) and the hosted MCP server. |
| `mcp/` | The MCP stdio package (`blamethestock-mcp`). |
| `dev/` | Tests (`sh dev/run-tests.sh`), a local preview server and data tools. |
| `docs/` | API reference and MCP publishing notes. |
| `launch-kit/` | Tools that make the logo, link-preview images and post cards. |

## Privacy

No wallet connection, no login, no cookies, no analytics. The API doesn't store visitor IP addresses; they're only used in memory for rate limiting. The live counter stores one number per day for each of blames run, coins checked (copy checks and launch reports, once per coin per visit) and copies flagged (same-name coins a copy check showed with a warning flag). Nothing about the visitor is stored.

## License

[MIT](LICENSE)
