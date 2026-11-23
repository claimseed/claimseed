// The commercial employer-plan EOB (generate/commercial-eob.js, render-commercial.js): one printed claim per billing
// provider; every figure the model's; every printed field read back from the pages; the appeal rights on every EOB
// and the No Surprises Act notice exactly when a line is protected; contacts in the fiction block or the two federal
// lines; the specimen marks on every page of both layout families; and the insurer option.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { generateData, render, renderDegraded, findChrome, launchBrowser, RENDERERS, listScenarios, loadScenario } from '../src/index.js';
import { SHAPE_NAMES } from '../src/generate/commercial/encounters.js';
import { watermarkRectsPerPage } from '../scripts/lib/pdf-markers.js';
import { buildRemittance, commercialAdjustments } from '../src/x12/remittance.js';
import { printedFields } from '../src/generate/commercial-eob.js';
import { generateDocument } from '../src/generate/index.js';
import { planTable, commercialView } from '../src/render-commercial.js';
import { check835 } from '../src/x12/check835.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const TEXT = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/stock-content.json'), 'utf-8'));
const cents = (x) => Math.round(x * 100);
const money = (x) => (Math.round(x * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const FEDERAL = ['1-866-444-3272', '1-800-985-3059'];
// every claim shape once, with the networks and flags that make each payee and protection case appear
const STRESS = [{ shape: 'surgery', anesthesiaNetwork: 'out' }, { shape: 'emergency', facilityNetwork: 'out', network: 'out', xray: true },
  { shape: 'imaging', facilityType: 'independent-imaging-center' }, 'ambulance', 'preventive-adult', 'lab', { shape: 'office-specialist', network: 'out' }, 'acupuncture'];
const gen = (seed, over) => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: over });

test('every shape and design: one printed claim per billing provider, and every figure is the model\'s', () => {
  const shapes = SHAPE_NAMES.filter((s) => s !== 'preventive-child');
  for (const design of ['ppo', 'hsa']) for (const seed of ['c1', 'c2', 'c3']) for (const over of [{ claims: STRESS, tier: 'family' }, { claims: shapes.slice(0, 7), tier: 'self' }, { claims: ['preventive-child', 'lab'], patient: 'child' }]) {
    const { data, groundTruth: k } = gen(seed, { ...over, design });
    const where = `${design} ${seed} ${JSON.stringify(over).slice(0, 40)}`;
    // the key's claims are the printed claims, one payee each, and together they hold every adjudicated line once
    assert.equal(k.claims.length, data.claims.length, where);
    k.claims.forEach((c, i) => { assert.equal(c.claimNumber, data.claims[i].claimNumber); assert.equal(c.lines.length, data.claims[i].lineItems.length); assert.ok(c.payee && c.payee.key, where); });
    assert.equal(new Set(data.claims.map((c) => c.claimNumber)).size, data.claims.length, `${where}: claim numbers unique`);
    for (const [i, c] of data.claims.entries()) {
      for (const [j, l] of c.lineItems.entries()) {
        const m = k.claims[i].lines[j];
        assert.deepEqual([l.billed, l.allowed, l.planPaid, l.deductible, l.copay, l.coinsurance, l.notCovered, l.youMayOwe], [m.charged, m.allowed, m.paid, m.toDeductible, m.copay, m.coinsurance, m.nonCovered, m.patientMayBeBilled], `${where} ${i}.${j}`);
        assert.equal(cents(l.allowed), cents(l.planPaid) + cents(l.deductible) + cents(l.copay) + cents(l.coinsurance), `${where} ${i}.${j}: allowed = paid + cost sharing`);
      }
      for (const f of ['billed', 'allowed', 'planPaid', 'youMayOwe']) assert.equal(cents(c.totals[f]), c.lineItems.reduce((s, l) => s + cents(l[f]), 0), `${where} claim ${i} ${f}`);
    }
    for (const f of ['billed', 'allowed', 'planPaid', 'youMayOwe']) assert.equal(cents(data.summary[f]), data.claims.reduce((s, c) => s + cents(c.totals[f]), 0), `${where} summary ${f}`);
    for (const r of data.accumulators) assert.equal(cents(r.before) + cents(r.thisStatement), cents(r.yearToDate), `${where} ${r.who} ${r.network} ${r.kind}`);
    const pid = data.patient.memberId; const net = (r) => (r.network === 'all' ? 'in' : r.network); const kind = (r) => (r.kind === 'deductible' ? 'ded' : 'oop');
    for (const r of data.accumulators) assert.equal(r.yearToDate, r.who === 'family' ? k.plan.after.family[net(r)][kind(r)] : k.plan.after.person[pid][net(r)][kind(r)], `${where}: year to date is the model's`);
  }
});

