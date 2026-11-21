// blamethestock.com/mcp: forwards the hosted MCP server from the main domain to the API Worker
// (https://api.blamethestock.com/mcp). Pages answers its own domain before any Worker route, so this tiny Pages
// Function does the hop. Read-only: it passes the request through and changes nothing.
// The visitor's IP goes along only so the Worker's rate limit counts each visitor separately (memory only, never
// stored), with a shared secret (PROXY_KEY, set on the Pages project and the Worker) so it can't be faked.
const TARGET = 'https://api.blamethestock.com/mcp';
const PASS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name',
  'last-event-id', 'origin', 'access-control-request-method', 'access-control-request-headers'];

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of PASS) {
    const v = request.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && env.PROXY_KEY) {
    headers.set('x-bts-client-ip', ip);
    headers.set('x-bts-proxy-key', env.PROXY_KEY);
  }
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const res = await fetch(TARGET + url.search, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
