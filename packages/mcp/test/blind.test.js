// Blind documents over MCP (render_blind, get_answer_key), end to end through the client as an agent would use them.
// The result, its page images, the embedded PDF and 835 and the files in the workspace name the id and nothing of the
// scenario, its errors and decoys, or the seed; the answer key comes only by id, from a separate call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { findChrome, BAND_TEXT, BLIND_ID, BLIND_STRINGS } from '@claimseed/core';
import { readMarkers } from '../../core/test/markers-read.js';
import { leaksIn, tokensOf, filesUnder } from '../../core/test/leak-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const T = BLIND_STRINGS.mcp;
const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../resources/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const SEED = 'leakprobe-7x';   // distinctive, so a leaked seed cannot hide among ordinary words
const RESULT_KEYS = ['bill', 'bytes', 'degradation', 'id', 'pages', 'pdf', 'pdfEmbedded', 'preview', 'remittance', 'sha256'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function connect(env = {}) {
  const workspace = env.CLAIMSEED_WORKSPACE ?? tmp('claimseed-mcp-blind-ws-');
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, CLAIMSEED_WORKSPACE: workspace, CLAIMSEED_MCP_TIMEOUT_MS: '120000', ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'claimseed-blind-test', version: '0.0.0' });
  await client.connect(transport);
  await client.listTools();   // the client then checks every structured result against its tool's output schema
  return { client, workspace, close: () => client.close() };
}
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
const said = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// Everything a result hands a tool, as files (images, the embedded PDF) and texts (the rest of the result as JSON).
function channelsOf(r, dir) {
  const files = []; let n = 0;
  for (const c of r.content) {
    if (c.type === 'image') { const f = path.join(dir, `img-${n++}.${c.mimeType === 'image/png' ? 'png' : 'jpg'}`); fs.writeFileSync(f, Buffer.from(c.data, 'base64')); files.push(f); }
    if (c.type === 'resource' && c.resource.blob) { const f = path.join(dir, `res-${n++}.pdf`); fs.writeFileSync(f, Buffer.from(c.resource.blob, 'base64')); files.push(f); }
  }
  const rest = { ...r, content: r.content.map((c) => (c.type === 'image' ? { ...c, data: null } : c.type === 'resource' && c.resource.blob ? { ...c, resource: { ...c.resource, blob: null } } : c)) };
  return { files, texts: [{ where: 'result', text: JSON.stringify(rest) }] };
}
async function keyOf(c, id) {
  const k = await call(c, 'get_answer_key', { id });
  assert.ok(!k.isError, said(k)); assert.equal(k.structuredContent.id, id);
  const key = k.structuredContent.groundTruth;
  assert.ok(validate(key), JSON.stringify(validate.errors)); assert.equal(key.schemaVersion, '1.5'); assert.equal(key.blind.id, id);
  return key;
}

test('the blind tools are listed with their own descriptions, no app view, and strict inputs', async () => {
  for (const env of [{}, { CLAIMSEED_WORKSPACE: '' }]) {
    const s = await connect(env);
    try {
      const { tools } = await s.client.listTools();
      const rb = tools.find((t) => t.name === 'render_blind'); const gk = tools.find((t) => t.name === 'get_answer_key');
      assert.equal(rb.description, env.CLAIMSEED_WORKSPACE === '' ? T.tool.descriptionInline : T.tool.descriptionWorkspace);
      assert.equal(rb.title, T.tool.title); assert.equal(gk.title, T.keyTool.title); assert.equal(gk.description, T.keyTool.description);
      assert.equal(rb._meta, undefined, 'no app view, whose name would be shown');
      assert.deepEqual(Object.keys(rb.inputSchema.properties).sort(), ['also', 'bill', 'from_page', 'include_pdf', 'layout_variant', 'preset', 'preview', 'scenario', 'seed', 'type']);
      assert.deepEqual(rb.inputSchema.properties.preset.enum, ['scan', 'fax', 'photo', 'low-res']);
      assert.deepEqual(Object.keys(gk.inputSchema.properties), ['id']); assert.equal(gk.inputSchema.properties.id.pattern, BLIND_ID.source);
      assert.deepEqual(Object.keys(rb.outputSchema.properties).sort(), RESULT_KEYS);
      assert.equal(gk.annotations.readOnlyHint, true); assert.equal(rb.annotations.readOnlyHint, env.CLAIMSEED_WORKSPACE === ''); assert.equal(rb.annotations.openWorldHint, false);
      // an undeclared argument is refused, never ignored; a malformed or unknown id is refused without being repeated
      const salt = '0123456789abcdef0123456789abcdef';
      for (const [name, args] of [['render_blind', { type: 'msn', scenario: 'baseline-clean', seed: 'x', salt }], ['get_answer_key', { id: 'doc-0123456789abcdef', salt }]]) {
        const r = await call(s.client, name, args); assert.equal(r.isError, true, name); assert.ok(!said(r).includes(salt), name);
      }
      const bad = await call(s.client, 'get_answer_key', { id: 'leakprobe-not-an-id' }); assert.equal(bad.isError, true); assert.ok(!said(bad).includes('leakprobe'));
      const none = await call(s.client, 'get_answer_key', { id: 'doc-0123456789abcdef' }); assert.equal(none.isError, true); assert.match(said(none), new RegExp(T.messages.noKey));
      assert.ok(!said(none).includes('0123456789abcdef'));
    } finally { await s.close(); }
  }
});

