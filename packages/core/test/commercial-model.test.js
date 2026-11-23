// The commercial employer-plan model (src/generate/commercial): each rule against a hand-worked claim, the model's
// invariants on every claim shape, both designs and both tiers over many seeds, and the data's own checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicateCommercial, startingAccumulators, preventiveFor, SERVICES, DESIGNS, CATALOG, PLACES, NSA_FACILITIES } from '../src/generate/commercial/adjudicate.js';
import { makeHousehold, clasProblems } from '../src/generate/commercial/household.js';
import { makeCommercialClaims, SHAPE_NAMES } from '../src/generate/commercial/encounters.js';
import { PLACES as LEXICON_PLACES } from '../src/generate/lexicon.js';
import { makeRng } from '../src/generate/rng.js';

const F40 = { id: 'a', age: 40, sex: 'F', flags: {} };
const M45 = { id: 'a', age: 45, sex: 'M', flags: {} };
const doc = (network, specialty = 'family-medicine') => ({ network, specialty });
const run = ({ design = 'ppo', tier = 'self', members = [F40], before, claims }) => adjudicateCommercial({ design, tier, members, before, claims });
const claim = (lines, extra = {}) => ({ id: 'c', memberId: extra.memberId || 'a', providers: { p: doc('in'), ...extra.providers }, markup: 1.5, ...extra, lines });
const line = (r, i = 0, j = 0) => r.claims[j].lines[i];
const self = (ded, oop, out = { ded: 0, oop: 0 }) => ({ person: { a: { in: { ded, oop }, out } } });

test('in network: allowed is the Medicare amount times the CBO multiple; deductible, then coinsurance on the rest', () => {
  const r = run({ before: self(1450, 1450), claims: [claim([{ service: 'chest-xray-facility' }, { service: 'chest-xray-reading', providerId: 'p' }], { facility: { network: 'in', type: 'hospital-outpatient' } })] });
  assert.deepEqual([line(r).allowed, line(r).deductible, line(r).coinsurance, line(r).planPaid], [198.27, 50, 29.65, 118.62], '88.91 x 2.23; $50 left of the deductible; 20% of the rest');
  assert.deepEqual([line(r, 1).allowed, line(r, 1).deductible, line(r, 1).coinsurance, line(r, 1).planPaid], [12.93, 0, 2.59, 10.34], '10.02 x 1.29 for the reading');
});

test('an office visit takes the copay only, with no deductible; copays count toward and stop at the out-of-pocket maximum', () => {
  const r = run({ claims: [claim([{ service: 'office-primary', providerId: 'p' }])] });
  assert.deepEqual([line(r).allowed, line(r).copay, line(r).deductible, line(r).planPaid], [122.8, 30, 0, 92.8]);
  assert.deepEqual(r.accumulators.person.a.in, { ded: 0, oop: 30 }, 'the copay counts toward the maximum, not the deductible');
  const near = run({ before: self(1500, 10590), claims: [claim([{ service: 'office-primary', providerId: 'p' }])] });
  assert.equal(line(near).copay, 10, 'the copay stops at the $10 left');
  const at = run({ before: self(1500, 10600), claims: [claim([{ service: 'office-primary', providerId: 'p' }])] });
  assert.equal(line(at).memberOwes, 0, 'at the maximum the member owes nothing');
});

test('the emergency-room facility line takes the $300 copay, then deductible and coinsurance on the rest', () => {
  const r = run({ before: self(1500, 1500), claims: [claim([{ service: 'er-facility' }, { service: 'er-physician', providerId: 'p' }], { emergency: true, facility: { network: 'in', type: 'hospital-emergency-department' }, providers: { p: doc('in', 'emergency-medicine') } })] });
  assert.deepEqual([line(r).allowed, line(r).copay, line(r).coinsurance, line(r).planPaid], [950.65, 300, 130.13, 520.52]);
  assert.deepEqual([line(r, 1).copay, line(r, 1).coinsurance], [0, 30.51], 'the physician line: coinsurance only');
});