test('the 835 beside a commercial EOB: one transaction per payee, balanced on every shape, both designs, seeds 1-20; each adjustment row from the code table', () => {
  const table = JSON.parse(fs.readFileSync(path.join(here, '../data/x12/commercial-codes.json'), 'utf-8'));
  const allowedRows = new Set(table.reasons.map((r) => `${r.group}-${r.code}`));
  const withDenials = [{ shape: 'surgery', priorAuthObtained: false, surgeonNetwork: 'out' }, 'acupuncture', 'acupuncture'];
  for (const design of ['ppo', 'hsa']) for (let i = 1; i <= 20; i++) for (const claims of [STRESS, withDenials]) {
    const seed = `x${i}`; const g = gen(seed, { claims, design, tier: 'family' });
    const r = buildRemittance({ type: 'commercial-eob', scenario: 'baseline-clean', seed, generated: g });
    assert.deepEqual(check835(r.text).findings, [], `${design} ${seed}`);
    assert.equal(r.text.split('~').filter((x) => x.trim().startsWith('ST*835')).length, new Set(g.groundTruth.claims.map((c) => c.payee.npi)).size, `${design} ${seed}: one transaction per payee`);
    assert.match(r.text, /\*T\*>~/); assert.match(r.text, /SPECIMEN - TEST ONLY/);
    for (const c of g.groundTruth.claims) for (const l of c.lines) for (const [group, triplets] of commercialAdjustments(l)) for (const [code] of triplets) assert.ok(allowedRows.has(`${group}-${code}`), `${group}-${code}`);
  }
});

test('one processing date per statement: every claim on an EOB is decided on the date it prints as processed, 1 to 30 days after its receipt (not printed); services 4 to 50 days before it, in order', () => {
  const day = (mdy) => { const [m, d, y] = mdy.split('/').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const shapes = SHAPE_NAMES.filter((x) => x !== 'preventive-child');
  for (let i = 1; i <= 120; i++) for (const design of ['ppo', 'hsa']) {
    const n = 1 + (i % 8); const claims = Array.from({ length: n }, (_, j) => shapes[(i + j) % shapes.length]);
    const { data, groundTruth: k, context } = generateDocument({ type: 'commercial-eob', scenario: 'baseline-clean', seed: `pd-${i}`, overrides: { claims, design, tier: 'family' } });
    const where = `${design} pd-${i}`; const iso = (s) => Date.parse(`${s}T00:00:00Z`) / 864e5;
    const adj = context.commercial.adjudicated.claims;
    assert.deepEqual([...new Set(adj.map((a) => a.dates.decided))].map(iso), [day(data.processed)], `${where}: one decision date, the one printed as processed`);
    for (const a of adj) { const wait = iso(a.dates.decided) - iso(a.dates.received); assert.ok(wait >= 1 && wait <= 30, `${where}: decided ${wait} days after receipt`); }
    const services = k.claims.map((c) => Date.parse(c.dateOfService) / 864e5); const processed = day(data.processed);
    assert.ok(services.every((s) => processed - s >= 4 && processed - s <= 50), `${where}: services 4 to 50 days before processing`);
    assert.deepEqual(services, [...services].sort((a, b) => a - b), `${where}: claims in service order`);
    assert.ok(!JSON.stringify(data).includes('eceived') && !Object.keys(k.documents[0].fields).some((f) => /received|decided/i.test(f)), `${where}: no receipt or decision date per claim in the data or the key`);
  }
  assert.throws(() => gen('pd-x', { claims: [{ shape: 'lab', infoRequested: true }] }), (e) => e.code === 'SCENARIO', 'a request for information is not an option');
});

test('the commercial scenarios are published, sourced and generate for many seeds with synthetic identifiers', () => {
  for (const slug of listScenarios('commercial-eob')) {
    const s = loadScenario('commercial-eob', slug);
    assert.equal(s.status, 'published'); assert.equal(s.slug, slug); assert.ok(s.description.length > 40);
    assert.ok(s.sources.length >= 2 && s.sources.every((x) => x.what && /https?:\/\/|CFR/.test(x.source)), slug);
    for (let i = 0; i < 25; i++) {
      const { groundTruth: k } = generateData({ type: 'commercial-eob', scenario: slug, seed: `g${i}` });
      for (const p of k.documents[0].entities.providers) assert.match(p.npi, /^9\d{9}$/);
      for (const v of Object.values(k.documents[0].fields)) if (typeof v === 'string') for (const m of v.matchAll(/\b\d{3}-\d{3}-\d{4}\b/g)) assert.match(m[0], /^[2-9]\d{2}-555-01\d{2}$/, `${slug} g${i}`);
    }
  }
});

test('scenario options: a wrong value is a SCENARIO refusal; a scenario\'s own starting totals are copied, never written into', () => {
  const bad = [{ visitsUsed: [] }, { visitsUsed: {} }, { visitsUsed: { 'office-primary': 1 } }, { visitsUsed: { acupuncture: -1 } }, { visitsUsed: { acupuncture: 1.5 } },
    { claims: [{ shape: 'surgery', consent: true }] }, { claims: [{ shape: 'lab', network: 'maybe' }] }, { claims: [{ shape: 'lab', labs: 'yes' }] }, { claims: [] }, { design: 'hmo' },
    // a design or tier that is not a string, and starting totals that are null, a list or of the wrong shape
    { design: ['ppo'] }, { design: { toString: () => 'ppo' } }, { tier: ['self'] }, { before: { person: null } }, { before: { person: [] } }, { before: null },
    { before: { family: null } }, { before: { person: { m: null } } }, { before: { person: { m: { visits: null } } } }, { before: { person: { m: { visits: { acupuncture: 'x' } } } } }];
  for (const over of bad) assert.throws(() => gen('opt', { claims: ['lab'], ...over }), (e) => e.code === 'SCENARIO', JSON.stringify(over));
  const before = { person: {}, family: {} }; const was = JSON.stringify(before);
  const { data } = gen('opt', { claims: ['acupuncture'], before, visitsUsed: { acupuncture: 3 } });
  assert.equal(JSON.stringify(before), was, 'the scenario\'s before is unchanged');
  assert.ok(data.claims.length >= 1);
});

test('the patient must fit every claim shape: a child\'s checkup is a child\'s, an adult\'s an adult\'s; refused as a SCENARIO', () => {
  const MSG = 'commercial-eob: patient does not fit a claim shape';
  const refused = (over) => assert.throws(() => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'fit-1', overrides: { tier: 'family', ...over } }),
    (e) => e.code === 'SCENARIO' && e.message === MSG, JSON.stringify(over));
  const fits = (over) => assert.doesNotThrow(() => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'fit-1', overrides: { tier: 'family', ...over } }), JSON.stringify(over));
  // the patient left out is the subscriber, an adult
  refused({ claims: ['preventive-child'] }); refused({ claims: ['preventive-child'], patient: 'subscriber' }); refused({ claims: ['preventive-child'], patient: 'spouse' });
  fits({ claims: ['preventive-child'], patient: 'child' });
  for (const shape of ['preventive-adult', 'problem-visit-listed', 'acupuncture']) { refused({ claims: [shape], patient: 'child' }); fits({ claims: [shape] }); fits({ claims: [shape], patient: 'spouse' }); }
  // a knee surgery is for someone 12 or older: a child under 12 is refused, the subscriber fits
  fits({ claims: ['surgery'] });
  let young = 0;
  for (let i = 0; i < 40; i++) {
    const seed = `fit-k${i}`; const o = { tier: 'family', patient: 'child', claims: ['surgery'] };
    const { context } = generateDocument({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: { ...o, claims: ['office-primary'] } });
    const age = context.commercial.patient.age;
    if (age < 12) { young++; assert.throws(() => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: o }), (e) => e.code === 'SCENARIO' && e.message === MSG, seed); }
    else assert.doesNotThrow(() => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: o }), seed);
  }
  assert.ok(young > 0, 'some children are under 12');
  // every published scenario's patient fits all of its shapes
  for (const s of listScenarios('commercial-eob')) for (let i = 1; i <= 20; i++) for (const insurer of ['a', 'b']) assert.doesNotThrow(() => generateData({ type: 'commercial-eob', scenario: s, seed: `set-${i}`, overrides: { insurer } }), `${s} set-${i} ${insurer}`);
});

