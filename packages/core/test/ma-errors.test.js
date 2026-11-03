// Error injection and decoys on the Medicare Advantage EOBs (src/generate/ma-mutations.js). For every operation on
// both layouts: what the answer key records is what the document prints, the operation breaks exactly the invariants
// its spec names, and every refusal stops it. Rendered checks read the PDF's text back for a few seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateData, listScenarios } from '../src/generate/index.js';
import { OPS as PART_B_OPS } from '../src/generate/mutations.js';
import { PLANS } from '../src/generate/ma-eob.js';
import { RENDERERS } from '../src/layouts.js';
import { variantIds } from '../src/variants.js';
import { launchBrowser, findChrome } from '../src/browser.js';
import { buildRemittance } from '../src/x12/remittance.js';
import { check835, checkSpecimen835 } from '../src/x12/check835.js';
import { scoreExtraction } from '../src/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const TYPES = ['ppo-eob', 'hmo-eob'];
const SEEDS = Array.from({ length: 20 }, (_, i) => `mae-${i + 1}`);
const SHARE = { 'ppo-eob': 'yourShare', 'hmo-eob': 'maxYouMayBeBilled' };
const CODE = { 'ppo-eob': 'cptCode', 'hmo-eob': 'billingCode' };
const KEYS = { 'ppo-eob': ['providerBilled', 'planApproved', 'planShare', 'yourShare'], 'hmo-eob': ['providersCharged', 'planApproved', 'amountPlanPaid', 'maxYouMayBeBilled'] };
const near = (a, b) => Math.abs(a - b) < 0.005;
const r2 = (x) => Math.round(x * 100) / 100;
const shortDate = { 'ppo-eob': (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; },
  'hmo-eob': (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; } };
const gen = (type, seed, overrides) => generateData({ type, scenario: 'baseline-clean', seed, overrides });

// The invariants an MA document holds (spec I1-I10); returns the names of those that fail.
function broken(type, data, gt) {
  const [billed, approved, paid, member] = KEYS[type]; const out = new Set();
  const fsum = data.financialSummary;
  for (const c of data.claims) for (const l of c.lineItems) if (!near(l[approved], l[paid] + l[member])) out.add('I1');
  for (const c of data.claims) for (const k of KEYS[type]) if (!near(c.claimTotal[k], c.lineItems.reduce((s, l) => s + l[k], 0))) out.add('I2');
  for (const k of KEYS[type]) if (!near(fsum.monthly[k], data.claims.reduce((s, c) => s + c.claimTotal[k], 0))) out.add('I3');
  if (!near(fsum.ytd[member], fsum.oopUsed)) out.add('I4');
  if (fsum.oopUsed > fsum.oopMax + 0.005) out.add('I5');
  if (type === 'ppo-eob' && (fsum.deductibleMet > fsum.deductible + 0.005 || fsum.deductibleFullyMet !== (fsum.deductibleMet >= fsum.deductible))) out.add('I6');
  for (const c of data.claims) for (const l of c.lineItems) {
    const n = l.notes[0];
    if ((n === 'P1' || n === 'L1') && l[member] > 0) out.add('I7');
    if (n === 'C1' && type === 'ppo-eob' && gt.deductibleMetBefore >= fsum.deductible && l[member] > r2(l[approved] * 0.2) + 0.01) out.add('I7');
    if (n === 'K1' && fsum.oopUsed >= fsum.oopMax && (fsum.ytd[member] - fsum.monthly[member]) >= fsum.oopMax - 0.005 && l[member] > 0) out.add('I7');
  }
  const stmt = data.metadata.statementDate || data.metadata.dateOfNotice; const stmtIso = new Date(stmt + ' 00:00:00 UTC').toISOString().slice(0, 10);
  for (const c of data.claims) for (const l of c.lineItems) { const [m, d, y] = l.dateOfService.split('/'); const iso = `20${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; if (iso > stmtIso) out.add('I8'); }
  for (const blk of [fsum.monthly, fsum.ytd]) if (!near(blk[approved], blk[paid] + blk[member]) || blk[billed] + 0.005 < blk[approved]) out.add('I9');
  for (const k of KEYS[type]) if (fsum.ytd[k] + 0.005 < fsum.monthly[k]) out.add('I10');
  return [...out].sort();
}
const field = (gt, ref) => gt.documents[0].fields[ref];
// the payee and patient names an 835 may carry, as remittance.test.js passes them to the specimen checks
const CLEAN_NAME = (s) => String(s).toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
const names = (g) => { const d = g.documents[0]; return [...d.entities.providers.map((p) => CLEAN_NAME(p.name)), ...CLEAN_NAME(d.entities.patient.name).split(' ')]; };
const findingsOf = (text) => check835(text).findings.map((f) => f.ref);

// One case per operation and layout: the scenario overrides, and what the test reads back.
const P = (t) => PLANS[t];
const CASES = {
  'ma-duplicate-line': (t) => ({ ov: { claimCount: 2, claimShapes: [t === 'ppo-eob' ? 'OPH' : 'PT', 'LAB'], mutations: [{ op: 'ma-duplicate-line', args: { claim: 0, line: 0 } }] }, breaks: [] }),
  'ma-break-claim-total': (t) => ({ ov: { claimCount: 2, mutations: [{ op: 'ma-break-claim-total', args: { claim: 1, field: 'patientMayBeBilled', by: 10 } }] }, breaks: ['I2', 'I3'] }),
  'ma-cost-share-on-exempt-line': (t) => ({ ov: { claimCount: 2, claimShapes: ['FP', 'LAB'], mutations: [{ op: 'ma-cost-share-on-exempt-line', args: { claim: 0, line: 0 } }] }, breaks: ['I7'] }),
  'ma-reapply-deductible': (t) => (t === 'hmo-eob' ? null : { ov: { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 400, maDeductibleMetBefore: P(t).deductible, mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 1 } }] }, breaks: ['I7'] }),
  'ma-share-after-oop-max': (t) => ({ ov: { claimCount: 1, claimShapes: ['OPH'], maPriorOop: P(t).oopMax, ...(t === 'ppo-eob' ? { maDeductibleMetBefore: P(t).deductible } : {}), mutations: [{ op: 'ma-share-after-oop-max', args: { claim: 0, line: 0 } }] }, breaks: ['I4', 'I7'] }),
  'ma-shift-date': (t) => ({ ov: { claimCount: 2, mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 3 } }] }, breaks: ['I8'] }),
  'ma-deny-line': (t) => ({ ov: { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-deny-line', args: { claim: 0, line: 0, note: { text: 'Test denial note.', rule: 'test rule' } } }] }, breaks: [] }),
};

for (const [op, mk] of Object.entries(CASES)) for (const type of TYPES) {
  const c = mk(type); if (!c) continue;
  test(`${op} on ${type}: recorded is printed, and only the spec's invariants break (seeds 1-20)`, () => {
    for (const seed of SEEDS) {
      const { data, groundTruth: gt } = gen(type, seed, c.ov);
      assert.equal(gt.errors.length, 1, `${seed}: one error`); const e = gt.errors[0];
      assert.ok(validate(gt), `${seed}: ${JSON.stringify(validate.errors)}`);
      assert.ok(e.fieldRef, `${seed}: a fieldRef`);
      if (op === 'ma-break-claim-total') assert.equal(field(gt, e.fieldRef), e.actual, `${seed}: the printed total is the recorded actual`);
      else if (op === 'ma-duplicate-line') {
        assert.equal(field(gt, `${e.fieldRef}.${CODE[type]}`), e.actual); assert.equal(field(gt, `${e.relatedFieldRef}.${CODE[type]}`), e.actual);
        assert.equal(field(gt, `${e.fieldRef}.dateOfService`), field(gt, `${e.relatedFieldRef}.dateOfService`)); assert.ok(e.delta > 0, `${seed}: the copy charges the member`);
      } else if (op === 'ma-shift-date') assert.equal(field(gt, `${e.fieldRef}.dateOfService`), shortDate[type](e.actual));
      else if (op === 'ma-deny-line') { assert.equal(field(gt, `${e.fieldRef}.planApproved`), 0); assert.equal(field(gt, `${e.fieldRef}.${SHARE[type]}`), 0); assert.equal(data.hasDenial, true); }
      else { assert.equal(field(gt, `${e.fieldRef}.${SHARE[type]}`), e.actual, `${seed}: the printed share is the recorded actual`); assert.ok(e.actual > 0); }
      assert.deepEqual(broken(type, data, gt), c.breaks, `${seed}: invariants broken`);
      // the model's claims block foots per line, and the 835 is a valid specimen with findings only for math and duplicates
      const r = buildRemittance({ type, scenario: 'baseline-clean', seed, generated: { data, groundTruth: gt } });
      assert.deepEqual(checkSpecimen835(r.text, { names: names(gt) }), [], `${seed}: specimen checks`);
      const findings = findingsOf(r.text).sort();
      const want = gt.errors.map((x, i) => (['math-error', 'duplicate-charge'].includes(x.kind) ? r.x12Refs[i] : null)).filter(Boolean).sort();
      assert.deepEqual(findings, want, `${seed}: the 835's findings are exactly the math and duplicate errors' places`);
      // scoring: flagging the error at its fieldRef counts as found, with no false alarm
      const s = scoreExtraction(gt, { errors: [{ kind: e.kind, fieldRef: e.fieldRef }] });
      assert.equal(s.errors.found, 1, `${seed}: scored as found`); assert.equal(s.errors.falseAlarms, 0);
    }
  });
}

