#!/usr/bin/env node
// blamethestock-mcp: a local (stdio) MCP server for Blame the Stock.
// It offers the same three read-only tools as the hosted server and forwards every call to it
// (https://api.blamethestock.com/mcp, or BTS_API_BASE for local testing). Nothing here can trade, sign or
// touch a wallet, and nothing about you is stored or sent beyond the tool's own input.
//
//   npx -y blamethestock-mcp
//   BTS_API_BASE=http://localhost:8787 npx -y blamethestock-mcp     (a local copy of the API)

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_TITLE, SITE, INSTRUCTIONS, TOOLS, INPUTS, ANNOTATIONS } from './tools.js';
import { apiBase, callRemoteTool } from './remote.js';

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

export function buildServer({ base = apiBase(process.env), fetch: fetchFn = null } = {}) {
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
    }, async (args) => callRemoteTool(name, args, { base, fetch: fetchFn, userAgent: 'blamethestock-mcp/' + pkg.version }));
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
      'Calls ' + apiBase(process.env) + '/mcp (set BTS_API_BASE to use another copy of the API).',
      'More: ' + SITE,
      '',
    ].join('\n'));
  } else {
    serveStdio(() => buildServer(), {
      onerror: (err) => { process.stderr.write('blamethestock-mcp: ' + String((err && err.message) || err) + '\n'); },
    });
  }
}
