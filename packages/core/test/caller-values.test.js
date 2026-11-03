// Values a caller can pass that are not what an entry point takes (objects from JSON with a toString key, objects
// with no prototype, values whose conversion runs code): every library entry point refuses them with its own message,
// never with a type error and never by running the value's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { generateData, listScenarios, loadScenario, render, verifyFromSeed, planBatch, readManifest, variantIds, checkVariantOption, resolveVariant, degradationParams, renderDegraded, hardenHtml } from '../src/index.js';

const ran = () => { throw new Error('the value ran code'); };
const ODD = [JSON.parse('{"toString":"msn"}'), JSON.parse('{"toString":null}'), JSON.parse('{"valueOf":null,"toString":null}'), Object.create(null),
  { valueOf: ran, toString: ran }, { [Symbol.toPrimitive]: ran }, [], ['msn'], Symbol('msn'), () => 'msn'];
const not = (re) => (e) => !(e instanceof TypeError) && re.test(e.message) && !/ran code/.test(e.message);

test('every entry point refuses a value it does not take with its own message, without converting it', async () => {
  for (const v of ODD) {
    assert.throws(() => generateData({ type: v, scenario: 'baseline-clean' }), not(/^invalid type or scenario slug$/));
    assert.throws(() => generateData({ type: 'msn', scenario: v }), not(/^invalid type or scenario slug$/));
    assert.throws(() => generateData({ type: 'msn', scenario: 'baseline-clean', seed: v }), not(/^invalid seed$/));
    assert.throws(() => listScenarios(v), not(/^invalid type slug$/));
    assert.throws(() => loadScenario(v, 'baseline-clean'), not(/^invalid type or scenario slug$/));
    assert.throws(() => loadScenario('msn', v), not(/^invalid type or scenario slug$/));
    await assert.rejects(render({ type: v, scenario: 'baseline-clean' }), not(/^render: invalid type, scenario or seed$/));
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', seed: v }), not(/^render: invalid type, scenario or seed$/));
    assert.throws(() => verifyFromSeed({ type: v, scenario: 'baseline-clean', output: {} }), not(/^verify: invalid type, scenario or seed$/));
    assert.throws(() => planBatch({ types: [v] }), not(/^batch: unknown document type/));
    assert.throws(() => planBatch({ types: ['msn'], scenarios: [v] }), not(/^batch: invalid scenario name/));
    assert.throws(() => planBatch({ types: ['msn'], seedPrefix: v }), not(/^batch: the seed prefix must be/));
    assert.throws(() => resolveVariant('itemized-bill', 'seeded', v), not(/^invalid seed$/));
    for (const doc of [{ type: v, scenario: 'baseline-clean', seed: 's' }, { type: 'msn', scenario: v, seed: 's' }, { type: 'msn', scenario: 'baseline-clean', seed: v }])
      assert.throws(() => degradationParams('scan', doc), not(/^degrade: invalid type, scenario or seed$/));
    assert.throws(() => degradationParams(v, { type: 'msn', scenario: 'baseline-clean', seed: 's' }), not(/^degrade: no such preset; presets: scan, fax, photo, low-res$/));
    await assert.rejects(renderDegraded({ type: 'msn', scenario: 'baseline-clean', preset: v }), not(/^degrade: no such preset/));
    assert.equal(typeof hardenHtml(v), 'string');
    assert.deepEqual(variantIds(v), []);
    assert.throws(() => checkVariantOption(v, 'b01'), (e) => e.code === 'LAYOUT_VARIANT');
    // a total named by such a value is not one the document prints
    assert.throws(() => generateData({ type: 'msn', scenario: 'baseline-clean', overrides: { mutations: [{ op: 'break-claim-total', args: { claim: 0, field: v, by: 1 } }] } }), not(/^break-claim-total: the named total/));
    assert.throws(() => generateData({ type: 'ppo-eob', scenario: 'baseline-clean', overrides: { mutations: [{ op: 'ma-break-claim-total', args: { claim: 0, field: v, by: 1 } }] } }), not(/^ma-break-claim-total: the named total/));
  }
  // overrides that are not an object are refused too; a number seed is still a seed
  for (const overrides of [null, 7, 'x', []]) assert.throws(() => generateData({ type: 'msn', scenario: 'baseline-clean', overrides }), not(/^invalid overrides$/));
  assert.deepEqual(generateData({ type: 'msn', scenario: 'baseline-clean', seed: 7 }).groundTruth, generateData({ type: 'msn', scenario: 'baseline-clean', seed: '7' }).groundTruth);
});

test('a manifest line whose hashes or 835 name are JSON objects is refused with its message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-manifest-'));
  try {
    const line = { pdf: 'a.pdf', groundTruth: 'a.ground-truth.json', type: 'msn', scenario: 'baseline-clean', seed: 's', groundTruthSha256: 'a'.repeat(64) };
    for (const [patch, re] of [[{ groundTruthSha256: { toString: null } }, /has no groundTruthSha256/], [{ remittance: { toString: null }, remittanceSha256: 'a'.repeat(64) }, /names an 835 outside/],
      [{ remittance: 'a.835', remittanceSha256: { toString: null } }, /names an 835 outside/]]) {
      const p = path.join(dir, `m-${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(p, JSON.stringify({ ...line, ...patch }) + '\n');
      assert.throws(() => readManifest(p), not(re), JSON.stringify(patch));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