test('ma-reapply-deductible near the maximum: refused, or the out-of-pocket figure stays within it (seeds 1-20)', () => {
  let refused = 0, accepted = 0;
  for (const prior of [5300, 5400, 5450, 5490]) for (const seed of SEEDS) for (const shapes of [['DERM'], ['DERM', 'OPH']]) {
    const ov = { claimCount: shapes.length, claimShapes: shapes, maPriorOop: prior, maDeductibleMetBefore: 150, mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 1 } }] };
    let g;
    try { g = gen('ppo-eob', seed, ov); } catch (e) {
      assert.ok([M('capBelowDeductible', { op: 'ma-reapply-deductible' }), M('capLeavesNothing', { op: 'ma-reapply-deductible' })].includes(e.message), e.message); refused++; continue;
    }
    accepted++;
    const f = g.groundTruth.documents[0].fields;
    assert.ok(f['financialSummary.oopUsed'] <= P('ppo-eob').oopMax, `${prior} ${seed}: out-of-pocket used within the maximum`);
    assert.deepEqual(broken('ppo-eob', g.data, g.groundTruth), ['I7'], `${prior} ${seed}: only the line's rule breaks`);
  }
  assert.ok(refused > 0 && accepted > 0, `refused ${refused}, accepted ${accepted}`);
});

test('the clean baseline breaks no invariant on either layout', () => {
  for (const type of TYPES) for (const seed of SEEDS) { const g = gen(type, seed); assert.deepEqual(broken(type, g.data, g.groundTruth), [], `${type} ${seed}`); }
});

// a denial is settled before adjudication: the line takes no deductible and no share of the maximum, the lines after it
// are adjudicated in claim order without it, and its delta is what it would have cost the member had it been covered
test('ma-deny-line: the denied line counts toward nothing, every other line follows its rule, delta is the share it would have had', () => {
  for (const type of TYPES) for (const seed of SEEDS) for (const state of [{}, { maPriorOop: P(type).oopMax, ...(type === 'ppo-eob' ? { maDeductibleMetBefore: P(type).deductible } : {}) }]) {
    const base = { claimCount: 2, claimShapes: ['DERM', 'DERM'], ...state };
    const plain = gen(type, seed, base).groundTruth; const covered = plain.claims[0].lines[1];
    const { data, groundTruth: gt } = gen(type, seed, { ...base, mutations: [{ op: 'ma-deny-line', args: { claim: 0, line: 1, note: { text: 'Test denial note.', rule: 'test rule' } } }] });
    const where = `${type} ${seed} ${state.maPriorOop ? 'at the cap' : 'drawn state'}`;
    const e = gt.errors[0]; const l = gt.claims[0].lines[1];
    assert.equal(e.lineRef, 'claims[0].lines[1]', where); assert.equal(e.expected, covered.allowed, where); assert.equal(e.actual, 0, where);
    assert.equal(e.delta, -covered.patientMayBeBilled || 0, `${where}: delta`);
    assert.equal(l.approved, false, where); assert.equal(l.allowed, 0, where); assert.equal(l.toDeductible + l.coinsurance + l.copay + l.patientMayBeBilled, 0, where);
    assert.deepEqual(broken(type, data, gt), [], `${where}: invariants`);
    const shares = (g) => g.claims.reduce((s, c) => s + c.lines.reduce((t, x) => t + Math.round(x.patientMayBeBilled * 100), 0), 0);
    assert.ok(shares(gt) <= shares(plain), `${where}: the member pays no more than without the denial`);
  }
});

