# Blame the Stock MCP server

Read-only research tools for coins on **Robinhood Chain** (chain id 4663), for AI agents and assistants.
The same facts as [blamethestock.com](https://blamethestock.com), with a proof link for every number.

> **Read-only. Not financial advice.** These tools only read public chain data. They can't trade, sign,
> approve or touch a wallet, and they never say "buy", "sell", "scam" or "safe". They show what was observed,
> with flags and proof links, and say plainly what can't be linked.

## Tools

| Tool | Input | What you get |
|---|---|---|
| `blame_split` | `token` (0x address), `window` (`1h`, `6h`, `24h` default, `7d`) | How much of a coin's price move came from what it is paired with (a stock token, ETH or another coin) and how much was the coin's own. Prices are read on-chain at stated blocks. |
| `check_copycats` | `query` (a ticker like `OBSYN`, or a 0x address) | Pons launches with the same or a look-alike name (hidden characters and look-alike letters included), each with launch time, dev buy and sells, fees, bridges, holders, liquidity and flags such as "launched just before" or "dev dumped fast". It never picks the "real" coin. |
| `launch_report` | `token` (0x address of a Pons coin) | The launch, the dev's buy and every later move (sends, burns, sells, fees claimed, ETH bridged out), the first buyers ("snipers") and whether they sold, graduation and hourly activity. Wallet links (shared funders) come in a separate `links` field with `links_status`: `ok`, `building` or `unavailable`. |

Every answer is a short plain-text summary, then the same facts as JSON (also in `structuredContent`), with
Blockscout proof links (`https://robinhoodchain.blockscout.com/tx/…`, `/address/…`, `/token/…`).

**Hosted vs local.** The hosted server can't read Robinhood Chain at the moment (the chain's public RPC refuses
Cloudflare's network): there, `check_copycats` lists the same-name launches from our launch index and
`launch_report` gives the coin's launch basics, each with a note, and `blame_split` points to the website card.
The local package below reads the chain from your own machine and gives the full facts, flags, launch report
and wallet links.

Wallets funded through exchanges, bridges or privacy tools can't be linked, so "no link found" is not proof that
there is none.

## Use it

### Hosted (no install)

The server runs at `https://blamethestock.com/mcp` (Streamable HTTP, no login; also at `https://api.blamethestock.com/mcp`).

**Claude Code**

```sh
claude mcp add --transport http blamethestock https://blamethestock.com/mcp
```

**Claude Desktop** and other clients that take a remote URL: add a custom connector with the URL
`https://blamethestock.com/mcp`.

### Local (stdio, via npx): not published to npm yet

The commands below work once the package is published; until then, run it from this folder with `node src/index.js`.

This package runs a small local server that reads Robinhood Chain from your machine (its public RPC and explorer)
and asks the hosted API only for its launch index. A launch report can take up to a minute. It needs Node.js 20 or
newer. (`--remote` forwards every call to the hosted server instead.)

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "blamethestock": {
      "command": "npx",
      "args": ["-y", "blamethestock-mcp"]
    }
  }
}
```

**Claude Code**

```sh
claude mcp add blamethestock -- npx -y blamethestock-mcp
```

**Any other MCP client:** run `npx -y blamethestock-mcp` as a stdio server.

### Settings

| Variable | Default | What it does |
|---|---|---|
| `BTS_API_BASE` | `https://api.blamethestock.com` | Where the launch index is read (`<base>/v1/...`; with `--remote`, `<base>/mcp`). Only change it to test a local copy of the API, e.g. `http://localhost:8787`. |

### Docker

```sh
docker build -t blamethestock-mcp .
docker run -i --rm blamethestock-mcp
```

## Privacy

Nothing about you is stored. The local server sends only the tool's input (a ticker or a coin address) to the API,
and reads public chain data from Robinhood Chain's RPC nodes and explorer. The API keeps no
IP addresses or user agents; results are cached by coin or query only.

## License

MIT. See [LICENSE](LICENSE).
