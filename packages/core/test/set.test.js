// Published sets (set.js): the standard set's composition, layouts and presets that turn the same way for every
// scenario, refusals that repeat nothing typed, a set's documents written by id with their 835s and degraded copies,
// keys apart that name the set and carry its canary, no leak into the documents, the same bytes again from the salt,
// and set scoring that counts every document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { launchBrowser, findChrome, renderBatch, readManifest, REMITTANCE_TYPES } from '../src/index.js';
import { listScenarios } from '../src/generate/index.js';
import { variantIds } from '../src/variants.js';
import { SET_NAMES, SET_STRINGS, SetError, loadSet, planSet, checkSet, canaryOf } from '../src/set.js';
import { writeJobs } from '../src/batch.js';
import { summarizeSet, scoreExtraction } from '../src/verify.js';
import { generateData } from '../src/generate/index.js';
import { leaksIn, tokensOf, filesUnder } from './leak-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const SALT = 'fedcba9876543210fedcba9876543210';
const M = SET_STRINGS.messages;
let browser = null;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

const spec = loadSet('standard');
const jobs = planSet(spec, { remittanceTypes: REMITTANCE_TYPES });

test('the standard set: 1,022 documents, balanced by type, every scenario, one in five a degraded copy, 835s where a type has one', () => {
  assert.deepEqual(SET_NAMES, ['standard']);
  assert.equal(jobs.length, 1022);
  const want = { msn: 20, 'itemized-bill': 50, 'ppo-eob': 32, 'hmo-eob': 32 };
  for (const [type, seeds] of Object.entries(want)) {
    const mine = jobs.filter((j) => j.type === type);
    assert.equal(mine.length, listScenarios(type).length * seeds, type);
    assert.deepEqual([...new Set(mine.map((j) => j.scenario))].sort(), [...listScenarios(type)].sort(), `${type}: every scenario`);
    assert.equal(new Set(mine.map((j) => `${j.scenario}/${j.seed}`)).size, mine.length, `${type}: no document twice`);
    assert.equal(mine.filter((j) => j.degrade).length, listScenarios(type).length * Math.floor(seeds / 5), `${type}: one in five degraded`);
    for (const j of mine) {
      assert.equal(j.also, REMITTANCE_TYPES.includes(type) ? '835' : null, `${type}: 835`);
      if (j.layoutVariant !== undefined) assert.ok(variantIds(type).includes(j.layoutVariant), `${type}: a published variant`);
    }
    // every layout of a type with variants is used, the base included
    if (variantIds(type).length) assert.equal(new Set(mine.map((j) => j.layoutVariant ?? 'base')).size, variantIds(type).length + 1, `${type}: every layout`);
  }
  for (const p of spec.presets) assert.ok(jobs.some((j) => j.degrade === p), `preset ${p} used`);
});

test('the set file takes exactly the degraded presets degrade.js publishes', async () => {
  const { PRESETS } = await import('../src/degrade.js');
  assert.deepEqual([...spec.presets].sort(), [...PRESETS].sort());
  assert.throws(() => checkSet({ ...structuredClone(spec), presets: [...PRESETS, 'blur'] }), /presets/);
});

test('layout, preset and 835 turn the same way for every scenario of a type, so none of them tells the scenario', () => {
  for (const type of new Set(jobs.map((j) => j.type))) {
    const profile = (scenario) => jobs.filter((j) => j.type === type && j.scenario === scenario)
      .map((j) => `${j.layoutVariant ?? 'base'}|${j.degrade ?? 'clean'}|${j.also ?? '-'}`).sort().join(',');
    const profiles = new Set(listScenarios(type).map(profile));
    assert.equal(profiles.size, 1, `${type}: one profile for all scenarios`);
  }
});

test('a set file outside its shape is refused, and an unknown set name is refused without repeating it', () => {
  const bad = (change) => assert.throws(() => checkSet({ ...structuredClone(spec), ...change }), /^Error: set file: /);
  bad({ extra: 1 }); bad({ name: 'other' }); bad({ canaryGuid: 'x' }); bad({ seedPrefix: '-x' }); bad({ types: [] });
  bad({ types: [{ type: 'msn', seeds: 1 }, { type: 'msn', seeds: 2 }] }); bad({ types: [{ type: 'nope', seeds: 1 }] }); bad({ types: [{ type: 'msn', seeds: 0 }] });
  bad({ types: [{ type: 'msn', seeds: 1, more: 1 }] }); bad({ degradeEvery: 1 }); bad({ presets: ['scan', 'scan'] }); bad({ presets: ['blur'] }); bad({ remittance: 'yes' });
  assert.throws(() => planSet({ ...structuredClone(spec), types: [{ type: 'msn', seeds: 1000 }] }), /over the limit/);
  const probe = 'zz-probe-name-91';
  assert.throws(() => loadSet(probe), (e) => e instanceof SetError && e.message === M.setUnknown.replace('{names}', 'standard') && !e.message.includes(probe));
  assert.equal(canaryOf(spec), SET_STRINGS.canary.replace('{guid}', spec.canaryGuid));
});

