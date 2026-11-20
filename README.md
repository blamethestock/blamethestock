# Blame the Stock

**Your coin didn't pump. The stock did.** Paste any Robinhood Chain coin and see how much of its move was what it's paired with.

**Site:** [blamethestock.com](https://blamethestock.com) · **X:** [@blamethestock](https://x.com/blamethestock)

**Official $BLAME CA:** coming at launch

> Read-only. No wallet connect. Not financial advice.

## What it does

- **Blame split.** Paste a coin's address. The site shows how much of its price move over 1h, 6h, 24h or 7d came from its pair (a stock token, ETH or another coin) and how much came from the coin itself. Every number links to its proof on the Robinhood Chain explorer: the coin, the pool or launch curve, and the start and end blocks.
- **Fake-copy warning ("Is this the real one?").** Paste an address or a ticker. It lists every Pons launch using the same name, including look-alike letters and hidden characters, with launch time, dev wallet, what the dev bought and sold, fees claimed, money bridged out and graduation. It flags patterns such as "launched just before", "dev dumped fast" and "took fees and left". It never declares which coin is "real". Only the official $BLAME address gets a ✅ badge.
- **Launch report.** For any Pons coin: what the dev did (buy, sends, burns, sells, fee claims), who bought in the first ~5 seconds and whether they sold, and wallet links (shared funders) loaded separately.

## How the split is calculated

1. We find the coin's main pool (the one with the most real money on the pair's side) or its Pons launch curve.
2. We read two prices straight from Robinhood Chain at the **same start and end blocks**: the coin priced in its pair, and the pair priced in dollars.
3. The coin's dollar move is the pair's move combined with the coin's own move against its pair: `(1 + coin) = (1 + pair) × (1 + coin vs pair)`.
4. The pair's share of the move is `ln(1 + pair) ÷ ln(1 + coin)`. The rest is the coin's own.
5. Special cases get plain sentences instead of a split: a dollar-paired coin (nothing to blame), a nearly flat coin, a pair that moved the opposite way, or a pair that moved more than the coin.

DexScreener and GeckoTerminal are only used to find which pool a coin trades in. Prices never come from them.

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
| Fake-copy warning | **Live** |
| Launch report with wallet links | **Live** |
| MCP server, hosted at `https://api.blamethestock.com/mcp` (tools: `blame_split`, `check_copycats`, `launch_report`) | **Live** |
| MCP npm package (`npx blamethestock-mcp`) and directory listings | Planned |
| $BLAME receipts on the site (dev buy, sells, burns, fee claims, live from the chain) | Built, switches on at launch |

## $BLAME

- **Fixed supply**, launched on Pons.
- **Dev buy about 1.5%** of supply at launch.
- **The dev never sells.**
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

No wallet connection, no login, no cookies, no analytics. The API doesn't store visitor IP addresses; they're only used in memory for rate limiting. The blame counter stores one number per day.

## License

[MIT](LICENSE)
