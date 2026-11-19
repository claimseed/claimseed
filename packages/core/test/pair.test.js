// A Medicare Advantage EOB and the provider's statement for one of its claims (src/generate/provider-statement.js):
// the EOB is the same with or without its statement; the statement agrees with the EOB on everything the two share and
// adds up on its own; which claim it bills depends only on its own stream; and it carries exactly the provider-side
// errors and decoys of that claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateData, generatePair, listScenarios } from '../src/generate/index.js';
import { makeRng } from '../src/generate/rng.js';

const TYPES = ['ppo-eob', 'hmo-eob'];
const SEEDS = Array.from({ length: 20 }, (_, i) => `pair-${i + 1}`);
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const sum = (xs) => r2(xs.reduce((s, x) => s + x, 0));
const each = function* () { for (const type of TYPES) for (const scenario of listScenarios(type)) for (const seed of SEEDS) yield { type, scenario, seed }; };
const share = (type, l) => (type === 'ppo-eob' ? l.yourShare : l.maxYouMayBeBilled);
const paid = (type, l) => (type === 'ppo-eob' ? l.planShare : l.amountPlanPaid);
const charge = (type, l) => (type === 'ppo-eob' ? l.providerBilled : l.providersCharged);
const code = (type, l) => (type === 'ppo-eob' ? l.cptCode : l.billingCode);

test('the EOB of a pair is the EOB alone, data and key', () => {
  // the data's internal path functions are made anew on each call, so the data is compared as the JSON it is written as
  const plain = (d) => JSON.parse(JSON.stringify(d));
  for (const job of each()) {
    const p = generatePair(job).eob; const alone = generateData(job); const where = `${job.type}/${job.scenario}/${job.seed}`;
    assert.deepEqual(p.groundTruth, alone.groundTruth, where); assert.deepEqual(plain(p.data), plain(alone.data), where);
  }
});

test('the statement agrees with its claim on the EOB, and its balance is the member share the EOB prints', () => {
  for (const job of each()) {
    const { eob, statement } = generatePair(job); const s = statement.data; const k = statement.groundTruth.pair.claim;
    const c = eob.data.claims[k]; const where = `${job.type}/${job.scenario}/${job.seed}`;
    assert.equal(s.metadata.claimNumber, c.claimNumber, where);
    assert.equal(s.metadata.memberId, eob.data.metadata.memberId, where);
    assert.equal(s.metadata.planName, eob.data.metadata.planName, where);
    assert.equal(s.metadata.providerName.toUpperCase(), c.providerName.toUpperCase(), where);
    assert.equal(s.metadata.npi, eob.groundTruth.documents[0].entities.providers[k].npi, where);
    assert.deepEqual(s.lineItems.map((l) => [l.code, l.charge]), c.lineItems.map((l) => [code(job.type, l), charge(job.type, l)]), where);
    assert.equal(s.summary.totalCharges, sum(c.lineItems.map((l) => charge(job.type, l))), where);
    assert.equal(s.summary.paidByPlan, sum(c.lineItems.map((l) => paid(job.type, l))), where);
    assert.equal(s.summary.balanceDue, sum(c.lineItems.map((l) => share(job.type, l))), where);
  }
});

test('every statement adds up from its own printed rows, each row at or above zero', () => {
  for (const job of each()) {
    const { summary: t, lineItems } = generatePair(job).statement.data; const where = `${job.type}/${job.scenario}/${job.seed}`;
    assert.equal(t.totalCharges, sum(lineItems.map((l) => l.charge)), where);
    assert.equal(t.balanceDue, r2(t.totalCharges - t.contractualAdjustment - (t.deniedNotBilled ?? 0) - t.paidByPlan - t.paymentsReceived), where);
    for (const v of [t.totalCharges, t.contractualAdjustment, t.deniedNotBilled ?? 0, t.paidByPlan, t.paymentsReceived, t.balanceDue]) assert.ok(v >= 0, where);
  }
});

test('the claim billed is the first draw of the statement\'s own stream, whatever the EOB\'s operations', () => {
  const counts = new Map();
  for (const type of TYPES) for (const scenario of listScenarios(type)) for (let i = 1; i <= 200; i++) {
    const seed = `ix-${i}`; const p = generatePair({ type, scenario, seed }); const n = p.eob.groundTruth.claims.length;
    assert.equal(p.statement.groundTruth.pair.claim, Math.floor(makeRng(seed, type, scenario, 'pair-bill')() * n), `${type}/${scenario}/${seed}`);
    const c = counts.get(n) ?? new Set(); c.add(p.statement.groundTruth.pair.claim); counts.set(n, c);
  }
  for (const [n, seen] of counts) assert.equal(seen.size, n, `every claim of a ${n}-claim EOB is billed for some seed`);
});