// ---------- refusals ----------
const STR = JSON.parse(fs.readFileSync(path.join(here, '../data/ma-operations.json'), 'utf-8')).messages;
// the message the strings file holds for a key, with only {op}, {type} or {what} filled in
const M = (key, fill = {}) => STR[key].replace(/\{(op|type|what|min|max|known)\}/g, (m, k) => (k in fill ? fill[k] : m));
const refuses = (type, ov, msg) => assert.throws(() => gen(type, 'mae-r', ov), (err) => { assert.equal(err.message, msg); return true; });
test('every refusal stops the operation, with a message that carries no caller value', () => {
  const sec = 'xyzzy-secret-7731';
  const m = (op, args, extra = {}) => ({ claimCount: 2, claimShapes: ['OPH', 'LAB'], ...extra, mutations: [{ op, args }] });
  for (const type of TYPES) {
    refuses(type, m('ma-duplicate-line', { claim: 9, line: 0 }), M('noLine', { op: 'ma-duplicate-line' }));
    refuses(type, m('ma-duplicate-line', { claim: 1, line: 0 }), M('chargesNothing', { op: 'ma-duplicate-line' }));
    refuses(type, m('ma-cost-share-on-exempt-line', { claim: 0, line: 0 }), M('notExemptLine'));
    refuses(type, m('ma-break-claim-total', { claim: 0, field: sec, by: 1 }), M('unknownField', { op: 'ma-break-claim-total' }));
    refuses(type, m('ma-break-claim-total', { claim: 0, field: 'charged', by: -5 }), M('badBy', { op: 'ma-break-claim-total' }));
    refuses(type, m('ma-break-claim-total', { claim: 0, field: 'paid', by: 0 }), M('badBy', { op: 'ma-break-claim-total' }));
    refuses(type, m('ma-shift-date', { claim: 0, line: 0, days: 0 }), M('badDays', { op: 'ma-shift-date' }));
    refuses(type, m('ma-share-after-oop-max', { claim: 0, line: 0 }), M('needsState', { op: 'ma-share-after-oop-max' }));
    refuses(type, { ...m('ma-share-after-oop-max', { claim: 1, line: 0 }), maPriorOop: P(type).oopMax, ...(type === 'ppo-eob' ? { maDeductibleMetBefore: P(type).deductible } : {}) }, M('chargesNothing', { op: 'ma-share-after-oop-max' }));
    refuses(type, m('ma-deny-line', { claim: 0, line: 0, note: { text: '  ' } }), M('needsNote'));
    refuses(type, m('ma-deny-line', { claim: 0, line: 0 }), M('needsNote'));
    refuses(type, { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 2 } }, { op: 'ma-deny-line', args: { claim: 0, line: 0, note: { text: 'x' } } }] }, M('lineTaken', { op: 'ma-deny-line' }));
    refuses(type, { claimCount: 2, mutations: [{ op: sec }] }, M('unknownOp'));
    refuses(type, { claimCount: 2, decoys: [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0 } }] }, M('decoyNeedsRule'));
    refuses(type, { claimCount: 2, decoys: [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0, factor: 3 }, rule: 'r' }] }, M('factorAtLeast', { op: 'ma-charge-far-above-approved', min: 4, max: 100 }));
    refuses(type, { claimCount: 2, claimShapes: ['LAB', 'LAB'], decoys: [{ op: 'ma-approved-below-copay', args: { claim: 0, line: 0 }, rule: 'r' }] }, M('noCopay'));
    refuses(type, { claimCount: 2, claimShapes: ['FP', 'LAB'], decoys: [{ op: 'ma-repeat-service-other-date', args: { claim: 0, line: 0, days: 1 }, rule: 'r' }] }, M('repeatIsError', { op: 'ma-repeat-service-other-date' }));
    refuses(type, { claimCount: 2, decoys: [{ op: 'ma-oop-cap-partial-share', args: { claim: 0, line: 0 }, rule: 'r' }] }, M('needsState', { op: 'ma-oop-cap-partial-share' }));
    // an index that does not exist, for every operation and decoy
    const OPS_ARGS = { 'ma-duplicate-line': {}, 'ma-shift-date': { days: 2 }, 'ma-deny-line': { note: { text: 'x' } }, 'ma-cost-share-on-exempt-line': {}, 'ma-reapply-deductible': {}, 'ma-share-after-oop-max': {} };
    const atCap = { maPriorOop: P(type).oopMax, ...(type === 'ppo-eob' ? { maDeductibleMetBefore: P(type).deductible } : {}) };
    for (const [op, extra] of Object.entries(OPS_ARGS)) {
      if (op === 'ma-reapply-deductible' && type === 'hmo-eob') continue;
      const state = op === 'ma-reapply-deductible' ? { maPriorOop: 400, maDeductibleMetBefore: 150 } : op === 'ma-share-after-oop-max' ? atCap : {};
      refuses(type, { ...m(op, { claim: 9, line: 0, ...extra }), ...state }, M('noLine', { op }));
      refuses(type, { ...m(op, { claim: 0, line: 9, ...extra }), ...state }, M('noLine', { op }));
    }
    refuses(type, m('ma-break-claim-total', { claim: 9, field: 'paid', by: 1 }), M('noLine', { op: 'ma-break-claim-total' }));
    const dec = (op, args, extra = {}) => ({ claimCount: 2, claimShapes: ['OPH', 'LAB'], ...extra, decoys: [{ op, args, rule: 'r' }] });
    for (const op of ['ma-repeat-service-other-date', 'ma-charge-far-above-approved', 'ma-approved-below-copay', 'ma-oop-cap-partial-share'])
      refuses(type, dec(op, { claim: 0, line: 9, days: 1 }, op === 'ma-oop-cap-partial-share' ? { maPriorOop: 100 } : {}), M('noLine', { op }));
    // the maximum already reached leaves nothing to charge on an exempt line
    refuses(type, { ...m('ma-cost-share-on-exempt-line', { claim: 1, line: 0 }), ...atCap }, M('capLeavesNothing', { op: 'ma-cost-share-on-exempt-line' }));
    // days: whole numbers from 1 to 365, on both operations that take them
    for (const days of [0, 366, 1e9, 1.5, sec]) refuses(type, m('ma-shift-date', { claim: 0, line: 0, days }), M('badDays', { op: 'ma-shift-date' }));
    for (const days of [0, 366, 2.5]) refuses(type, dec('ma-repeat-service-other-date', { claim: 0, line: 0, days }), M('badDays', { op: 'ma-repeat-service-other-date' }));
    refuses(type, dec('ma-repeat-service-other-date', { claim: 0, line: 0, days: 365 }), M('outsidePeriod', { op: 'ma-repeat-service-other-date' }));
    refuses(type, { claimCount: 2, claimShapes: ['OPH', 'LAB'], decoys: [{ op: 'ma-repeat-service-other-date', args: { claim: 0, line: 0, days: 1 }, rule: 'r' }, { op: 'ma-repeat-service-other-date', args: { claim: 0, line: 0, days: 1 }, rule: 'r' }] }, M('sameDate', { op: 'ma-repeat-service-other-date' }));
    // a claim total shifted below zero
    refuses(type, m('ma-break-claim-total', { claim: 0, field: 'allowed', by: -99999 }), M('totalBelowZero', { op: 'ma-break-claim-total' }));
    // the cap did not cut this line: no maximum reached this month
    refuses(type, dec('ma-oop-cap-partial-share', { claim: 0, line: 0 }, { maPriorOop: 100 }), M('notPartialCap'));
    // entries: an operation is named, and the text a caller hands over is capped
    refuses(type, { claimCount: 2, mutations: [{}] }, M('entryNeedsOp', { what: 'mutation' }));
    refuses(type, { claimCount: 2, decoys: [5] }, M('entryNeedsOp', { what: 'decoy' }));
    const big = (n) => 'x'.repeat(n);
    refuses(type, { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 2 }, rule: big(1001) }] }, M('entryTextTooLong', { what: 'mutation' }));
    refuses(type, { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 2 }, note: big(501) }] }, M('entryTextTooLong', { what: 'mutation' }));
    refuses(type, { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 2 }, rule: { sec } }] }, M('entryTextTooLong', { what: 'mutation' }));
    refuses(type, { claimCount: 2, decoys: [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0, factor: 5 }, rule: big(1001) }] }, M('entryTextTooLong', { what: 'decoy' }));
    refuses(type, { claimCount: 2, decoys: [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0, factor: 5 }, rule: 'r', note: big(501) }] }, M('entryTextTooLong', { what: 'decoy' }));
    refuses(type, m('ma-deny-line', { claim: 0, line: 0, note: { text: big(501) } }), M('denialNoteTooLong'));
    refuses(type, m('ma-deny-line', { claim: 0, line: 0, note: { text: 'x', rule: big(1001) } }), M('denialNoteTooLong'));
    refuses(type, m('ma-deny-line', { claim: 0, line: 0, note: { text: 'x', rule: 7 } }), M('denialNoteTooLong'));
    // at the limits, accepted
    assert.equal(gen(type, 'mae-r', { claimCount: 2, claimShapes: ['OPH', 'LAB'], mutations: [{ op: 'ma-deny-line', args: { claim: 0, line: 0, note: { text: big(500), rule: big(1000) } }, note: big(500), rule: big(1000) }] }).groundTruth.errors.length, 1);
    // forced state
    refuses(type, { maPriorOop: -1 }, M('priorOop', { type }));
    refuses(type, { maPriorOop: P(type).oopMax + 1 }, M('priorOop', { type }));
    refuses(type, { maPriorOop: sec }, M('priorOop', { type }));
    for (const v of [12.345, 0.001, NaN, Infinity]) refuses(type, { maPriorOop: v }, M('priorOop', { type }));
  }
  for (const v of [12.345, 0.001, NaN, -1, 151]) refuses('ppo-eob', { maPriorOop: 400, maDeductibleMetBefore: v }, M('deductibleRange', { type: 'ppo-eob' }));
  refuses('hmo-eob', { claimCount: 1, claimShapes: ['DERM'], mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 1 } }] }, M('noDeductible', { op: 'ma-reapply-deductible', type: 'hmo-eob' }));
  refuses('hmo-eob', { maPriorOop: 10, maDeductibleMetBefore: 5 }, M('planNoDeductible', { type: 'hmo-eob' }));
  refuses('ppo-eob', { maDeductibleMetBefore: 50 }, M('deductibleNeedsPrior', { type: 'ppo-eob' }));
  refuses('ppo-eob', { maPriorOop: 40, maDeductibleMetBefore: 50 }, M('deductibleAbovePrior', { type: 'ppo-eob' }));
  refuses('ppo-eob', { maPriorOop: 400, maDeductibleMetBefore: 151 }, M('deductibleRange', { type: 'ppo-eob' }));
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 400, maDeductibleMetBefore: 100, mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 1 } }] }, M('needsState', { op: 'ma-reapply-deductible' }));
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 400, maDeductibleMetBefore: 150, mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 0 } }] }, M('notCoinsuranceLine'));
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 400, maDeductibleMetBefore: 150, decoys: [{ op: 'ma-partial-deductible', args: { claim: 0, line: 1 }, rule: 'r' }] }, M('notPartialDeductible'));
  refuses('hmo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 10, decoys: [{ op: 'ma-partial-deductible', args: { claim: 0, line: 1 }, rule: 'r' }] }, M('noDeductible', { op: 'ma-partial-deductible', type: 'hmo-eob' }));
  // a line that took part of the deductible, with no maximum reached, is not the cap's partial share
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 300, maDeductibleMetBefore: 100, decoys: [{ op: 'ma-oop-cap-partial-share', args: { claim: 0, line: 1 }, rule: 'r' }] }, M('notPartialCap'));
  // a deductible taken again in a month too close to the maximum
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: P('ppo-eob').oopMax - 40, maDeductibleMetBefore: 150, mutations: [{ op: 'ma-reapply-deductible', args: { claim: 0, line: 1 } }] }, M('capBelowDeductible', { op: 'ma-reapply-deductible' }));
  // entries are checked the same way on every layout: kind and severity (MA and Part B), rule and note caps (Part B)
  refuses('hmo-eob', { claimCount: 1, claimShapes: ['DERM'], mutations: [{ op: 'ma-duplicate-line', args: { claim: 0, line: 0 }, kind: 'Bad Kind' }] }, M('entryKindInvalid', { what: 'mutation' }));
  refuses('ppo-eob', { claimCount: 1, claimShapes: ['DERM'], mutations: [{ op: 'ma-duplicate-line', args: { claim: 0, line: 0 }, severity: 'urgent' }] }, M('entrySeverityInvalid', { what: 'mutation' }));
  refuses('ppo-eob', { claimCount: 2, claimShapes: ['PT', 'PT'], decoys: [{ op: 'ma-repeat-service-other-date', args: { claim: 0, line: 0, days: 7 }, rule: 'r', kind: 'x'.repeat(65) }] }, M('entryKindInvalid', { what: 'decoy' }));
  const partB = (type, ov, msg) => assert.throws(() => generateData({ type, scenario: 'baseline-clean', seed: 'pb-1', overrides: ov }), (e) => { assert.equal(e.message, msg); return true; });
  for (const type of ['msn', 'itemized-bill']) {
    partB(type, { mutations: [{ op: 'duplicate-line', args: { claim: 0, line: 0 }, kind: 'Bad Kind' }] }, M('entryKindInvalid', { what: 'mutation' }));
    partB(type, { mutations: [{ op: 'duplicate-line', args: { claim: 0, line: 0 }, severity: 'urgent' }] }, M('entrySeverityInvalid', { what: 'mutation' }));
    partB(type, { mutations: [{ op: 'duplicate-line', args: { claim: 0, line: 0 }, rule: 'r'.repeat(1001) }] }, M('entryTextTooLong', { what: 'mutation' }));
    partB(type, { mutations: [{ op: 'duplicate-line', args: { claim: 0, line: 0 }, note: 'n'.repeat(501) }] }, M('entryTextTooLong', { what: 'mutation' }));
    partB(type, { decoys: [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r'.repeat(1001) }] }, M('entryTextTooLong', { what: 'decoy' }));
    partB(type, { decoys: [{ op: 'charge-far-above-approved', args: { claim: 0, line: 0 }, rule: 'r', kind: 'Bad Kind' }] }, M('entryKindInvalid', { what: 'decoy' }));
  }
  partB('msn', { mutations: [{ op: 'deny-line', args: { claim: 0, line: 0, note: { text: 't'.repeat(501) } } }] }, M('denyNoteTooLong'));
  partB('msn', { mutations: [{ op: 'deny-line', args: { claim: 0, line: 0, note: { text: 't', rule: 'r'.repeat(1001) } } }] }, M('denyNoteTooLong'));
  partB('msn', { mutations: [{ op: 'deny-line', args: { claim: 0, line: 0, note: 'not an object' } }] }, M('denyNoteTooLong'));
  // the shipped scenarios fit the caps: every published scenario of every type still generates
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) for (const s of listScenarios(type)) generateData({ type, scenario: s, seed: 'pb-2' });
  // every message key the code names exists in the strings file, and no message names a key it does not hold
  const code = ['ma-mutations.js', 'ma-eob.js', 'mutations.js', 'index.js'].map((f) => fs.readFileSync(path.join(here, `../src/generate/${f}`), 'utf-8')).join('\n');
  const used = [...code.matchAll(/fail\('(\w+)'/g)].map((x) => x[1]);
  for (const k of used) assert.ok(STR[k], `message ${k} is in data/ma-operations.json`);
  const tests = fs.readFileSync(path.join(here, 'ma-errors.test.js'), 'utf-8') + fs.readFileSync(path.join(here, 'decoys.test.js'), 'utf-8');
  for (const k of Object.keys(STR)) assert.ok(tests.includes(`M('${k}'`) || tests.includes(`is('${k}'`) || tests.includes(`.messages.${k}`), `message ${k} has a negative test`);
  for (const k of Object.keys(STR)) assert.ok(used.includes(k), `message ${k} is used by the code`);
  // the cap that would cut into an unmet deductible: adjudicateMa's own refusal, reachable through overrides
  assert.throws(() => gen('ppo-eob', 'mae-cap', { claimCount: 1, claimShapes: ['DERM'], maPriorOop: P('ppo-eob').oopMax - 5, maDeductibleMetBefore: 0 }), /cap cuts into deductible/);
});

// ---------- forced state leaves everything else where it was ----------
// Every number an operation takes, on every operation that takes one (the Part B operations on the MSN and the bill,
// the Medicare Advantage ones on both EOBs): a value is either refused with the strings file's message, or the error
// it plants changes a printed figure, in whole cents, to a finite value. A sub-cent amount, a factor or rate that
// rounds to no change, a huge or non-finite number and an index that names no claim or line are all refused.
test('every number an operation takes either changes what prints, in whole cents, or is refused with its message', () => {
  const pattern = (t) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(op|type|what|min|max|known)\\\}/g, '[\\w.-]+')}$`);
  const ours = Object.values(STR).map(pattern);
  const finiteNumbers = (x) => (typeof x === 'number' ? Number.isFinite(x) : x && typeof x === 'object' ? Object.values(x).every(finiteNumbers) : true);
  const BAD_AMOUNTS = [0, 0.001, 0.004, 0.005, 0.009, 1e-9, 12.345, 1e308, Infinity, -Infinity, NaN, 100000.01, -100000.01, '5', null, true];
  const FACTORS = [1, 1.0001, 1.001, 1.01, 0.5, 0, -2, 4, 99.99, 100, 100.01, 101, 1e308, Infinity, NaN, '2'];
  const RATES = [0, -0.1, 0.0001, 0.001, 0.2, 1, 1.0001, 2, NaN, Infinity, '0.2'];
  const DAYS = [0, -1, 1, 365, 366, 1.5, NaN, 1e9, '7'];
  const INDICES = [-1, 1.5, 9, NaN, '0', null];
  const cases = [];   // [type, mutations|decoys, op, args, the message a refusal must carry]
  const pb = (op, args, msg) => cases.push(['msn', 'mutations', op, args, msg]);
  for (const by of BAD_AMOUNTS) pb('break-claim-total', { claim: 0, field: 'maxYouMayBeBilled', by }, M('badBy', { op: 'break-claim-total' }));
  pb('break-claim-total', { claim: 0, field: 'amountProviderCharged', by: -1 }, M('badBy', { op: 'break-claim-total' }));
  // a total the layout does not print, or no total at all, is refused; every total it prints is taken
  for (const field of ['__proto__', 'constructor', 'toDeductible', 'coinsurance', 'providerBilled', 'nope', 7]) pb('break-claim-total', { claim: 0, field, by: 1 }, M('unknownField', { op: 'break-claim-total' }));
  for (const field of ['maxYouMayBeBilled', 'amountProviderCharged', 'medicareApprovedAmount', 'amountMedicarePaid', 'charged', 'allowed', 'paid', 'patientMayBeBilled']) pb('break-claim-total', { claim: 0, field, by: 1 }, null);
  const bill = (args, msg) => cases.push(['itemized-bill', 'mutations', 'break-claim-total', args, msg]);
  for (const field of [undefined, 'maxYouMayBeBilled', 'patientMayBeBilled', '__proto__']) bill({ claim: 0, field, by: 1 }, M('unknownField', { op: 'break-claim-total' }));
  for (const field of ['amountProviderCharged', 'medicareApprovedAmount', 'amountMedicarePaid', 'charged', 'allowed', 'paid', 'toDeductible', 'coinsurance', 'providerBilled']) bill({ claim: 0, field, by: 1 }, null);
  pb('break-claim-total', { claim: 0, field: 'maxYouMayBeBilled', by: -99999 }, M('totalBelowZero', { op: 'break-claim-total' }));
  for (const by of [0.01, -0.01, 1, 99999.99, 100000]) pb('break-claim-total', { claim: 0, field: 'maxYouMayBeBilled', by }, null);
  for (const factor of FACTORS) pb('overprice-line', { claim: 0, line: 0, factor }, factor > 1 && factor <= 100 && typeof factor === 'number' ? 'noChange' : M('factorAbove', { op: 'overprice-line', min: 1, max: 100 }));
  for (const rate of RATES) pb('apply-cost-share-to-exempt-line', { claim: 0, line: 0, rate }, rate > 0 && rate <= 1 && typeof rate === 'number' ? 'noChange' : M('badRate'));
  for (const days of DAYS) pb('shift-date', { claim: 0, line: 0, days }, Number.isInteger(days) && days >= 1 && days <= 365 ? null : M('badDays', { op: 'shift-date' }));
  // the provider's bill to the patient prints only on the itemized bill: the MSN refuses the operation in any form
  for (const args of [{ claim: 0, line: 0 }, { claim: 0, line: 0, mode: 'extra', by: 5 }, { claim: 0, line: 0, mode: 'xyzzy' }]) pb('bill-above-approved', args, M('unknownOp'));
  cases.push(['itemized-bill', 'mutations', 'bill-above-approved', { claim: 0, line: 0, mode: 'xyzzy' }, M('badMode')]);
  for (const args of [{ claim: 0, line: 0 }, { claim: 0, line: 0, mode: 'extra', by: 0.01 }, { claim: 0, line: 0, mode: 'extra', by: 100000 }]) cases.push(['itemized-bill', 'mutations', 'bill-above-approved', args, null]);
  for (const by of [...BAD_AMOUNTS, -1]) cases.push(['itemized-bill', 'mutations', 'bill-above-approved', { claim: 0, line: 0, mode: 'extra', by }, M('badBy', { op: 'bill-above-approved' })]);
  for (const op of ['duplicate-line', 'apply-cost-share-to-exempt-line', 'reapply-deductible', 'deny-line', 'shift-date', 'overprice-line'])
    for (const i of INDICES) { pb(op, { claim: i, line: 0, days: 1 }, M('noLine', { op })); pb(op, { claim: 0, line: i, days: 1 }, M('noLine', { op })); }
  for (const i of INDICES) for (const args of [{ claim: i, line: 0 }, { claim: 0, line: i }]) cases.push(['itemized-bill', 'mutations', 'bill-above-approved', args, M('noLine', { op: 'bill-above-approved' })]);
  for (const i of INDICES) pb('break-claim-total', { claim: i, field: 'maxYouMayBeBilled', by: 1 }, M('noLine', { op: 'break-claim-total' }));
  const dec = (op, args, msg) => cases.push(['msn', 'decoys', op, args, msg]);
  for (const factor of FACTORS) dec('charge-far-above-approved', { claim: 0, line: 0, factor }, factor > 1 && factor <= 100 && typeof factor === 'number' ? 'noChange' : M('factorAbove', { op: 'charge-far-above-approved', min: 1, max: 100 }));
  for (const days of [0, 366, 1.5, NaN, 1e9, '7']) dec('repeat-service-other-date', { claim: 0, line: 0, days }, M('badDays', { op: 'repeat-service-other-date' }));
  for (const op of ['charge-far-above-approved', 'repeat-service-other-date']) for (const i of INDICES) dec(op, { claim: i, line: 0, days: 7 }, M('noLine', { op }));
  for (const type of TYPES) {
    for (const by of BAD_AMOUNTS) cases.push([type, 'mutations', 'ma-break-claim-total', { claim: 0, field: 'paid', by }, M('badBy', { op: 'ma-break-claim-total' })]);
    for (const by of [0.01, -0.01, 15, 100000]) cases.push([type, 'mutations', 'ma-break-claim-total', { claim: 0, field: 'charged', by }, by < 0 ? M('badBy', { op: 'ma-break-claim-total' }) : null]);
    for (const factor of FACTORS) cases.push([type, 'decoys', 'ma-charge-far-above-approved', { claim: 0, line: 0, factor }, typeof factor === 'number' && factor >= 4 && factor <= 100 ? 'noChange' : M('factorAtLeast', { op: 'ma-charge-far-above-approved', min: 4, max: 100 })]);
  }
  let accepted = 0, refused = 0;
  // the same request with nothing planted: an operation that is taken must change what the answer key says prints
  const fieldsOf = (type, list, entries) => generateData({ type, scenario: 'baseline-clean', seed: 'args-1', overrides: type === 'itemized-bill' ? { [list]: entries } : { claimCount: 2, claimShapes: ['OPH', 'LAB'], [list]: entries } }).groundTruth.documents[0].fields;
  for (const [type, list, op, args, msg] of cases) {
    const where = `${type} ${op} ${JSON.stringify(args)}`;
    const entry = { op, args, ...(list === 'decoys' ? { rule: 'r' } : {}) };
    const ov = { claimCount: 2, claimShapes: ['OPH', 'LAB'], [list]: [entry] };
    let g;
    try { g = generateData({ type, scenario: 'baseline-clean', seed: 'args-1', overrides: type === 'itemized-bill' ? { [list]: [entry] } : ov }); }
    catch (e) {
      refused++;
      if (msg && msg !== 'noChange') assert.equal(e.message, msg, where);
      else assert.ok(msg === 'noChange' ? e.message === M('noChange', { op }) : false, `${where}: refused (${e.message})`);
      assert.ok(ours.some((re) => re.test(e.message)), `${where}: ${e.message}`);
      continue;
    }
    accepted++;
    assert.ok(msg === null || msg === 'noChange', `${where}: accepted, but ${msg} was due`);
    const gt = g.groundTruth;
    assert.ok(finiteNumbers(gt.claims) && finiteNumbers(gt.errors) && finiteNumbers(g.data.claims), `${where}: a figure that is not a finite number`);
    assert.notDeepEqual(gt.documents[0].fields, fieldsOf(type, list, []), `${where}: nothing printed changed`);
    if (list === 'mutations') {
      const e = gt.errors[0]; assert.notEqual(JSON.stringify(e.actual), JSON.stringify(e.expected), `${where}: nothing changed`);
      if (typeof e.actual === 'number') { assert.ok(Math.abs(e.actual * 100 - Math.round(e.actual * 100)) < 1e-6, `${where}: actual in whole cents`); if (e.kind === 'math-error') assert.equal(Math.round((e.actual - e.expected) * 100), Math.round(e.delta * 100), `${where}: delta = actual - expected`); }
    }
  }
  assert.ok(accepted >= 20 && refused >= 150, `accepted ${accepted}, refused ${refused}`);
});

test('a second denial of a denied line, an operation name that is not one and an entry that is not an object are refused without the name', () => {
  const ov = (list, entries) => ({ claimCount: 2, claimShapes: ['OPH', 'LAB'], [list]: entries });
  const deny = { op: 'deny-line', args: { claim: 0, line: 0 } };
  assert.throws(() => generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'args-2', overrides: ov('mutations', [deny, deny]) }), (e) => e.message === M('lineTaken', { op: 'deny-line' }));
  // a copy inserted before a line that already carries an error would move it from under its record
  for (const type of ['msn', 'itemized-bill']) {
    const moved = { claimCount: 2, claimShapes: ['DERM', 'LAB'], mutations: [{ op: 'shift-date', args: { claim: 0, line: 1, days: 3 } }, { op: 'duplicate-line', args: { claim: 0, line: 0 } }] };
    assert.throws(() => generateData({ type, scenario: 'baseline-clean', seed: 'args-2', overrides: moved }), (e) => e.message === M('dupMovesLine'), type);
    const after = { ...moved, mutations: [{ op: 'shift-date', args: { claim: 0, line: 0, days: 3 } }, { op: 'duplicate-line', args: { claim: 0, line: 1 } }] };
    assert.equal(generateData({ type, scenario: 'baseline-clean', seed: 'args-2', overrides: after }).groundTruth.errors.length, 2, `${type}: a copy after the error's line`);
  }
  const sec = 'xyzzy-secret-7731';
  // every layout, both lists: a name that is not one of the layout's own operations, prototype names included
  const ops = [sec, '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const foreign = { msn: ['ma-deny-line', 'ma-charge-far-above-approved'], 'itemized-bill': ['ma-deny-line'], 'ppo-eob': ['deny-line', 'charge-far-above-approved'], 'hmo-eob': ['bill-above-approved'] };
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) for (const list of ['mutations', 'decoys']) for (const op of [...ops, ...foreign[type]])
    assert.throws(() => generateData({ type, scenario: 'baseline-clean', seed: 'args-2', overrides: { [list]: [{ op, args: { claim: 0, line: 0 }, rule: 'r' }] } }), (e) => e.message === M(list === 'mutations' ? 'unknownOp' : 'unknownDecoy') && !e.message.includes(sec), `${type} ${list} ${op}`);
  // an entry that is not an object is refused with its own message, never a type error
  for (const type of ['msn', 'ppo-eob']) for (const list of ['mutations', 'decoys']) for (const entry of [null, 7, 'deny-line', [], { args: {} }])
    assert.throws(() => generateData({ type, scenario: 'baseline-clean', seed: 'args-2', overrides: { [list]: [entry] } }), (e) => e.message === M('entryNeedsOp', { what: list === 'mutations' ? 'mutation' : 'decoy' }), `${type} ${list} ${JSON.stringify(entry)}`);
});

