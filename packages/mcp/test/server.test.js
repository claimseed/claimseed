// The server end to end, through the MCP client over stdio, as an agent would use it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { generateData, findChrome } from '@claimseed/core';
import { PDFDocument } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const ROOT = path.resolve(here, '../../..');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function connect(env = {}) {
  const workspace = env.CLAIMSEED_WORKSPACE ?? tmp('claimseed-mcp-ws-');
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, CLAIMSEED_WORKSPACE: workspace, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'claimseed-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, workspace, close: () => client.close() };
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

let s;
before(async () => { s = await connect(); });
after(async () => { await s.close(); });

test('the server offers exactly the four documented tools, each with an input schema and honest hints', async () => {
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['describe_document_type', 'generate_data', 'list_document_types', 'render_document']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.outputSchema, `${t.name}: output schema`);
    assert.equal(t.annotations.openWorldHint, false, `${t.name}: never reaches outside the machine`);
    assert.equal(t.annotations.readOnlyHint, t.name !== 'render_document', t.name);
  }
});

test('list_document_types and describe_document_type describe every type and scenario, with the errors each injects', async () => {
  const r = await call(s.client, 'list_document_types');
  assert.ok(!r.isError);
  assert.deepEqual(r.structuredContent.types.map((t) => t.type).sort(), ['hmo-eob', 'itemized-bill', 'msn', 'ppo-eob']);
  for (const t of r.structuredContent.types) assert.ok(t.title && t.description && t.scenarios.includes('baseline-clean'), t.type);
  const d = (await call(s.client, 'describe_document_type', { type: 'msn' })).structuredContent;
  const by = Object.fromEntries(d.scenarios.map((x) => [x.scenario, x]));
  assert.deepEqual(by['baseline-clean'].injectedErrors, []);
  assert.deepEqual(by['duplicate-office-visit'].injectedErrors.map((e) => e.kind), ['duplicate-charge']);
  assert.deepEqual(by['combined-three-errors'].injectedErrors.map((e) => e.kind).sort(), ['cost-sharing-error', 'duplicate-charge', 'math-error']);
  for (const x of d.scenarios) assert.ok(x.sources.length > 0, `${x.scenario}: sources`);
});

test('generate_data returns exactly what the library returns for the same type, scenario and seed', async () => {
  const r = await call(s.client, 'generate_data', { type: 'itemized-bill', scenario: 'duplicate-charge', seed: 'mcp-gen-1' });
  assert.ok(!r.isError);
  assert.deepEqual(r.structuredContent, JSON.parse(JSON.stringify(generateData({ type: 'itemized-bill', scenario: 'duplicate-charge', seed: 'mcp-gen-1' }))));
  const again = await call(s.client, 'generate_data', { type: 'itemized-bill', scenario: 'duplicate-charge', seed: 'mcp-gen-1' });
  assert.deepEqual(again.structuredContent, r.structuredContent);
});

test('bad arguments are refused as tool errors: unknown type, path-like scenario or seed, unknown scenario', async () => {
  const cases = [
    [{ type: 'w2', scenario: 'baseline-clean' }, /type/i],
    [{ type: 'msn', scenario: '../../etc/passwd' }, /scenario|invalid/i],
    [{ type: 'msn', scenario: 'baseline-clean', seed: 'a/b' }, /seed|invalid/i],
    [{ type: 'msn', scenario: 'baseline-clean', seed: '.hidden' }, /seed|invalid/i],
    [{ type: 'msn', scenario: 'baseline-clean', seed: 'x'.repeat(65) }, /seed|invalid/i],
    [{ type: 'msn', scenario: 'no-such-scenario' }, /no scenario "no-such-scenario" for msn/],
  ];
  for (const tool of ['generate_data', 'render_document']) for (const [args, re] of cases) {
    const r = await call(s.client, tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)} was accepted`);
    assert.match(r.content[0].text, re, `${tool} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(fs.readdirSync(s.workspace), [], 'a refused call wrote something');
});

