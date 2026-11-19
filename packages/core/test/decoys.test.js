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
  const MSG = JSON.parse(fs.readFileSync(path.join(here, '../data/ma-operations.json'), 'utf-8')).messages;
  const is = (key, op) => (e) => e.message === MSG[key].replace('{op}', op);
  refuse('msn', 'duplicate-office-visit', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }], is('lineTaken', 'charge-far-above-approved'));
  refuse('msn', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 } }], is('decoyNeedsRule'));
  const [rc, rl] = repeatable(gen('msn', 'baseline-clean').groundTruth);
  refuse('msn', 'baseline-clean', [{ op: 'repeat-service-other-date', args: { claim: rc, line: rl, days: 365 }, rule: 'r' }], is('outsidePeriod', 'repeat-service-other-date'));
  refuse('msn', 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }, { op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }], is('lineTaken', 'charge-far-above-approved'));
  refuse('msn', 'baseline-clean', [{ op: 'no-such-op', args: {}, rule: 'r' }], is('unknownDecoy'));
  // the Medicare Advantage layouts take their own decoys (ma-*), never the Part B ones, and the reverse
  for (const type of ['ppo-eob', 'hmo-eob']) assert.throws(() => gen(type, 'baseline-clean', [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r' }]), is('unknownDecoy'));
  refuse('msn', 'baseline-clean', [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0, factor: 5 }, rule: 'r' }], is('unknownDecoy'));
  const preventive = gen('msn', 'preventive-visit-cost-sharing').groundTruth.claims.flatMap((c, i) => c.lines.map((l, j) => [i, j, l])).find(([, , l]) => l.code && /^(G0438|G0439|99387|99397|G0402)$/.test(l.code));
  if (preventive) refuse('msn', 'preventive-visit-cost-sharing', [{ op: 'repeat-service-other-date', args: { claim: preventive[0], line: preventive[1], days: 1 }, rule: 'r' }], (e) => is('repeatIsError', 'repeat-service-other-date')(e) || is('lineTaken', 'repeat-service-other-date')(e));
});

test('every ground truth is schema 1.3 with a decoys list, empty unless the scenario plants some', () => {
  const { groundTruth: g } = gen('itemized-bill', 'duplicate-charge');
  assert.equal(g.schemaVersion, '1.3'); assert.deepEqual(g.decoys, []); assert.equal(g.documents[0].degradationParams, null);
  assert.ok(validate(g), JSON.stringify(validate.errors));
});

test('a repeat on another date names the line it repeats, and verify counts a flag at either line as that decoy', async () => {
  const { scoreExtraction } = await import('../src/verify.js');
  const decoyScenario = { msn: 'decoys-repeat-visit-high-charge', 'itemized-bill': 'decoys-repeat-therapy-high-charge', 'ppo-eob': 'decoys-partial-deductible', 'hmo-eob': 'decoys-oop-cap-partial' };
  for (const [type, scenario] of Object.entries(decoyScenario)) {
    const { groundTruth: g } = generateData({ type, scenario, seed: 'pair-ref-1' });
    const d = g.decoys.find((x) => x.kind === 'repeat-service-different-date');
    assert.ok(d, `${type}: the scenario plants a repeat on another date`);
    assert.ok(d.relatedLineRef && d.relatedLineRef !== d.lineRef, `${type}: the decoy names the first visit`);
    const first = at(g.claims, d.relatedLineRef); const again = at(g.claims, d.lineRef);
    assert.equal(first.code, again.code); assert.notEqual(first.dateOfService, again.dateOfService);
    assert.ok(d.relatedFieldRef && Object.keys(g.documents[0].fields).some((k) => k.startsWith(`${d.relatedFieldRef}.`)), `${type}: the first visit is printed where relatedFieldRef says`);
    assert.ok(validate(g), JSON.stringify(validate.errors));
    for (const ref of [d.lineRef, d.relatedLineRef]) {
      const r = scoreExtraction(g, { errors: [{ kind: 'duplicate-charge', lineRef: ref }] });
      assert.deepEqual(r.errors.decoysFlagged, [d.id], `${type}: a duplicate reported at ${ref} is the decoy flagged`);
      assert.equal(r.errors.falseAlarms, 1);
    }
  }
});

test('two repeats of one EOB line each name that line as their first visit', () => {
  for (const type of ['hmo-eob', 'ppo-eob']) {
    const scenario = type === 'hmo-eob' ? 'decoys-oop-cap-partial' : 'decoys-partial-deductible';
    const decoys = [1, 3].map((days) => ({ op: 'ma-repeat-service-other-date', kind: 'repeat-service-different-date', args: { claim: 0, line: 0, days }, rule: 'r' }));
    const { groundTruth: g } = generateData({ type, scenario, seed: 'pair-ref-2', overrides: { decoys } });
    assert.equal(g.decoys.length, 2);
    for (const d of g.decoys) assert.equal(d.relatedLineRef, 'claims[0].lines[0]', `${type} ${d.id}`);
    assert.notEqual(g.decoys[0].lineRef, g.decoys[1].lineRef);
  }
});

test('a flag at a line is scored against the decoy planted on that line before a repeat that names it, and one repeat pair flagged at both lines is one false alarm', async () => {
  const { scoreExtraction } = await import('../src/verify.js');
  const [c, j] = repeatable(gen('msn', 'baseline-clean', null, 'dc-4').groundTruth);
  const decoys = [{ op: 'repeat-service-other-date', args: { claim: c, line: j, days: 7 }, rule: 'r' }, { op: 'charge-far-above-approved', args: { claim: c, line: j, factor: 5 }, rule: 'r' }];
  const { groundTruth: g } = gen('msn', 'baseline-clean', decoys, 'dc-4');
  const [repeat, high] = g.decoys;
  assert.equal(repeat.relatedLineRef, high.lineRef, 'both decoys involve the first line');
  const one = scoreExtraction(g, { errors: [{ kind: 'fee-schedule-overcharge', lineRef: high.lineRef }] });
  assert.deepEqual(one.errors.decoysFlagged, [high.id], 'the decoy on that line, not the repeat that names it');
  // with the repeat alone on that line: both lines of the pair flagged as a duplicate are one false alarm and a repeat
  const { groundTruth: g2 } = gen('msn', 'baseline-clean', [decoys[0]], 'dc-4');
  const pair = g2.decoys[0];
  const both = scoreExtraction(g2, { errors: [{ kind: 'duplicate-charge', lineRef: pair.lineRef }, { kind: 'duplicate-charge', lineRef: pair.relatedLineRef }] });
  assert.equal(both.errors.falseAlarms, 1); assert.equal(both.errors.repeats, 1); assert.deepEqual(both.errors.decoysFlagged, [pair.id]);
});
