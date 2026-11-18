#!/usr/bin/env node
// blamethestock-mcp: a local (stdio) MCP server for Blame the Stock.
// It offers the same three read-only tools as the hosted server and reads Robinhood Chain from this machine
// (the chain's public RPC and explorer), asking the hosted API only for its launch index
// (https://api.blamethestock.com, or BTS_API_BASE for local testing). Full facts, flags, launch reports and
// wallet links, even when the hosted server can't read the chain. Nothing here can trade, sign or touch a
// wallet, and nothing about you is stored or sent beyond the tool's own input.
//
//   npx -y blamethestock-mcp
//   BTS_API_BASE=http://localhost:8787 npx -y blamethestock-mcp     (a local copy of the API)
//   npx -y blamethestock-mcp --remote                               (forward every call to the hosted server instead)

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_TITLE, SITE, INSTRUCTIONS, TOOLS, INPUTS, ANNOTATIONS } from './tools.js';
import { apiBase, callRemoteTool } from './remote.js';
import { localTools } from './local.js';

const pkg = createRequire(import.meta.url)('../package.json');

function field(spec) {
  let s;
  if (spec.type === 'enum') s = z.enum(spec.values);
  else {
    s = z.string();
    if (spec.maxLength) s = s.max(spec.maxLength);
  }
  if (spec.default !== undefined) s = s.default(spec.default);
  return s.describe(spec.description);
}

export function buildServer({ base = apiBase(process.env), fetch: fetchFn = null, remote = false } = {}) {
  const userAgent = 'blamethestock-mcp/' + pkg.version;
  const local = remote ? null : localTools({ base, fetch: fetchFn, userAgent });
  const server = new McpServer(
    { name: SERVER_NAME, version: pkg.version, title: SERVER_TITLE, websiteUrl: SITE },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },   // the tool list never changes
  );
  for (const [name, meta] of Object.entries(TOOLS)) {
    const shape = {};
    for (const [key, spec] of Object.entries(INPUTS[name])) shape[key] = field(spec);
    server.registerTool(name, {
      title: meta.title,
      description: meta.description,
      inputSchema: z.object(shape),
      annotations: ANNOTATIONS,
    }, async (args) => (local ? local.run(name, args) : callRemoteTool(name, args, { base, fetch: fetchFn, userAgent })));
  }
  return server;
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) { return false; }
})();

if (isMain) {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(pkg.version + '\n');
  } else if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write([
      'blamethestock-mcp ' + pkg.version + ': read-only Robinhood Chain coin research for AI agents (MCP over stdio).',
      'Tools: blame_split, check_copycats, launch_report. Not financial advice.',
      'Reads Robinhood Chain from this machine; asks ' + apiBase(process.env) + ' only for its launch index',
      '(set BTS_API_BASE to use another copy of the API; --remote forwards every call to ' + apiBase(process.env) + '/mcp instead).',
      'More: ' + SITE,
      '',
    ].join('\n'));
  } else {
    const remote = process.argv.includes('--remote');
    serveStdio(() => buildServer({ remote }), {
      onerror: (err) => { process.stderr.write('blamethestock-mcp: ' + String((err && err.message) || err) + '\n'); },
    });
  }
}