test('every date an accepted scenario prints is a real date, at the edges of what the limits allow', () => {
  // the widest period (a whole year), the latest notice, the longest shift and repeat: nothing prints as undefined,
  // NaN or an invalid date, and every printed year is the period's year or the next
  const looks = /undefined|NaN|Invalid|Infinity/;
  const partB = { mutations: [{ op: 'shift-date', args: { claim: 0, line: 0, days: 365 } }] };
  const ma = { mutations: [{ op: 'ma-shift-date', args: { claim: 0, line: 0, days: 365 } }] };
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) for (const year of [2025, 2026]) for (const notice of [null, 90]) for (const ops of [{}, type.endsWith('eob') ? ma : partB]) {
    const period = { start: `${year}-01-01`, end: `${year}-12-31` };
    const dateOfNotice = notice === null ? undefined : new Date(Date.UTC(year + 1, 0, 1 + 89)).toISOString().slice(0, 10);
    const g = generateData({ type, scenario: 'baseline-clean', seed: `edge-${year}`, overrides: { period, ...(dateOfNotice ? { dateOfNotice } : {}), claimCount: 2, claimShapes: ['OPH', 'OPH'], ...ops } });
    const text = JSON.stringify([g.groundTruth, g.data]);
    assert.doesNotMatch(text, looks, `${type} ${year} notice ${notice}`);
    // the years of every date as the documents write them: 2026-03-04, 03/04/2026, March 4, 2026
    const years = [...text.matchAll(/\b([0-9]{4,})-[0-9]{2}-[0-9]{2}\b|\b[0-9]{2}\/[0-9]{2}\/([0-9]{4,})\b|[A-Z][a-z]+ [0-9]{1,2}, ([0-9]{4,})\b/g)].map((m) => Number(m[1] || m[2] || m[3]));
    assert.ok(years.length > 5, `${type} ${year}: dates found`);
    for (const y of years) assert.ok(y >= year - 1 && y <= year + 2, `${type} ${year}: a printed year ${y}`);
  }
});