test('family coverage: the family deductible met by others, the embedded per-person amounts, and the limits of the law', () => {
  const fam = [{ id: 'a', age: 40, sex: 'F', flags: {} }, { id: 'b', age: 41, sex: 'M', flags: {} }, { id: 'c', age: 9, sex: 'F', flags: {} }];
  const xr = (who) => claim([{ service: 'chest-xray-facility' }], { memberId: who, facility: { network: 'in', type: 'hospital-outpatient' } });
  const met = run({ tier: 'family', members: fam, before: { person: { a: { in: { ded: 1500, oop: 1500 } }, b: { in: { ded: 1500, oop: 1500 } } }, family: { in: { ded: 3000, oop: 3000 } } }, claims: [xr('c')] });
  assert.deepEqual([line(met).deductible, line(met).coinsurance], [0, 39.65], 'the family deductible met by a and b: c pays coinsurance only');
  const emb = run({ tier: 'family', members: fam, before: { person: { a: { in: { ded: 1400, oop: 1400 } } }, family: { in: { ded: 1400, oop: 1400 } } }, claims: [xr('a')] });
  assert.deepEqual([line(emb).deductible, line(emb).coinsurance], [100, 19.65], 'a stops at the $1,500 per-person deductible');
  const visit = (who) => claim([{ service: 'office-primary', providerId: 'p' }], { memberId: who });
  const lim = run({ tier: 'family', members: fam, before: { person: { a: { in: { ded: 1500, oop: 10600 } }, b: { in: { ded: 1500, oop: 10590 } } }, family: { in: { ded: 3000, oop: 21190 } } },
    claims: [visit('a'), visit('b'), visit('c')] });
  assert.equal(line(lim, 0, 0).memberOwes, 0, 'a person stops at $10,600');
  assert.equal(line(lim, 0, 1).copay, 10, 'the charge that brings the family exactly to $21,200');
  assert.equal(line(lim, 0, 2).memberOwes, 0, 'nobody is charged after the family reaches $21,200');
  assert.equal(lim.accumulators.family.in.oop, 21200);
});

test('preventive: $0 in network before the deductible; cost-shared out of network; age, sex and condition decide it', () => {
  const r = run({ claims: [claim([{ service: 'hepc-test', providerId: 'p' }])] });
  assert.deepEqual([line(r).memberOwes, line(r).planPaid, line(r).deductible], [0, line(r).allowed, 0]);
  assert.equal(line(r).preventive, 'uspstf-hepatitis-c-screening');
  const out = run({ claims: [claim([{ service: 'hepc-test', providerId: 'p', billed: 40 }], { providers: { p: doc('out') } })] });
  assert.deepEqual([line(out).allowed, line(out).deductible, line(out).balanceBillable, line(out).memberOwes], [15.7, 15.7, 24.3, 40], '14.27 x 1.10, to the out-of-network deductible');
  assert.equal(line(run({ members: [{ ...M45 }], claims: [claim([{ service: 'pap-test', providerId: 'p' }])] })).preventive, null, 'not for a man');
  assert.equal(line(run({ members: [{ id: 'a', age: 70, sex: 'F', flags: {} }], claims: [claim([{ service: 'hiv-test', providerId: 'p' }])] })).preventive, null, 'HIV screening is for ages 15 to 65');
  assert.equal(line(run({ claims: [claim([{ service: 'a1c-test', providerId: 'p' }])] })).preventive, null, 'diabetes screening needs overweight');
  assert.ok(line(run({ members: [{ ...F40, flags: { overweight: true } }], claims: [claim([{ service: 'a1c-test', providerId: 'p' }])] })).preventive);
  assert.equal(line(run({ claims: [claim([{ service: 'vaccine-admin-adult', providerId: 'p' }])] })).preventive, null, 'an administration is preventive only with its vaccine');
  const flu = run({ members: [{ id: 'a', age: 2, sex: 'M', flags: {} }], claims: [claim([{ service: 'vaccine-admin-child', providerId: 'p' }, { service: 'flu-vaccine', providerId: 'p' }])] });
  assert.deepEqual([line(flu).memberOwes, line(flu, 1).memberOwes], [0, 0], 'a child\'s flu shot and vaccine');
});