test('a scenario\'s own starting totals must be ones its plan, tier and household could hold: otherwise "before not allowed", a SCENARIO', () => {
  const MSG = 'commercial-eob: before not allowed';
  const seed = 'totals-1'; const base = { design: 'hsa', tier: 'family', claims: ['lab'] };
  const ids = generateDocument({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: base }).context.commercial.household.members.map((m) => m.id);
  const run = (before, over = {}) => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: { ...base, ...over, before } });
  const bad = [
    { family: { out: { ded: 100, oop: 100 } } },                                  // a combined design has one set of totals: the family's out of network
    { person: { [ids[0]]: { out: { ded: 50, oop: 50 } } } },                    // and a member's
    { person: { 'SPEC00000000-09': { in: { ded: 50, oop: 60 } } } },              // a member who is not in the household
    { person: { [ids[0]]: { in: { ded: 60, oop: 50 } } }, family: { in: { ded: 60, oop: 50 } } },   // more deductible than out-of-pocket
    { person: { [ids[0]]: { in: { ded: 90000, oop: 90000 } } }, family: { in: { ded: 90000, oop: 90000 } } },   // over the limits
    { person: { [ids[0]]: { in: { ded: 50, oop: 60 } } }, family: { in: { ded: 10, oop: 60 } } },   // the family's not the members' sum
    { person: { [ids[0]]: { in: { ded: 33.333, oop: 60 } } }, family: { in: { ded: 33.333, oop: 60 } } },   // not a whole cent: the page prints cents
  ];
  for (const b of bad) assert.throws(() => run(b), (e) => e.code === 'SCENARIO' && e.message === MSG, JSON.stringify(b));
  assert.throws(() => run({ family: { in: { ded: 10, oop: 10 } } }, { tier: 'self' }), (e) => e.code === 'SCENARIO' && e.message === MSG, 'a family total on self-only coverage');
  assert.doesNotThrow(() => run({ person: { [ids[0]]: { in: { ded: 50, oop: 60 } } }, family: { in: { ded: 50, oop: 60 } } }), 'good totals');
  assert.doesNotThrow(() => run({ person: { [ids[0]]: { in: { ded: 33.33, oop: 60.1 } } }, family: { in: { ded: 33.33, oop: 60.1 } } }), 'whole cents');
  assert.doesNotThrow(() => run({}), 'empty totals');
  for (const s of ['combined-three-errors', 'preventive-cost-sharing']) assert.doesNotThrow(() => generateData({ type: 'commercial-eob', scenario: s, seed: 'set-1' }), s);
});