test("a scenario's own figures are refused, with their message, unless the documents can print them", () => {
  const sc = (type, ov) => () => generateData({ type, scenario: 'baseline-clean', seed: 'sc-1', overrides: ov });
  const SHAPES = 'IM, LAB, CARD, OPH, PT, RAD, DERM, FP';
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) {
    const max = 16;
    for (const claimCount of [0, -1, 1.5, NaN, '2', null, max + 1, 1e9]) assert.throws(sc(type, { claimCount }), (e) => e.message === M('badClaimCount', { type, max }), `${type} claimCount ${claimCount}`);
    for (const claimCount of [1, max]) sc(type, { claimCount, claimShapes: [] })();
    for (const claimShapes of [['NOPE'], 'OPH', [1], ['constructor'], {}]) assert.throws(sc(type, { claimShapes }), (e) => e.message === M('badShape', { type, known: SHAPES }), `${type} claimShapes ${JSON.stringify(claimShapes)}`);
    sc(type, { claimCount: 3, claimShapes: [null, '', 'LAB'] })();
    for (const period of [null, 'x', {}, { start: '2026-13-01', end: '2026-03-31' }, { start: '2026-02-30', end: '2026-03-31' }, { start: '2026-03-31', end: '2026-03-01' }, { start: '20260301', end: '2026-03-31' }, { start: '2026-03-01' },
      { start: '2026-01-01', end: '9999-12-31' }, { start: '2025-12-15', end: '2026-01-15' }, { start: '2026-01-01', end: '2027-01-01' }])
      assert.throws(sc(type, { period }), (e) => e.message === M('badPeriod', { type }), `${type} period ${JSON.stringify(period)}`);
    for (const year of [2019, 2025, 2025.5, '2026', 1e308, 0, null]) assert.throws(sc(type, { year }), (e) => e.message === M('yearNotPeriod', { type }), `${type} year ${year}`);
    sc(type, { year: 2026 })();
    assert.throws(sc(type, { period: { start: '2019-03-01', end: '2019-03-31' } }), (e) => e.message === M('badYear', { type }));
    for (const dateOfNotice of ['nope', '2026-02-30', 12, '2026-03-30', '2026-01-01', '2026-06-30', '9999-12-31']) assert.throws(sc(type, { dateOfNotice }), (e) => e.message === M('badNoticeDate', { type, max: 90 }), `${type} dateOfNotice ${dateOfNotice}`);
    for (const dateOfNotice of ['2026-03-31', '2026-06-29']) sc(type, { dateOfNotice })();
    for (const deductibleMetBefore of [NaN, -1, 12.345, 0.001, 1e308, '5', 10000]) assert.throws(sc(type, { deductibleMetBefore }), (e) => e.message === M('deductibleRange', { type }), `${type} deductibleMetBefore ${deductibleMetBefore}`);
    for (const deductibleMetBefore of [0, 12.34, 100]) sc(type, { deductibleMetBefore })();
  }
  // a line charged at no more than its approved amount: billing the unpaid balance leaves nothing above the share (a
  // generated line always charges more than Medicare approves, so the operation is called on such a line directly)
  const flat = { type: 'itemized-bill', claims: [{ lines: [{ charged: 10, allowed: 10, paid: 8, toDeductible: 0, coinsurance: 2, patientMayBeBilled: 2, approved: true }], totals: {} }], params: { partB: { coinsuranceRate: 0.2, deductible: 283 } } };
  assert.throws(() => PART_B_OPS['bill-above-approved'](flat, { claim: 0, line: 0 }), (e) => e.message === M('billNothingAbove'));
  // and a denied line is an error's line: no second error stands on it
  assert.throws(() => generateData({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'sc-1', overrides: { mutations: [{ op: 'deny-line', args: { claim: 0, line: 0 } }, { op: 'bill-above-approved', args: { claim: 0, line: 0 } }] } }),
    (e) => e.message === M('lineTaken', { op: 'bill-above-approved' }));
});

