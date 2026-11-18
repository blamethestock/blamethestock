// Calls one tool on the hosted Blame the Stock MCP endpoint (<base>/mcp, Streamable HTTP, stateless, no login)
// and hands back its result unchanged, so the hosted server stays the one source of truth.
//
//   const result = await callRemoteTool('launch_report', { token: '0x…' }, { base, fetch, timeoutMs });
//
// The hosted endpoint is stateless: every POST is served on its own, so a single `tools/call` message is a
// complete exchange (2025-06-18 protocol, answered as JSON or as one SSE event). Errors never throw: they come
// back as a tool result with isError and a plain message.
// Nothing about the user is sent: only the tool name and its arguments.

import { DEFAULT_API_BASE } from './tools.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_TIMEOUT_MS = 60000;

export function apiBase(env) {
  const raw = String((env && env.BTS_API_BASE) || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(raw)) return DEFAULT_API_BASE;
  return raw.replace(/\/mcp$/, '');
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], structuredContent: { ok: false, message }, isError: true };
}

// One JSON-RPC message out of a response body: plain JSON, or the last `data:` event of an SSE stream that
// carries a result or an error for our id.
export function parseRpcBody(text, contentType, id) {
  const body = String(text || '');
  const pick = (msg) => (msg && typeof msg === 'object' && (msg.id === id || msg.id == null) && ('result' in msg || 'error' in msg) ? msg : null);
  if (/text\/event-stream/i.test(contentType || '')) {
    let found = null;
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let msg = null;
      try { msg = JSON.parse(data); } catch (e) { msg = null; }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) { const hit = pick(m); if (hit) found = hit; }
    }
    return found;
  }
  let msg = null;
  try { msg = JSON.parse(body); } catch (e) { return null; }
  if (Array.isArray(msg)) return msg.map(pick).find(Boolean) || null;
  return pick(msg);
}

let nextId = 1;

export async function callRemoteTool(name, args, { base = DEFAULT_API_BASE, fetch: fetchFn = null, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = 'blamethestock-mcp' } = {}) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!f) return errorResult('This Node.js has no fetch. Use Node.js 20 or newer.');
  const id = nextId++;
  const url = base.replace(/\/+$/, '') + '/mcp';
  let res, text;
  try {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'user-agent': userAgent,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }),
    };
    if (timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
    res = await f(url, init);
    text = await res.text();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return errorResult(timedOut
      ? 'Blame the Stock took too long to answer. Try again in a minute.'
      : 'Couldn\'t reach Blame the Stock (' + url + '). Check the internet connection and try again.');
  }
  if (res.status === 429) return errorResult('Blame the Stock is busy (too many requests). Try again in a minute.');
  const ct = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
  const msg = parseRpcBody(text, ct, id);
  if (!msg) {
    return errorResult(res.ok
      ? 'Blame the Stock sent an answer this tool couldn\'t read. Try again in a minute.'
      : 'Blame the Stock is unavailable right now (HTTP ' + res.status + '). Try again in a minute.');
  }
  if (msg.error) return errorResult(String(msg.error.message || 'Blame the Stock returned an error.'));
  const r = msg.result;
  if (!r || !Array.isArray(r.content)) return errorResult('Blame the Stock sent an empty answer. Try again in a minute.');
  return r;
}
