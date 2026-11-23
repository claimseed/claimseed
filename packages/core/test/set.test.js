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
import { SET_NAMES, SET_STRINGS, SetError, loadSet, planSet, planWithCounts, floorsMissed, drawSalt, drawnMessage, checkSet, canaryOf } from '../src/set.js';
import { generatePair } from '../src/generate/index.js';
import { blindSeed } from '../src/blind.js';
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
const jobs = planSet(spec, { remittanceTypes: REMITTANCE_TYPES, salt: SALT });
const PAIRED = ['ppo-eob', 'hmo-eob', 'commercial-eob'];
const index = (j) => Number(j.seed.split('-').pop());
// salts found by search, the same every run: the first that meets every floor and the first that misses one
const probe = (i) => crypto.createHash('sha256').update(`set-floor-probe-${i}`).digest('hex').slice(0, 32);
const found = (want) => { for (let i = 0; i < 40; i++) { const s = probe(i); const { counts } = planWithCounts(spec, { remittanceTypes: REMITTANCE_TYPES, salt: s }); if ((floorsMissed(spec, counts).length === 0) === want) return s; } throw new Error('no salt found'); };

test('the standard set: 1,887 documents, balanced by type, every scenario, a statement beside each EOB of an even or degraded seed, 835s where a type has one', () => {
  assert.deepEqual(SET_NAMES, ['standard']);
  // the published values, written out, so the set file cannot change them unseen
  assert.deepEqual(spec.statements, { every: 2 });
  assert.deepEqual(spec.floors, { errorKind: 20, decoy: 20, statementKind: 20, statementClean: 20, statementVariant: 5, statementProvider: 2, insurerShare: 0.4 });
  assert.equal(jobs.length, 1887);
  const want = { msn: 20, 'itemized-bill': 50, 'ppo-eob': 32, 'hmo-eob': 32, 'commercial-eob': 32 };
  assert.deepEqual(spec.types.map((t) => [t.type, t.seeds]), Object.entries(want));
  const docs = jobs.filter((j) => j.part !== 'bill');
  for (const [type, seeds] of Object.entries(want)) {
    const mine = docs.filter((j) => j.type === type);
    assert.equal(mine.length, listScenarios(type).length * seeds, type);
    assert.deepEqual([...new Set(mine.map((j) => j.scenario))].sort(), [...listScenarios(type)].sort(), `${type}: every scenario`);
    assert.equal(new Set(mine.map((j) => `${j.scenario}/${j.seed}`)).size, mine.length, `${type}: no document twice`);
    assert.equal(mine.filter((j) => j.degrade).length, listScenarios(type).length * Math.floor(seeds / 5), `${type}: every fifth seed degraded`);
    for (const j of mine) {
      const statement = PAIRED.includes(type) && (index(j) % 2 === 0 || j.degrade !== null);
      assert.equal(j.part === 'eob', statement, `${type} ${j.seed}: a statement exactly on an even or degraded seed`);
      const extra = REMITTANCE_TYPES.includes(type) ? ['835'] : [];
      assert.deepEqual(j.also, statement ? [...extra, 'bill'] : (extra[0] ?? null), `${type}: 835 and statement`);
      if (j.layoutVariant !== undefined) assert.ok(variantIds(type).includes(j.layoutVariant), `${type}: a published variant`);
    }
    if (variantIds(type).length) assert.equal(new Set(mine.map((j) => j.layoutVariant ?? 'base')).size, variantIds(type).length + 1, `${type}: every layout`);
  }
  // each statement right after its EOB, with the same job and variant; 152 + 152 + 209, every preset among the copies
  const bills = jobs.filter((j) => j.part === 'bill');
  assert.deepEqual(Object.fromEntries(PAIRED.map((t) => [t, bills.filter((j) => j.type === t).length])), { 'ppo-eob': 152, 'hmo-eob': 152, 'commercial-eob': 209 });
  for (const [i, j] of jobs.entries()) if (j.part === 'bill') { const { part: _a, ...a } = jobs[i - 1]; const { part: _b, ...b } = j; assert.equal(jobs[i - 1].part, 'eob'); assert.deepEqual(a, b); }
  const byPreset = {}; for (const j of bills) if (j.degrade) byPreset[j.degrade] = (byPreset[j.degrade] || 0) + 1;
  assert.deepEqual(byPreset, { scan: 54, fax: 54, photo: 27, 'low-res': 27 });
  for (const p of spec.presets) assert.ok(docs.some((j) => j.degrade === p), `preset ${p} used`);
});