test('an error planted on a Part B layout stays as recorded, whatever operation or decoy runs after it, or the later one is refused', () => {
  const STRM = Object.values(STR).map((t) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(op|type|what|min|max|known)\\\}/g, '[\\w., -]+')}$`));
  const r2 = (x) => Math.round(x * 100) / 100;
  const OPS = [['duplicate-line', {}], ['apply-cost-share-to-exempt-line', {}], ['reapply-deductible', {}], ['deny-line', {}], ['shift-date', { days: 3 }],
    ['overprice-line', { factor: 1.5 }], ['bill-above-approved', { mode: 'extra', by: 5 }], ['break-claim-total', { field: 'charged', by: 10 }],
    ['break-claim-total', { field: 'paid', by: -1 }], ['break-claim-total', { field: 'allowed', by: 7 }]];
  const DECOYS = [['charge-far-above-approved', { factor: 4 }], ['repeat-service-other-date', { days: 7 }]];
  const PLACES = [[0, 0], [0, 1], [1, 0], [2, 1]];
  const lineOf = (ref) => { const m = /^claims\[(\d+)\]\.lines\[(\d+)\]$/.exec(ref || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
  let pairs = 0, refused = 0;
  for (const type of ['msn', 'itemized-bill']) {
    const gen = (mutations, decoys = []) => generateData({ type, scenario: 'baseline-clean', seed: 'later-ops', overrides: { claimCount: 3, claimShapes: ['DERM', 'LAB', 'DERM'], mutations, decoys } });
    for (const [opA, argsA] of OPS) for (const [ca, la] of PLACES) {
      const a = { op: opA, args: { claim: ca, line: la, ...argsA } };
      let alone; try { alone = gen([a]); } catch { continue; }
      for (const [opB, argsB, decoy] of [...OPS.map((o) => [...o, false]), ...DECOYS.map((o) => [...o, true])]) for (const [cb, lb] of PLACES) {
        const b = { op: opB, args: { claim: cb, line: lb, ...argsB }, ...(decoy ? { rule: 'r' } : {}) };
        const where = `${type}: ${opA} ${JSON.stringify(a.args)} then ${opB} ${JSON.stringify(b.args)}`;
        let both;
        try { both = decoy ? gen([a], [b]) : gen([a, b]); } catch (e) { assert.ok(STRM.some((re) => re.test(e.message)), `${where}: ${e.message}`); refused++; continue; }
        pairs++;
        const ea = alone.groundTruth.errors[0]; const eb = both.groundTruth.errors[0]; const g = both.groundTruth;
        if (ea.kind === 'math-error') {
          // the total prints as recorded, and what it should be is the sum of the lines as every operation left them
          assert.equal(g.documents[0].fields[eb.fieldRef], eb.actual, `${where}: the printed total`);
          const field = /totals\.(\w+)$/.exec(eb.lineRef)[1];
          const claims = eb.fieldRef.startsWith('insuranceSummary.') ? g.claims : [g.claims[ca]];
          assert.equal(eb.expected, claims.reduce((t, c) => r2(t + c.lines.reduce((u, l) => r2(u + l[field]), 0)), 0), `${where}: expected = the lines' sum`);
          assert.equal(r2(eb.actual - eb.expected), argsA.by, `${where}: the shift`);
        } else {
          // a line error: the same record, and its lines exactly as they were with nothing after it
          assert.deepEqual(eb, ea, `${where}: the record`);
          for (const ref of [ea.lineRef, ea.relatedLineRef].filter(Boolean)) { const [c, l] = lineOf(ref); assert.deepEqual(g.claims[c].lines[l], alone.groundTruth.claims[c].lines[l], `${where}: ${ref}`); }
        }
      }
    }
  }
  assert.ok(pairs > 200 && refused > 100, `${pairs} pairs, ${refused} refused`);
});