test('the office-visit cases are decided by the visit code: a preventive visit with a listed service is $0, a problem visit is not', () => {
  const pv = run({ claims: [claim([{ service: 'office-primary', providerId: 'p' }, { service: 'hiv-test', providerId: 'p' }])] });
  assert.deepEqual([line(pv).copay, line(pv, 1).memberOwes], [30, 0], 'a problem visit billed separately is cost-shared; the listed service stays $0');
  const alone = run({ members: [M45], claims: [claim([{ service: 'welladult-40-64', providerId: 'p' }])] });
  assert.equal(line(alone).memberOwes, 0, 'a preventive visit code is a visit whose main purpose is preventive, with or without separate lines');
  const withListed = run({ members: [M45], claims: [claim([{ service: 'welladult-40-64', providerId: 'p' }, { service: 'hepc-test', providerId: 'p' }])] });
  assert.deepEqual([line(withListed).memberOwes, line(withListed, 1).memberOwes], [0, 0]);
  assert.equal(line(run({ members: [{ ...M45, age: 70 }], claims: [claim([{ service: 'welladult-40-64', providerId: 'p' }])] })).copay, 30, 'past the code\'s age band it is a visit with a copay');
  assert.equal(line(run({ claims: [claim([{ service: 'welladult-40-64', providerId: 'p' }])] })).memberOwes, 0, 'a woman\'s well-woman visit');
});

test('the HSA design: no benefit before the deductible except preventive care, and no copays', () => {
  const r = run({ design: 'hsa', claims: [claim([{ service: 'office-primary', providerId: 'p' }, { service: 'hepc-test', providerId: 'p' }])] });
  assert.deepEqual([line(r).copay, line(r).deductible, line(r).planPaid], [0, 122.8, 0], 'the visit goes to the deductible');
  assert.equal(line(r, 1).memberOwes, 0, 'preventive care before the deductible');
  const er = run({ design: 'hsa', before: self(3400, 3400), claims: [claim([{ service: 'er-facility' }], { emergency: true, facility: { network: 'in', type: 'hospital-emergency-department' } })] });
  assert.deepEqual([line(er).copay, line(er).coinsurance], [0, 190.13], 'coinsurance only after the deductible: 20% of 950.65');
  const oon = run({ design: 'hsa', before: self(3400, 3400), claims: [claim([{ service: 'office-primary', providerId: 'p', billed: 200 }], { providers: { p: doc('out') } })] });
  assert.deepEqual([line(oon).allowed, line(oon).coinsurance, line(oon).balanceBillable], [104.71, 41.88, 95.29], 'out of network: 40% of 110% of Medicare, one accumulator set');
  assert.deepEqual(oon.accumulators.person.a.in, { ded: 3400, oop: 3441.88 });
});

test('No Surprises Act: emergency out of network on the recognized amount, counted in network; the provider may bill nothing more', () => {
  const er = (billed) => run({ before: self(1500, 1500), claims: [claim([{ service: 'er-physician', providerId: 'p', billed }], { emergency: true, facility: { network: 'in', type: 'hospital-emergency-department' }, providers: { p: doc('out', 'emergency-medicine') }, dates: { received: '2026-03-01', decidable: '2026-03-01' }, decisionDays: 12 })] });
  const hi = er(300);
  assert.deepEqual([line(hi).protected, line(hi).qpa, line(hi).recognized, line(hi).coinsurance, line(hi).planPaid, line(hi).balanceBillable], [true, 144.9, 144.9, 28.98, 115.92, 0], 'QPA below billed: cost sharing on the QPA');
  assert.deepEqual(hi.accumulators.person.a.in, { ded: 1500, oop: 1528.98 }, 'counted toward the in-network maximum');
  assert.deepEqual(hi.accumulators.person.a.out, { ded: 0, oop: 0 });
  const lo = er(120);
  assert.deepEqual([line(lo).recognized, line(lo).coinsurance], [120, 24], 'billed below QPA: the billed amount is recognized');
  assert.deepEqual(hi.claims[0].providerNotices, [{ payee: 'p', lines: [{ service: 'er-physician', code: '99284', qpa: 144.9, recognized: 144.9, codeChanged: false }], initialPayment: 115.92, decided: '2026-03-13', stateLaw: 'none' }]);
});

