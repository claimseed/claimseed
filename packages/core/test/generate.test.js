import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { generateData, listScenarios, loadScenario, SCENARIOS_DIR, ASSEMBLERS } from '../src/generate/index.js';
import { isSyntheticNpi, isSyntheticMbi, syntheticNpi, syntheticMbi, luhnCheckDigit } from '../src/generate/identifiers.js';
import { makeRng } from '../src/generate/rng.js';
import { OPS } from '../src/generate/mutations.js';
import { CLAIM_SHAPE_NAMES } from '../src/generate/encounter.js';

const SEEDS = ['t1', 't2', 'alpha', 'beta', 'gamma', '0', '12345', 'claimseed', 'x', 'y', 'z', 'seed-11', 'seed-12', 'seed-13', 'seed-14', 'seed-15'];
const TYPES = fs.readdirSync(SCENARIOS_DIR).filter((d) => fs.statSync(path.join(SCENARIOS_DIR, d)).isDirectory());
const TAXONOMY = fs.readFileSync(path.join(SCENARIOS_DIR, '../../../docs/error-taxonomy.md'), 'utf-8');
const near = (a, b) => Math.abs(a - b) < 0.005;

// ---------- identifiers ----------
test('identifiers are synthetic by construction', () => {
  const rng = makeRng('ids');
  for (let i = 0; i < 500; i++) {
    const npi = syntheticNpi(rng); assert.ok(isSyntheticNpi(npi), npi); assert.equal(npi[0], '9');
    const mbi = syntheticMbi(rng); assert.ok(isSyntheticMbi(mbi), mbi); assert.equal(mbi[1], 'S');
  }
  // Luhn sanity: the NPI check digit is computed over the 80840 prefix (CMS NPI check-digit instructions)
  assert.equal(luhnCheckDigit('80840' + '123456789'), 3);
});

// ---------- determinism ----------
test('same seed, same output; different seed, different member', () => {
  const a = generateData({ type: 'msn', scenario: 'combined-three-errors', seed: 't1' });
  const b = generateData({ type: 'msn', scenario: 'combined-three-errors', seed: 't1' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'x' });
  const d = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'y' });
  assert.notEqual(c.data.metadata.medicareNumber, d.data.metadata.medicareNumber);
});