test('the statement variant: assigned from the salt alone, always one that applies, quotas and floors, a held-harmless statement kept clean', () => {
  assert.deepEqual(planSet(spec, { remittanceTypes: REMITTANCE_TYPES, salt: SALT }), jobs, 'the same salt, the same plan');
  const other = planSet(spec, { remittanceTypes: REMITTANCE_TYPES, salt: probe(99) });
  assert.notDeepEqual(other.map((j) => j.bill ?? null), jobs.map((j) => j.bill ?? null), 'another salt, other variants');
  assert.deepEqual(other.map(({ bill: _b, ...j }) => j), jobs.map(({ bill: _b, ...j }) => j), 'another salt, the same documents');
  assert.throws(() => planSet(spec, { remittanceTypes: REMITTANCE_TYPES }), /planned from the salt/);
  for (const type of PAIRED) {
    const mine = jobs.filter((j) => j.part === 'bill' && j.type === type);
    const quota = Math.floor(mine.length / 6); const n = {};
    let heldClean = false;
    for (const j of mine) {
      const g = { type, scenario: j.scenario, seed: blindSeed(SALT, j), layoutVariant: j.layoutVariant ?? null };
      assert.equal(generatePair({ ...g, bill: j.bill, orClean: true }).statement.groundTruth.pair.variant, j.bill, `${type} ${j.scenario} ${j.seed}: the variant applies`);
      n[j.bill] = (n[j.bill] || 0) + 1;
      if (j.bill === 'clean' && generatePair({ ...g, bill: 'denied-line-billed', orClean: true }).statement.groundTruth.pair.variant === 'denied-line-billed') heldClean = true;
    }
    for (const [v, k] of Object.entries(n)) if (v !== 'clean') assert.ok(k <= quota, `${type} ${v}: at most the quota`);
    assert.ok(heldClean, `${type}: a statement on a held-harmless denied line kept clean`);
  }
  // the rule's result for the test salt, written out: rarest first in the salt's order, round robin to a sixth each
  const variants = (t) => Object.fromEntries(['clean', 'over-owed', 'denied-line-billed', 'payment-misposted', 'paid-at-visit', 'over-owed-with-payment'].map((v) => [v, jobs.filter((j) => j.part === 'bill' && j.type === t && j.bill === v).length]));
  assert.deepEqual(variants('ppo-eob'), { clean: 45, 'over-owed': 25, 'denied-line-billed': 7, 'payment-misposted': 25, 'paid-at-visit': 25, 'over-owed-with-payment': 25 });
  assert.deepEqual(variants('hmo-eob'), { clean: 43, 'over-owed': 25, 'denied-line-billed': 9, 'payment-misposted': 25, 'paid-at-visit': 25, 'over-owed-with-payment': 25 });
  assert.deepEqual(variants('commercial-eob'), { clean: 73, 'over-owed': 34, 'denied-line-billed': 17, 'payment-misposted': 34, 'paid-at-visit': 25, 'over-owed-with-payment': 26 });
  // the kinds the floors hold the set to: every kind and decoy the published scenarios plant, written out
  assert.deepEqual(planWithCounts(spec, { remittanceTypes: REMITTANCE_TYPES, salt: SALT }).counts.expected, {"errorKind":{"msn":["cost-sharing-error","coverage-denial","deductible-misapplied","duplicate-charge","fee-schedule-overcharge","math-error","preventive-cost-sharing","service-date-anomaly"],"itemized-bill":["assignment-violation","duplicate-charge","subtotals-mismatch"],"ppo-eob":["coverage-denial","deductible-misapplied","duplicate-charge","math-error","preventive-cost-sharing"],"hmo-eob":["cost-sharing-error","coverage-denial","duplicate-charge","math-error","oop-max-exceeded","service-date-anomaly"],"commercial-eob":["coverage-denial","emergency-authorization-denial","in-network-balance-bill","math-error","missing-required-section","preventive-cost-sharing","surprise-balance-bill"]},"decoy":{"msn":["charge-above-approved","repeat-service-different-date"],"itemized-bill":["charge-above-approved","repeat-service-different-date"],"ppo-eob":["approved-below-copay","charge-above-approved","partial-deductible","repeat-service-different-date"],"hmo-eob":["approved-below-copay","charge-above-approved","oop-cap-partial-share","repeat-service-different-date"],"commercial-eob":["appeal-rights-by-section","consented-balance","elective-authorization-denial","ground-ambulance-balance","oop-excludes-non-covered","out-of-network-balance","problem-visit-beside-listed"]}});
  const pass = found(true);
  assert.deepEqual(floorsMissed(spec, planWithCounts(spec, { remittanceTypes: REMITTANCE_TYPES, salt: pass }).counts), []);
});

