// The three tools this server offers: names, titles, descriptions and inputs.
// Kept word for word the same as the hosted server (api/src/mcp.js in the Blame the Stock repo); a test checks it.
// Plain data, no imports, so it loads anywhere.

export const SERVER_NAME = 'blamethestock';
export const SERVER_TITLE = 'Blame the Stock';
export const SITE = 'https://blamethestock.com';
export const DEFAULT_API_BASE = 'https://api.blamethestock.com';
export const NOT_ADVICE = 'Read-only on-chain facts from Robinhood Chain; not financial advice.';
export const WINDOWS = ['1h', '6h', '24h', '7d'];

export const INSTRUCTIONS = 'Blame the Stock: read-only research on Robinhood Chain coins (chain id 4663). '
  + 'blame_split splits a coin\'s price move into the part from what it is paired with and the coin\'s own part. '
  + 'check_copycats finds Pons coins using the same or a look-alike name and flags patterns. '
  + 'launch_report shows what a Pons coin\'s dev and first buyers did. Facts, flags and proof links only: '
  + 'never a buy/sell call, never "scam" or "safe". Nothing here can trade, sign or touch a wallet.';

export const TOOLS = {
  blame_split: {
    title: 'Blame split',
    description: 'Read-only. For a Robinhood Chain coin address, splits its price move over a time window into the '
      + 'part from what it is paired with (a stock token, ETH or another coin) and the coin\'s own part. '
      + 'Prices are read on-chain at stated blocks. Returns a short summary plus JSON with proof links. Not financial advice.',
  },
  check_copycats: {
    title: 'Check copycats',
    description: 'Read-only. Given a ticker (e.g. OBSYN) or a coin address, lists Pons launches on Robinhood Chain '
      + 'with the same or a look-alike name, with launch time, dev buy and sells, fees, bridges, holders and '
      + 'liquidity, and flags such as "launched just before" or "dev dumped fast". Shows facts, never picks the '
      + '"real" coin. Summary plus JSON with proof links. Not financial advice.',
  },
  launch_report: {
    title: 'Launch report',
    description: 'Read-only. For a Pons coin address on Robinhood Chain: the launch, the dev\'s buy and every later '
      + 'move (sends, burns, sells, fees claimed, ETH bridged out), the first buyers ("snipers") and whether they '
      + 'sold, graduation and hourly activity, plus wallet links (shared funders) in a separate field with '
      + 'links_status. Heavy reports may answer status "building": call again in about 20 seconds. Summary plus '
      + 'JSON with proof links. Not financial advice.',
  },
};

// Inputs, as plain descriptions (src/index.js turns them into zod schemas).
export const ADDRESS_HELP = 'Token contract address on Robinhood Chain: 0x followed by 40 hex characters.';
export const INPUTS = {
  blame_split: {
    token: { type: 'string', description: ADDRESS_HELP },
    window: { type: 'enum', values: WINDOWS, default: '24h', description: 'Time window: 1h, 6h, 24h (default) or 7d.' },
  },
  check_copycats: {
    query: { type: 'string', maxLength: 100, description: 'A ticker such as OBSYN or $OBSYN, or a token address (0x + 40 hex).' },
  },
  launch_report: {
    token: { type: 'string', description: 'The Pons coin\'s token address on Robinhood Chain (0x + 40 hex).' },
  },
};

export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
