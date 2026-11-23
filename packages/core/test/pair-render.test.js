// The provider's statement rendered beside its Medicare Advantage EOB (also: 'bill', in the library and on the command
// line): both PDFs and both keys, schema 1.6, naming each other; the EOB the same with or without its statement; the
// statement printing its title (the label's "Patient Statement"), lines and summary and nothing of Part B; a blind
// statement naming only its own id; and the values a caller can give for also and bill refused with fixed messages
// before anything is written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { findChrome, launchBrowser, render, renderBatch, renderDegraded, readManifest } from '../src/index.js';
import { pairMessage } from '../src/generate/provider-statement.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pair-'));
const text = (pdf) => execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf-8' });
const money = (x) => `$${x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test('render with also bill writes the statement and its key beside the EOB, and the EOB is the same without it', { skip, timeout: 180000 }, async () => {
  const dir = tmp(); const job = { type: 'hmo-eob', scenario: 'baseline-clean', seed: 'pair-r1', browser };
  const r = await render({ ...job, outDir: dir, also: ['bill', '835'], bill: 'over-owed' });
  const base = path.join(dir, 'hmo-eob_baseline-clean_pair-r1');
  for (const f of ['.pdf', '.ground-truth.json', '.835', '.bill.pdf', '.bill.ground-truth.json']) assert.ok(fs.existsSync(base + f), f);
  const eob = JSON.parse(fs.readFileSync(base + '.ground-truth.json', 'utf-8')); const st = JSON.parse(fs.readFileSync(base + '.bill.ground-truth.json', 'utf-8'));
  for (const k of [eob, st]) { assert.ok(validate(k), JSON.stringify(validate.errors)); assert.equal(k.schemaVersion, '1.6'); }
  assert.deepEqual([eob.pair.role, eob.pair.with, st.pair.role, st.pair.with], ['eob', 'hmo-eob_baseline-clean_pair-r1.bill', 'bill', 'hmo-eob_baseline-clean_pair-r1']);
  for (const f of ['claim', 'variant', 'params']) assert.deepEqual(eob.pair[f], st.pair[f], f);
  assert.equal(st.pair.variant, 'over-owed'); assert.deepEqual(st.errors.map((e) => e.kind), ['bill-vs-eob-mismatch']);
  assert.equal(st.documents[0].sha256, sha(fs.readFileSync(base + '.bill.pdf'))); assert.equal(st.documents[0].pages, 1);
  assert.equal(st.documents[0].fields['metadata.pageCount'], st.documents[0].pages, 'the statement key\'s page count, as every key has');
  assert.equal(r.bill.groundTruth.documents[0].sha256, st.documents[0].sha256);
  // the statement prints its lines and every summary row, and nothing of Part B or Medigap and no MBI
  const t = text(base + '.bill.pdf'); const s = st.documents[0].fields;
  for (let j = 0; s[`lineItems[${j}].code`] !== undefined; j++) assert.ok(t.includes(s[`lineItems[${j}].code`]) && t.includes(money(s[`lineItems[${j}].charge`])), `line ${j}`);
  for (const f of ['totalCharges', 'balanceDue']) assert.ok(t.includes(money(s[`summary.${f}`])), f);
  for (const f of ['contractualAdjustment', 'paidByPlan']) assert.ok(t.includes(`-${money(s[`summary.${f}`])}`), f);
  assert.ok(!/Part B|Medigap|MBI/i.test(t)); assert.match(t, /provider-statement \/ baseline-clean \/ seed pair-r1/);
  // the Medicare Advantage statement's title is the label's, and none of the commercial statements' titles prints
  const { PAIR_STRINGS } = await import('../src/generate/provider-statement.js');
  assert.ok(t.includes(PAIR_STRINGS.labels.title) && PAIR_STRINGS.labels.title === 'Patient Statement', 'the MA title');
  for (const title of Object.values(PAIR_STRINGS.commercialStatement.titles)) assert.ok(!t.includes(title), title);
  assert.ok(!t.includes(PAIR_STRINGS.labels.treatingProvider), 'no treating row');
  // the EOB and its key are the same without the statement (apart from the pair link and its version)
  const plain = await render(job);
  const { pair: _p, schemaVersion: _v, ...rest } = r.groundTruth; const { schemaVersion: _w, ...plainRest } = plain.groundTruth;
  rest.documents = rest.documents.slice(0, 1); plainRest.documents = plainRest.documents.slice(0, 1); rest.errors = rest.errors.map(({ x12Ref: _x, ...e }) => e);
  assert.deepEqual(rest, plainRest);
});

test('a blind statement is named and banded by its own id only, and its key goes to the keys folder', { skip, timeout: 180000 }, async () => {
  const dir = tmp(); const keys = tmp(); const salt = '0123456789abcdef0123456789abcdef';
  const r = await render({ type: 'ppo-eob', scenario: 'denied-service', seed: 'pair-b1', browser, outDir: dir, keysDir: keys, blind: { salt }, also: 'bill', bill: 'over-owed' });
  assert.match(r.bill.id, /^doc-[0-9a-f]{16}$/); assert.notEqual(r.bill.id, r.id);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${r.id}.pdf`, `${r.bill.id}.pdf`].sort());
  assert.deepEqual(fs.readdirSync(keys).sort(), [`${r.id}.ground-truth.json`, `${r.bill.id}.ground-truth.json`].sort());
  const st = JSON.parse(fs.readFileSync(path.join(keys, `${r.bill.id}.ground-truth.json`), 'utf-8'));
  assert.ok(validate(st), JSON.stringify(validate.errors)); assert.equal(st.blind.id, r.bill.id); assert.equal(st.pair.with, r.id);
  const t = text(path.join(dir, `${r.bill.id}.pdf`));
  for (const leak of ['denied-service', 'over-owed', 'pair-b1', 'provider-statement', 'ppo-eob', 'bill-vs-eob']) assert.ok(!t.includes(leak), leak);
  assert.ok(t.includes(r.bill.id));
  // another variant of the same EOB's statement has an id of its own, so neither key replaces the other
  const other = await render({ type: 'ppo-eob', scenario: 'denied-service', seed: 'pair-b1', browser, outDir: dir, keysDir: keys, blind: { salt }, also: 'bill', bill: 'clean' });
  assert.equal(other.id, r.id); assert.notEqual(other.bill.id, r.bill.id);
  assert.equal(fs.readdirSync(keys).length, 3);
});