test('each floor, one at a time: counts written by hand at every floor pass, and one below a floor misses exactly that floor', () => {
  const titles = ['Hospital Patient Statement', 'Medical Group Statement', 'Urgent Care Statement', 'Laboratory Statement', 'Ambulance Statement'];
  const statements = () => ({ total: 100, variant: { clean: 20, 'over-owed': 5, 'denied-line-billed': 5, 'payment-misposted': 5, 'paid-at-visit': 5, 'over-owed-with-payment': 5 }, errorKind: { 'bill-vs-eob-mismatch': 20, 'bill-payment-mismatch': 20 }, decoy: { 'paid-at-visit': 20 } });
  const at = () => ({ errorKind: { msn: { 'math-error': 20 } }, decoy: { msn: { 'charge-above-approved': 20 } }, expected: { errorKind: { msn: ['math-error', 'duplicate-charge'] }, decoy: { msn: ['charge-above-approved'] } },
    statements: { 'ppo-eob': statements(), 'commercial-eob': statements() }, statementProvider: Object.fromEntries(titles.map((t) => [t, 2])), insurer: { total: 10, a: 4, b: 6 } });
  const base = at(); base.errorKind.msn['duplicate-charge'] = 20;
  assert.deepEqual(floorsMissed(spec, base), [], 'every count at its floor');
  const cases = [
    [(c) => { c.errorKind.msn['math-error'] = 19; }, 'errorKind msn math-error'],
    [(c) => { delete c.errorKind.msn['duplicate-charge']; }, 'errorKind msn duplicate-charge'],
    [(c) => { c.decoy.msn['charge-above-approved'] = 19; }, 'decoy msn charge-above-approved'],
    [(c) => { c.statements['ppo-eob'].errorKind['bill-vs-eob-mismatch'] = 19; }, 'statementKind ppo-eob bill-vs-eob-mismatch'],
    [(c) => { c.statements['ppo-eob'].errorKind['bill-payment-mismatch'] = 19; }, 'statementKind ppo-eob bill-payment-mismatch'],
    [(c) => { c.statements['commercial-eob'].decoy['paid-at-visit'] = 19; }, 'statementKind commercial-eob paid-at-visit'],
    [(c) => { c.statements['ppo-eob'].variant.clean = 19; }, 'statementClean ppo-eob'],
    [(c) => { c.statements['commercial-eob'].variant['denied-line-billed'] = 4; }, 'statementVariant commercial-eob denied-line-billed'],
    [(c) => { c.statementProvider['Ambulance Statement'] = 1; }, 'statementProvider Ambulance Statement'],
    [(c) => { c.insurer.a = 3; c.insurer.b = 7; }, 'insurerShare a'],
  ];
  for (const [change, name] of cases) { const c = structuredClone(base); change(c); assert.deepEqual(floorsMissed(spec, c), [name], name); }
  assert.equal(drawnMessage(3), M.setDrawn.replace('{who}', 'batch').replace('{n}', '3'));
});

