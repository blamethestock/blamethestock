// Blame the Stock API Worker: the entry module wrangler starts (wrangler.toml `main`).
//
// It loads the heavier modules up front (the MCP SDK, zod and AsyncLocalStorage),
// so they are evaluated once when the Worker starts and not inside the first request's 10 ms of CPU (free plan).
// Everything else lives in worker.js, which the tests import directly (they run without the MCP SDK).
//
// workerd treats every named export of the entry module as an entrypoint, so this file exports only `default`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer, localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { setMcpSdk } from './mcp.js';
import worker from './worker.js';

setMcpSdk({ McpServer, createMcpHandler, localhostAllowedHostnames, z });
worker.internals.useAsyncLocalStorage(AsyncLocalStorage);   // each request's own budget from its first call

export default worker;
