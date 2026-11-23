// Values a caller can pass that are not what an entry point takes (objects from JSON with a toString key, objects
// with no prototype, values whose conversion runs code): every library entry point refuses them with its own message,
// never with a type error and never by running the value's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { generateData, listScenarios, loadScenario, render, verifyFromSeed, planBatch, readManifest, variantIds, checkVariantOption, resolveVariant, degradationParams, renderDegraded, hardenHtml, renderBatch, keysApart, buildRemittance, BLIND_STRINGS } from '../src/index.js';
import { SET_STRINGS } from '../src/set.js';

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
      [{ remittance: 'a.835', remittanceSha256: { toString: null } }, /names an 835 outside/],
      ...[{ toString: null }, { fictional: 'a' }, ['scan'], 7, true, '', 'blur', 'FICTIONAL-MARKER', '__proto__', 'toString', 'Scan'].map((d) => [{ degradation: d }, /^manifest line 1 has a degradation that is neither null nor one of the presets: scan, fax, photo, low-res$/])]) {
      const p = path.join(dir, `m-${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(p, JSON.stringify({ ...line, ...patch }) + '\n');
      assert.throws(() => readManifest(p), not(re), JSON.stringify(patch));
    }
    // a clean line names no degradation (or null); a degraded one names its preset
    for (const patch of [{}, { degradation: null }, { degradation: 'scan' }, { degradation: 'low-res' }]) {
      const p = path.join(dir, `m-${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(p, JSON.stringify({ ...line, ...patch }) + '\n');
      assert.equal(readManifest(p).length, 1, JSON.stringify(patch));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// a blind render's layout variant, a batch's preset and every folder option are refused with fixed messages before
// any of them is converted, hashed or used to make a folder, and a refused call leaves no folder behind
test('blind rendering, batch presets and folder options refuse such values with fixed messages and make no folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-caller-'));
  const M = BLIND_STRINGS.messages; const msg = (k, who) => M[k].replace('{who}', who);
  const exact = (m) => (e) => !(e instanceof TypeError) && e.message === m && !/ran code/.test(e.message);
  const salt = '0123456789abcdef0123456789abcdef';
  const base = { type: 'ppo-eob', scenario: 'baseline-clean', seed: 'caller-values', blind: { salt } };
  const docs = path.join(dir, 'docs'); const keys = path.join(dir, 'keys');
  const PRESET = 'batch: no such preset; presets: scan, fax, photo, low-res';
  try {
    const folders = [...ODD, '', 'a\u0000b', 'x'.repeat(4097), 7, true];
    for (const v of ODD) {
      await assert.rejects(render({ ...base, layoutVariant: v }), (e) => e.code === 'LAYOUT_VARIANT' && !/ran code/.test(e.message));
      await assert.rejects(render({ ...base, outDir: docs, keysDir: keys, layoutVariant: v }), (e) => e.code === 'LAYOUT_VARIANT');
      await assert.rejects(renderDegraded({ ...base, preset: 'scan', outDir: docs, keysDir: keys, layoutVariant: v, browser: {} }), (e) => e.code === 'LAYOUT_VARIANT');
      await assert.rejects(renderBatch({ types: ['msn'], degrade: v, outDir: docs }), exact(PRESET));
      assert.throws(() => buildRemittance({ type: v, scenario: 'baseline-clean', seed: 's', generated: {} }), exact('remittance: an 835 is written for msn, ppo-eob, hmo-eob, commercial-eob only'));
    }
    for (const v of folders) {
      await assert.rejects(render({ ...base, outDir: v, keysDir: keys }), exact(msg('outDirText', 'render')));
      await assert.rejects(render({ ...base, outDir: docs, keysDir: v }), exact(msg('keysDirText', 'render')));
      await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', outDir: v }), exact(msg('outDirText', 'render')));
      await assert.rejects(renderDegraded({ ...base, preset: 'scan', outDir: v, keysDir: keys, browser: {} }), exact(msg('outDirText', 'degrade')));
      await assert.rejects(renderDegraded({ ...base, preset: 'scan', outDir: docs, keysDir: v, browser: {} }), exact(msg('keysDirText', 'degrade')));
      await assert.rejects(renderBatch({ types: ['msn'], outDir: v }), exact(msg('outDirText', 'batch')));
      await assert.rejects(renderBatch({ types: ['msn'], outDir: docs, blind: true, keysDir: v }), exact(msg('keysDirText', 'batch')));
      await assert.rejects(renderBatch({ set: 'standard', outDir: v, blind: true, keysDir: keys }), exact(msg('outDirText', 'batch')));
      assert.throws(() => keysApart(v, keys, 'render'), exact(msg('outDirText', 'render')));
      assert.throws(() => keysApart(docs, v, 'render'), exact(msg('keysDirText', 'render')));
    }
    // a preset given as text that is not one is not repeated
    await assert.rejects(renderBatch({ types: ['msn'], degrade: 'FICTIONAL-MARKER', outDir: docs }), exact(PRESET));
    // refusals that come from the generator or the blind option, with both folders named, make neither
    await assert.rejects(render({ ...base, scenario: 'fictional-not-found', outDir: docs, keysDir: keys, browser: {} }), exact('scenario not found'));
    await assert.rejects(renderDegraded({ ...base, scenario: 'fictional-not-found', preset: 'low-res', outDir: docs, keysDir: keys, browser: {} }), exact('scenario not found'));
    await assert.rejects(renderDegraded({ ...base, preset: 'low-res', blind: JSON.parse('{"toString":null}'), outDir: docs, keysDir: keys, browser: {} }), exact(BLIND_STRINGS.messages.blindOption));
    await assert.rejects(renderDegraded({ ...base, type: 'itemized-bill', also: '835', preset: 'scan', outDir: docs, keysDir: keys, browser: {} }), exact('render: an 835 is written for msn, ppo-eob, hmo-eob, commercial-eob only'));
    await assert.rejects(renderBatch({ types: ['msn'], degrade: 'blur', outDir: docs, blind: true, keysDir: keys }), exact(PRESET));
    assert.deepEqual(fs.readdirSync(dir), [], 'a refused call made a folder');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