test('the command line refuses a set with other batch options, without its keys folder, or by an unknown name, repeating nothing', () => {
  const dir = tmp('cs-set-cli-'); const probe = 'zz-probe-name-92';
  const run = (...a) => spawnSync(process.execPath, [CLI, 'batch', ...a], { encoding: 'utf-8' });
  for (const extra of [['--types', 'msn'], ['--scenarios', 'all'], ['--seeds', '2'], ['--seed-prefix', probe], ['--degrade', 'scan'], ['--also', '835'], ['--layout-variant', 'p01']]) {
    const r = run('--set', 'standard', ...extra, '--out', path.join(dir, 'd'), '--blind-keys', path.join(dir, 'k'));
    assert.equal(r.status, 2, extra[0]); assert.equal(r.stderr.trim(), M.setFixed); assert.ok(!r.stderr.includes(probe));
  }
  let r = run('--set', 'standard', '--out', path.join(dir, 'd'));
  assert.equal(r.status, 2); assert.equal(r.stderr.trim(), M.setNeedsKeys);
  r = run('--set', probe, '--out', path.join(dir, 'd'), '--blind-keys', path.join(dir, 'k'));
  assert.equal(r.status, 2); assert.equal(r.stderr.trim(), M.setUnknown.replace('{names}', 'standard')); assert.ok(!r.stderr.includes(probe));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing made');
});

test('the library refuses a set with other options or without blind and a keys folder, before anything is made', async () => {
  const dir = tmp('cs-set-lib-');
  const who = (k) => M[k].replace('{who}', 'batch');
  await assert.rejects(renderBatch({ set: 'standard', types: ['msn'], outDir: path.join(dir, 'd'), blind: true, keysDir: path.join(dir, 'k') }), (e) => e.message === who('setOptions'));
  await assert.rejects(renderBatch({ set: 'standard', outDir: path.join(dir, 'd'), blind: true }), (e) => e.message === who('setNotBlind'));
  await assert.rejects(renderBatch({ set: 'standard', outDir: path.join(dir, 'd'), keysDir: path.join(dir, 'k') }), (e) => e.message === who('setNotBlind'));
  await assert.rejects(renderBatch({ set: 'nope', outDir: path.join(dir, 'd'), blind: true, keysDir: path.join(dir, 'k') }), (e) => e.code === 'SET');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing made');
});

// four documents of the standard set's plan: a degraded MSN with its 835, a PPO EOB in a variant with its 835, an
// itemized bill in its base layout, a degraded HMO EOB in a variant with its 835
const pick = () => [
  jobs.find((j) => j.type === 'msn' && j.degrade === 'scan'),
  jobs.find((j) => j.type === 'ppo-eob' && j.layoutVariant && !j.degrade),
  jobs.find((j) => j.type === 'itemized-bill' && !j.layoutVariant && !j.degrade),
  jobs.find((j) => j.type === 'hmo-eob' && j.layoutVariant && j.degrade === 'fax'),
];