test('the examples hold every published commercial scenario once per insurer', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '../../../examples/manifest.json'), 'utf-8'));
  const got = manifest.examples.filter((e) => e.type === 'commercial-eob').map((e) => `${e.scenario}.${e.insurer}`).sort();
  assert.deepEqual(got, listScenarios('commercial-eob').flatMap((s) => [`${s}.a`, `${s}.b`]).sort());
});

let browser; let dir;
before(async () => { if (!skip) { browser = await launchBrowser(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-commercial-')); } });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const pdfText = (pdf) => execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ');

test('both layout families: every printed field reads back, the appeal rights always and the No Surprises notice exactly when a line is protected, contacts in the fiction block, marks on every page', { skip, timeout: 600000 }, async () => {
  const stock = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/stock-content.json'), 'utf-8'));
  for (const insurer of ['a', 'b']) for (const [label, over] of [['baseline', {}], ['stress', { claims: STRESS, tier: 'family', design: 'ppo' }]]) {
    const { data } = gen(`p-${insurer}`, { ...over, insurer });
    const out = fs.mkdtempSync(path.join(dir, `${insurer}-${label}-`));
    const pdf = await RENDERERS['commercial-eob'](data, stock, out, { browser, title: 't', band: `commercial-eob / ${label} / seed p-${insurer}` });
    const t = pdfText(pdf); const where = `${insurer} ${label}`;
    for (const v of [data.insurer.name, data.plan.name, data.plan.option, data.plan.sponsor, data.plan.groupNumber, data.plan.memberId, data.processed, data.patient.name, data.mailing.street])
      assert.ok(t.includes(v), `${where}: ${v}`);
    for (const c of data.claims) {
      for (const v of [c.claimNumber, c.provider.name, `$${money(c.totals.youMayOwe)}`]) assert.ok(t.includes(v), `${where}: ${c.claimNumber} ${v}`);
      for (const l of c.lineItems) for (const v of [l.date, l.code, `$${money(l.billed)}`, `$${money(l.allowed)}`, `$${money(l.youMayOwe)}`]) assert.ok(t.includes(v), `${where}: ${c.claimNumber} ${l.code} ${v}`);
    }
    for (const r of data.accumulators) for (const v of [r.before, r.thisStatement, r.yearToDate]) assert.ok(t.includes(`$${money(v)}`), `${where}: accumulator ${v}`);
    for (const code of new Set(data.claims.flatMap((c) => c.lineItems.map((l) => l.remark)).filter(Boolean))) assert.ok(t.includes(stock.remarks.find((x) => x.code === code).meaning), `${where}: remark ${code}`);
    for (const v of [stock.appeal.title, stock.appeal.externalReview, stock.appeal.civilAction, stock.appeal.codes, stock.appeal.rationale, stock.appeal.ebsa, stock.appeal.howToAppeal.replace('{insurer}', data.insurer.name).replace('{days}', '180')]) assert.ok(t.includes(v), `${where}: appeal ${v.slice(0, 30)}`);
    assert.equal(t.includes(stock.nsa.title), data.hasProtected, `${where}: the No Surprises notice exactly when a line is protected`);
    if (label === 'stress') assert.ok(data.hasProtected, 'the stress EOB has a protected line');
    for (const m of t.matchAll(/\b1?-?\d{3}-\d{3}-\d{4}\b/g)) assert.ok(/^[2-9]\d{2}-555-01\d{2}$/.test(m[0]) || FEDERAL.includes(m[0]), `${where}: phone ${m[0]}`);
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
    assert.equal(pages, insurer === 'a' ? data.claims.length + 2 : planTable(commercialView(data, stock).claims).length + 1, `${where}: the pages planned`);
    const rects = await watermarkRectsPerPage(pdf);
    for (let p = 1; p <= pages; p++) {
      const pt = execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, '');
      assert.ok(pt.includes('SYNTHETICSPECIMEN'), `${where}: band on page ${p}`); assert.ok(rects[p - 1] >= 100, `${where}: watermark on page ${p}`);
    }
  }
});

// The printed-fields contract (printedFields: what the page prints, in its words, and the answer key's fields): every
// claim's facts read back beside their labels in that claim's own block, every line read back as its row, every note
// and accumulator row, on an EOB with a protected line, consent, both prior-authorization denials and a visit-limit
// denial, for both insurers; and hand-worked figures for one office visit under each plan option.
const CASES = [{ shape: 'emergency', facilityNetwork: 'out', network: 'out' }, { shape: 'surgery', surgeonNetwork: 'out', anesthesiaNetwork: 'out', consent: ['surgeon', 'anesthesia'] },
  { shape: 'surgery', priorAuthObtained: false }, { shape: 'surgery', priorAuthObtained: false, surgeonNetwork: 'out' }, 'acupuncture'];
const dash = (x) => (x > 0 ? `$${money(x)}` : '-');
// the plan's terms box as each option's design states it (plan-designs.json), written out by hand
const pair = (a, b) => `$${a} (Individual) / $${b} (Family)`;
const TERMS = {
  ppo: [['deductible', pair('1,500.00', '3,000.00'), pair('3,000.00', '6,000.00')], ['coinsurance', '20%', '40%'], ['copayPrimary', '$30.00', 'None'],
    ['copaySpecialist', '$60.00', 'None'], ['copayEmergency', '$300.00', 'None'], ['outOfPocket', pair('10,600.00', '21,200.00'), pair('13,000.00', '26,000.00')]],
  hsa: [['deductible', pair('3,400.00', '6,800.00'), pair('3,400.00', '6,800.00')], ['coinsurance', '20%', '40%'], ['copayPrimary', 'None', 'None'],
    ['copaySpecialist', 'None', 'None'], ['copayEmergency', 'None', 'None'], ['outOfPocket', pair('8,000.00', '16,000.00'), pair('8,000.00', '16,000.00')]],
};
const SECTION = { 'prior-authorization': '4.3', 'visit-limit': '6.2' };
const sum = (xs) => xs.reduce((a, x) => a + cents(x), 0) / 100;
// the terms box and the summary box read back: each terms row with the design's amounts, the summary's title and
// each row with the claims' own sums
function boxesReadBack(all, P, design, stock, where) {
  for (const [label, inNet, outNet] of TERMS[design]) assert.ok(all.includes(`${stock.terms[label]} ${inNet} ${outNet}`), `${where}: terms "${stock.terms[label]} ${inNet} ${outNet}"`);
  const lines = P.claims.flatMap((c) => c.lineItems); const m = (k) => `$${money(sum(lines.map((l) => l[k])))}`;
  const U = stock.summary;
  const want = `${U.titleA} ${U.claims} ${P.claims.length} ${U.billed} ${m('billed')} ${U.allowed} ${m('allowed')} ${U.planPaid} ${m('planPaid')} ${U.youMayOwe} ${m('youMayOwe')}`;
  assert.ok(all.includes(want), `${where}: summary "${want}"`);
  assert.ok(!all.includes(U.titleB), `${where}: the summary box is this statement's, not the year's`);
}
test('the printed-fields contract: each claim block, line row, note and accumulator row reads back beside its label, both insurers; hand-worked figures', { skip, timeout: 600000 }, async () => {
  const stock = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/stock-content.json'), 'utf-8'));
  const S = stock.claim;
  for (const insurer of ['a', 'b']) {
    const { data, groundTruth: k } = gen(`pf-${insurer}`, { claims: CASES, design: 'ppo', tier: 'family', visitsUsed: { acupuncture: 12 }, insurer });
    const P = printedFields(data, stock);
    const remarks = new Set(P.claims.flatMap((c) => c.lineItems.map((l) => l.remark)));
    for (const code of ['NS', 'CN', 'PI', 'PO', 'VL']) assert.ok(remarks.has(code), `${insurer}: the case holds ${code}`);
    // the key's fields are exactly what printedFields says the page prints
    const flat = k.documents[0].fields; assert.equal(flat['claims[0].network'], P.claims[0].network); assert.equal(flat['claims[0].lineItems[0].remark'], P.claims[0].lineItems[0].remark);
    for (const key of Object.keys(flat)) assert.ok(!/(^|\.)(kind|combined|hasProtected|consent|met|_)/.test(key) || key.startsWith('accumulators['), `${insurer}: ${key} is not printed`);
    // the printed facts follow the model's facts in the key, each by its own rule
    k.claims.forEach((kc, i) => {
      const c = P.claims[i];
      assert.equal(c.network, kc.payee.network === 'in' ? S.inNetwork : S.outOfNetwork, `claim ${i}: the payee's own network`);
      assert.equal(k.documents[0].entities.providers[i].specialty, c.specialty, `claim ${i}: the key's provider specialty is the printed one`);
      assert.equal(c.emergency, kc.emergency ? S.yes : S.no, `claim ${i}: emergency`);
      kc.lines.forEach((l, j) => {
        const want = l.denial ? (l.denial === 'visit-limit' ? 'VL' : l.network === 'in' ? 'PI' : 'PO') : l.protected ? 'NS' : l.preventive ? 'PV' : l.balanceBillable > 0 ? (data.claims[i].consent ? 'CN' : 'OA') : null;
        if (want) assert.equal(c.lineItems[j].remark, want, `claim ${i} line ${j}`);
      });
    });
    const D = { in: { ded: 1500, oop: 10600 }, fam: { ded: 3000, oop: 21200 }, out: { ded: 3000, oop: 13000 }, outFam: { ded: 6000, oop: 26000 } };
    for (const r of data.accumulators) {
      const kk = r.kind === 'deductible' ? 'ded' : 'oop';
      assert.equal(r.limit, (r.who === 'family' ? (r.network === 'out' ? D.outFam : D.fam) : (r.network === 'out' ? D.out : D.in))[kk], `${r.who} ${r.network} ${r.kind} limit`);
    }
    const out = fs.mkdtempSync(path.join(dir, `pf-${insurer}-`));
    const pdf = await RENDERERS['commercial-eob'](data, stock, out, { browser, title: 't', band: 'b' });
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
    // whitespace as single spaces, and a word broken at its hyphen across a line (a narrow cell) rejoined
    const page = (p) => execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ').replace(/([a-z])- ([a-z])/g, '$1-$2');
    const all = Array.from({ length: pages }, (_, i) => page(i + 1)).join(' ');
    // a claim's block: insurer a's page for it; insurer b's text from its claim number to the next claim's
    const at = (i) => all.indexOf(`${S.number} ${P.claims[i].claimNumber}`);
    const block = (i) => (insurer === 'a' ? page(i + 2) : all.slice(at(i), i + 1 < P.claims.length ? at(i + 1) : undefined));
    if (insurer === 'a') assert.equal(pages, P.claims.length + 2);
    P.claims.forEach((c, i) => {
      const b = block(i); const where = `${insurer} claim ${i} ${c.claimNumber}`;
      for (const [label, value] of [[S.number, c.claimNumber], [S.provider, c.provider], [S.specialty, c.specialty], [S.network, c.network], [S.place, c.place], [S.emergency, c.emergency]])
        assert.ok(b.includes(`${label} ${value}`), `${where}: "${label} ${value}"`);
      for (const l of c.lineItems) {
        const row = `${l.code} $${money(l.billed)} $${money(l.allowed)} $${money(l.planPaid)} ${dash(l.deductible)} ${dash(l.copay)} ${dash(l.coinsurance)} ${dash(l.notCovered)} $${money(l.youMayOwe)}${l.remark ? ` ${l.remark}` : ''}`;
        assert.ok(b.includes(row), `${where}: row "${row}"`);
      }
      for (const n of c.notes) assert.ok(b.includes(n), `${where}: note "${n.slice(0, 50)}"`);
      // each denial names its own plan section; each protected line the member's in-network share from the key
      k.claims[i].lines.forEach((kl, j) => {
        if (kl.denial) assert.ok(b.includes(`${stock.denial.codeLabel}: ${c.lineItems[j].remark}. ${stock.denial.provisionLabel}: ${stock.denial.provisionText.replace('{section}', SECTION[kl.denial])}`), `${where}: ${kl.code} cites section ${SECTION[kl.denial]}`);
        if (kl.protected) {
          const share = sum([kl.toDeductible, kl.copay, kl.coinsurance]); assert.equal(share, kl.patientMayBeBilled, `${where}: a protected line owes its in-network share only`);
          assert.ok(b.includes(stock.lineNotes.protected.replace('{amount}', `$${money(share)}`)), `${where}: ${kl.code} protected at $${money(share)}`);
        }
      });
      // consent prints only where it lets the provider bill the difference: the surgeon, never the anesthesiologist
      const kc = k.claims[i];
      if (kc.payee.key === 'anesthesia' && data.claims[i].consent) { assert.ok(c.lineItems.every((l) => l.remark === 'NS'), `${where}: anesthesia stays protected`); assert.ok(!b.includes(stock.lineNotes.consent), `${where}: no consent sentence`); }
      if (kc.payee.key === 'surgeon' && data.claims[i].consent) assert.ok(b.includes(stock.lineNotes.consent), `${where}: the consent sentence`);
    });
    assert.ok(k.claims.some((kc, i) => kc.payee.key === 'anesthesia' && data.claims[i].consent), `${insurer}: the case holds a consent the law does not honour`);
    boxesReadBack(all, P, 'ppo', stock, insurer);
    // each provider notice names the printed claim of its own payee
    for (const n of k.plan.providerNotices) assert.equal(k.claims.find((kc) => kc.claimNumber === n.claimNumber)?.payee.key, n.payee, `${insurer}: notice for ${n.payee}`);
    assert.ok(k.plan.providerNotices.length >= 2, `${insurer}: notices for more than one payee`);
    for (const r of P.accumulators) assert.ok(all.includes(`${r.label} $${money(r.before)} $${money(r.thisStatement)} $${money(r.yearToDate)}${r.met ? ` (${stock.accumulators.metNote})` : ''} $${money(r.limit)}`), `${insurer}: accumulator ${r.group} ${r.label}`);
    for (const g of new Set(P.accumulators.map((r) => r.group))) assert.ok(all.includes(g), `${insurer}: ${g}`);
    // each row's label by its network and kind, as the stock text has it; the Family heading between the last
    // individual row and the first family row
    const A = stock.accumulators; const LABEL = { deductible: { in: A.deductibleIn, out: A.deductibleOut, all: A.deductibleAll }, outOfPocket: { in: A.outOfPocketIn, out: A.outOfPocketOut, all: stock.terms.outOfPocket } };
    data.accumulators.forEach((r, k) => assert.equal(P.accumulators[k].label, LABEL[r.kind][r.network], `${insurer}: row ${k} label`));
    const rowAt = (r) => all.indexOf(`${r.label} $${money(r.before)} $${money(r.thisStatement)} $${money(r.yearToDate)}${r.met ? ` (${stock.accumulators.metNote})` : ''} $${money(r.limit)}`);
    const persons = P.accumulators.filter((r, k) => data.accumulators[k].who === 'person'); const families = P.accumulators.filter((r, k) => data.accumulators[k].who === 'family');
    const famHead = all.indexOf(A.family, Math.max(...persons.map(rowAt)));
    assert.ok(famHead > Math.max(...persons.map(rowAt)) && famHead < Math.min(...families.map(rowAt)), `${insurer}: the Family heading sits between the individual and family rows`);
  }
  // the HSA option's terms box: the one deductible and one maximum for all care, in both columns
  {
    const { data } = gen('pf-hsa', { claims: ['office-primary', 'lab'], design: 'hsa', tier: 'family', insurer: 'b' });
    const out = fs.mkdtempSync(path.join(dir, 'pf-hsa-'));
    const pdf = await RENDERERS['commercial-eob'](data, stock, out, { browser, title: 't', band: 'b' });
    const all = execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ').replace(/([a-z])- ([a-z])/g, '$1-$2');
    boxesReadBack(all, printedFields(data, stock), 'hsa', stock, 'hsa b');
  }
  // hand-worked: the office visit (99213, Medicare national $95.19 x 1.29 = $122.80 allowed). PPO: the $30 copay only,
  // plan pays $92.80. HSA with nothing met before: the whole $122.80 goes to the deductible, plan pays $0.
  const ppo = gen('hw', { claims: [{ shape: 'office-primary', labs: false }], design: 'ppo', tier: 'self', before: {} }).data.claims[0].lineItems[0];
  assert.deepEqual([ppo.allowed, ppo.copay, ppo.deductible, ppo.planPaid, ppo.youMayOwe, ppo.remark], [122.8, 30, 0, 92.8, 30, 'CP']);
  const hsa = gen('hw', { claims: [{ shape: 'office-primary', labs: false }], design: 'hsa', tier: 'self', before: {} }).data.claims[0].lineItems[0];
  assert.deepEqual([hsa.allowed, hsa.copay, hsa.deductible, hsa.planPaid, hsa.youMayOwe, hsa.remark], [122.8, 0, 122.8, 0, 122.8, 'DD']);
});

test('the insurer option: a or b for the commercial EOB, refused for another type, another value and a blind render; the key records it', { skip, timeout: 180000 }, async () => {
  const msg = (key) => (e) => e.message === `render: ${{ insurerType: 'the insurer option applies only to the commercial-eob document type.', insurerValue: 'insurer must be a or b.', insurerBlind: "insurer cannot be set for a blind render; a blind document's insurer comes from its own seed." }[key]}`;
  await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', insurer: 'a', browser }), msg('insurerType'));
  for (const v of ['c', 'A', 1, ['a']]) await assert.rejects(render({ type: 'commercial-eob', scenario: 'baseline-clean', insurer: v, browser }), msg('insurerValue'), String(v));
  await assert.rejects(render({ type: 'commercial-eob', scenario: 'baseline-clean', insurer: 'a', blind: { salt: '0123456789abcdef0123456789abcdef' }, browser }), msg('insurerBlind'));
  const r = await render({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'ins', insurer: 'b', browser });
  assert.equal(r.groundTruth.plan.insurer, 'b'); assert.equal(r.groundTruth.schemaVersion, '1.7');
  // the drawn insurer comes from a stream of its own: naming it changes nothing else the seed draws
  const drawn = gen('ins', {}).data; const named = gen('ins', { insurer: drawn._insurerId === 'a' ? 'b' : 'a' }).data;
  assert.deepEqual(named.claims, drawn.claims); assert.notEqual(named.insurer.name, drawn.insurer.name);
  // a named insurer names the files, so the two insurers' documents and degraded copies of one seed sit side by side
  const out = fs.mkdtempSync(path.join(dir, 'named-'));
  for (const ins of ['a', 'b']) {
    const r1 = await render({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'two', insurer: ins, outDir: out, browser });
    assert.ok(r1.pdf.endsWith(`commercial-eob_baseline-clean_two.${ins}.pdf`));
    const r2 = await renderDegraded({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'two', insurer: ins, preset: 'scan', outDir: out, browser, pageImages: false });
    assert.ok(r2.pdf.endsWith(`commercial-eob_baseline-clean_two.${ins}_scan.pdf`), r2.pdf);
  }
});

test('each No Surprises Act notice names its own claim and that claim\'s protected lines, two surgeries on one EOB', () => {
  for (let i = 1; i <= 20; i++) {
    const { groundTruth: k } = gen(`ns-${i}`, { claims: [{ shape: 'surgery', anesthesiaNetwork: 'out' }, { shape: 'surgery', anesthesiaNetwork: 'out', radiologyNetwork: 'out' }] });
    const notices = k.plan.providerNotices;
    assert.ok(notices.length >= 3, `ns-${i}: a notice per protected payee`);
    assert.equal(new Set(notices.map((n) => n.claimNumber)).size, notices.length, `ns-${i}: each notice its own claim`);
    for (const n of notices) {
      const c = k.claims.find((x) => x.claimNumber === n.claimNumber);
      assert.equal(c.payee.key, n.payee, `ns-${i}: payee`);
      assert.deepEqual(n.lines.map((l) => l.code), c.lines.filter((l) => l.protected).map((l) => l.code), `ns-${i}: the notice's lines are its claim's protected lines`);
    }
  }
});

test('the schema: version 1.7 if and only if the key is a commercial EOB\'s, a 1.7 pair only on the EOB\'s side, and a commercial line\'s modifier', async () => {
  const Ajv = (await import('ajv/dist/2020.js')).default; const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8')));
  const { generatePair } = await import('../src/generate/index.js');
  const k = generateData({ type: 'commercial-eob', scenario: 'care-settings-clean', seed: 'example' }).groundTruth;
  assert.ok(validate(k), JSON.stringify(validate.errors?.slice(0, 3)));
  assert.ok(k.claims.flatMap((c) => c.lines).some((l) => l.modifier === '26'));
  const eob = generatePair({ type: 'commercial-eob', scenario: 'care-settings-clean', seed: 'example', bill: 'clean' }).eob.groundTruth;
  const asStatement = structuredClone(eob); asStatement.pair = { role: 'bill', with: 'x', claim: 0, variant: 'clean', params: {} }; asStatement.documents[0].type = 'provider-statement'; delete asStatement.documents[0].layoutVariant;
  const labelled = structuredClone(k); labelled.documents[0].type = 'provider-statement';
  const msn = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'x' }).groundTruth; assert.ok(validate(msn));
  const msnAsCommercial = structuredClone(msn); msnAsCommercial.documents[0].type = 'commercial-eob';
  const noModifier = structuredClone(k); delete noModifier.claims[0].lines[0].modifier;
  const longModifier = structuredClone(k); longModifier.claims[0].lines[0].modifier = '263';
  const msnModifier = structuredClone(msn); msnModifier.claims[0].lines[0].modifier = null;
  for (const [what, key] of [['a 1.7 key labelled a statement, role bill', asStatement], ['a 1.7 key labelled a statement', labelled], ['a 1.3 key labelled a commercial EOB', msnAsCommercial],
    ['a commercial line without its modifier', noModifier], ['a 3-character modifier', longModifier], ['a modifier on an MSN line', msnModifier]]) assert.equal(validate(key), false, what);
});