test('the statement carries the provider-side errors and decoys of its claim, keyed on its own lines, and no others', () => {
  const passedErrors = new Set(['duplicate-charge', 'service-date-anomaly']);
  const passedDecoys = new Set(['repeat-service-different-date', 'charge-above-approved']);
  const seen = { errors: new Set(), decoys: new Set() };
  for (const job of each()) {
    const { eob, statement } = generatePair(job); const k = statement.groundTruth.pair.claim; const key = statement.groundTruth;
    const mine = (x) => x.lineRef.startsWith(`claims[${k}].`);
    const wantE = eob.groundTruth.errors.filter((e) => mine(e) && passedErrors.has(e.kind));
    const wantD = eob.groundTruth.decoys.filter((d) => mine(d) && passedDecoys.has(d.kind));
    assert.deepEqual(key.errors.map((e) => e.kind), wantE.map((e) => e.kind));
    assert.deepEqual(key.decoys.map((d) => d.kind), wantD.map((d) => d.kind));
    for (const [x, from] of [...key.errors.map((e, i) => [e, wantE[i]]), ...key.decoys.map((d, i) => [d, wantD[i]])]) {
      const j = Number(/lines\[(\d+)\]$/.exec(from.lineRef)[1]);
      assert.equal(x.lineRef, `claims[0].lines[${j}]`); assert.equal(x.fieldRef, `lineItems[${j}]`);
      assert.equal(x.documentId, 'provider-statement-1'); assert.equal(x.relatedDocumentId, eob.groundTruth.documents[0].id);
      assert.equal(x.relatedDocumentFieldRef, from.fieldRef);
      assert.ok(Object.hasOwn(key.documents[0].fields, `${x.fieldRef}.code`));
    }
    for (const e of key.errors) seen.errors.add(e.kind); for (const d of key.decoys) seen.decoys.add(d.kind);
  }
  assert.deepEqual([...seen.errors].sort(), [...passedErrors].sort(), 'both passed error kinds occur over these seeds');
  assert.deepEqual([...seen.decoys].sort(), [...passedDecoys].sort(), 'both passed decoy kinds occur over these seeds');
});

test('a statement is made for the two Medicare Advantage EOBs only', () => {
  for (const type of ['msn', 'itemized-bill', 'provider-statement', { toString: null }, ['ppo-eob']])
    assert.throws(() => generatePair({ type, scenario: 'baseline-clean', seed: 's' }), (e) => !(e instanceof TypeError) && /^pair: /.test(e.message));
});

// ---- statement variants ------------------------------------------------------------------------------------------
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { scoreExtraction } from '../src/verify.js';
import { BILL_VARIANTS, PAIR_STRINGS } from '../src/generate/provider-statement.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8')));
const msg = (k) => PAIR_STRINGS.messages[k].replace('{who}', 'pair').replace('{variants}', BILL_VARIANTS.join(', '));
// the two keys as render links them: each names the other's id, both at 1.6
const linked = (p) => {
  const eob = structuredClone(p.eob.groundTruth); const st = structuredClone(p.statement.groundTruth);
  eob.schemaVersion = '1.6'; eob.pair = { ...st.pair, role: 'eob', with: st.documents[0].id }; st.pair.with = eob.documents[0].id;
  return { eob, st };
};