test('also, bill and a statement where none can be made are refused with fixed messages, before anything is written', { skip, timeout: 120000 }, async () => {
  const dir = tmp(); const base = { scenario: 'baseline-clean', seed: 'pair-x', browser };
  const msg = (key, who = 'render') => (e) => e.message === pairMessage(key, who);
  for (const also of [[], ['bill', 'bill'], ['835', 'bill', 'bill'], ['x12'], [['bill']], ['bill', 7], { 0: 'bill', length: 1 }])
    await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, also }), msg('alsoList'), JSON.stringify(also));
  await assert.rejects(render({ ...base, type: 'msn', outDir: dir, also: 'bill' }), msg('pairTypes'));
  await assert.rejects(render({ ...base, type: 'itemized-bill', outDir: dir, also: ['bill'] }), msg('pairTypes'));
  await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, bill: 'over-owed' }), msg('billNeedsAlso'));
  await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, billParams: { by: 1 } }), msg('billNeedsAlso'));
  await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, also: [, 'bill'] }), msg('alsoList'));   // eslint-disable-line no-sparse-arrays
  for (const bill of ['nope', 7, ['clean'], JSON.parse('{"toString":"clean"}')])
    await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, also: 'bill', bill }), msg('billVariant'));
  await assert.rejects(render({ ...base, type: 'ppo-eob', outDir: dir, also: 'bill', bill: 'over-owed', billParams: { by: 0.001 } }), msg('billAmount'));
  const batch = { types: ['ppo-eob'], scenarios: ['baseline-clean'], seeds: 1, outDir: dir, browser };
  await assert.rejects(renderBatch({ ...batch, types: ['msn'], also: 'bill' }), msg('pairTypes', 'batch'));
  await assert.rejects(renderBatch({ ...batch, bill: 'over-owed' }), msg('billNeedsAlso', 'batch'));
  for (const bill of ['nope', 7, ['clean']]) await assert.rejects(renderBatch({ ...batch, also: 'bill', bill }), msg('billVariant', 'batch'));
  await assert.rejects(renderBatch({ ...batch, also: ['bill', 'bill'] }), msg('alsoList', 'batch'));
  // a seed ending in .bill would name another seed's statement files, so a type with statements refuses it, with or without a statement
  for (const seed of ['pair-x.bill', 'pair-x.BILL', 'pair-x.Bill']) for (const type of ['ppo-eob', 'hmo-eob']) for (const also of [null, 'bill'])
    await assert.rejects(render({ ...base, type, seed, outDir: dir, also }), (e) => e.message === pairMessage('seedSuffix', 'render'), `${type} ${seed} ${also}`);
  // a degraded copy refuses them before it makes its folders, a blind one with the seed it would render from
  const out = path.join(dir, 'deg'); const keys = path.join(dir, 'deg-keys');
  for (const [opts, key] of [[{ bill: 'nope' }, 'billVariant'], [{ bill: 'over-owed', billParams: { by: '5' } }, 'billAmount'], [{ bill: 'over-owed', billParams: { by: 1e9 } }, 'billAmount']])
    for (const blind of [false, true]) await assert.rejects(renderDegraded({ ...base, type: 'ppo-eob', preset: 'scan', also: 'bill', outDir: out, ...(blind ? { blind, keysDir: keys } : {}), ...opts }), msg(key, 'degrade'), `${JSON.stringify(opts)} blind ${blind}`);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a blind batch writes each statement as a job of its own, with its manifest line, and pairs.jsonl holds the ids only', { skip, timeout: 180000 }, async () => {
  const dir = tmp(); const keys = tmp(); const salt = 'fedcba9876543210fedcba9876543210';
  await renderBatch({ types: ['ppo-eob'], scenarios: ['duplicate-visit'], seeds: 1, outDir: dir, keysDir: keys, blind: { salt }, also: 'bill', bill: 'over-owed', browser });
  const lines = readManifest(path.join(keys, 'manifest.jsonl'));
  assert.deepEqual(lines.map((l) => l.type).sort(), ['ppo-eob', 'provider-statement']);
  const eob = lines.find((l) => l.type === 'ppo-eob'); const st = lines.find((l) => l.type === 'provider-statement');
  assert.equal(st.pairOf, eob.id); assert.equal(st.scenario, 'duplicate-visit');
  const pairs = fs.readFileSync(path.join(dir, 'pairs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(pairs, [{ eob: eob.id, bill: st.id }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [eob.pdf, st.pdf, 'pairs.jsonl'].sort());
  const key = JSON.parse(fs.readFileSync(path.join(keys, st.groundTruth), 'utf-8'));
  assert.ok(validate(key), JSON.stringify(validate.errors)); assert.equal(key.pair.with, eob.id);
  for (const pdf of [eob.pdf, st.pdf]) { const t = text(path.join(dir, pdf)); for (const leak of ['duplicate-visit', 'over-owed', 'provider-statement', 'ppo-eob']) assert.ok(!t.includes(leak), `${pdf}: ${leak}`); }
  // a folder that already holds pairs.jsonl is refused before anything is rendered, and leaves no manifest behind
  const keys2 = tmp();
  await assert.rejects(renderBatch({ types: ['ppo-eob'], scenarios: ['duplicate-visit'], seeds: 1, outDir: dir, keysDir: keys2, blind: { salt }, also: 'bill', browser }), (e) => e.code === 'EEXIST');
  assert.deepEqual(fs.readdirSync(keys2), []);
});

test('the command line writes the statement with --also bill or --also 835,bill and --bill, and refuses a bad list', { skip, timeout: 180000 }, () => {
  const dir = tmp();
  const ok = spawnSync(process.execPath, [CLI, 'render', 'ppo-eob', 'baseline-clean', '--seed', 'pair-c1', '--out', dir, '--also', '835,bill', '--bill', 'payment-misposted'], { encoding: 'utf-8' });
  assert.equal(ok.status, 0, ok.stderr);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'ppo-eob_baseline-clean_pair-c1.bill.ground-truth.json'), 'utf-8'));
  assert.equal(st.pair.variant, 'payment-misposted'); assert.ok(fs.existsSync(path.join(dir, 'ppo-eob_baseline-clean_pair-c1.835')));
  const bad = spawnSync(process.execPath, [CLI, 'render', 'ppo-eob', 'baseline-clean', '--out', tmp(), '--also', 'bill,bill'], { encoding: 'utf-8' });
  assert.equal(bad.status, 2); assert.equal(bad.stderr.trim(), pairMessage('alsoList', '--also'));
});