test('resources: the schema, catalogs, taxonomy and policy are served, and the schema is the repository schema', async () => {
  const { resources } = await s.client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ['catalog://mutations', 'catalog://scenarios', 'docs://error-taxonomy', 'policy://synthetic-data', 'schema://ground-truth']);
  const read = async (uri) => (await s.client.readResource({ uri })).contents[0].text;
  assert.equal(await read('schema://ground-truth'), fs.readFileSync(path.join(ROOT, 'schemas/ground-truth.schema.json'), 'utf-8'));
  assert.equal(await read('policy://synthetic-data'), fs.readFileSync(path.join(ROOT, 'docs/synthetic-data-policy.md'), 'utf-8'));
  const scen = JSON.parse(await read('catalog://scenarios'));
  assert.deepEqual(Object.keys(scen).sort(), ['hmo-eob', 'itemized-bill', 'msn', 'ppo-eob']);
  const ops = JSON.parse(await read('catalog://mutations')).ops;
  const dup = ops.find((o) => o.op === 'duplicate-line');
  assert.ok(dup && dup.errorKinds.includes('duplicate-charge') && dup.usedBy.includes('msn/duplicate-office-visit'));
});

test('the build_test_case prompt carries the goal and points at the tools', async () => {
  const p = await s.client.getPrompt({ name: 'build_test_case', arguments: { goal: 'flag duplicate office visits', type: 'msn' } });
  const t = p.messages[0].content.text;
  assert.match(t, /flag duplicate office visits/);
  assert.match(t, /describe_document_type for msn/);
  assert.match(t, /render_document/);
});

test('render_document writes a stamped PDF and its ground truth into the workspace, under server-chosen names', { skip, timeout: 120000 }, async () => {
  const args = { type: 'msn', scenario: 'duplicate-office-visit', seed: 'mcp-render-1' };
  const r = await call(s.client, 'render_document', args);
  assert.ok(!r.isError, r.content?.[0]?.text);
  const out = r.structuredContent;
  for (const p of [out.pdf, out.groundTruthFile]) {
    assert.equal(path.dirname(p), fs.realpathSync(s.workspace), `${p} is outside the workspace`);
    assert.match(path.basename(p), /^msn_duplicate-office-visit_mcp-render-1_[0-9a-f]{12}\.(pdf|ground-truth\.json)$/);
  }
  const bytes = fs.readFileSync(out.pdf);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), out.sha256);
  assert.equal(out.groundTruth.documents[0].sha256, out.sha256);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(pdf.getPageCount(), out.pages);
  assert.match(pdf.getSubject() || '', /synthetic specimen/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(out.groundTruthFile, 'utf-8')), out.groundTruth);
  assert.deepEqual(out.groundTruth.errors.map((e) => e.kind), ['duplicate-charge']);
  const links = r.content.filter((c) => c.type === 'resource_link').map((c) => fileURLToPath(c.uri));
  assert.deepEqual(links.sort(), [out.pdf, out.groundTruthFile].sort());
  // the same request again: new files, same bytes
  const again = (await call(s.client, 'render_document', args)).structuredContent;
  assert.notEqual(again.pdf, out.pdf);
  assert.equal(again.sha256, out.sha256);
  const ledger = JSON.parse(fs.readFileSync(path.join(s.workspace, '.claimseed-mcp.json'), 'utf-8'));
  assert.equal(ledger.files.length, 4);
});

test('renders running side by side in the shared browser give the same bytes as renders made alone', { skip, timeout: 180000 }, async () => {
  const jobs = [['ppo-eob', 'baseline-clean'], ['itemized-bill', 'balance-billing'], ['msn', 'combined-three-errors']].map(([type, scenario]) => ({ type, scenario, seed: 'mcp-par-1' }));
  const parallel = await Promise.all(jobs.map((a) => call(s.client, 'render_document', a)));
  for (const [i, r] of parallel.entries()) {
    assert.ok(!r.isError, r.content?.[0]?.text);
    const alone = await call(s.client, 'render_document', jobs[i]);
    assert.equal(r.structuredContent.sha256, alone.structuredContent.sha256, `${jobs[i].type}: output depends on what else was rendering`);
  }
});