test('each statement variant changes only its rows, keeps the statement adding up, and is keyed where the design says', () => {
  const seen = new Set();
  for (const job of each()) for (const bill of BILL_VARIANTS) {
    const p = generatePair({ ...job, bill, orClean: true }); const st = p.statement; const t = st.data.summary; const key = st.groundTruth;
    const clean = generatePair(job).statement.data.summary; const where = `${job.type}/${job.scenario}/${job.seed}/${bill}`;
    const v = key.pair.variant; seen.add(v);
    assert.ok(v === bill || v === 'clean', where);
    assert.equal(t.balanceDue, r2(t.totalCharges - t.contractualAdjustment - (t.deniedNotBilled ?? 0) - t.paidByPlan - t.paymentsReceived), where);
    for (const x of Object.values(t)) assert.ok(x === null || x >= 0, where);
    assert.equal(t.totalCharges, clean.totalCharges, where);
    const errs = key.errors.filter((e) => e.kind.startsWith('bill-')); const dec = key.decoys.filter((d) => d.kind === 'paid-at-visit');
    const { by = 0, amount = 0 } = key.pair.params;
    if (v === 'clean') { assert.deepEqual(t, clean, where); assert.equal(errs.length + dec.length, 0, where); }
    if (v === 'over-owed') { assert.equal(t.balanceDue, r2(clean.balanceDue + by), where); assert.deepEqual(errs.map((e) => [e.kind, e.fieldRef, e.relatedFieldRef]), [['bill-vs-eob-mismatch', 'summary.balanceDue', 'summary.contractualAdjustment']], where); }
    if (v === 'denied-line-billed') { assert.ok(t.balanceDue > clean.balanceDue, where); assert.equal(errs.length, 1, where); assert.equal(errs[0].fieldRef, 'summary.balanceDue'); assert.match(errs[0].relatedFieldRef, /^lineItems\[\d+\]$/); }
    if (v === 'payment-misposted') { assert.equal(t.balanceDue, clean.balanceDue, where); assert.equal(t.paidByPlan, r2(clean.paidByPlan + by), where); assert.ok(by !== 0, where);
      assert.deepEqual(errs.map((e) => [e.kind, e.fieldRef, e.severity]), [['bill-payment-mismatch', 'summary.paidByPlan', 'low']], where); }
    if (v === 'paid-at-visit') { assert.equal(t.balanceDue, r2(clean.balanceDue - amount), where); assert.equal(errs.length, 0, where);
      assert.deepEqual(dec.map((d) => [d.fieldRef, d.relatedFieldRef]), [['summary.paymentsReceived', 'summary.balanceDue']], where); }
    if (v === 'over-owed-with-payment') { assert.equal(t.balanceDue, r2(clean.balanceDue - amount + by), where); assert.equal(errs.length, 1, where); assert.equal(dec.length, 1, where); }
    for (const x of [...key.errors, ...key.decoys].filter((y) => y.kind.startsWith('bill-') || y.kind === 'paid-at-visit')) {
      assert.equal(x.relatedDocumentId, p.eob.groundTruth.documents[0].id, where);
      assert.ok(Object.hasOwn(p.eob.groundTruth.documents[0].fields, x.relatedDocumentFieldRef) || Object.keys(p.eob.groundTruth.documents[0].fields).some((f) => f.startsWith(`${x.relatedDocumentFieldRef}.`)), `${where} ${x.relatedDocumentFieldRef}`);
      assert.ok(Object.hasOwn(key.documents[0].fields, x.fieldRef), `${where} ${x.fieldRef}`);
    }
    // the variant draws after everything else: the statement's other content is the clean one's
    assert.deepEqual(st.data.metadata, generatePair(job).statement.data.metadata, where);
    const { eob, st: sk } = linked(p);
    assert.ok(validate(eob), `${where} eob key: ${ajv.errorsText(validate.errors)}`);
    assert.ok(validate(sk), `${where} statement key: ${ajv.errorsText(validate.errors)}`);
  }
  assert.deepEqual([...seen].sort(), [...BILL_VARIANTS].sort(), 'every variant applies somewhere over these seeds');
});

test('a variant that does not apply, an unknown variant and amounts out of range are refused with fixed messages', () => {
  const ran = () => { throw new Error('the value ran code'); };
  const exact = (k) => (e) => e.code === 'PAIR' && e.message === msg(k);
  const base = { type: 'ppo-eob', scenario: 'baseline-clean' };
  for (const bill of ['nope', '', 'Clean', { toString: ran }, ['clean'], 7, null]) assert.throws(() => generatePair({ ...base, seed: 's1', bill }), exact('billVariant'), JSON.stringify(bill));
  // a seed whose billed claim has no denied line
  assert.throws(() => generatePair({ ...base, seed: 's1', bill: 'denied-line-billed' }), exact('billNotHere'));
  // find a seed where over-owed applies, then try amounts
  let seed = null; for (let i = 1; i < 50 && !seed; i++) { const p = generatePair({ ...base, seed: `a${i}`, bill: 'over-owed', orClean: true }); if (p.statement.groundTruth.pair.variant === 'over-owed') seed = `a${i}`; }
  assert.ok(seed);
  const ok = generatePair({ ...base, seed, bill: 'over-owed', billParams: { by: 1.23 } });
  assert.deepEqual(ok.statement.groundTruth.pair.params, { by: 1.23 });
  for (const billParams of [{ by: 1.234 }, { by: 0 }, { by: -1 }, { by: 1e9 }, { by: '1.00' }, { amount: 1 }, { by: 1, x: 2 }, [1], Object.create(null), { by: { valueOf: ran } }])
    assert.throws(() => generatePair({ ...base, seed, bill: 'over-owed', billParams }), exact('billAmount'), JSON.stringify(billParams));
});

