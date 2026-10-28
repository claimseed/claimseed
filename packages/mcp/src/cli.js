#!/usr/bin/env node
// claimseed-mcp — MCP server over stdio.
//   claimseed-mcp --workspace DIR        (or CLAIMSEED_WORKSPACE=DIR)
// Settings (environment):
//   CLAIMSEED_WORKSPACE          folder the server writes PDFs and ground truth to (required)
//   CLAIMSEED_MCP_QUOTA_MB       total size of the server's outputs kept in the folder (default 500)
//   CLAIMSEED_MCP_TIMEOUT_MS     longest one render may take (default 30000)
//   CLAIMSEED_MCP_CONCURRENCY    renders run at once, 1-4 (default 2)
//   CLAIMSEED_CHROME             Chrome or Chromium binary (see @claimseed/core)
// stdout carries the protocol only; every message from the server goes to stderr.
for (const k of ['log', 'info', 'debug', 'warn']) console[k] = (...a) => console.error(...a);

const args = process.argv.slice(2);
const usage = 'usage: claimseed-mcp --workspace DIR   (or set CLAIMSEED_WORKSPACE); see the package README for settings';
function fail(msg, code = 2) { process.stderr.write(`claimseed-mcp: ${msg}\n`); process.exit(code); }
function intSetting(name, dflt, min, max) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v) || +v < min || +v > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return +v;
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) { process.stderr.write(usage + '\n'); return; }
  const { createClaimseedServer, VERSION } = await import('./server.js');
  if (args.includes('--version')) { process.stderr.write(VERSION + '\n'); return; }
  let workspace = process.env.CLAIMSEED_WORKSPACE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace') { workspace = args[++i]; if (!workspace) fail('--workspace needs a folder'); }
    else fail(`unknown argument ${args[i]}\n${usage}`);
  }
  if (!workspace) fail(`no workspace folder\n${usage}`);
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  let app;
  try {
    app = createClaimseedServer({
      workspace,
      quotaMB: intSetting('CLAIMSEED_MCP_QUOTA_MB', 500, 1, 100000),
      timeoutMs: intSetting('CLAIMSEED_MCP_TIMEOUT_MS', 30000, 100, 600000),
      concurrency: intSetting('CLAIMSEED_MCP_CONCURRENCY', 2, 1, 4),
    });
  } catch (e) { fail(e.message); }
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 4 * 2 ** 20 });
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  transport.onclose = shutdown;
  await app.server.connect(transport);
  process.stderr.write(`claimseed-mcp ${VERSION}: writing to ${app.workspace.root}\n`);
}
main().catch((e) => fail(e.message, 1));
