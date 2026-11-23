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
import { scoreExtraction, summarizeSet, verifyFromSeed, checkOutput, normDate, normNumber, sameValue, LIMITS } from '../src/verify.js';

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

test('the example report of the README and the samples scores as they say', () => {
  const r = verifyFromSeed({ type: 'msn', scenario: 'combined-three-errors', seed: 'example', output: { errors: [{ kind: 'duplicate-charge', lineRef: 'claims[0].lines[1]' }] } }).errors;
  assert.deepEqual([r.found, r.expected, r.recall, r.precision, r.falseAlarms], [1, 3, 0.3333, 1, 0]);
  assert.deepEqual(r.missedRefs.map((x) => x.split('@')[0]).sort(), ['cost-sharing-error', 'math-error']);
});

// excludingInfo: the figures without the entries at severity info, whose precision is found over the flags it counts
const flag = (e) => ({ kind: e.kind, ...(e.lineRef ? { lineRef: e.lineRef } : { fieldRef: e.fieldRef }) });
const ex = (gt, errors) => { const x = scoreExtraction(gt, { errors }).errors; assert.equal(x.excludingInfo.precision, x.excludingInfo.counted ? Math.round(x.excludingInfo.found / x.excludingInfo.counted * 10000) / 10000 : null); return x; };

test('excludingInfo leaves out the info entries and the flags that found them, under each report shape', () => {
  const gt = key('commercial-eob', 'combined-three-errors', 'example', { insurer: 'a' });
  const info = gt.errors.filter((e) => e.severity === 'info'); const plain = gt.errors.filter((e) => e.severity !== 'info');
  assert.deepEqual([info.length, plain.length], [1, 3]);
  const all = ex(gt, gt.errors.map(flag));
  assert.deepEqual([all.recall, all.precision], [1, 1]);
  assert.deepEqual(all.excludingInfo, { expected: 3, counted: 3, found: 3, missed: 0, recall: 1, precision: 1 });
  const onlyInfo = ex(gt, info.map(flag));
  assert.deepEqual([onlyInfo.found, onlyInfo.recall], [1, 0.25]);
  assert.deepEqual(onlyInfo.excludingInfo, { expected: 3, counted: 0, found: 0, missed: 3, recall: 0, precision: null });
  const onlyPlain = ex(gt, plain.map(flag));
  assert.deepEqual([onlyPlain.recall, onlyPlain.precision], [0.75, 1]);
  assert.deepEqual(onlyPlain.excludingInfo, { expected: 3, counted: 3, found: 3, missed: 0, recall: 1, precision: 1 });
  assert.deepEqual(ex(gt, []).excludingInfo, { expected: 3, counted: 0, found: 0, missed: 3, recall: 0, precision: null });
  // the info entry flagged twice (a repeat) and one flag that finds nothing: only the false alarm is counted
  const mixed = ex(gt, [flag(info[0]), flag(info[0]), { kind: 'math-error', lineRef: 'claims[0].lines[0]' }]);
  assert.deepEqual([mixed.repeats, mixed.falseAlarms], [1, 1]);
  assert.deepEqual(mixed.excludingInfo, { expected: 3, counted: 1, found: 0, missed: 3, recall: 0, precision: 0 });
});

test('excludingInfo on a correct denial that sits on a decoy\'s line: its own kind finds it, another kind is a false alarm', () => {
  const gt = key('commercial-eob', 'decoys-only', 'example', { insurer: 'a' });
  assert.equal(gt.errors.length, 2); assert.ok(gt.errors.every((e) => e.severity === 'info' && e.kind === 'coverage-denial'));
  const on = gt.errors[0].lineRef; const d = gt.decoys.find((x) => x.lineRef === on);
  assert.ok(d, 'the denial shares its line with a decoy');
  const found = ex(gt, [{ kind: 'coverage-denial', lineRef: on }]);
  assert.deepEqual([found.found, found.falseAlarms, found.decoysFlagged.length], [1, 0, 0]);
  assert.deepEqual(found.excludingInfo, { expected: 0, counted: 0, found: 0, missed: 0, recall: null, precision: null });
  const other = ex(gt, [{ kind: 'surprise-balance-bill', lineRef: on }]);
  assert.deepEqual([other.found, other.falseAlarms, other.decoysFlagged], [0, 1, [d.id]]);
  assert.deepEqual(other.excludingInfo, { expected: 0, counted: 1, found: 0, missed: 0, recall: null, precision: 0 });
  const none = ex(gt, []);
  assert.deepEqual([none.expected, none.recall], [2, 0]);
  assert.deepEqual(none.excludingInfo, { expected: 0, counted: 0, found: 0, missed: 0, recall: null, precision: null });
});

