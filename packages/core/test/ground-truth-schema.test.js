// Every scenario's ground truth validates against schemas/ground-truth.schema.json, from `generate` (pages and
// sha256 null) and after a render; every error's fieldRef points at keys that exist in fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateData, listScenarios } from '../src/generate/index.js';
import { RENDERERS } from '../src/layouts.js';
import { findChrome } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
const validate = ajv.compile(schema);
const SCENARIOS = fs.readdirSync(path.join(here, '../scenarios'));

test('generate output validates for every scenario and every fieldRef resolves', () => {
  for (const type of SCENARIOS) for (const scenario of listScenarios(type)) for (const seed of ['gt-1', 'gt-2']) {
    const { groundTruth } = generateData({ type, scenario, seed });
    assert.ok(validate(groundTruth), `${type}/${scenario} ${seed}: ${JSON.stringify(validate.errors)}`);
    const keys = Object.keys(groundTruth.documents[0].fields);
    const matches = (ref) => keys.some((k) => k === ref || k.startsWith(ref + '.'));
    for (const e of groundTruth.errors) {
      // a document-level entry (a section the document leaves out) has no location; only that kind may lack one
      if (e.fieldRef === null && e.lineRef === null) { assert.equal(e.kind, 'missing-required-section', `${type}/${scenario}: ${e.kind} has no location`); continue; }
      assert.ok(e.fieldRef, `${type}/${scenario}: error ${e.kind} has no fieldRef`);
      assert.ok(matches(e.fieldRef), `${type}/${scenario}: fieldRef ${e.fieldRef} matches no field`);
      if (e.relatedFieldRef) assert.ok(matches(e.relatedFieldRef), `${type}/${scenario}: relatedFieldRef ${e.relatedFieldRef} matches no field`);
      // an accumulator row is printed but is no claim line, so it has no lineRef
      if (e.lineRef === null) assert.match(e.fieldRef, /^accumulators\[\d+\]$/, `${type}/${scenario}: ${e.kind} has no lineRef`);
      else assert.ok(resolve(groundTruth.claims, e.lineRef) !== undefined, `${type}/${scenario}: lineRef ${e.lineRef} does not resolve in claims`);
    }
    for (const d of groundTruth.decoys || []) assert.ok(matches(d.fieldRef) && resolve(groundTruth.claims, d.lineRef) !== undefined, `${type}/${scenario}: decoy ${d.kind} location`);
    for (const k of ['carrier', 'scenario', 'hasDenial']) assert.ok(!(k in groundTruth.documents[0].fields), `internal key ${k} in fields`);
  }
});
function resolve(obj, ref) { return ref.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), { claims: obj }); }

test('rendered ground truth validates with pages and sha256 filled', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gt-'));
  for (const type of Object.keys(RENDERERS)) {
    const scenario = listScenarios(type)[0];
    execFileSync(process.execPath, [path.join(here, '../src/cli.js'), 'render', type, scenario, '--seed', 'gt-r', '--out', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
    const gt = JSON.parse(fs.readFileSync(path.join(dir, `${type}_${scenario}_gt-r.ground-truth.json`), 'utf-8'));
    assert.ok(validate(gt), `${type}: ${JSON.stringify(validate.errors)}`);
    assert.equal(typeof gt.documents[0].pages, 'number'); assert.match(gt.documents[0].sha256, /^[a-f0-9]{64}$/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// Version 1.7 (the commercial EOB): the plan object and the commercial claim and line facts are required in 1.7 and
// refused in every earlier version, so a key cannot carry half of one version and half of another.
test('schema 1.7: plan, payee and the line facts required in 1.7 and refused before it', () => {
  const ok = (k) => validate(k);
  const com = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'v17' }).groundTruth;
  assert.ok(ok(com), JSON.stringify(validate.errors));
  const drop = (k, f) => { const c = structuredClone(k); f(c); return c; };
  assert.ok(!ok(drop(com, (c) => { delete c.plan; })), 'a 1.7 key without plan');
  for (const f of ['payee', 'facility', 'emergency']) assert.ok(!ok(drop(com, (c) => { delete c.claims[0][f]; })), `a 1.7 claim without ${f}`);
  for (const f of ['network', 'protected', 'recognized', 'qpa', 'balanceBillable', 'preventive', 'denial']) assert.ok(!ok(drop(com, (c) => { delete c.claims[0].lines[0][f]; })), `a 1.7 line without ${f}`);
  assert.ok(!ok(drop(com, (c) => { c.schemaVersion = '1.6'; })), 'commercial facts under 1.6');
  const msn = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'v17' }).groundTruth;
  assert.ok(ok(msn));
  assert.ok(!ok(drop(msn, (c) => { c.plan = com.plan; })), 'plan before 1.7');
  assert.ok(!ok(drop(msn, (c) => { c.claims[0].payee = com.claims[0].payee; })), 'payee before 1.7');
  assert.ok(!ok(drop(msn, (c) => { c.claims[0].lines[0].protected = false; })), 'a line fact before 1.7');
});
