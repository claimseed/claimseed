// The provider's statement over MCP: render_document and render_blind with also bill, inline and with a workspace,
// get_answer_key by the statement's own id, and verify_document scoring a report on the statement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findChrome, PAIR_STRINGS, BILL_VARIANTS, BLIND_ID } from '@claimseed/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const T = PAIR_STRINGS.mcp;
async function connect(workspace) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, CLAIMSEED_WORKSPACE: workspace, CLAIMSEED_MCP_TIMEOUT_MS: '120000' }, stderr: 'pipe' });
  const client = new Client({ name: 'claimseed-pair-test', version: '0.0.0' });
  await client.connect(transport); await client.listTools();   // results are then checked against the output schemas
  return client;
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
const said = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('the render and verify tools take also as one value or a list, bill and document', async () => {
  const c = await connect('');
  try {
    const { tools } = await c.listTools(); const tool = (n) => tools.find((t) => t.name === n).inputSchema.properties;
    for (const n of ['render_document', 'render_blind']) { assert.deepEqual(tool(n).bill.enum, [...BILL_VARIANTS]); assert.equal(tool(n).bill.description, T.bill); assert.ok(tool(n).also.anyOf, n); }
    assert.equal(tool('render_document').also.description, T.alsoRender); assert.equal(tool('render_blind').also.description, T.alsoBlind);
    assert.deepEqual(tool('verify_document').document.enum, ['eob', 'bill']);
    const r = await call(c, 'render_document', { type: 'msn', scenario: 'baseline-clean', seed: 'p', also: 'bill' });
    assert.equal(r.isError, true); assert.match(said(r), new RegExp(PAIR_STRINGS.messages.pairTypes.replace('{who}', 'render').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const d = await call(c, 'render_blind', { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'p', also: 'bill', preset: 'scan' });
    assert.equal(d.isError, true);
  } finally { await c.close(); }
});

test('inline: the statement is embedded and its key is in the result; verify_document scores a report on it', { skip, timeout: 600000 }, async () => {
  const c = await connect('');
  try {
    const r = await call(c, 'render_document', { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'pair-m1', also: ['835', 'bill'], bill: 'over-owed', preview: 'none' });
    assert.ok(!r.isError, said(r));
    const b = r.structuredContent.bill; assert.equal(b.embedded, true); assert.equal(b.pdf, null);
    assert.equal(b.groundTruth.pair.variant, 'over-owed'); assert.equal(r.structuredContent.groundTruth.pair.role, 'eob');
    assert.ok(r.content.some((x) => x.type === 'resource' && x.resource.uri.endsWith('.bill.pdf') && x.resource.blob));
    assert.ok(said(r).includes(T.statementEmbedded));
    const e = b.groundTruth.errors[0];
    const v = await call(c, 'verify_document', { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'pair-m1', document: 'bill', bill: 'over-owed', output: { errors: [{ kind: e.kind, fieldRef: e.fieldRef }] } });
    assert.ok(!v.isError, said(v)); assert.equal(v.structuredContent.errors.found, 1);
    const blind = await call(c, 'render_blind', { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'pair-m2', also: 'bill', preview: 'none' });
    assert.ok(!blind.isError, said(blind)); const id = blind.structuredContent.bill.id; assert.match(id, BLIND_ID);
    assert.ok(!JSON.stringify(blind).includes('baseline-clean') && !JSON.stringify(blind).includes('pair-m2'));
    const k = await call(c, 'get_answer_key', { id }); assert.ok(!k.isError); assert.equal(k.structuredContent.groundTruth.pair.role, 'bill');
    assert.equal(k.structuredContent.groundTruth.pair.with, blind.structuredContent.id);
  } finally { await c.close(); }
});

test('workspace: the statement and its ground truth are saved beside the EOB\'s files', { skip, timeout: 600000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pair-ws-')); const c = await connect(ws);
  try {
    const r = await call(c, 'render_document', { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'pair-w1', also: 'bill', preview: 'none' });
    assert.ok(!r.isError, said(r)); const b = r.structuredContent.bill;
    assert.ok(fs.existsSync(b.pdf) && fs.existsSync(b.groundTruthFile)); assert.equal(b.embedded, false);
    assert.ok(said(r).includes(T.statementSaved.replace('{pdf}', b.pdf).replace('{key}', b.groundTruthFile)));
    assert.equal(JSON.parse(fs.readFileSync(b.groundTruthFile, 'utf-8')).pair.with, path.basename(r.structuredContent.pdf, '.pdf'));
  } finally { await c.close(); }
});