test('a set\'s documents are named by id with their 835s, keys apart name the set and carry its canary, nothing leaks, and the salt makes the same bytes', { skip, timeout: 600000 }, async () => {
  const dir = tmp('cs-set-render-'); const set = { name: spec.name, canary: canaryOf(spec) };
  const make = (sub) => writeJobs({ jobs: pick(), salt: SALT, outDir: path.join(dir, sub, 'docs'), keysDir: path.join(dir, sub, 'keys'), browser, set });
  await make('a');
  const docs = path.join(dir, 'a', 'docs'); const keys = path.join(dir, 'a', 'keys');
  const entries = readManifest(path.join(keys, 'manifest.jsonl'));
  assert.equal(entries.length, 4);
  assert.deepEqual(fs.readdirSync(docs).sort(), entries.flatMap((e) => [e.pdf, ...(e.remittance ? [e.remittance] : [])]).sort(), 'documents and 835s only');
  for (const e of entries) {
    assert.equal(e.set, 'standard'); assert.equal(e.canary, set.canary); assert.match(e.pdf, /^doc-[0-9a-f]{16}\.pdf$/);
    assert.equal(Boolean(e.remittance), REMITTANCE_TYPES.includes(e.type), `${e.type}: 835`);
    const key = JSON.parse(fs.readFileSync(path.join(keys, e.groundTruth), 'utf-8'));
    assert.ok(validate(key), JSON.stringify(validate.errors));
    assert.equal(key.blind.set, 'standard'); assert.equal(key.blind.canary, set.canary); assert.equal(key.blind.salt, SALT);
    assert.equal(e.degradation !== null, Boolean(key.blind.copyOf), 'a degraded copy names the document it was copied from');
    // nothing a tool can read names the scenario, an error, a decoy, the seed or the canary
    const files = [path.join(docs, e.pdf), ...(e.remittance ? [path.join(docs, e.remittance)] : [])];
    assert.deepEqual(leaksIn({ files }, [...tokensOf(key), spec.canaryGuid]), [], e.pdf);
  }
  // a key without its canary, or a canary without the set, is outside the schema
  const one = JSON.parse(fs.readFileSync(path.join(keys, entries[0].groundTruth), 'utf-8'));
  const { canary: _c, ...noCanary } = one.blind; assert.equal(validate({ ...one, blind: noCanary }), false);
  const { set: _s, ...noSet } = one.blind; assert.equal(validate({ ...one, blind: noSet }), false);
  // the same plan and salt, again on this machine: the same files, byte for byte
  await make('b');
  for (const f of filesUnder(path.join(dir, 'a'))) {
    const rel = path.relative(path.join(dir, 'a'), f);
    assert.equal(sha(path.join(dir, 'b', rel)), sha(f), rel);
  }
});

test('set scores count every document: a missing or invalid report, or a part a report leaves out, scores as empty', () => {
  const key = (type, scenario) => generateData({ type, scenario, seed: 's1' }).groundTruth;
  const perfect = (k) => ({ fields: k.documents[0].fields, errors: k.errors.map((x) => ({ kind: x.kind, fieldRef: x.fieldRef, lineRef: x.lineRef })) });
  const a = key('msn', 'duplicate-office-visit'); const b = key('itemized-bill', 'baseline-clean'); const c = key('ppo-eob', 'baseline-clean');
  const rows = [
    { document: 'a.pdf', type: 'msn', degradation: null, key: a, output: perfect(a) },
    { document: 'b.pdf', type: 'itemized-bill', degradation: 'scan', key: b, missing: true },
    { document: 'c.pdf', type: 'ppo-eob', degradation: null, key: c, output: { fields: c.documents[0].fields } },
    { document: 'd.pdf', type: 'msn', degradation: 'fax', key: a, problem: 'extractor output: not valid JSON' },
  ];
  const s = summarizeSet(rows);
  assert.equal(s.documents, 4); assert.equal(s.scored, 2); assert.equal(s.missingOutputs, 1);
  assert.deepEqual(s.invalidOutputs, [{ document: 'd.pdf', problem: 'extractor output: not valid JSON' }]);
  const fieldsOf = (k) => scoreExtraction(k, { fields: {} }).fields.expected;
  // fields: a and c are right; b and d count as empty
  assert.equal(s.scoredOnly.fields.accuracy, 1);
  assert.equal(s.fields.correct, s.scoredOnly.fields.correct); assert.ok(s.fields.expected > s.scoredOnly.fields.expected);
  assert.equal(s.fields.expected, 2 * fieldsOf(a) + fieldsOf(b) + fieldsOf(c), 'every document\'s fields counted');
  // errors: c left them out while a gave them, so c's errors count as not found; scored-only counts a alone
  assert.equal(s.scoredOnly.errors.expected, a.errors.length);
  assert.equal(s.errors.expected, 2 * a.errors.length + b.errors.length + c.errors.length);
  assert.equal(s.errors.found, a.errors.length);
  assert.deepEqual(Object.keys(s.byType), ['itemized-bill', 'msn', 'ppo-eob']);
  assert.equal(s.byType.msn.documents, 2);
  assert.deepEqual(Object.keys(s.byDegradation), ['clean', 'fax', 'scan']);
  assert.equal(s.byDegradation.scan.fields.correct, 0);
  for (const e of a.errors) assert.ok(s.byKind[e.kind].expected >= 2 && s.byKind[e.kind].found >= 1, e.kind);
  assert.equal(Object.getPrototypeOf(s.byKind), Object.prototype);
  // leaving documents out lowers recall but not precision, which counts only what was flagged
  const flagged = (k) => ({ fields: k.documents[0].fields, errors: [...perfect(k).errors, { kind: 'math-error', fieldRef: 'claims[0].lineItems[0]' }] });
  const all = summarizeSet([a, a, a].map((k, i) => ({ document: `${i}.pdf`, type: 'msn', degradation: null, key: k, output: flagged(k) })));
  const fewer = summarizeSet([a, a, a].map((k, i) => ({ document: `${i}.pdf`, type: 'msn', degradation: null, key: k, ...(i ? { missing: true } : { output: flagged(k) }) })));
  assert.ok(fewer.errors.recall < all.errors.recall); assert.equal(fewer.errors.precision, all.errors.precision);
  // no report at all: both parts count, as empty
  const none = summarizeSet([{ document: 'x.pdf', type: 'msn', degradation: null, key: a, missing: true }]);
  assert.equal(none.fields.correct, 0); assert.ok(none.fields.expected > 0); assert.equal(none.fields.accuracy, 0);
  assert.equal(none.errors.expected, a.errors.length); assert.equal(none.errors.recall, a.errors.length ? 0 : null);
});