test('No Surprises Act: an out-of-network emergency room with the deductible unmet; one notice per payee', () => {
  const r = run({ claims: [claim([{ service: 'er-facility', billed: 2000 }, { service: 'er-physician', providerId: 'p', billed: 400 }], { emergency: true, facility: { network: 'out', type: 'hospital-emergency-department' }, providers: { p: doc('out', 'emergency-medicine') }, dates: { received: '2026-05-01', decidable: '2026-05-01' }, decisionDays: 30 })] });
  assert.deepEqual([line(r).protected, line(r).terms, line(r).recognized, line(r).copay, line(r).deductible, line(r).coinsurance, line(r).planPaid, line(r).balanceBillable],
    [true, 'in', 903.12, 300, 603.12, 0, 0, 0], 'the $300 copay, then the in-network deductible, on the 903.12 recognized amount');
  assert.deepEqual(line(r, 1).deductible, 144.9, 'the physician line: its 144.90 recognized amount to the deductible');
  assert.deepEqual(r.accumulators.person.a.in, { ded: 748.02, oop: 1048.02 }, 'both lines counted in network: 603.12 + 144.90 of deductible, plus the copay');
  assert.deepEqual(r.claims[0].providerNotices.map((n) => [n.payee, n.lines.map((x) => x.service), n.initialPayment]), [['facility', ['er-facility'], line(r).planPaid], ['p', ['er-physician'], line(r, 1).planPaid]],
    'the facility and the physician each get their own notice, lines and payment');
  assert.equal(r.claims[0].providerNotices[0].decided, '2026-05-31');
});

test('the out-of-pocket maximum stops coinsurance and then the deductible, on any line', () => {
  const surgery = (before) => run({ before, claims: [claim([{ service: 'knee-surgery-facility' }, { service: 'knee-surgery-surgeon', providerId: 's' }, { service: 'knee-anesthesia', providerId: 'n', minutes: 60 }],
    { facility: { network: 'in', type: 'hospital-outpatient' }, providers: { s: doc('in', 'orthopedic-surgery'), n: doc('in', 'anesthesiology') }, priorAuthObtained: true })] });
  const a = surgery(self(1500, 10000));
  assert.deepEqual([line(a).allowed, line(a).coinsurance, line(a, 1).memberOwes, line(a, 2).memberOwes], [7454.6, 600, 0, 0], 'coinsurance stops at the $600 left');
  assert.equal(line(a, 2).allowed, 211.53, 'anesthesia: (4 base + 4 time units) x 20.49754 x 1.29');
  const b = surgery(self(1000, 10500));
  assert.deepEqual([line(b).deductible, line(b).coinsurance], [100, 0], 'the deductible itself stops at the $100 left');
  assert.deepEqual(b.accumulators.person.a.in, { ded: 1100, oop: 10600 });
});

test('No Surprises Act at an in-network facility: consent never waives anesthesia, pathology or radiology; it waives an elective surgeon', () => {
  const hh = { members: [F40] };
  const [c] = makeCommercialClaims(makeRng('t'), hh, { shapes: [{ shape: 'surgery', surgeonNetwork: 'out', anesthesiaNetwork: 'out', pathologyNetwork: 'out', radiologyNetwork: 'out', consent: ['surgeon', 'anesthesia', 'pathology', 'radiology'], member: F40, memberId: 'a' }] });
  const r = run({ claims: [c] }).claims[0];
  const by = Object.fromEntries(r.lines.map((l) => [l.service, l]));
  for (const s of ['knee-anesthesia', 'tissue-exam', 'knee-xray-reading']) assert.equal(by[s].protected, true, `${s} protected whatever the consent`);
  assert.equal(by['knee-surgery-surgeon'].protected, false, 'the surgeon\'s valid consent waives protection');
  assert.ok(by['knee-surgery-surgeon'].balanceBillable > 0);
  const noConsent = run({ claims: [{ ...c, consent: [] }] }).claims[0];
  assert.equal(noConsent.lines.find((l) => l.service === 'knee-surgery-surgeon').protected, true, 'without consent the surgeon is protected too');
});