test('the insurer option on another type is refused by the library too, before anything is drawn', () => {
  for (const [type, scenario] of [['msn', 'baseline-clean'], ['itemized-bill', 'baseline-clean'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']])
    assert.throws(() => generateData({ type, scenario, overrides: { insurer: 'a' } }), (e) => e.message === 'generate: the insurer option applies only to the commercial-eob document type.', type);
  assert.equal(generateData({ type: 'msn', scenario: 'baseline-clean', overrides: { insurer: null } }).groundTruth.documents[0].type, 'msn');
});

test('a claim from an out-of-network ground ambulance prints the note that the No Surprises Act does not protect it, and no other claim does', () => {
  let seen = 0;
  for (const scenario of listScenarios('commercial-eob')) for (const seed of ['amb-1', 'amb-2', 'example']) for (const insurer of ['a', 'b']) {
    const { data } = generateData({ type: 'commercial-eob', scenario, seed, overrides: { insurer } });
    printedFields(data).claims.forEach((c, i) => {
      const p = data.claims[i].provider; const want = p.kind === 'ambulance' && p.network === 'out';
      assert.equal(c.notes.filter((n) => n === TEXT.lineNotes.groundAmbulance).length, want ? 1 : 0, `${scenario} ${seed} ${insurer} claim ${i + 1}`);
      if (want) seen++;
    });
  }
  assert.ok(seen > 0, 'an out-of-network ambulance claim among them');
});
