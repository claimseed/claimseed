// The commercial EOB over MCP: list_document_types lists it with its reviewed words; generate_data and
// verify_document take the insurer, which the answer key records; the insurer is refused for another type and
// another value; render_blind has no insurer argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { COMMERCIAL_TEXT } from '@claimseed/core';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, CLAIMSEED_WORKSPACE: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'claimseed-commercial-test', version: '0.0.0' });
  await client.connect(transport); await client.listTools();
  return client;
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const said = (r) => r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');

test('the commercial EOB over MCP: listed, the insurer taken and recorded, refused where it does not apply', async () => {
  const c = await connect();
  try {
    const { tools } = await c.listTools(); const props = (n) => tools.find((t) => t.name === n).inputSchema.properties;
    for (const n of ['generate_data', 'render_document', 'degrade_document', 'verify_document']) { assert.deepEqual(props(n).insurer.enum, ['a', 'b'], n); assert.equal(props(n).insurer.description, COMMERCIAL_TEXT.insurerOption, n); }
    assert.equal(props('render_blind').insurer, undefined, 'render_blind takes no insurer');
    const list = await call(c, 'list_document_types');
    const t = list.structuredContent.types.find((x) => x.type === 'commercial-eob');
    assert.equal(t.title, COMMERCIAL_TEXT.typeTitle); assert.equal(t.description, COMMERCIAL_TEXT.typeDescription);
    const g = await call(c, 'generate_data', { type: 'commercial-eob', scenario: 'baseline-clean', seed: 'm1', insurer: 'b' });
    assert.ok(!g.isError, said(g)); assert.equal(g.structuredContent.groundTruth.plan.insurer, 'b');
    const v = await call(c, 'verify_document', { type: 'commercial-eob', scenario: 'baseline-clean', seed: 'm1', insurer: 'b', output: { fields: { insurer: g.structuredContent.data.insurer.name } } });
    assert.ok(!v.isError, said(v)); assert.equal(v.structuredContent.fields.correct, 1);
    const wrongType = await call(c, 'generate_data', { type: 'msn', scenario: 'baseline-clean', seed: 'm1', insurer: 'a' });
    assert.equal(wrongType.isError, true); assert.match(said(wrongType), new RegExp(COMMERCIAL_TEXT.messages.insurerType.replace('{who}', 'generate_data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const wrongValue = await call(c, 'generate_data', { type: 'commercial-eob', scenario: 'baseline-clean', seed: 'm1', insurer: 'c' });
    assert.equal(wrongValue.isError, true);
  } finally { await c.close(); }
});