test('verify scores the statement\'s errors at the balance or the payment, and a fooled report at the balance against the decoy', () => {
  const report = (kind, fieldRef) => ({ errors: [{ kind, fieldRef }] });
  let n = 0;
  for (const job of each()) for (const bill of ['over-owed', 'denied-line-billed', 'payment-misposted', 'paid-at-visit']) {
    const p = generatePair({ ...job, bill, orClean: true }); const key = p.statement.groundTruth; if (key.pair.variant !== bill) continue; n++;
    const atBalance = scoreExtraction(key, report('bill-vs-eob-mismatch', 'summary.balanceDue')).errors;
    const atPayment = scoreExtraction(key, report('bill-payment-mismatch', 'summary.paidByPlan')).errors;
    const where = `${job.type}/${job.scenario}/${job.seed}/${bill}`;
    if (bill === 'over-owed' || bill === 'denied-line-billed') { assert.equal(atBalance.found, 1, where); assert.equal(atPayment.falseAlarms, 1, where); }
    if (bill === 'payment-misposted') { assert.equal(atPayment.found, 1, where); assert.equal(atBalance.falseAlarms, 1, where); }
    if (bill === 'paid-at-visit') { assert.equal(atBalance.falseAlarms, 1, where); assert.deepEqual(atBalance.decoysFlagged, key.decoys.filter((d) => d.kind === 'paid-at-visit').map((d) => d.id), where); }
    if (bill === 'denied-line-billed') {
      const line = key.errors.find((e) => e.kind === 'bill-vs-eob-mismatch').relatedFieldRef;
      assert.equal(scoreExtraction(key, report('bill-vs-eob-mismatch', line)).errors.found, 1, `${where}: a report at the denied line counts`);
    }
  }
  assert.ok(n > 50, `${n} variant statements scored`);
});

test('a claim whose EOB total does not add up gets only a clean statement, which follows the lines', () => {
  let billed = 0;
  for (const type of TYPES) for (let i = 1; i <= 60; i++) {
    const job = { type, scenario: 'claim-total-math-error', seed: `mis-${i}` };
    const { eob, statement } = generatePair({ ...job, bill: 'over-owed', orClean: true }); const k = statement.groundTruth.pair.claim;
    if (!eob.groundTruth.errors.some((e) => e.kind === 'math-error' && e.lineRef.startsWith(`claims[${k}].`))) continue;
    billed++;
    assert.equal(statement.groundTruth.pair.variant, 'clean'); assert.deepEqual(statement.groundTruth.errors, []);
    const lines = eob.groundTruth.claims[k].lines; const t = statement.data.summary;
    assert.equal(t.balanceDue, sum(lines.map((l) => l.patientMayBeBilled)), `${type} ${job.seed}: the balance is the lines' member share`);
    for (const bill of ['over-owed', 'payment-misposted']) assert.throws(() => generatePair({ ...job, bill }), (e) => e.code === 'PAIR' && /does not apply/.test(e.message));
  }
  assert.ok(billed >= 10, `billed a misprinted claim ${billed} times`);
});

test('the error and the decoy on one statement carry their own rules, each true of that statement', () => {
  let n = 0;
  for (const type of TYPES) for (let i = 1; i <= 40; i++) {
    const p = generatePair({ type, scenario: 'baseline-clean', seed: `both-${i}`, bill: 'over-owed-with-payment', orClean: true }).statement;
    if (p.groundTruth.pair.variant !== 'over-owed-with-payment') continue;
    n++;
    assert.equal(p.groundTruth.errors[0].rule, PAIR_STRINGS.rules.overOwedWithPayment); assert.equal(p.groundTruth.decoys.at(-1).rule, PAIR_STRINGS.rules.paidAtVisitWithError);
    const t = p.data.summary; const e = p.groundTruth.errors[0];
    assert.ok(e.delta > 0 && r2(t.balanceDue + t.paymentsReceived) > r2(e.expected + t.paymentsReceived), 'the balance plus the visit payment is above the EOB share');
  }
  assert.ok(n > 0);
});
