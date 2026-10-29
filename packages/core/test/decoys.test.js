// Decoys (src/generate/mutations.js DECOY_OPS): lines that look wrong but follow the rules. Each op changes only what
// it says, never what the patient owes on another line, never an error's place, and refuses a line it can't use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateData } from '../src/generate/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
const validate = ajv.compile(schema);
const gen = (type, scenario, decoys, seed = 'dc-1') => generateData({ type, scenario, seed, overrides: decoys ? { decoys } : {} });
const at = (claims, ref) => ref.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => o?.[k], { claims });
// the first line a repeat may use: not preventive, not a new-patient visit, not HbA1c
const repeatable = (gt) => { for (const [i, c] of gt.claims.entries()) for (const [j, l] of c.lines.entries()) if (!/^(9920[2-5]|83036|G04\d\d|99387|99397)$/.test(l.code) && l.patientMayBeBilled !== 0) return [i, j]; return null; };

test('repeat-service-other-date appends the same service on a later date, adjudicated as a second visit', () => {
  for (const type of ['msn', 'itemized-bill']) {
    const base = gen(type, 'baseline-clean').groundTruth;
    const [c, j] = repeatable(base);
    const before = base.claims[c].lines[j];
    const { groundTruth: g } = gen(type, 'baseline-clean', [{ op: 'repeat-service-other-date', args: { claim: c, line: j, days: 1 }, rule: 'cited rule' }]);
    const d = g.decoys[0];
    assert.equal(d.kind, 'repeat-service-different-date'); assert.equal(d.id, 'decoy-1'); assert.equal(d.rule, 'cited rule');
    const copy = at(g.claims, d.lineRef);
    assert.equal(copy.code, before.code); assert.notEqual(copy.dateOfService, before.dateOfService);
    assert.equal(Math.round((copy.paid + copy.patientMayBeBilled) * 100), Math.round(copy.allowed * 100), 'the copy foots');
    assert.equal(g.claims[c].lines.length, base.claims[c].lines.length + 1);
    assert.ok(Object.keys(g.documents[0].fields).some((k) => k.startsWith(`${d.fieldRef}.`)), `${type}: the decoy is printed`);
    assert.ok(validate(g), JSON.stringify(validate.errors));
  }
});

test('charge-far-above-approved raises only the charge; approved amount and patient share stay put', () => {
  const base = gen('msn', 'baseline-clean').groundTruth;
  const { groundTruth: g } = gen('msn', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0, factor: 5 }, rule: 'cited rule' }]);
  const was = base.claims[0].lines[0]; const now = g.claims[0].lines[0];
  assert.equal(now.charged, Math.round(was.allowed * 5 * 100) / 100);
  assert.deepEqual([now.allowed, now.paid, now.patientMayBeBilled], [was.allowed, was.paid, was.patientMayBeBilled]);
  assert.equal(g.claims[0].totals.patientMayBeBilled, base.claims[0].totals.patientMayBeBilled);
  assert.equal(g.errors.length, 0, 'a decoy is never an error');
});

test('a repeat on another date takes what is left of the deductible, and widens the printed date ranges', () => {
  const [c0, j0] = repeatable(gen('msn', 'baseline-clean', null, 'dc-2').groundTruth);
  const sc = { deductibleMetBefore: 0, decoys: [{ op: 'repeat-service-other-date', args: { claim: c0, line: j0, days: 2 }, rule: 'r' }] };
  const { groundTruth: g, data } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'dc-2', overrides: sc });
  const met = g.claims.reduce((n, c) => n + c.lines.reduce((m, l) => m + (l.toDeductible || 0), 0), 0);
  assert.ok(met <= 283.001, 'never more than one deductible in total');
  const copy = at(g.claims, g.decoys[0].lineRef);
  const range = data.providers.find((p) => p.name === g.claims[c0].provider.toUpperCase()).dateRange;
  const [y, m, d] = copy.dateOfService.split('-');
  assert.ok(range.includes(`${m}/${d}/${y}`), `the provider's date range ${range} includes the repeat ${copy.dateOfService}`);
  const bill = gen('itemized-bill', 'baseline-clean', null, 'dc-3').groundTruth; const [c1, j1] = repeatable(bill);
  const { groundTruth: gb } = gen('itemized-bill', 'baseline-clean', [{ op: 'repeat-service-other-date', args: { claim: c1, line: j1, days: 9 }, rule: 'r' }], 'dc-3');
  const when = at(gb.claims, gb.decoys[0].lineRef).dateOfService;
  const all = gb.claims.flatMap((c) => c.lines.map((l) => l.dateOfService)).sort();
  const printed = Object.entries(gb.documents[0].fields).find(([k]) => /serviceDateRange$/.test(k))?.[1] || '';
  const long = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (when === all[0] || when === all.at(-1)) assert.ok(printed.includes(long(when)), `the bill's range "${printed}" includes the repeat ${when}`);
});

test('decoys keep every error in place, and refuse lines they cannot use', () => {
  const { groundTruth: g } = gen('msn', 'combined-three-errors', [{ op: 'charge-far-above-approved', args: { claim: 2, line: 0 }, rule: 'r' }]);
  const plain = gen('msn', 'combined-three-errors').groundTruth;
  assert.deepEqual(g.errors.map((e) => [e.kind, e.lineRef, e.fieldRef]), plain.errors.map((e) => [e.kind, e.lineRef, e.fieldRef]));
  const refuse = (type, scenario, decoys, re) => assert.throws(() => gen(type, scenario, decoys), re);
  refuse('msn', 'duplicate-office-visit', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }], /carries an error/);
  refuse('msn', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 } }], /must cite the rule/);
  const [rc, rl] = repeatable(gen('msn', 'baseline-clean').groundTruth);
  refuse('msn', 'baseline-clean', [{ op: 'repeat-service-other-date', args: { claim: rc, line: rl, days: 400 }, rule: 'r' }], /inside the period/);
  refuse('msn', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }, { op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }], /already carries a decoy/);
  refuse('msn', 'baseline-clean', [{ op: 'no-such-op', args: {}, rule: 'r' }], /unknown decoy op/);
  refuse('ppo-eob', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }], /not supported for this layout/);
  const preventive = gen('msn', 'preventive-visit-cost-sharing').groundTruth.claims.flatMap((c, i) => c.lines.map((l, j) => [i, j, l])).find(([, , l]) => l.code && /^(G0438|G0439|99387|99397|G0402)$/.test(l.code));
  if (preventive) refuse('msn', 'preventive-visit-cost-sharing', [{ op: 'repeat-service-other-date', args: { claim: preventive[0], line: preventive[1], days: 1 }, rule: 'r' }], /preventive|carries an error/);
});

test('every ground truth is schema 1.1 with a decoys list, empty unless the scenario plants some', () => {
  const { groundTruth: g } = gen('itemized-bill', 'duplicate-charge');
  assert.equal(g.schemaVersion, '1.1'); assert.deepEqual(g.decoys, []);
  assert.ok(validate(g), JSON.stringify(validate.errors));
});