// ---------- scenario catalog ----------
test('every scenario file is well-formed and published', () => {
  for (const type of TYPES) {
    const slugs = listScenarios(type);
    assert.ok(slugs.length >= (type === 'msn' ? 10 : 1), `${type} has ${slugs.length} scenarios`);
    assert.ok(ASSEMBLERS[type], `no assembler for scenario type ${type}`);
    for (const slug of slugs) {
      const s = loadScenario(type, slug);
      assert.equal(s.type, type, `${type}/${slug}: type`);
      assert.equal(s.slug, slug, `${type}/${slug}: slug must equal filename`);
      assert.equal(s.status, 'published', `${type}/${slug}: status`);
      assert.ok(typeof s.description === 'string' && s.description.length > 40, `${type}/${slug}: description`);
      assert.match(s.period.start, /^\d{4}-\d{2}-\d{2}$/); assert.match(s.period.end, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isInteger(s.claimCount) && s.claimCount >= 1 && s.claimCount <= 6, `${type}/${slug}: claimCount`);
      assert.ok(s.sources.length >= 2 && s.sources.length <= 4, `${type}/${slug}: 2–4 sources`);
      for (const src of s.sources) {
        assert.ok(src.what && src.source, `${type}/${slug}: source needs what+source`);
        assert.ok(/https?:\/\//.test(src.source) || /(CFR|U\.S\.C\.|Social Security Act|Manual|taxonomy)/.test(src.source), `${type}/${slug}: source must be a URL or a precise citation: ${src.source}`);
      }
      for (const sh of s.claimShapes || []) if (sh) assert.ok(CLAIM_SHAPE_NAMES.includes(sh), `${type}/${slug}: unknown claim shape ${sh}`);
      for (const m of s.mutations) {
        assert.ok(OPS[m.op], `${type}/${slug}: unknown op ${m.op}`);
        assert.ok(m.args.claim < s.claimCount, `${type}/${slug}: claim index ${m.args.claim} >= claimCount`);
      }
    }
  }
});

test('every scenario generates for many seeds, each mutation lands and reports a taxonomy kind', () => {
  for (const type of TYPES) for (const slug of listScenarios(type)) {
    const s = loadScenario(type, slug);
    for (const seed of SEEDS) {
      const { data, groundTruth } = generateData({ type, scenario: slug, seed });
      assert.equal(groundTruth.errors.length, s.mutations.length, `${type}/${slug}@${seed}: one ground-truth error per mutation`);
      for (const e of groundTruth.errors) {
        assert.ok(TAXONOMY.includes('`' + e.kind + '`'), `${type}/${slug}@${seed}: kind ${e.kind} not in docs/error-taxonomy.md`);
        assert.ok(e.rule && e.severity && e.documentId, `${type}/${slug}@${seed}: error fields`);
      }
      assert.equal(groundTruth.scenario, `${type}.${slug}`);
      assert.ok(groundTruth.sources.length >= s.sources.length);
      // every provider NPI in the ground truth is synthetic
      for (const p of groundTruth.documents[0].entities.providers) assert.ok(isSyntheticNpi(p.npi), p.npi);
      // no phone outside the fiction block anywhere in the rendered fields
      for (const v of Object.values(groundTruth.documents[0].fields)) {
        if (typeof v !== 'string') continue;
        for (const m of v.matchAll(/\b(\d{3})-(\d{3})-(\d{4})\b/g)) assert.match(m[0], /^[2-9]\d{2}-555-01\d{2}$/, `${type}/${slug}@${seed}: phone ${m[0]}`);
      }
      assert.ok(data.metadata, 'assembler returns metadata');
    }
  }
});

// ---------- MSN behaviour ----------
test('clean MSN controls have no errors and consistent sums', () => {
  for (const slug of ['baseline-clean', 'control-clean-january']) for (const seed of SEEDS.slice(0, 6)) {
    const { data, groundTruth } = generateData({ type: 'msn', scenario: slug, seed });
    assert.equal(groundTruth.errors.length, 0);
    let total = 0;
    for (const c of data.claims) {
      const s = c.lineItems.reduce((t, l) => t + l.maxYouMayBeBilled, 0);
      assert.ok(near(s, c.claimTotal.maxYouMayBeBilled), `${slug}@${seed}: claim total`);
      total += c.claimTotal.maxYouMayBeBilled;
      const codes = c.lineItems.map((l) => l.cptCode);
      assert.equal(new Set(codes).size, codes.length, `${slug}@${seed}: a clean claim never repeats a code`);
      for (const code of codes) assert.match(code, /^[0-9A-Z]{5}$/);
    }
    assert.ok(near(total, data.summary.totalYouMayBeBilled));
    assert.equal(data.summary.allServicesApproved, 'YES');
  }
  const ref = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'any' });
  assert.match(ref.data.metadata.memberName, /SPECIMEN$/);
});

test('forced claim shapes put the mutation on the intended kind of line for any seed', () => {
  for (const seed of SEEDS) {
    const lab = generateData({ type: 'msn', scenario: 'lab-coinsurance-charged', seed });
    assert.equal(lab.groundTruth.errors[0].kind, 'cost-sharing-error');
    assert.ok(lab.data.claims[0].lineItems[0].maxYouMayBeBilled > 0, `${seed}: lab line now carries coinsurance`);
    assert.ok(lab.data.claims[0].lineItems.slice(1).every((l) => l.maxYouMayBeBilled === 0), `${seed}: other lab lines still $0`);
    const prev = generateData({ type: 'msn', scenario: 'preventive-visit-cost-sharing', seed });
    assert.equal(prev.groundTruth.errors[0].kind, 'preventive-cost-sharing');
    assert.ok(['G0439'].includes(prev.data.claims[0].lineItems[0].cptCode), `${seed}: preventive line 0`);
    const dup = generateData({ type: 'msn', scenario: 'duplicate-office-visit', seed });
    const [l0, l1] = dup.data.claims[0].lineItems;
    assert.equal(l0.cptCode, l1.cptCode); assert.equal(l0.dateOfService, l1.dateOfService); assert.equal(l0.amountProviderCharged, l1.amountProviderCharged);
    assert.match(l0.cptCode, /^992/, `${seed}: cardiology claim starts with an office visit`);
  }
});

