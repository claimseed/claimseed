// Layout variants through the MCP server (0.5.0): layout_variant on the four tools that make or score a document, the
// refusals (closed list, nothing echoed, nothing written), and strict arguments: an argument a tool does not declare
// is refused on every tool instead of being dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateData, findChrome, verifyFromSeed, VARIANT_STRINGS, variantIds } from '@claimseed/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const M = VARIANT_STRINGS.messages;
const SEC = 'zz-secret-5521';

let c; let workspace;
before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-mcp-var-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, CLAIMSEED_WORKSPACE: workspace, CLAIMSEED_MCP_TIMEOUT_MS: '120000' }, stderr: 'pipe' });
  c = new Client({ name: 'claimseed-test', version: '0.0.0' }); await c.connect(transport); await c.listTools();
});
after(async () => { await c.close(); fs.rmSync(workspace, { recursive: true, force: true }); });
const call = (name, args) => c.callTool({ name, arguments: args });
const refused = (r, where) => { assert.equal(r.isError, true, `${where}: accepted`); const t = JSON.stringify(r.content); assert.ok(!t.includes(SEC), `${where}: echoed`); return r.content[0].text; };

test('layout_variant is declared on exactly the four tools that make or score a document, with the published text', async () => {
  const { tools } = await c.listTools();
  for (const t of tools) {
    const has = 'layout_variant' in (t.inputSchema.properties || {});
    assert.equal(has, ['generate_data', 'render_document', 'degrade_document', 'verify_document'].includes(t.name), t.name);
    if (!has) continue;
    const p = t.inputSchema.properties.layout_variant;
    assert.equal(p.type, 'string'); assert.equal(p.maxLength, 64); assert.equal(p.description, VARIANT_STRINGS.developer.mcpLayoutVariant);
    assert.ok(!(t.inputSchema.required || []).includes('layout_variant'), `${t.name}: optional`);
  }
});

test('generate_data and verify_document take a variant and give the library\'s answer', async () => {
  for (const lv of ['h05', 'seeded']) {
    const r = await call('generate_data', { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'mv-1', layout_variant: lv });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.deepEqual(r.structuredContent, JSON.parse(JSON.stringify(generateData({ type: 'hmo-eob', scenario: 'baseline-clean', seed: 'mv-1', layoutVariant: lv }))));
    assert.equal(r.structuredContent.groundTruth.schemaVersion, '1.4');
  }
  const plain = await call('generate_data', { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'mv-1' });
  assert.equal(plain.structuredContent.groundTruth.schemaVersion, '1.3'); assert.equal('layoutVariant' in plain.structuredContent.groundTruth.documents[0], false);
  const key = generateData({ type: 'ppo-eob', scenario: 'baseline-clean', seed: 'mv-2', layoutVariant: 'p07' }).groundTruth;
  const output = { fields: key.documents[0].fields, errors: [] };
  const v = await call('verify_document', { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'mv-2', layout_variant: 'p07', output });
  assert.ok(!v.isError, v.content?.[0]?.text);
  assert.deepEqual(v.structuredContent, JSON.parse(JSON.stringify(verifyFromSeed({ type: 'ppo-eob', scenario: 'baseline-clean', seed: 'mv-2', layoutVariant: 'p07', output }))));
  assert.equal(v.structuredContent.answerKey.schemaVersion, '1.4');
});

test('every refusal of a variant: the published message on every tool, nothing echoed, nothing written', async () => {
  const output = { fields: {}, errors: [] };
  const extra = { verify_document: { output }, degrade_document: { preset: 'scan' } };
  const cases = [
    ['ppo-eob', SEC, M.variantUnknown], ['ppo-eob', 'h01', M.variantUnknown], ['hmo-eob', variantIds('itemized-bill')[0], M.variantUnknown],
    ['ppo-eob', `../${SEC}`, M.variantUnknown], ['ppo-eob', 'p01/..', M.variantUnknown], ['ppo-eob', 'p0\u0000', M.variantUnknown],
    ['ppo-eob', 'all', M.variantAllHere], ['ppo-eob', '', M.variantEmpty], ['msn', 'p01', M.variantMsn], ['msn', 'seeded', M.variantMsn],
    ['ppo-eob', `${SEC}${'x'.repeat(60)}`, null],
  ];
  for (const tool of ['generate_data', 'render_document', 'degrade_document', 'verify_document']) {
    for (const [type, lv, msg] of cases) {
      const t = refused(await call(tool, { type, scenario: 'baseline-clean', seed: 'mv-3', layout_variant: lv, ...(extra[tool] || {}) }), `${tool} ${type} ${lv.length}`);
      if (msg) assert.ok(t.endsWith(msg), `${tool}: ${t}`);
    }
    for (const lv of [42, true, { id: 'p01' }, ['p01']]) refused(await call(tool, { type: 'ppo-eob', scenario: 'baseline-clean', layout_variant: lv, ...(extra[tool] || {}) }), `${tool} ${typeof lv}`);
  }
  assert.deepEqual(fs.readdirSync(workspace).filter((f) => !f.startsWith('.')), [], 'a refused call wrote something');
});