test('not protected: an out-of-network clinician at an out-of-network facility, any clinician at an imaging center, ground ambulance', () => {
  const xr = (facility) => run({ claims: [claim([{ service: 'chest-xray-reading', providerId: 'p' }], { facility, providers: { p: doc('out', 'radiology') } })] });
  assert.equal(line(xr({ network: 'out', type: 'hospital-outpatient' })).protected, false);
  assert.equal(line(xr({ network: 'in', type: 'independent-imaging-center' })).protected, false);
  assert.ok(!NSA_FACILITIES.has('independent-imaging-center'));
  assert.equal(line(xr({ network: 'in', type: 'hospital-outpatient' })).protected, true, 'the same reading at an in-network hospital department is');
  const amb = run({ claims: [claim([{ service: 'ambulance-transport', providerId: 'p' }, { service: 'ambulance-mileage', providerId: 'p', units: 10 }], { emergency: true, providers: { p: doc('out', 'ambulance') } })] });
  assert.equal(line(amb).protected, false, 'ground ambulance is outside the Act, emergency or not');
  assert.ok(line(amb).balanceBillable > 0);
  assert.equal(line(amb, 1).allowed, 100.65, 'mileage: 10 miles x 9.15 x 1.10');
});

test('prior authorization: elective care only, never emergency care', () => {
  const lines = [{ service: 'knee-surgery-facility' }, { service: 'knee-surgery-surgeon', providerId: 'p', billed: 2000 }];
  const facility = { network: 'in', type: 'hospital-outpatient' };
  const inn = run({ claims: [claim(lines, { facility, providers: { p: doc('in', 'orthopedic-surgery') }, priorAuthObtained: false })] });
  assert.deepEqual([line(inn).denial.reason, line(inn).denial.carc, line(inn).allowed, line(inn).memberOwes, line(inn).planPaid], ['prior-authorization', '197', 0, 0, 0], 'in network the member owes nothing');
  for (const consent of [['p'], []]) {
    const out = run({ claims: [claim(lines, { facility, providers: { p: doc('out', 'orthopedic-surgery') }, consent, priorAuthObtained: false })] });
    assert.deepEqual([line(out, 1).denial.reason, line(out, 1).memberOwes, line(out, 1).protected, line(out, 1).qpa], ['prior-authorization', 2000, false, null], 'out of network the member owes the charge; a denial is never protected');
    assert.deepEqual(out.claims[0].providerNotices, [], 'and is on no notice');
  }
  const er = run({ claims: [claim(lines, { emergency: true, facility, providers: { p: doc('out', 'orthopedic-surgery') }, priorAuthObtained: false })] });
  assert.equal(line(er, 1).denial, null, 'emergency care is never denied for authorization');
  assert.equal(line(run({ claims: [claim(lines, { facility, providers: { p: doc('in', 'orthopedic-surgery') }, priorAuthObtained: true })] })).denial, null);
});

test('outside the out-of-pocket maximum: balance bills and non-covered care; the visit limit on a service outside the benchmark', () => {
  const amb = run({ claims: [claim([{ service: 'ambulance-transport', providerId: 'p', billed: 1500 }], { emergency: true, providers: { p: doc('out', 'ambulance') } })] });
  assert.equal(amb.accumulators.person.a.out.oop, line(amb).deductible + line(amb).coinsurance, 'only cost sharing counts; the balance does not');
  const acu = (used) => run({ before: { person: { a: { in: { ded: 0, oop: 0 }, visits: { acupuncture: used } } } }, claims: [claim([{ service: 'acupuncture', providerId: 'p' }], { providers: { p: doc('in', 'acupuncture') } })] });
  const ok = acu(11);
  assert.equal(line(ok).denial, null); assert.equal(ok.accumulators.person.a.visits.acupuncture, 12);
  const past = acu(12);
  assert.deepEqual([line(past).denial.reason, line(past).denial.carc, line(past).allowed, line(past).memberOwes, line(past).planPaid], ['visit-limit', '119', 0, 62.05, 0], 'past the limit the provider may bill its network rate');
  assert.deepEqual(past.accumulators.person.a.in, { ded: 0, oop: 0 }, 'non-covered care counts toward nothing');
});

test('a clinician may not take the facility\'s payee key', () => {
  assert.throws(() => run({ claims: [claim([{ service: 'office-primary', providerId: 'facility' }], { providers: { facility: doc('in') } })] }), /reserved/);
});