test('denied line is printed as NO with its note and the dashboard counts it', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const { data, groundTruth } = generateData({ type: 'msn', scenario: 'denied-not-reasonable-necessary', seed });
    const line = data.claims[0].lineItems[1];
    assert.equal(line.cptCode, '11102'); assert.equal(line.serviceApproved, 'NO'); assert.equal(line.medicareApprovedAmount, 0);
    assert.equal(line.maxYouMayBeBilled, line.amountProviderCharged);
    const letter = line.noteLetters[0];
    assert.match(data.notes.find((n) => n.letter === letter).text, /reasonable and necessary/);
    assert.equal(data.summary.deniedCount, 1); assert.equal(data.summary.allServicesApproved, 'NO');
    assert.equal(groundTruth.errors[0].kind, 'coverage-denial'); assert.match(groundTruth.errors[0].rule, /1862/);
  }
});

test('reapply-deductible keeps the line footing and never pays a negative amount', () => {
  for (const seed of SEEDS) {
    const { data, groundTruth } = generateData({ type: 'msn', scenario: 'deductible-applied-after-met', seed });
    const l = data.claims[0].lineItems[0];
    assert.ok(l.amountMedicarePaid >= 0, `${seed}: paid ${l.amountMedicarePaid}`);
    assert.ok(near(l.amountMedicarePaid + l.maxYouMayBeBilled, l.medicareApprovedAmount), `${seed}: paid + patient = approved`);
    assert.equal(data.deductible.met, data.deductible.annual, 'deductible status says it was already met');
    assert.equal(groundTruth.errors[0].kind, 'deductible-misapplied'); assert.ok(groundTruth.errors[0].delta > 0);
  }
});

test('shift-date moves the line after the notice date', () => {
  const { data, groundTruth } = generateData({ type: 'msn', scenario: 'service-date-after-notice', seed: 't1' });
  const e = groundTruth.errors[0]; assert.equal(e.kind, 'service-date-anomaly');
  assert.ok(e.actual > e.expected && e.actual > '2026-04-12', e.actual);
  assert.equal(data.claims[0].lineItems[0].dateOfService.slice(-4), '2026');
});

test('math-error overstates the claim total and flows to the page-1 total', () => {
  const { data, groundTruth } = generateData({ type: 'msn', scenario: 'claim-total-math-error', seed: 't1' });
  const c = data.claims[0]; const s = c.lineItems.reduce((t, l) => t + l.maxYouMayBeBilled, 0);
  assert.ok(near(c.claimTotal.maxYouMayBeBilled - s, 12.5));
  assert.equal(groundTruth.errors[0].delta, 12.5);
  const all = data.claims.reduce((t, c) => t + c.claimTotal.maxYouMayBeBilled, 0);
  assert.ok(near(all, data.summary.totalYouMayBeBilled));
});

// ---------- itemized bill ----------
test('itemized bill: groups mirror claims, subtotals foot, insurance summary reconciles (clean)', () => {
  for (const seed of SEEDS) {
    const { data, groundTruth } = generateData({ type: 'itemized-bill', scenario: 'baseline-clean', seed });
    assert.equal(groundTruth.errors.length, 0);
    assert.equal(data.revenueCodeGroups.length, 3);
    assert.deepEqual(data.revenueCodeGroups.map((g) => g.revCode), ['0510', '0300', '0320']);
    let total = 0;
    for (const g of data.revenueCodeGroups) {
      const s = g.lineItems.reduce((t, l) => t + l.amount, 0);
      assert.ok(near(s, g.subtotal), `${seed}: subtotal ${g.revCode}`); total += s;
      for (const l of g.lineItems) { assert.match(l.hcpcs, /^[0-9A-Z]{5}$/); assert.match(l.date, /^\d{2}\/\d{2}\/\d{4}$/); assert.ok(l.amount > 0); }
    }
    assert.ok(near(total, data.grandTotal));
    const s = data.insuranceSummary;
    assert.ok(near(s.totalCharges, data.grandTotal));
    assert.ok(near(s.medicarePaid + s.deductibleApplied + s.coinsurance, s.medicareApproved), `${seed}: approved splits into paid + deductible + coinsurance`);
    assert.ok(near(s.balanceDue, s.deductibleApplied + s.coinsurance), `${seed}: clean balance due = cost sharing`);
    assert.ok(near(data.agingSummary.total, s.balanceDue));
    const m = data.metadata;
    assert.match(m.taxId, /^00-\d{7}$/); assert.match(m.websiteUrl, /\.example$/); assert.match(m.hospitalPhone, /^[2-9]\d{2}-555-01\d{2}$/);
    assert.match(m.patientName, /Specimen$/); assert.ok(isSyntheticMbi(m.medicareNumber));
    const ents = groundTruth.documents[0].entities;
    assert.equal(ents.providers.length, 1); assert.equal(ents.providers[0].name, m.hospitalName); assert.equal(ents.identifiers.accountNumber, m.accountNumber);
  }
});