test('a render that exceeds the time limit fails cleanly, writes nothing, and the server keeps working', { skip, timeout: 60000 }, async () => {
  const t = await connect({ CLAIMSEED_MCP_TIMEOUT_MS: '100' });
  try {
    const r = await call(t.client, 'render_document', { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'slow' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /timed out after 100 ms; the browser was restarted/);
    assert.deepEqual(fs.readdirSync(t.workspace), []);
    const g = await call(t.client, 'generate_data', { type: 'msn', scenario: 'baseline-clean' });
    assert.ok(!g.isError);
  } finally { await t.close(); }
});

test('stdout carries only protocol messages, even while the renderer reports progress', { skip, timeout: 120000 }, async () => {
  const ws = tmp('claimseed-mcp-raw-');
  const child = spawn(process.execPath, [CLI], { env: { ...process.env, CLAIMSEED_WORKSPACE: ws }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.on('exit', r));
  const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
  const lines = () => out.split('\n').filter(Boolean);
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const waitFor = async (id) => {
    for (let i = 0; i < 900; i++) {
      const bad = lines().find((l) => parse(l)?.jsonrpc !== '2.0');
      assert.equal(bad, undefined, `non-protocol line on stdout: ${String(bad).slice(0, 80)}`);
      if (lines().some((l) => parse(l).id === id)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no reply ${id}; stderr: ${err}`);
  };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    await waitFor(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'render_document', arguments: { type: 'msn', scenario: 'baseline-clean', seed: 'raw-1' } } });
    await waitFor(2);
    child.stdin.end();
    await exited;
    for (const l of lines()) assert.equal(parse(l)?.jsonrpc, '2.0', `non-protocol line on stdout: ${l.slice(0, 80)}`);
    assert.ok(!parse(lines().find((l) => parse(l).id === 2)).result.isError);
    assert.match(err, /Rendering page 1/, 'the renderer progress should have gone to stderr');
  } finally { child.kill('SIGTERM'); }
});

test('an oversized message closes the server instead of growing its memory', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [CLI], { env: { ...process.env, CLAIMSEED_WORKSPACE: tmp('claimseed-mcp-big-') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  child.stdin.on('error', () => {});   // the server closes before the whole buffer is written (EPIPE): that is the point
  await new Promise((r) => setTimeout(r, 500));
  child.stdin.write(Buffer.alloc(5 * 2 ** 20, 0x61));   // 5 MB without a line end: over the 4 MB read buffer
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 15000))]);
  if (code === 'still running') child.kill('SIGKILL');
  assert.equal(code, 0);
});

test('the server will not start without a workspace folder of its own', () => {
  const file = path.join(tmp('claimseed-mcp-f-'), 'not-a-folder'); fs.writeFileSync(file, 'x');
  const run = (env, args = []) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, CLAIMSEED_WORKSPACE: '', ...env }, input: '', encoding: 'utf-8', timeout: 20000 });
  for (const [env, re] of [[{}, /no workspace folder/], [{ CLAIMSEED_WORKSPACE: '/nonexistent/claimseed' }, /does not exist/], [{ CLAIMSEED_WORKSPACE: file }, /is not a folder/],
    [{ CLAIMSEED_WORKSPACE: '/' }, /refusing \/ as the workspace/], [{ CLAIMSEED_WORKSPACE: os.homedir() }, /refusing .* as the workspace/],
    [{ CLAIMSEED_WORKSPACE: tmp('claimseed-mcp-q-'), CLAIMSEED_MCP_QUOTA_MB: 'lots' }, /CLAIMSEED_MCP_QUOTA_MB must be a whole number/]]) {
    const r = run(env);
    assert.equal(r.status, 2, `${JSON.stringify(env)}: exit ${r.status} ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, '', 'nothing but protocol may reach stdout');
  }
  const bad = run({ CLAIMSEED_WORKSPACE: tmp('claimseed-mcp-a-') }, ['--output', '/tmp']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /unknown argument --output/);
});