test('inline: the result carries the id, page images, the PDF and the 835, and nothing that names what was planted', { skip, timeout: 600000 }, async () => {
  const s = await connect({ CLAIMSEED_WORKSPACE: '' }); const dir = tmp('claimseed-mcp-blind-in-');
  try {
    const args = { type: 'msn', scenario: 'duplicate-office-visit', seed: SEED, also: '835', include_pdf: true };
    const r = await call(s.client, 'render_blind', args);
    assert.ok(!r.isError, said(r));
    const out = r.structuredContent; const id = out.id;
    assert.deepEqual(Object.keys(out).sort(), RESULT_KEYS, 'exactly the documented result');
    assert.match(id, BLIND_ID); assert.equal(out.pdf, null); assert.equal(out.pdfEmbedded, true); assert.equal(out.degradation, null); assert.equal(out.remittance.embedded, true);
    const text = r.content[0].text;
    assert.ok(text.startsWith(T.rendered.replace('{id}', id).replace('{pages}', out.pages).replace('{bytes}', out.bytes)), text);
    for (const k of ['remittanceInline', 'pdfEmbedded', 'keyHint']) assert.ok(text.includes(T[k]), k);
    const res = r.content.filter((c) => c.type === 'resource');
    assert.deepEqual(res.map((c) => c.resource.uri).sort(), [`claimseed://blind/${id}.835`, `claimseed://blind/${id}.pdf`]);
    const pdf = Buffer.from(res.find((c) => c.resource.uri.endsWith('.pdf')).resource.blob, 'base64');
    assert.equal(sha(pdf), out.sha256); assert.equal(pdf.length, out.bytes);
    const remittance = res.find((c) => c.resource.uri.endsWith('.835')).resource.text;
    assert.equal(sha(Buffer.from(remittance)), out.remittance.sha256);
    const images = r.content.filter((c) => c.type === 'image');
    // every page from from_page on, as many as fit beside the PDF, and the rest named
    assert.ok(images.length >= 1); assert.deepEqual(out.preview.pages, images.map((_, i) => i + 1));
    if (images.length < out.pages) { assert.equal(out.preview.next, images.length + 1); assert.ok(text.includes(T.more.replace('{next}', images.length + 1))); }
    for (const i of images) { const m = readMarkers(i.mimeType, i.data); assert.equal(m.description, BAND_TEXT); if (i.mimeType === 'image/png') assert.equal(m.label, id); }

    // the key, by id only: it describes this document, and none of what it gives away is anywhere in the result
    const key = await keyOf(s.client, id);
    assert.equal(key.blind.seed, SEED); assert.equal(key.documents[0].sha256, out.sha256);
    assert.ok(key.errors.length > 0);
    const tokens = tokensOf(key);
    assert.ok(tokens.includes('duplicate-office-visit') && tokens.includes(SEED) && tokens.includes('duplicate-charge'), tokens.join());
    const ch = channelsOf(r, dir); ch.texts.push({ where: '835', text: remittance });
    assert.deepEqual(leaksIn(ch, tokens), []);

    // the same arguments in the same session give the same document (without the PDF, the result says nothing was
    // saved); the key belongs to the session that rendered it
    const again = await call(s.client, 'render_blind', { ...args, include_pdf: false, preview: 'none' });
    assert.equal(again.structuredContent.id, id); assert.equal(again.structuredContent.sha256, out.sha256);
    assert.ok(said(again).includes(T.nothingSaved)); assert.equal(again.content.filter((c) => c.type === 'image').length, 0);
    // another session: another salt, so another id, and no key for this one; there, with a limit the PDF is over,
    // include_pdf leaves the PDF out with the size note (sizes only) and says no file was saved
    const s2 = await connect({ CLAIMSEED_WORKSPACE: '', CLAIMSEED_MCP_PREVIEW_KB: '100' });
    try {
      const lost = await call(s2.client, 'get_answer_key', { id }); assert.equal(lost.isError, true, 'keys belong to the session that rendered them');
      const big = await call(s2.client, 'render_blind', { ...args, also: undefined, preview: 'none' });
      assert.ok(!big.isError, said(big)); assert.notEqual(big.structuredContent.id, id); assert.equal(big.structuredContent.pdfEmbedded, false);
      assert.ok(out.bytes > 100 * 1024 * 3 / 4, 'the test document is over the 100 KB limit as base64');
      assert.match(said(big), /^The PDF \(\d+ KB as base64\) is larger than this server's limit for one result \(100 KB, CLAIMSEED_MCP_PREVIEW_KB\) and was left out; raise the limit or run the server with a workspace\.$/m);
      assert.ok(said(big).includes('No file was saved.') && !said(big).includes(T.nothingSaved));
      assert.ok(!big.content.some((c) => c.type === 'resource'));
      const k2 = await keyOf(s2.client, big.structuredContent.id);
      assert.deepEqual(leaksIn({ texts: [{ where: 'result', text: JSON.stringify(big) }] }, tokensOf(k2)), []);
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('workspace: files are named by the id, no answer key is written, and a degraded copy has its own id', { skip, timeout: 600000 }, async () => {
  const s = await connect();
  try {
    const ws = fs.realpathSync(s.workspace);
    const clean = await call(s.client, 'render_blind', { type: 'hmo-eob', scenario: 'decoys-oop-cap-partial', seed: SEED, also: '835' });
    assert.ok(!clean.isError, said(clean));
    const copy = await call(s.client, 'render_blind', { type: 'itemized-bill', scenario: 'duplicate-charge', seed: SEED, preset: 'scan' });
    assert.ok(!copy.isError, said(copy));
    const a = clean.structuredContent; const b = copy.structuredContent;
    for (const out of [a, b]) {
      assert.deepEqual(Object.keys(out).sort(), RESULT_KEYS);
      assert.equal(path.dirname(out.pdf), ws); assert.match(path.basename(out.pdf), new RegExp(`^${out.id}_[0-9a-f]{12}\\.pdf$`));
      assert.equal(sha(fs.readFileSync(out.pdf)), out.sha256); assert.equal(out.pdfEmbedded, false);
    }
    assert.match(path.basename(a.remittance.file), new RegExp(`^${a.id}_[0-9a-f]{12}\\.835$`)); assert.equal(a.remittance.embedded, false);
    assert.equal(b.degradation, 'scan'); assert.equal(b.remittance, null);
    // the workspace holds the documents, their 835 and the server's ledger, and no answer key
    const names = fs.readdirSync(ws).sort();
    assert.deepEqual(names.filter((n) => n !== '.claimseed-mcp.json').map((n) => n.replace(/_[0-9a-f]{12}\./, '.')).sort(), [`${a.id}.835`, `${a.id}.pdf`, `${b.id}.pdf`].sort());
    // the first page only by default, and the rest named
    for (const [r, out] of [[clean, a], [copy, b]]) {
      assert.equal(r.content.filter((c) => c.type === 'image').length, 1);
      if (out.pages > 1) { assert.equal(out.preview.next, 2); assert.ok(said(r).includes(T.more.replace('{next}', 2))); }
      assert.ok(r.content.some((c) => c.type === 'resource_link' && c.name === path.basename(out.pdf)));
      assert.ok(!r.content.some((c) => c.type === 'resource'), 'nothing embedded with a workspace unless asked');
    }
    const ka = await keyOf(s.client, a.id); const kb = await keyOf(s.client, b.id);
    assert.ok(ka.decoys?.length > 0, 'a scenario with decoys, so their kinds and rules are among the tokens');
    assert.equal(ka.documents[1].sha256, a.remittance.sha256);
    assert.equal(kb.documents[0].degradation, 'scan'); assert.match(kb.blind.copyOf, BLIND_ID); assert.notEqual(kb.blind.copyOf, b.id);
    assert.equal(kb.documents[0].sha256, b.sha256);
    // nothing of either key in the workspace (names, bytes, text, metadata) or in either result
    const tokens = [...new Set([...tokensOf(ka), ...tokensOf(kb)])];
    const files = filesUnder(ws);
    const found = [...leaksIn({ files }, tokens), ...leaksIn(channelsOf(clean, tmp('claimseed-mcp-blind-a-')), tokens), ...leaksIn(channelsOf(copy, tmp('claimseed-mcp-blind-b-')), tokens)];
    assert.deepEqual(found, []);
    // the copy's id is not the clean document's: its key names that one, and nothing visible links them
    assert.ok(!JSON.stringify(copy.structuredContent).includes(kb.blind.copyOf));
  } finally { await s.close(); }
});