test('itemized bill: duplicate, subtotals-mismatch and balance-billing scenarios', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    const dup = generateData({ type: 'itemized-bill', scenario: 'duplicate-charge', seed });
    const [a, b] = dup.data.revenueCodeGroups[0].lineItems;
    assert.equal(dup.groundTruth.errors[0].kind, 'duplicate-charge');
    assert.deepEqual([a.hcpcs, a.date, a.amount], [b.hcpcs, b.date, b.amount]);

    const mis = generateData({ type: 'itemized-bill', scenario: 'subtotals-mismatch', seed });
    assert.equal(mis.groundTruth.errors[0].kind, 'subtotals-mismatch', 'kind override from the scenario file');
    const g0 = mis.data.revenueCodeGroups[0];
    assert.ok(near(g0.subtotal - g0.lineItems.reduce((t, l) => t + l.amount, 0), 25));
    const groupSum = mis.data.revenueCodeGroups.reduce((t, g) => t + g.subtotal, 0);
    assert.ok(!near(groupSum, mis.data.grandTotal), 'subtotals no longer add up to the grand total');
    assert.ok(near(mis.data.insuranceSummary.totalCharges, mis.data.grandTotal));

    const bb = generateData({ type: 'itemized-bill', scenario: 'balance-billing', seed });
    const e = bb.groundTruth.errors[0];
    assert.equal(e.kind, 'assignment-violation'); assert.match(e.rule, /1395u\(b\)\(3\)\(B\)\(ii\)/); assert.ok(e.delta > 0);
    const s = bb.data.insuranceSummary;
    assert.ok(s.balanceDue > s.deductibleApplied + s.coinsurance + 0.005, `${seed}: balance due exceeds approved cost sharing`);
    assert.ok(near(s.balanceDue - (s.deductibleApplied + s.coinsurance), e.delta));
    // Medicare's side of the same month is untouched: the MSN for this seed would print the approved share.
    assert.ok(near(e.expected + e.delta, e.actual));
  }
});

test('bill-above-approved refuses to run where it would not exceed the approved share', () => {
  const ctx = { claims: [{ lines: [{ charged: 10, allowed: 10, paid: 8, toDeductible: 0, coinsurance: 2, patientMayBeBilled: 2, approved: true }], totals: {} }], params: { partB: { coinsuranceRate: 0.2, deductible: 283 } } };
  assert.throws(() => OPS['bill-above-approved'](ctx, { claim: 0, line: 0 }), /does not exceed/);
  const ok = OPS['bill-above-approved'](ctx, { claim: 0, line: 0, mode: 'extra', by: 5 });
  assert.equal(ok.actual, 7); assert.equal(ok.delta, 5); assert.equal(ctx.claims[0].totals.providerBilled, 7); assert.equal(ctx.claims[0].totals.patientMayBeBilled, 2);
});

test('MA layouts generate and reconcile (ppo-eob, hmo-eob)', () => {
  for (const type of ['ppo-eob', 'hmo-eob']) {
    const { data, groundTruth } = generateData({ type, scenario: 'baseline-clean', seed: 'ma-1' });
    assert.ok(data.claims.length >= 1);
    for (const c of data.claims) {
      const tot = c.claimTotal;
      const sumYour = c.lineItems.reduce((s, l) => s + (l.yourShare ?? l.maxYouMayBeBilled), 0);
      assert.ok(Math.abs(sumYour - (tot.yourShare ?? tot.maxYouMayBeBilled)) < 0.005);
    }
    assert.ok(data.financialSummary.oopUsed <= data.financialSummary.oopMax);
    assert.equal(groundTruth.errors.length, 0);
    assert.ok(JSON.stringify(data).includes('SPECIMEN'));
  }
});
