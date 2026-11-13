# Blame the Stock

A one-page site. Paste a Robinhood Chain coin and it shows how much of the coin's price move came from what it's paired with, and how much came from the coin itself.

## What's in this folder

| Folder or file | What it is | Goes online? |
|---|---|---|
| `site/` | **The website.** This is the only folder you upload. | Yes |
| `site/settings.js` | **Every blank in one file:** headline, X handle, $BLAME details, launch switch, feature switches, update log, wording. | Yes |
| `reports/` | Plain-English reports: the data check and the going-live guide. | No |
| `dev/` | Tests, preview pages and tools, used only while building. | No |

## Changing something

1. Open `site/settings.js` in any text editor (TextEdit works).
2. Change the words between the quotes, or switch a `true` / `false`.
3. Save, then upload the `site` folder again (see `reports/2-going-live.md`).

## Launch day

In `site/settings.js`, under `token`:
- set `launched` to `true`
- paste the contract address, the Pons link, the dev wallet and the dev buy amount.

Then upload.

## Feature switches (in `site/settings.js`, under `features`)

- `offHoursMode`: shows whether a move happened while the US stock market was closed. Planned for Sunday.
- `stockBoard`: the Stock-Paired Board. Planned for Monday.

## Where the numbers come from

Every price is read straight from Robinhood Chain, at the same start and end moment for the coin and its pair. DexScreener and GeckoTerminal are only used to find which pool a coin trades in. If data is missing or old, the card says so instead of showing a number. Details are in `reports/1-data-check.md`.