test('forcing the drawn prior amount changes nothing; the draw is consumed either way', () => {
  for (const type of TYPES) for (const seed of SEEDS) {
    const base = gen(type, seed);
    const prior = r2(base.groundTruth.documents[0].fields['financialSummary.oopUsed'] - base.data.claims.reduce((s, c) => s + c.claimTotal[SHARE[type]], 0));
    const ov = { maPriorOop: prior, ...(type === 'ppo-eob' ? { maDeductibleMetBefore: base.groundTruth.deductibleMetBefore } : {}) };
    const forced = gen(type, seed, ov);
    assert.equal(JSON.stringify(forced.groundTruth), JSON.stringify(base.groundTruth), `${type} ${seed}: same key`);
  }
});

// ---------- decoys ----------
const DECOYS = {
  'ma-repeat-service-other-date': (t) => ({ claimCount: 2, claimShapes: ['PT', 'LAB'], decoys: [{ op: 'ma-repeat-service-other-date', args: { claim: 0, line: 0, days: 1 }, rule: 'r' }] }),
  'ma-charge-far-above-approved': (t) => ({ claimCount: 2, claimShapes: ['OPH', 'LAB'], decoys: [{ op: 'ma-charge-far-above-approved', args: { claim: 0, line: 0, factor: 5 }, rule: 'r' }] }),
  'ma-approved-below-copay': (t) => ({ claimCount: 2, claimShapes: ['OPH', 'LAB'], decoys: [{ op: 'ma-approved-below-copay', args: { claim: 0, line: 0 }, rule: 'r' }] }),
  'ma-oop-cap-partial-share': (t) => ({ claimCount: 1, claimShapes: ['OPH'], maPriorOop: r2(P(t).oopMax - 15), decoys: [{ op: 'ma-oop-cap-partial-share', args: { claim: 0, line: 0 }, rule: 'r' }] }),
  'ma-partial-deductible': (t) => (t === 'hmo-eob' ? null : { claimCount: 1, claimShapes: ['DERM'], maPriorOop: 300, maDeductibleMetBefore: 100, decoys: [{ op: 'ma-partial-deductible', args: { claim: 0, line: 1 }, rule: 'r' }] }),
};
for (const [op, mk] of Object.entries(DECOYS)) for (const type of TYPES) {
  const ov = mk(type); if (!ov) continue;
  test(`${op} on ${type}: a hard negative that follows the plan rules (seeds 1-20)`, () => {
    for (const seed of SEEDS) {
      const { data, groundTruth: gt } = gen(type, seed, ov);
      assert.equal(gt.errors.length, 0); assert.equal(gt.decoys.length, 1); const d = gt.decoys[0];
      assert.ok(validate(gt), JSON.stringify(validate.errors));
      const at = (ref) => ref.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => o?.[k], { claims: gt.claims });
      assert.ok(at(d.lineRef), `${seed}: the decoy's lineRef resolves in the claims block`);
      assert.ok(Object.keys(gt.documents[0].fields).some((k) => k.startsWith(`${d.fieldRef}.`)), `${seed}: the decoy is printed`);
      assert.deepEqual(broken(type, data, gt), [], `${seed}: a decoy breaks no invariant`);
      const r = buildRemittance({ type, scenario: 'baseline-clean', seed, generated: { data, groundTruth: gt } });
      assert.deepEqual(checkSpecimen835(r.text, { names: names(gt) }), []); assert.deepEqual(findingsOf(r.text), [], `${seed}: no 835 finding for a decoy`);
      const s = scoreExtraction(gt, { errors: [{ kind: 'cost-sharing-error', fieldRef: d.fieldRef }] });
      assert.equal(s.errors.falseAlarms, 1, `${seed}: flagging a decoy is a false alarm`);
    }
  });
}