test('the floors: a given salt that misses one is refused before anything is made, a drawn salt meets every floor, and 50 misses are refused', async () => {
  const miss = found(false);
  const dir = tmp('cs-set-floor-'); const who = (k) => M[k].replace('{who}', 'batch');
  await assert.rejects(renderBatch({ set: 'standard', outDir: path.join(dir, 'd'), blind: { salt: miss }, keysDir: path.join(dir, 'k') }), (e) => e instanceof SetError && e.message === who('setFloors') && !e.message.includes(miss));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing made');
  const d = drawSalt(spec, true, { remittanceTypes: REMITTANCE_TYPES });
  assert.deepEqual(floorsMissed(spec, d.plan.counts), []); assert.equal(d.missed.length, d.draws - 1);
  for (const m of d.missed) for (const name of m) assert.match(name, /^[a-zA-Z]+ [a-z-]+( [a-z-]+)?$|^statementProvider [A-Za-z ]+$|^insurerShare [ab]$/);
  // floors no salt can meet: refused after 50 draws (a one-type set file, so the plans are quick)
  const tiny = { ...structuredClone(spec), types: [{ type: 'ppo-eob', seeds: 2 }], floors: { ...spec.floors, statementClean: 1000 } };
  assert.throws(() => drawSalt(tiny, true, { remittanceTypes: REMITTANCE_TYPES }), (e) => e instanceof SetError && e.message === who('setDraws'));
  assert.equal(M.setDrawn.includes('{n}'), true);
});

test('the set file takes exactly the degraded presets degrade.js publishes', async () => {
  const { PRESETS } = await import('../src/degrade.js');
  assert.deepEqual([...spec.presets].sort(), [...PRESETS].sort());
  assert.throws(() => checkSet({ ...structuredClone(spec), presets: [...PRESETS, 'blur'] }), /presets/);
});

test('layout, preset, 835 and statement turn the same way for every scenario of a type, so none of them tells the scenario', () => {
  for (const type of new Set(jobs.map((j) => j.type))) {
    const profile = (scenario) => jobs.filter((j) => j.type === type && j.scenario === scenario)
      .map((j) => `${j.seed}|${j.layoutVariant ?? 'base'}|${j.degrade ?? 'clean'}|${[j.also ?? '-'].flat().join('+')}|${j.part ?? '-'}`).sort().join(',');
    const profiles = new Set(listScenarios(type).map(profile));
    assert.equal(profiles.size, 1, `${type}: one profile for all scenarios`);
  }
});