test('excludingInfo: a key without info entries gives the headline figures; an entry without a severity is not info; key order decides between two unplaced entries of one kind', () => {
  const gt = key('msn', 'combined-three-errors');
  for (const errors of [gt.errors.map(flag), [flag(gt.errors[0]), flag(gt.errors[0]), { kind: 'math-error', lineRef: 'claims[0].lines[0]' }], []]) {
    const r = ex(gt, errors);
    assert.deepEqual([r.excludingInfo.expected, r.excludingInfo.found, r.excludingInfo.recall, r.excludingInfo.precision, r.excludingInfo.counted], [r.expected, r.found, r.recall, r.precision, r.flagged - r.repeats]);
  }
  const ce = structuredClone(key('commercial-eob', 'combined-three-errors', 'example', { insurer: 'a' }));
  delete ce.errors.find((e) => e.severity === 'info').severity;
  assert.equal(ex(ce, []).excludingInfo.expected, 4);
  const two = structuredClone(gt);
  const unplaced = { ...gt.errors[0], kind: 'missing-required-section', fieldRef: null, lineRef: null, relatedFieldRef: null, relatedLineRef: null };
  two.errors = [{ ...unplaced, severity: 'info' }, { ...unplaced, severity: 'high' }];
  const r = ex(two, [{ kind: 'missing-required-section' }]);
  assert.deepEqual([r.found, r.excludingInfo.found, r.excludingInfo.counted], [1, 0, 0]);
});

test('a set\'s excludingInfo is summed from its documents, in the headline and in each breakdown', () => {
  const ce = key('commercial-eob', 'combined-three-errors', 'example', { insurer: 'a' });
  const msn = key('msn', 'combined-three-errors');
  const info = ce.errors.filter((e) => e.severity === 'info');
  const rows = [{ document: 'a.pdf', type: 'commercial-eob', degradation: null, key: ce, output: { errors: ce.errors.map(flag) } },
    { document: 'b.pdf', type: 'commercial-eob', degradation: 'fax', key: ce, output: { errors: info.map(flag) } },
    { document: 'c.pdf', type: 'msn', degradation: null, key: msn, output: { errors: [flag(msn.errors[0])] } }];
  const s = summarizeSet(rows);
  assert.deepEqual(s.errors.excludingInfo, { expected: 9, counted: 4, found: 4, missed: 5, recall: 0.4444, precision: 1 });
  assert.deepEqual(s.byType['commercial-eob'].errors.excludingInfo, { expected: 6, counted: 3, found: 3, missed: 3, recall: 0.5, precision: 1 });
  assert.deepEqual(s.byDegradation.fax.errors.excludingInfo, { expected: 3, counted: 0, found: 0, missed: 3, recall: 0, precision: null });
  assert.deepEqual(s.scoredOnly.errors.excludingInfo, s.errors.excludingInfo);
  assert.deepEqual([s.errors.found, s.errors.expected], [6, 11]);
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

test('the command line scores a commercial EOB from its type, scenario, seed and insurer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-verify-ins-'));
  const gt = key('commercial-eob', 'baseline-clean', 'v-ins', { insurer: 'b' });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(perfect(gt)));
  const run = (...a) => spawnSync(process.execPath, [CLI, 'verify', 'commercial-eob', 'baseline-clean', '--seed', 'v-ins', '--output', path.join(dir, 'report.json'), ...a], { encoding: 'utf-8' });
  const b = run('--insurer', 'b'); assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout).fields.accuracy, 1, 'the key for insurer b');
  const a = run('--insurer', 'a'); assert.equal(a.status, 0, a.stderr);
  assert.ok(JSON.parse(a.stdout).fields.accuracy < 1, 'the key for insurer a is another key');
  const x = run('--insurer', 'zz-probe'); assert.equal(x.status, 1); assert.ok(!x.stderr.includes('zz-probe') && /insurer/.test(x.stderr));
  fs.rmSync(dir, { recursive: true, force: true });
});