// ---------- rendered: the page prints what the key records (seeds 1-3 per operation and layout) ----------
const pdftotext = (pdf, page) => execFileSync('pdftotext', ['-layout', '-f', String(page), '-l', String(page), pdf, '-'], { encoding: 'utf-8' });
const money = (n) => '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
test('rendered: each operation prints its actual value on the anchor row, not the expected one', { skip, timeout: 900000 }, async () => {
  const browser = await launchBrowser();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-'));
  try {
    for (const [op, mk] of Object.entries(CASES)) for (const type of TYPES) {
      const c = mk(type); if (!c) continue;
      for (const seed of SEEDS.slice(0, 3)) {
        const { data, groundTruth: gt } = gen(type, seed, c.ov); const e = gt.errors[0];
        const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
        const work = fs.mkdtempSync(path.join(tmp, 'w')); const pdf = await RENDERERS[type](data, stock, work, { title: 't', band: `${type} / ${op} / ${seed}`, browser });
        const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
        const ci = Number(/^claims\[(\d+)\]/.exec(e.lineRef)[1]); const claimNo = data.claims[ci].claimNumber;
        // the claims page holding the claim's detail block: the claim number with its lines (not the cover's list)
        let text = null;
        for (let p = 2; p <= pages; p++) { const t = pdftotext(pdf, p); if (t.includes(claimNo) && /\d+\/\d+\/\d{2}/.test(t)) { text = t; break; } }
        assert.ok(text, `${type} ${op} ${seed}: the claim's page`);
        const lines = text.split('\n');
        if (op === 'ma-break-claim-total') {
          // the claim's own totals row: "Claim total, <number>" on the PPO; on the HMO the first "Total for this claim"
          // after the "Claim <number> |" header. Its last amount is the member's column.
          let ti;
          if (type === 'ppo-eob') ti = lines.findIndex((l) => l.includes(`Claim total, ${claimNo}`));
          else { const h = lines.findIndex((l) => l.includes(`Claim ${claimNo} |`)); ti = h < 0 ? -1 : lines.findIndex((l, i) => i > h && /^\s*Total for this claim/.test(l)); }
          assert.ok(ti >= 0, `${type} ${seed}: the claim's totals row`);
          const last = lines[ti].match(/\$[\d,]+\.\d{2}/g)?.at(-1);
          assert.equal(last, money(e.actual), `${type} ${seed}: the shifted total is on the claim's totals row`);
          assert.notEqual(last, money(e.expected), `${type} ${seed}: the correct total is not on the claim's totals row`);
          continue;
        }
        const line = gt.claims[ci].lines[Number(/lines\[(\d+)\]/.exec(e.lineRef)[1])];
        const ds = shortDate[type](line.dateOfService);
        let anchors;
        if (type === 'ppo-eob') anchors = lines.map((l, i) => i).filter((i) => lines[i].includes(ds) && lines[i].includes(line.code));
        else anchors = lines.map((l, i) => i).filter((i) => lines[i].includes(`Code ${line.code}`) && lines[i].includes(`Date ${ds}`)).map((i) => { let k = i - 1; while (k >= 0 && !/\$\d/.test(lines[k])) k--; return k; });
        if (op === 'ma-duplicate-line') { assert.equal(anchors.length, 2, `${type} ${seed}: the code-and-date pair prints twice`); continue; }
        assert.equal(anchors.length, 1, `${type} ${op} ${seed}: one anchor row`); const row = lines[anchors[0]];
        if (op === 'ma-shift-date') continue; // the row was found by its (shifted) date
        if (op === 'ma-deny-line') { assert.ok(row.includes('$0.00')); continue; }
        assert.ok(row.includes(money(e.actual)), `${type} ${op} ${seed}: the actual share on the anchor row`);
        if (e.expected > 0) assert.ok(!row.includes(money(e.expected)) || money(e.expected) === money(line.allowed), `${type} ${op} ${seed}: the expected share not on the row`);
      }
    }
  } finally { await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- examples: one per published scenario, the MA error and decoy scenarios included ----------
test('the example set holds the 20 scenarios of 0.4.0 and the 14 Medicare Advantage error and decoy scenarios', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '../../../examples/manifest.json'), 'utf-8'));
  const published = ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob'].flatMap((t) => listScenarios(t).map((s) => `${t}/${s}`));
  const ma = published.filter((k) => /^(ppo|hmo)-eob\//.test(k) && !k.endsWith('/baseline-clean'));
  assert.equal(ma.length, 14, 'Medicare Advantage error and decoy scenarios');
  assert.equal(published.length, 34, 'published scenarios');
  const plain = manifest.examples.filter((e) => !e.layoutVariant);
  assert.deepEqual(plain.map((e) => `${e.type}/${e.scenario}`).sort(), published.sort());
  assert.equal(plain.length, 34);
  // and one per layout variant id, on the type's published scenarios in turn (0.5.0)
  const varied = manifest.examples.filter((e) => e.layoutVariant);
  const pub = (t) => listScenarios(t).filter((s) => published.includes(`${t}/${s}`));
  const want = ['itemized-bill', 'ppo-eob', 'hmo-eob'].flatMap((t) => variantIds(t).map((id, i) => `${t}/${pub(t)[i % pub(t).length]}.${id}`));
  assert.deepEqual(varied.map((e) => `${e.type}/${e.scenario}.${e.layoutVariant}`), want);
  assert.equal(varied.length, 36); assert.equal(manifest.examples.length, 70);
  for (const e of varied) assert.equal(e.file, `${e.type}_${e.scenario}_example.${e.layoutVariant}.pdf`);
});