test('a set file outside its shape is refused, and an unknown set name is refused without repeating it', () => {
  const bad = (change) => assert.throws(() => checkSet({ ...structuredClone(spec), ...change }), /^Error: set file: /);
  bad({ extra: 1 }); bad({ name: 'other' }); bad({ canaryGuid: 'x' }); bad({ seedPrefix: '-x' }); bad({ types: [] });
  bad({ types: [{ type: 'msn', seeds: 1 }, { type: 'msn', seeds: 2 }] }); bad({ types: [{ type: 'nope', seeds: 1 }] }); bad({ types: [{ type: 'msn', seeds: 0 }] });
  bad({ types: [{ type: 'msn', seeds: 1, more: 1 }] }); bad({ degradeEvery: 1 }); bad({ presets: ['scan', 'scan'] }); bad({ presets: ['blur'] }); bad({ remittance: 'yes' });
  bad({ statements: { every: 0 } }); bad({ statements: { every: 2, more: 1 } }); bad({ statements: 2 }); bad({ types: [{ type: 'msn', seeds: 1 }] });
  bad({ floors: { ...spec.floors, more: 1 } }); bad({ floors: { ...spec.floors, decoy: 0 } }); bad({ floors: { ...spec.floors, insurerShare: 1 } });
  const { decoy: _d, ...fewer } = spec.floors; bad({ floors: fewer });
  assert.throws(() => planSet({ ...structuredClone(spec), types: [{ type: 'msn', seeds: 1000 }, { type: 'ppo-eob', seeds: 1 }] }), /over the limit/);
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

// seven documents of the standard set's plan: a degraded MSN with its 835, a PPO EOB in a variant with its 835, an
// itemized bill in its base layout, a degraded HMO EOB in a variant with its 835 and its statement's degraded copy, a
// degraded commercial EOB with its 835s and its statement's copy (a variant other than clean)
const pick = () => {
  const i = jobs.findIndex((j) => j.type === 'commercial-eob' && j.part === 'eob' && j.degrade === 'photo' && j.bill !== 'clean');
  return [
    jobs.find((j) => j.type === 'msn' && j.degrade === 'scan'),
    jobs.find((j) => j.type === 'ppo-eob' && j.layoutVariant && !j.degrade && !j.part),
    jobs.find((j) => j.type === 'itemized-bill' && !j.layoutVariant && !j.degrade),
    jobs.find((j) => j.type === 'hmo-eob' && j.layoutVariant && j.degrade === 'fax' && j.part === 'eob'),
    jobs.find((j) => j.type === 'hmo-eob' && j.layoutVariant && j.degrade === 'fax' && j.part === 'bill'),
    jobs[i], jobs[i + 1],
  ];
};

test('a set\'s documents are named by id with their 835s, keys apart name the set and carry its canary, nothing leaks, and the salt makes the same bytes', { skip, timeout: 600000 }, async () => {
  const dir = tmp('cs-set-render-'); const set = { name: spec.name, canary: canaryOf(spec) };
  const make = (sub) => writeJobs({ jobs: pick(), salt: SALT, outDir: path.join(dir, sub, 'docs'), keysDir: path.join(dir, sub, 'keys'), browser, set });
  await make('a');
  const docs = path.join(dir, 'a', 'docs'); const keys = path.join(dir, 'a', 'keys');
  const entries = readManifest(path.join(keys, 'manifest.jsonl'));
  assert.equal(entries.length, 7);
  assert.deepEqual(fs.readdirSync(docs).sort(), [...entries.flatMap((e) => [e.pdf, ...(e.remittance ? [e.remittance] : [])]), 'pairs.jsonl'].sort(), 'documents, 835s and pairs.jsonl only');
  // the pairs by id only, each naming a statement and its EOB of the set; no line or key name carries the variant
  const pairs = fs.readFileSync(path.join(docs, 'pairs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(pairs.length, 2);
  for (const p of pairs) { assert.deepEqual(Object.keys(p), ['eob', 'bill']); for (const id of [p.eob, p.bill]) assert.ok(entries.some((e) => e.id === id), id); }
  for (const e of entries) for (const v of ['bill', 'variant']) assert.ok(!Object.hasOwn(e, v), `${e.pdf}: no ${v} in the manifest line`);
  for (const e of entries) {
    assert.equal(e.set, 'standard'); assert.equal(e.canary, set.canary); assert.match(e.pdf, /^doc-[0-9a-f]{16}\.pdf$/);
    assert.equal(Boolean(e.remittance), REMITTANCE_TYPES.includes(e.type), `${e.type}: 835`);
    const key = JSON.parse(fs.readFileSync(path.join(keys, e.groundTruth), 'utf-8'));
    assert.ok(validate(key), JSON.stringify(validate.errors));
    assert.equal(key.blind.set, 'standard'); assert.equal(key.blind.canary, set.canary); assert.equal(key.blind.salt, SALT);
    assert.equal(e.degradation !== null, Boolean(key.blind.copyOf), 'a degraded copy names the document it was copied from');
    if (e.type === 'provider-statement') {
      assert.ok(pairs.some((p) => p.bill === e.id && p.eob === e.pairOf) && key.pair.with === e.pairOf, 'the statement names its EOB');
      assert.equal(key.pair.variant, pick().find((j) => j.part === 'bill' && j.scenario === e.scenario && j.seed === e.seed).bill, 'the planned variant');
    }
    // nothing a tool can read names the scenario, an error, a decoy, the seed or the canary
    const files = [path.join(docs, e.pdf), ...(e.remittance ? [path.join(docs, e.remittance)] : [])];
    assert.deepEqual(leaksIn({ files }, [...tokensOf(key), spec.canaryGuid]), [], e.pdf);
  }
  // a key without its canary, or a canary without the set, is outside the schema
  const one = JSON.parse(fs.readFileSync(path.join(keys, entries[0].groundTruth), 'utf-8'));
  const { canary: _c, ...noCanary } = one.blind; assert.equal(validate({ ...one, blind: noCanary }), false);
  const { set: _s, ...noSet } = one.blind; assert.equal(validate({ ...one, blind: noSet }), false);
  // the same plan and salt, again on this machine: the same files, byte for byte. Run alone: under heavy parallel render
  // work a degraded copy's pixels can shift (the glyph edges of one heading in an MSN scan copy, about 2,000 pixels by
  // more than 40 levels), so a set is built with nothing else rendering
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