test('starting accumulators a real year could not hold are refused', () => {
  const d = DESIGNS.designs.ppo; const fam = [{ id: 'a' }, { id: 'b' }];
  assert.throws(() => startingAccumulators(d, 'self', [{ id: 'a' }], { person: { a: { in: { ded: 500, oop: 400 } } } }), /ded > oop/);
  assert.throws(() => startingAccumulators(d, 'self', [{ id: 'a' }], { person: { a: { in: { ded: 0, oop: 1060001 } } } }), /over limit/);
  assert.throws(() => startingAccumulators(d, 'family', fam, { person: { a: { in: { ded: 100, oop: 100 } } }, family: { in: { ded: 0, oop: 0 } } }), /not members' sum/);
  assert.throws(() => startingAccumulators(DESIGNS.designs.hsa, 'self', [{ id: 'a' }], { person: { a: { out: { ded: 100, oop: 100 } } } }), /one set/);
});

// starting values a little under each limit: the subscriber and the spouse nearly at their own, the family nearly at its
function nearLimits(design, tier, members) {
  const t = DESIGNS.designs[design].inNetwork;
  if (tier === 'self') return { person: { [members[0].id]: { in: { ded: t.deductible.self, oop: t.outOfPocket.self - 150 } } } };
  const [a, b] = members; const da = t.deductible.perPerson, db = t.deductible.family - da;
  const oa = t.outOfPocket.perPerson - 100, ob = Math.min(t.outOfPocket.perPerson, t.outOfPocket.family - oa) - 200;
  return { person: { [a.id]: { in: { ded: da, oop: oa } }, [b.id]: { in: { ded: db, oop: ob } } }, family: { in: { ded: da + db, oop: oa + ob } } };
}

test('invariants on every claim shape, both designs and both tiers, 500 seeds', () => {
  const C = (d) => Math.round(d * 100);
  for (let seed = 0; seed < 500; seed++) {
    for (const tier of ['self', 'family']) {
      const rng = makeRng(`commercial-${seed}`, tier);
      const hh = makeHousehold(rng, { tier, children: tier === 'family' ? 2 : 0 });
      if (tier === 'family') { hh.members[2].age = 10; hh.members[3].age = 15; }
      const usable = SHAPE_NAMES.filter((s) => tier === 'family' || !['preventive-child'].includes(s));
      const claims = makeCommercialClaims(rng, hh, { shapes: usable });
      for (const design of ['ppo', 'hsa']) {
        const before = seed % 4 === 1 ? nearLimits(design, tier, hh.members) : undefined; // a quarter of the seeds start near the maximum
        const r = adjudicateCommercial({ design, tier, members: hh.members, claims, before });
        if (seed < 20) {
          const rng2 = makeRng(`commercial-${seed}`, tier); const hh2 = makeHousehold(rng2, { tier, children: tier === 'family' ? 2 : 0 });
          if (tier === 'family') { hh2.members[2].age = 10; hh2.members[3].age = 15; }
          const again = adjudicateCommercial({ design, tier, members: hh2.members, claims: makeCommercialClaims(rng2, hh2, { shapes: usable }), before });
          assert.equal(JSON.stringify(again), JSON.stringify(r), 'same seed, same result');
        }
        const D = DESIGNS.designs[design];
        for (const c of r.claims) {
          const member = hh.members.find((m) => m.id === c.memberId);
          for (const l of c.lines) {
            for (const k of ['billed', 'allowed', 'copay', 'deductible', 'coinsurance', 'planPaid', 'notCovered', 'balanceBillable', 'memberOwes']) assert.ok(l[k] >= 0, `${k} >= 0`);
            assert.equal(C(l.allowed), C(l.planPaid) + C(l.copay) + C(l.deductible) + C(l.coinsurance), `${seed} ${design} ${l.service}: allowed = plan paid + cost sharing`);
            if (l.network === 'in' || l.protected) assert.equal(l.balanceBillable, 0, 'nothing billable beyond cost sharing');
            if (l.protected) { assert.equal(l.recognized, Math.min(l.qpa, l.billed)); assert.equal(l.notCovered, 0); assert.equal(l.denial, null); }
            if (l.denial) assert.deepEqual([l.allowed, l.planPaid, l.protected], [0, 0, false]);
            if (l.preventive) assert.ok(preventiveFor(SERVICES[l.service], member, c.lines.map((x) => x.service), true), 'preventive only for an eligible member');
            assert.ok(l.allowed <= l.billed, 'allowed never above billed');
          }
        }
        const sets = D.combinedAccumulators ? ['in'] : ['in', 'out'];
        for (const net of sets) {
          const t = D[net === 'in' ? 'inNetwork' : 'outOfNetwork'];
          for (const m of hh.members) {
            const p = r.accumulators.person[m.id][net];
            assert.ok(p.ded <= (tier === 'family' ? t.deductible.perPerson : t.deductible.self) && p.oop <= (tier === 'family' ? t.outOfPocket.perPerson : t.outOfPocket.self), 'a person within the limits');
          }
          if (tier === 'family') assert.ok(r.accumulators.family[net].ded <= t.deductible.family && r.accumulators.family[net].oop <= t.outOfPocket.family, 'the family within the limits');
        }
      }
    }
  }
});

test('the data: every price sourced, every design number within its limit, preventive dates, places', () => {
  for (const s of CATALOG.services) {
    assert.ok(s.medicare.url?.startsWith('https://www.cms.gov/') && s.medicare.read && s.medicare.verified === true, `${s.id}: a sourced, verified price`);
    assert.ok(typeof s.description === 'string' && s.description.length <= 48, `${s.id}: a description`);
    for (const b of s.preventive || []) if (b.issued) {
      const [y, m, d] = b.issued.split('-').map(Number);
      assert.ok(y + 1 < 2026 || (y + 1 === 2026 && m === 1 && d === 1), `${s.id}: ${b.topic} issued at least a year before the plan year (a month alone counts as its last day)`);
    }
  }
  const L = DESIGNS.limits; const ppo = DESIGNS.designs.ppo.inNetwork; const hsa = DESIGNS.designs.hsa.inNetwork;
  assert.ok(ppo.outOfPocket.self <= L.acaOutOfPocket.self && ppo.outOfPocket.family <= L.acaOutOfPocket.family && ppo.outOfPocket.perPerson <= L.acaOutOfPocket.self);
  assert.ok(hsa.outOfPocket.self <= L.hdhp.maximumOutOfPocket.self && hsa.outOfPocket.family <= L.hdhp.maximumOutOfPocket.family && hsa.outOfPocket.perPerson <= L.acaOutOfPocket.self);
  assert.ok(hsa.deductible.self >= L.hdhp.minimumDeductible.self && hsa.deductible.family >= L.hdhp.minimumDeductible.family && hsa.deductible.perPerson >= L.hdhp.minimumDeductible.family);
  assert.equal(hsa.copay, null, 'no copays on the HSA design');
  const lex = PLACES.places.filter((p) => !p.commercialOnly);
  assert.deepEqual(lex.map((p) => `${p.city}|${p.zip}`), LEXICON_PLACES.map((p) => `${p.city}|${p.zip}`), 'the lexicon places, by city and ZIP');
  for (const p of PLACES.places) assert.ok(p.county && /^\d{5}$/.test(p.countyFips) && p.countyVerified === true, `${p.city}: a verified county`);
  assert.deepEqual(clasProblems(), [], 'no place in a county on the CLAS list');
  assert.deepEqual(clasProblems([{ city: 'Yakima', state: 'WA', countyFips: '53077' }]), ['Yakima, WA: county 53077 CLAS-listed'], 'a listed county fails');
  assert.equal(clasProblems([{ city: 'El Paso', state: 'TX', countyFips: '48141' }]).length, 1, 'a state the list is not stored for fails');
  assert.deepEqual(clasProblems([{ city: 'Erie', state: 'PA', countyFips: '42049' }]), [], 'a state with no listed county passes');
  assert.ok(PLACES.clas.url && PLACES.clas.read && PLACES.clas.edition === 'November 2023', 'the list read is recorded');
  for (const ids of Object.values(PLACES.clas.listedFips)) for (const id of ids) assert.match(id, /^\d{5}$/);
});