test('strict arguments: every tool refuses an argument it does not declare, naming none, before doing anything', async () => {
  const valid = {
    list_document_types: {}, describe_document_type: { type: 'msn' }, generate_data: { type: 'msn', scenario: 'baseline-clean' },
    render_document: { type: 'msn', scenario: 'baseline-clean' }, degrade_document: { type: 'msn', scenario: 'baseline-clean', preset: 'scan' },
    verify_document: { type: 'msn', scenario: 'baseline-clean', output: { fields: {} } },
  };
  const { tools } = await c.listTools();
  assert.deepEqual(Object.keys(valid).sort(), tools.map((t) => t.name).sort());
  for (const [tool, args] of Object.entries(valid)) {
    for (const key of ['layoutVariant', 'layout-variant', SEC, `${SEC}${'k'.repeat(10000)}`, '__proto__x', 'constructor']) {
      const t = refused(await call(tool, { ...args, [key]: 'p01' }), `${tool} ${key.slice(0, 20)}`);
      assert.ok(t.endsWith(M.unknownArgument), `${tool}: ${t.slice(0, 200)}`);
      assert.ok(!t.includes(key.slice(0, 12)), `${tool}: the key is named`);
    }
  }
  assert.deepEqual(fs.readdirSync(workspace).filter((f) => !f.startsWith('.')), [], 'a refused call wrote something');
});

test('render_document and degrade_document with a variant: the id in the file names, the summary and the key', { skip, timeout: 240000 }, async () => {
  const r = await call('render_document', { type: 'itemized-bill', scenario: 'baseline-clean', seed: 'mv-4', layout_variant: 'b07' });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const out = r.structuredContent;
  for (const p of [out.pdf, out.groundTruthFile]) assert.match(path.basename(p), /^itemized-bill_baseline-clean_mv-4\.b07_[0-9a-f]{12}\.(pdf|ground-truth\.json)$/);
  assert.equal(out.groundTruth.documents[0].layout, 'itemized-bill.b07'); assert.equal(out.groundTruth.documents[0].layoutVariant.id, 'b07');
  assert.match(r.content[0].text, /^Rendered itemized-bill\.b07 \/ baseline-clean \/ seed mv-4: /);
  const lib = generateData({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'mv-4', layoutVariant: 'b07' }).groundTruth;
  const strip = (g) => { const x = JSON.parse(JSON.stringify(g)); delete x.documents[0].sha256; delete x.documents[0].pages; delete x.documents[0].fields['metadata.pageCount']; return x; };
  assert.deepEqual(strip(out.groundTruth), strip(lib), 'the key is the library\'s');
  const d = await call('degrade_document', { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'mv-4', preset: 'low-res', layout_variant: 'h09' });
  assert.ok(!d.isError, d.content?.[0]?.text);
  assert.match(path.basename(d.structuredContent.pdf), /^hmo-eob_baseline-clean_mv-4\.h09_low-res_[0-9a-f]{12}\.pdf$/);
  assert.equal(d.structuredContent.groundTruth.documents[0].layout, 'hmo-eob.h09'); assert.equal(d.structuredContent.degradation, 'low-res'); assert.equal(d.structuredContent.groundTruth.documents[0].degradation, 'low-res');
  assert.equal(d.structuredContent.groundTruth.documents[0].layoutVariant.id, 'h09');
  assert.match(d.content[0].text, /^Rendered a low-res copy of hmo-eob\.h09 \/ baseline-clean \/ seed mv-4: /);
});

test('agent text: the instructions, describe_document_type and build_test_case name layout_variant, every id and every kind the code has', async () => {
  const { tools } = await c.listTools();
  assert.match(c.getInstructions(), /layout_variant/); assert.match(c.getInstructions(), /msn has one layout/);
  assert.match(tools.find((t) => t.name === 'describe_document_type').description, /layout variant ids/);
  const kinds = { errors: new Set(), decoys: new Set() };
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) {
    const r = await call('describe_document_type', { type });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.deepEqual(r.structuredContent.layoutVariants, variantIds(type), `${type}: the published ids`);
    for (const s of r.structuredContent.scenarios) { for (const e of s.injectedErrors) kinds.errors.add(e.kind); for (const d of s.decoys) kinds.decoys.add(d.kind); }
  }
  assert.equal(variantIds('msn').length, 0); assert.equal(variantIds('ppo-eob').length, 12);
  // the kinds the published scenarios produce, as the mutation catalog derives them from the operations
  const cat = JSON.parse((await c.readResource({ uri: 'catalog://mutations' })).contents[0].text);
  assert.deepEqual([...kinds.errors].sort(), [...new Set(cat.ops.flatMap((o) => o.errorKinds))].sort(), 'error kinds');
  assert.deepEqual([...kinds.decoys].sort(), [...new Set(cat.decoyOps.flatMap((o) => o.decoyKinds))].sort(), 'decoy kinds');
  const taxonomy = (await c.readResource({ uri: 'docs://error-taxonomy' })).contents[0].text;
  for (const k of [...kinds.errors, ...kinds.decoys]) assert.ok(taxonomy.includes(`\`${k}\``), `${k} in the error taxonomy`);
  const p = await c.getPrompt({ name: 'build_test_case', arguments: { goal: 'read every line' } });
  assert.match(p.messages[0].content.text, /layout_variant set \(an id or seeded\)/);
});