test('a report that gives neither part takes nothing out of the headline, and every breakdown adds up to it', () => {
  const key = (type, scenario) => generateData({ type, scenario, seed: 's2' }).groundTruth;
  const a = key('msn', 'duplicate-office-visit'); const b = key('ppo-eob', 'baseline-clean');
  const row = (k, doc, type, degradation, more) => ({ document: doc, type, degradation, key: k, ...more });
  const zero = { documents: 0, fe: 0, fc: 0, ee: 0, ef: 0, fa: 0 };
  const add = (t, g) => ({ documents: t.documents + g.documents, fe: t.fe + g.fields.expected, fc: t.fc + g.fields.correct, ee: t.ee + g.errors.expected, ef: t.ef + g.errors.found, fa: t.fa + g.errors.falseAlarms });
  const checked = (rows) => {
    const s = summarizeSet(rows); const head = add(zero, s);
    assert.deepEqual(Object.values(s.byType).reduce(add, zero), head, 'byType adds up to the headline');
    assert.deepEqual(Object.values(s.byDegradation).reduce(add, zero), head, 'byDegradation adds up to the headline');
    assert.equal(Object.values(s.byKind).reduce((n, k) => n + k.expected, 0), s.errors.expected, 'byKind adds up to the headline');
    return s;
  };
  const none = checked([row(a, 'a.pdf', 'msn', null, { missing: true }), row(b, 'b.pdf', 'ppo-eob', 'scan', { missing: true })]);
  assert.ok(none.fields.expected > 0 && none.errors.expected > 0);
  for (const [label, rows] of [
    ['every report empty', [row(a, 'a.pdf', 'msn', null, { output: {} }), row(b, 'b.pdf', 'ppo-eob', 'scan', { output: {} })]],
    ['an empty report and a missing one', [row(a, 'a.pdf', 'msn', null, { output: {} }), row(b, 'b.pdf', 'ppo-eob', 'scan', { missing: true })]],
    ['an empty report and an invalid one', [row(a, 'a.pdf', 'msn', null, { output: {} }), row(b, 'b.pdf', 'ppo-eob', 'scan', { problem: 'extractor output: not valid JSON' })]],
  ]) {
    const s = checked(rows);
    assert.equal(s.fields.expected, none.fields.expected, label); assert.equal(s.errors.expected, none.errors.expected, label);
    assert.equal(s.fields.accuracy, 0, label); assert.equal(s.errors.recall, 0, label);
    // the scored reports' own figures are as before: an empty report scores neither part
    assert.equal(s.scoredOnly.fields.expected, 0, label); assert.equal(s.scoredOnly.errors.expected, 0, label);
  }
  // a run whose reports give fields only, or errors only, still counts only that part
  const fieldsOnly = checked([row(a, 'a.pdf', 'msn', null, { output: { fields: a.documents[0].fields } }), row(b, 'b.pdf', 'ppo-eob', 'scan', { output: {} })]);
  assert.equal(fieldsOnly.fields.expected, none.fields.expected); assert.equal(fieldsOnly.errors.expected, 0);
  const errorsOnly = checked([row(a, 'a.pdf', 'msn', null, { output: { errors: [] } }), row(b, 'b.pdf', 'ppo-eob', 'scan', { missing: true })]);
  assert.equal(errorsOnly.fields.expected, 0); assert.equal(errorsOnly.errors.expected, none.errors.expected);
  // a group is named by text only: a type that is not text, or a degradation that is not a preset, is refused
  const refusal = SET_STRINGS.messages.scoreRows;
  for (const bad of [{ type: { toString: null } }, { type: ['msn'] }, { degradation: { fictional: 'a' } }, { degradation: JSON.parse('{"toString":null}') }, { degradation: 'blur' }, { degradation: 7 }])
    assert.throws(() => summarizeSet([{ ...row(a, 'a.pdf', 'msn', null, { missing: true }), ...bad }]), (e) => e.message === refusal, JSON.stringify(bad));
});
