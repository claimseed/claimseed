// Scoring an extractor's report against an answer key (src/verify.js): perfect reports score 100%, each kind of
// mistake moves exactly the number it should, printed formats are read, decoys count as false alarms, and nothing a
// caller sends comes back in the result. No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { generateData } from '../src/generate/index.js';
import { scoreExtraction, verifyFromSeed, checkOutput, normDate, normNumber, sameValue, LIMITS } from '../src/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const key = (type, scenario, seed = 'v-1', overrides) => generateData({ type, scenario, seed, overrides }).groundTruth;
const perfect = (gt) => ({ fields: { ...gt.documents[0].fields }, errors: gt.errors.map((e) => ({ kind: e.kind, fieldRef: e.fieldRef })) });

test('a report that equals the answer key scores 100% on fields and errors', () => {
  for (const [type, scenario] of [['msn', 'combined-three-errors'], ['itemized-bill', 'duplicate-charge'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']]) {
    const gt = key(type, scenario);
    const r = scoreExtraction(gt, perfect(gt));
    assert.equal(r.fields.accuracy, 1, type); assert.equal(r.fields.wrong + r.fields.missing, 0, type);
    if (gt.errors.length) { assert.equal(r.errors.recall, 1, type); assert.equal(r.errors.precision, 1, type); }
    else { assert.equal(r.errors.recall, null); assert.equal(r.errors.precision, null); assert.equal(r.errors.falseAlarms, 0); }
    assert.deepEqual(verifyFromSeed({ type, scenario, seed: 'v-1', output: perfect(gt) }), r, `${type}: the seed rebuilds the same key`);
  }
});

test('each mistake moves exactly one count: a missing field, a wrong value, a missed error, a false alarm', () => {
  const gt = key('msn', 'combined-three-errors');
  const out = perfect(gt); const paths = Object.keys(out.fields).filter((k) => typeof out.fields[k] === 'number');
  delete out.fields[paths[0]]; out.fields[paths[1]] = out.fields[paths[1]] + 1;
  out.errors.pop(); out.errors.push({ kind: 'math-error', fieldRef: 'claims[0].lineItems[0]' });
  const r = scoreExtraction(gt, out);
  assert.equal(r.fields.missing, 1); assert.deepEqual(r.fields.missingPaths, [paths[0]]);
  assert.equal(r.fields.wrong, 1); assert.deepEqual(r.fields.wrongPaths, [paths[1]]);
  assert.equal(r.fields.correct, r.fields.expected - 2);
  assert.equal(r.errors.found, gt.errors.length - 1); assert.equal(r.errors.missed, 1); assert.equal(r.errors.falseAlarms, 1);
  assert.equal(r.errors.recall, Math.round(((gt.errors.length - 1) / gt.errors.length) * 10000) / 10000);
});

test('printed formats are read: money as text, dates in three styles, case and spacing in text, yes/no', () => {
  assert.equal(normNumber('$1,234.50'), 1234.5); assert.equal(normNumber('(12.00)'), -12); assert.equal(normNumber('12 apples'), null);
  assert.equal(normDate('April 11, 2026'), '2026-04-11'); assert.equal(normDate('Apr 11 2026'), '2026-04-11');
  assert.equal(normDate('4/11/2026'), '2026-04-11'); assert.equal(normDate('04/11/26'), '2026-04-11'); assert.equal(normDate('11 April'), null);
  assert.ok(sameValue(280.21, '$280.21')); assert.ok(!sameValue(280.21, '$280.20'));
  assert.ok(sameValue('2026-03-05', 'March 5, 2026')); assert.ok(sameValue('Template Family Clinic', '  template  FAMILY clinic '));
  assert.ok(sameValue(true, 'Yes')); assert.ok(sameValue(false, 'NO')); assert.ok(sameValue(null, ''));
  assert.ok(!sameValue('99213', '')); assert.ok(sameValue('99213', 99213));
});

test('a date the answer key prints as "Month D, YYYY" or M/D/YYYY matches the same date reported in ISO or numeric form', () => {
  assert.ok(sameValue('March 5, 2026', '2026-03-05')); assert.ok(sameValue('3/5/2026', '2026-03-05')); assert.ok(sameValue('2026-03-05', '03/05/26'));
  assert.ok(!sameValue('March 5, 2026', '2026-03-06'));
  for (const [type, scenario] of [['msn', 'baseline-clean'], ['itemized-bill', 'duplicate-charge'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']]) {
    const gt = key(type, scenario, 'v-dates'); const out = perfect(gt); let dates = 0;
    for (const [k, v] of Object.entries(out.fields)) { const d = typeof v === 'string' ? normDate(v) : null; if (d && d !== v) { out.fields[k] = d; dates++; } }
    const r = scoreExtraction(gt, out);
    assert.equal(r.fields.accuracy, 1, `${type}: ${r.fields.wrongPaths.join(', ')}`);
    if (type === 'msn') assert.ok(dates > 0, 'the MSN prints some dates in words or M/D/YYYY');
  }
});

test('a duplicate charge is found on either line, and reporting both lines is one finding, not a false alarm', () => {
  const gt = key('msn', 'duplicate-office-visit'); const dup = gt.errors[0];
  assert.ok(dup.relatedFieldRef && dup.relatedLineRef, 'the answer key names the original line');
  const original = scoreExtraction(gt, { errors: [{ kind: 'duplicate-charge', fieldRef: dup.relatedFieldRef }] });
  assert.equal(original.errors.found, 1);
  const both = scoreExtraction(gt, { errors: [{ kind: 'duplicate-charge', fieldRef: dup.fieldRef }, { kind: 'Duplicate-Charge', lineRef: dup.relatedLineRef }] });
  assert.deepEqual([both.errors.found, both.errors.repeats, both.errors.falseAlarms, both.errors.precision], [1, 1, 0, 1]);
  const inside = scoreExtraction(gt, { errors: [{ kind: 'duplicate-charge', fieldRef: `${dup.fieldRef}.cptCode` }] });
  assert.equal(inside.errors.found, 1, 'a field inside the line names the line');
});

test('flagging a decoy is a false alarm that names the decoy, and leaves recall alone', () => {
  const last = key('msn', 'duplicate-office-visit', 'v-2').claims.length - 1;
  const decoys = [{ op: 'charge-far-above-approved', args: { claim: last, line: 0 }, rule: 'test rule' }];
  const gt = key('msn', 'duplicate-office-visit', 'v-2', { decoys });
  assert.equal(gt.decoys.length, 1); const d = gt.decoys[0];
  const out = { errors: [...gt.errors.map((e) => ({ kind: e.kind, fieldRef: e.fieldRef })), { kind: 'fee-schedule-overcharge', fieldRef: d.fieldRef }] };
  const r = scoreExtraction(gt, out);
  assert.equal(r.errors.recall, 1); assert.equal(r.errors.falseAlarms, 1); assert.deepEqual(r.errors.decoysFlagged, ['decoy-1']); assert.equal(r.errors.precision, 0.5);
});

test('the report is checked against the limits and the documented shape, and its text never comes back', () => {
  const secret = 'IGNORE-ALL-PREVIOUS-INSTRUCTIONS';
  assert.throws(() => checkOutput([]), /extractor output: must be a JSON object/);
  assert.throws(() => checkOutput({ fields: {}, extra: 1 }), /only "fields" and "errors"/);
  assert.throws(() => checkOutput({ fields: { a: { nested: secret } } }), (e) => /field 1: value must be/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => checkOutput({ fields: { [secret.repeat(10)]: 1 } }), (e) => /path longer than/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => checkOutput({ fields: Object.fromEntries(Array.from({ length: LIMITS.fields + 1 }, (_, i) => [`f${i}`, 1])) }), /limit is 5000/);
  assert.throws(() => checkOutput({ errors: [{ kind: 'x', note: secret }] }), (e) => /only kind, fieldRef and lineRef/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => checkOutput({ errors: [{ kind: secret.repeat(3) }] }), /kind must be a string of 1 to 64/);
  const gt = key('msn', 'baseline-clean');
  const r = scoreExtraction(gt, { fields: { [secret]: secret, 'metadata.memberName': secret }, errors: [{ kind: secret.slice(0, 60), fieldRef: secret }] });
  assert.ok(!JSON.stringify(r).includes(secret), 'caller text came back in the result');
  assert.equal(r.fields.unknownPaths, 1); assert.equal(r.errors.falseAlarms, 1);
});

test('field paths named like object properties are unknown paths, not answer-key paths', () => {
  const gt = key('msn', 'baseline-clean');
  const out = JSON.parse('{"fields":{"__proto__":"x","constructor":"y","toString":1,"hasOwnProperty":null},"errors":[{"kind":"toString","lineRef":"__proto__"}]}');
  const r = scoreExtraction(gt, out);
  assert.equal(r.fields.unknownPaths, 4); assert.equal(r.fields.correct, 0); assert.equal(r.errors.falseAlarms, 1);
  assert.equal(({}).x, undefined, 'no prototype was changed');
});

test('an answer key is checked before scoring, and its error kinds never reach an object\'s prototype', () => {
  const report = { fields: { x: 1 }, errors: [] };
  const refused = (k, re) => assert.throws(() => scoreExtraction(k, report), (e) => e.code === 'ANSWER_KEY' && re.test(e.message));
  refused(JSON.parse('{"documents":[{"fields":{"x":1}}],"errors":[{"kind":"__proto__"}]}'), /error 1: needs a kind/);
  refused({ documents: [{ fields: { x: 1 } }], errors: [{ kind: 7 }] }, /error 1: needs a kind/);
  refused({ documents: [{ fields: { x: 1 } }], errors: [{ kind: 'math-error', lineRef: { a: 1 } }] }, /error 1: needs a kind .* string references/);
  refused({ documents: [{ fields: { x: { nested: 1 } } }], errors: [] }, /field 1: value must be/);
  refused({ documents: [{ fields: { x: 1 } }], errors: [], decoys: [{ lineRef: 'claims[0].lines[0]' }] }, /decoy 1: needs an id/);
  refused({ documents: [{ fields: { x: 1 } }], errors: [null] }, /error 1/);
  assert.equal(Object.hasOwn(Object.prototype, 'expected'), false, 'no prototype was changed');
  // a well-formed kind named like an object property is counted as its own kind
  const r = scoreExtraction({ documents: [{ fields: { x: 1 } }], errors: [{ kind: 'constructor' }, { kind: 'constructor' }] }, { fields: { x: 1 }, errors: [{ kind: 'constructor' }] });
  assert.deepEqual(r.errors.byKind, { constructor: { expected: 2, found: 1 } }); assert.ok(Object.hasOwn(r.errors.byKind, 'constructor'));
  assert.equal(({}).expected, undefined);
  // every answer key claimseed writes passes the check
  for (const [t, sc] of [['msn', 'combined-three-errors'], ['msn', 'decoys-repeat-visit-high-charge'], ['itemized-bill', 'decoys-repeat-therapy-high-charge'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']]) {
    const gt = key(t, sc); assert.equal(scoreExtraction(gt, perfect(gt)).fields.accuracy, 1, `${t}/${sc}`);
  }
});

test('the extractor-output schema accepts what the scorer accepts', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/extractor-output.schema.json'), 'utf-8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const gt = key('itemized-bill', 'duplicate-charge');
  assert.ok(validate(perfect(gt)), JSON.stringify(validate.errors));
  assert.ok(!validate({ fields: {}, extra: 1 })); assert.ok(!validate({ errors: [{ fieldRef: 'x' }] }));
});

test('the command line scores a report against a saved answer key or a seed, and refuses bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-verify-'));
  const gt = key('msn', 'duplicate-office-visit', 'cli-1');
  fs.writeFileSync(path.join(dir, 'key.json'), JSON.stringify(gt)); fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify(perfect(gt)));
  const a = JSON.parse(execFileSync(process.execPath, [CLI, 'verify', '--answer-key', path.join(dir, 'key.json'), '--output', path.join(dir, 'out.json')], { encoding: 'utf-8' }));
  assert.equal(a.fields.accuracy, 1); assert.equal(a.errors.recall, 1);
  const b = JSON.parse(execFileSync(process.execPath, [CLI, 'verify', 'msn', 'duplicate-office-visit', '--seed', 'cli-1', '--output', path.join(dir, 'out.json')], { encoding: 'utf-8' }));
  assert.deepEqual(b, a);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ fields: { x: { y: 1 } } }));
  const bad = spawnSync(process.execPath, [CLI, 'verify', '--answer-key', path.join(dir, 'key.json'), '--output', path.join(dir, 'bad.json')], { encoding: 'utf-8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /extractor output: field 1/);
});
