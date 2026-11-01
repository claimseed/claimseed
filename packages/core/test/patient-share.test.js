// The patient's share in its parts (ground truth 1.3): every claim line splits what the patient may be billed into
// deductible, coinsurance, copay and non-covered amounts that add up to it exactly, the lines' deductible adds up to
// the deductible the document prints, and the split changes no printed value. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateData, listScenarios } from '../src/index.js';
import { adjudicateMa } from '../src/generate/ma-eob.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const TYPES = ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob'];
const SEEDS = Array.from({ length: 40 }, (_, i) => `share-${i}`);
const cents = (v) => Math.round(v * 100);

test('every claim line splits the patient amount into deductible, coinsurance, copay and non-covered, exactly', () => {
  let lines = 0;
  for (const type of TYPES) for (const scenario of listScenarios(type)) for (const seed of SEEDS) {
    const g = generateData({ type, scenario, seed }).groundTruth;
    assert.equal(g.schemaVersion, '1.3');
    assert.ok(validate(g), `${type}/${scenario}/${seed}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
    g.claims.forEach((c, i) => c.lines.forEach((l, j) => {
      const where = `${type}/${scenario}/${seed} claims[${i}].lines[${j}]`;
      for (const k of ['toDeductible', 'coinsurance', 'copay', 'nonCovered']) assert.ok(typeof l[k] === 'number' && l[k] >= 0, `${where}: ${k} ${l[k]}`);
      assert.equal(cents(l.toDeductible) + cents(l.coinsurance) + cents(l.copay) + cents(l.nonCovered), cents(l.patientMayBeBilled), `${where}: parts do not add up`);
      if (type === 'msn' || type === 'itemized-bill') assert.equal(l.copay, 0, `${where}: Part B has no copay`);
      if (l.approved) assert.equal(l.nonCovered, 0, `${where}: an approved line has no non-covered part`);
      else assert.equal(cents(l.nonCovered), cents(l.patientMayBeBilled), `${where}: a denied line is non-covered`);
      lines++;
    }));
  }
  assert.ok(lines > 2000, `only ${lines} lines checked`);
});

test('the lines\' deductible adds up to the printed deductible met, less what was met before', () => {
  for (const type of TYPES) for (const scenario of listScenarios(type)) for (const seed of SEEDS) {
    const { data, groundTruth: g } = generateData({ type, scenario, seed });
    const lineDed = g.claims.reduce((s, c) => s + c.lines.reduce((t, l) => t + cents(l.toDeductible), 0), 0);
    const where = `${type}/${scenario}/${seed}`;
    assert.equal(typeof g.deductibleMetBefore, 'number', `${where}: deductibleMetBefore`);
    if (type === 'msn') {
      const printed = cents(data.deductible.met) - cents(g.deductibleMetBefore);
      // the notice prints the deductible met, capped at the annual deductible (a scenario that applies the deductible
      // again after it was met shows the extra on the lines, above the cap)
      assert.equal(Math.min(cents(data.deductible.annual), cents(g.deductibleMetBefore) + lineDed), cents(data.deductible.met), where);
    } else if (type === 'itemized-bill') assert.equal(lineDed, cents(data.insuranceSummary.deductibleApplied), where);
    else if (type === 'ppo-eob') assert.equal(lineDed, cents(data.financialSummary.deductibleMet) - cents(g.deductibleMetBefore), where);
    else { assert.equal(lineDed, 0, `${where}: the HMO plan has no deductible`); assert.equal(g.deductibleMetBefore, 0); }
  }
});

test('Medicare Advantage lines: coinsurance only on coinsurance services, a copay only on copay services, as the notes print', () => {
  for (const type of ['ppo-eob', 'hmo-eob']) for (const scenario of listScenarios(type)) for (const seed of SEEDS) {
    const { data, groundTruth: g } = generateData({ type, scenario, seed });
    g.claims.forEach((c, i) => c.lines.forEach((l, j) => {
      const note = data.claims[i].lineItems[j].notes[0]; const where = `${type}/${scenario}/${seed} line ${i}.${j} note ${note}`;
      if (note === 'K1') { assert.equal(l.coinsurance, 0, where); assert.equal(l.toDeductible, 0, where); }
      else if (note === 'C1') assert.equal(l.copay, 0, where);
      else assert.equal(cents(l.patientMayBeBilled), 0, where);
    }));
  }
});

test('the out-of-pocket maximum cuts coinsurance first, then the copay, and never the deductible', () => {
  // crafted lines: the generated documents never reach the plans' maximum, so the order is checked directly
  const plan = { deductible: 100, oopMax: 300, copay: { visit: 40 }, coinsurance: { procedure: 0.2 } };
  const claim = (lines) => [{ lines: lines.map((l) => ({ charged: l.allowed * 2, units: 1, ...l })) }];
  const parts = (l) => [l.deductibleApplied, l.coinsurance, l.copay, l.yourShare];
  // 150 used of a 300 maximum; a 500 procedure: deductible 100 + coinsurance 80 = 180, capped at 150: the cut of 30 comes off coinsurance
  let r = adjudicateMa(claim([{ allowed: 500, category: 'procedure' }]), plan, { oopUsedBefore: 150 });
  assert.deepEqual(parts(r.claims[0].lines[0]), [100, 50, 0, 150], 'deductible kept, coinsurance cut');
  r = adjudicateMa(claim([{ allowed: 500, category: 'procedure' }]), { ...plan, deductible: 0 }, { oopUsedBefore: 250 });
  assert.deepEqual(parts(r.claims[0].lines[0]), [0, 50, 0, 50], 'coinsurance cut to what is left');
  r = adjudicateMa(claim([{ allowed: 120, category: 'visit' }]), plan, { oopUsedBefore: 285.5 });
  assert.deepEqual(parts(r.claims[0].lines[0]), [0, 0, 14.5, 14.5], 'copay cut to what is left');
  r = adjudicateMa(claim([{ allowed: 333.33, category: 'procedure' }]), { ...plan, deductible: 0 }, { oopUsedBefore: 299.99 });
  assert.deepEqual(parts(r.claims[0].lines[0]), [0, 0.01, 0, 0.01], 'a cent left');
  // the cap would have to eat the deductible: refused
  assert.throws(() => adjudicateMa(claim([{ allowed: 500, category: 'procedure' }]), plan, { oopUsedBefore: 250 }), /cap cuts into deductible/);
});
