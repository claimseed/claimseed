// The commercial EOB's planted errors and decoys (generate/commercial-operations.js): each kind decidable from the
// printed page alone and keyed where the page prints it; no decoy and no clean EOB flagged; every scenario generates
// for any seed; the key's lines and the 835 are the printed adjudication, differing from the true one only where an
// error is planted; and verify scores each kind, its decoys and the plan's own denials.
import { test, before, after } from 'node:test';
import os from 'os';
import { execFileSync } from 'child_process';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { generateData, listScenarios, loadScenario, RENDERERS, findChrome, launchBrowser } from '../src/index.js';
import { generateDocument } from '../src/generate/index.js';
import { printedFields } from '../src/generate/commercial-eob.js';
import { SERVICES } from '../src/generate/commercial/adjudicate.js';
import { SHAPE_NAMES } from '../src/generate/commercial/encounters.js';
import { WELL_VISITS } from '../src/generate/commercial-operations.js';
import { commercialAdjustments } from '../src/x12/remittance.js';
import { scoreExtraction } from '../src/verify.js';
import { checkCommercialPage } from '../scripts/lib/commercial-checker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEXT = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/stock-content.json'), 'utf-8'));
const SCENARIOS = listScenarios('commercial-eob');
const key = (x) => `${x.kind}@${x.fieldRef}`;
// the options a scenario leaves to the seed are varied; a scenario that fixes the plan option keeps it
const optionsOf = (s) => (loadScenario('commercial-eob', s).design ? [{}] : [{ design: 'ppo' }, { design: 'hsa' }]);
const PRE_KINDS = new Set(['surprise-balance-bill', 'preventive-cost-sharing', 'emergency-authorization-denial']);

test('decidable from the page: the page-only checker finds exactly the planted errors (kind and place), no decoy, nothing on a clean EOB; every scenario, option, insurer, seeds 1-20', () => {
  const seen = new Set();
  for (const s of SCENARIOS) for (const o of optionsOf(s)) for (const insurer of ['a', 'b']) for (let i = 1; i <= 20; i++) {
    const { data, groundTruth: k } = generateData({ type: 'commercial-eob', scenario: s, seed: `dc-${i}`, overrides: { ...o, insurer } });
    const flags = checkCommercialPage(printedFields(data, TEXT), TEXT).map(key).sort();
    const want = k.errors.filter((e) => e.severity !== 'info').map(key).sort();
    assert.deepEqual(flags, want, `${s} ${JSON.stringify(o)} ${insurer} dc-${i}`);
    for (const d of k.decoys) assert.ok(!flags.includes(`${d.kind}@${d.fieldRef}`) && !flags.some((f) => f.endsWith(`@${d.fieldRef}`)), `${s}: decoy ${d.kind} flagged`);
    for (const e of k.errors) seen.add(e.kind);
  }
  for (const kind of ['in-network-balance-bill', 'surprise-balance-bill', 'preventive-cost-sharing', 'math-error', 'emergency-authorization-denial', 'missing-required-section', 'coverage-denial']) assert.ok(seen.has(kind), `a scenario plants ${kind}`);
  // and on varied EOBs with no operation (every shape, the network, consent and authorization options), nothing
  const OPTS = [{}, { network: 'out' }, { facilityNetwork: 'out' }, { surgeonNetwork: 'out' }, { surgeonNetwork: 'out', consent: ['surgeon'] }, { anesthesiaNetwork: 'in' },
    { anesthesiaNetwork: 'out', consent: ['anesthesia'] }, { priorAuthObtained: false }, { facilityType: 'ambulatory-surgical-center' }];
  const fits = { surgeonNetwork: ['surgery'], anesthesiaNetwork: ['surgery'], consent: ['surgery'], priorAuthObtained: ['surgery'], facilityNetwork: ['imaging', 'surgery', 'emergency'], facilityType: ['surgery'] };
  const shapes = SHAPE_NAMES.filter((x) => x !== 'preventive-child');
  for (let i = 1; i <= 300; i++) {
    const claims = Array.from({ length: 1 + (i % 6) }, (_, j) => {
      const o = { shape: shapes[(i * 3 + j * 5) % shapes.length], ...OPTS[(i + j * 7) % OPTS.length] };
      for (const [opt, ok] of Object.entries(fits)) if (!ok.includes(o.shape)) delete o[opt];
      return o;
    });
    const { data } = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: `vc-${i}`, overrides: { claims, visitsUsed: { acupuncture: i % 3 ? 0 : 12 } } });
    assert.deepEqual(checkCommercialPage(printedFields(data, TEXT), TEXT), [], `vc-${i} ${JSON.stringify(claims)}`);
  }
});

test('every commercial scenario generates for seeds 1-200 on each option it leaves open; each error and decoy lands on the line its scenario names, whatever the service order', () => {
  let reordered = 0;
  for (const s of SCENARIOS) {
    const sc = loadScenario('commercial-eob', s);
    assert.ok(sc.claims.some((c) => !['lab', 'ambulance', 'urgent-care'].includes(typeof c === 'string' ? c : c.shape)), `${s}: a clinician's claim for a statement`);
    for (const o of optionsOf(s)) for (let i = 1; i <= 200; i++) {
      const { groundTruth: k, context } = generateDocument({ type: 'commercial-eob', scenario: s, seed: `gen-${i}`, overrides: o });
      const g = context.commercial;
      if (g.scenarioIndex.some((x, j) => x !== j)) reordered++;
      const placed = [...k.errors.filter((e) => e.severity !== 'info' && e.lineRef), ...k.decoys];
      for (const m of [...(sc.mutations || []), ...(sc.decoys || [])].filter((x) => x.args?.line)) {
        const want = m.args.line === 'well-visit' ? [...WELL_VISITS].map((id) => SERVICES[id].code) : [SERVICES[m.args.line].code];
        assert.ok(placed.some((e) => { const [ki, j] = e.lineRef.match(/\d+/g).map(Number);
          return g.scenarioIndex[g.keyClaims[ki].encounter] === m.args.claim && want.includes(k.claims[ki].lines[j].code); }), `${s} gen-${i}: ${m.op} on claim ${m.args.claim} ${m.args.line}`);
      }
    }
  }
  assert.ok(reordered > 0, 'some seeds print the claims in another order than the scenario lists them');
});

test('the key and the 835 are the printed adjudication: each key line\'s facts and money equal the true adjudication except on a planted line (money also after a pre-operation line); the 835 rows agree with the page on each pre kind', () => {
  const FACTS = ['protected', 'qpa', 'recognized', 'preventive', 'denial', 'balanceBillable'];
  const MONEY = ['charged', 'allowed', 'paid', 'toDeductible', 'coinsurance', 'copay', 'nonCovered', 'patientMayBeBilled'];
  for (const s of SCENARIOS) for (let i = 1; i <= 50; i++) {
    const { groundTruth: k, context } = generateDocument({ type: 'commercial-eob', scenario: s, seed: `kf-${i}` });
    const g = context.commercial; const truth = g.truth.claims;
    const planted = new Set(k.errors.filter((e) => e.severity !== 'info' && e.lineRef).map((e) => e.lineRef));
    const preAt = k.errors.filter((e) => PRE_KINDS.has(e.kind)).map((e) => e.lineRef);
    // every key line with its encounter and its position there, in the order the plan adjudicated them
    const order = []; k.claims.forEach((kc, ki) => { const enc = g.keyClaims[ki].encounter; const own = truth[enc].lines.map((l, li) => ({ l, li })).filter(({ l }) => (l.providerId ?? 'facility') === g.keyClaims[ki].payee.key);
      kc.lines.forEach((line, j) => order.push({ ref: `claims[${ki}].lines[${j}]`, line, t: own[j].l, at: enc * 100 + own[j].li })); });
    const firstPre = Math.min(...order.filter((x) => preAt.includes(x.ref)).map((x) => x.at));
    for (const { ref, line, t, at } of order) {
      const truthLine = { protected: !!t.protected, qpa: t.qpa ?? null, recognized: t.recognized ?? null, preventive: t.preventive || null, denial: t.denial ? t.denial.reason : null, balanceBillable: t.balanceBillable,
        charged: t.billed, allowed: t.allowed, paid: t.planPaid, toDeductible: t.deductible, coinsurance: t.coinsurance, copay: t.copay, nonCovered: t.notCovered, patientMayBeBilled: t.memberOwes };
      if (!planted.has(ref)) for (const f of FACTS) assert.deepEqual(line[f], truthLine[f], `${s} kf-${i} ${ref}: ${f} differs from the truth with no entry`);
      if (!planted.has(ref) && !(at > firstPre)) for (const f of MONEY) assert.equal(line[f], truthLine[f], `${s} kf-${i} ${ref}: ${f}`);
    }
    // the 835 rows of each pre-kind line follow what the page prints for it
    for (const e of k.errors.filter((x) => PRE_KINDS.has(x.kind))) {
      const [ki, j] = e.lineRef.match(/\d+/g).map(Number); const line = k.claims[ki].lines[j]; const rows = Object.fromEntries(commercialAdjustments(line));
      const codes = Object.values(rows).flat().map(([c]) => c); const remark = g.data.claims[ki].lineItems[j].remark;
      if (e.kind === 'emergency-authorization-denial') { assert.ok(codes.includes('197'), `${s}: denied for authorization, CARC 197`); assert.ok(['PI', 'PO'].includes(remark)); }
      if (e.kind === 'surprise-balance-bill') { assert.ok((rows.PR || []).some(([c]) => c === '45'), `${s}: the balance billed to the patient, PR-45`); assert.ok(['OA', 'CN'].includes(remark)); }
      if (e.kind === 'preventive-cost-sharing') { assert.ok((rows.PR || []).some(([c]) => ['1', '2', '3'].includes(c)), `${s}: cost sharing, PR-1/2/3`); assert.ok(['DD', 'CP', 'CI'].includes(remark)); }
    }
  }
});

test('verify: each kind is found at its line, at a field inside it, and (a denial note) at the note; each decoy\'s "wrongly reported as" counts against it; the elective denial\'s coverage-denial is found and emergency-authorization-denial there is a false alarm; a document-level entry is found with or without a place', () => {
  const at = (e) => e.fieldRef;
  for (const s of SCENARIOS) {
    const { groundTruth: k } = generateData({ type: 'commercial-eob', scenario: s, seed: 'vs-1' });
    const fields = k.documents[0].fields; const planted = k.errors.filter((e) => e.severity !== 'info');
    const reports = [
      planted.map((e) => ({ kind: e.kind, ...(at(e) ? { fieldRef: at(e) } : {}) })),
      planted.map((e) => ({ kind: e.kind, ...(at(e) ? { fieldRef: Object.keys(fields).find((f) => f.startsWith(`${at(e)}.`)) || at(e) } : { fieldRef: 'claims[0].lineItems[0]' }) })),
      planted.map((e) => ({ kind: e.kind, ...(e.relatedFieldRef ? { fieldRef: e.relatedFieldRef } : at(e) ? { fieldRef: at(e) } : {}) })),
    ];
    for (const errors of reports) { const r = scoreExtraction(k, { fields: {}, errors }).errors; assert.equal(r.found, planted.length, `${s}: ${JSON.stringify(errors)}`); assert.equal(r.falseAlarms, 0, s); }
  }
  const wronglyAs = { 'out-of-network-balance': ['in-network-balance-bill', 'surprise-balance-bill'], 'consented-balance': ['surprise-balance-bill'], 'ground-ambulance-balance': ['surprise-balance-bill'],
    'problem-visit-beside-listed': ['preventive-cost-sharing'], 'oop-excludes-non-covered': ['math-error', 'oop-max-exceeded'], 'elective-authorization-denial': ['emergency-authorization-denial'],
    'appeal-rights-by-section': ['missing-required-section'] };
  const { groundTruth: k } = generateData({ type: 'commercial-eob', scenario: 'decoys-only', seed: 'vs-2' });
  assert.deepEqual(k.decoys.map((d) => d.kind).sort(), Object.keys(wronglyAs).sort());
  for (const d of k.decoys) for (const kind of wronglyAs[d.kind]) {
    const r = scoreExtraction(k, { fields: {}, errors: [{ kind, fieldRef: d.fieldRef }] }).errors;
    assert.equal(r.falseAlarms, 1, `${d.kind} reported as ${kind}`); assert.deepEqual(r.decoysFlagged, [d.id]);
  }
  const elective = k.decoys.find((d) => d.kind === 'elective-authorization-denial');
  assert.ok(k.errors.some((e) => e.kind === 'coverage-denial' && e.severity === 'info' && e.fieldRef === elective.fieldRef), 'the elective denial is keyed coverage-denial');
  assert.equal(scoreExtraction(k, { fields: {}, errors: [{ kind: 'coverage-denial', fieldRef: elective.fieldRef }] }).errors.found, 1);
  const doc = generateData({ type: 'commercial-eob', scenario: 'denial-without-appeal-rights', seed: 'vs-3' }).groundTruth;
  for (const report of [{ kind: 'missing-required-section' }, { kind: 'missing-required-section', fieldRef: 'claims[0].lineItems[0]' }]) {
    const r = scoreExtraction(doc, { fields: {}, errors: [report, report] }).errors; assert.equal(r.found, 1, JSON.stringify(report)); assert.equal(r.falseAlarms, 0); assert.equal(r.repeats, 1);
  }
});

test('the statement beside a commercial EOB: any printed claim; its balance is the claim\'s printed amount the member may owe (each variant off by its recorded delta); out of network unprotected only clean; the payment at the visit only with a copay; the denied line only when nothing is owed for it; a 1.6 key without the commercial facts', async () => {
  const { generatePair } = await import('../src/generate/index.js');
  const { BILL_VARIANTS } = await import('../src/generate/provider-statement.js');
  const FACTS = ['network', 'protected', 'recognized', 'qpa', 'balanceBillable', 'preventive', 'denial'];
  const reach = new Map();
  for (const s of SCENARIOS) for (let i = 1; i <= 50; i++) for (const bill of BILL_VARIANTS) {
    const p = generatePair({ type: 'commercial-eob', scenario: s, seed: `st-${i}`, bill, orClean: true });
    const st = p.statement; const k = st.groundTruth.pair.claim; const ec = p.eob.groundTruth.claims[k]; const printed = p.eob.data.claims[k];
    const where = `${s} st-${i} ${bill}`;
    const sm = st.data.summary; const err = st.groundTruth.errors.find((e) => e.kind === 'bill-vs-eob-mismatch');
    assert.equal(Math.round((sm.balanceDue + sm.paymentsReceived) * 100), Math.round(printed.totals.youMayOwe * 100) + (err ? Math.round(err.delta * 100) : 0), `${where}: balance`);
    const v = st.groundTruth.pair.variant; reach.set(v, (reach.get(v) || 0) + 1);
    const oa = ec.lines.some((l) => l.approved && l.network === 'out' && !l.protected);
    if (oa) assert.equal(v, 'clean', `${where}: out of network unprotected`);
    if (['paid-at-visit', 'over-owed-with-payment'].includes(v)) assert.ok(ec.lines.some((l) => l.copay > 0), `${where}: a copay`);
    if (v === 'denied-line-billed') assert.ok(ec.lines.some((l) => !l.approved && l.patientMayBeBilled === 0), `${where}: a held-harmless denial`);
    assert.equal(st.groundTruth.schemaVersion, '1.6');
    for (const l of st.groundTruth.claims[0].lines) for (const f of FACTS) assert.ok(!(f in l), `${where}: ${f} on the statement key`);
    for (const f of ['payee', 'facility', 'emergency']) assert.ok(!(f in st.groundTruth.claims[0]), `${where}: ${f}`);
    assert.equal(p.eob.groundTruth.schemaVersion, '1.7');
  }
  for (const v of BILL_VARIANTS) assert.ok(reach.get(v) > 0, `${v} reached`);
});

// Every new scenario's page, both insurers, read back: each claim's facts beside their labels in its own block, each line
// as its row, each note (the denial with or without its plan section, the appeal pointer, the protected, consent and
// out-of-pocket notes), each accumulator row, and the sections: the appeal rights title printed exactly when the key
// says the section is there, the No Surprises Act notice exactly when a line is protected.
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser; let dir;
before(async () => { if (!skip) { browser = await launchBrowser(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-commercial-errors-')); } });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const money = (x) => (Math.round(x * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const dash = (x) => (x > 0 ? `$${money(x)}` : '-');
test('every new scenario\'s page reads back field by field for both insurers, sections included', { skip, timeout: 900000 }, async () => {
  const S = TEXT.claim; let withoutAppeal = 0; let withAppeal = 0;
  for (const s of SCENARIOS.filter((x) => x !== 'baseline-clean')) for (const insurer of ['a', 'b']) {
    const { data } = generateData({ type: 'commercial-eob', scenario: s, seed: 'rb-1', overrides: { insurer } });
    const P = printedFields(data, TEXT);
    const out = fs.mkdtempSync(path.join(dir, `${s}-${insurer}-`));
    const pdf = await RENDERERS['commercial-eob'](data, TEXT, out, { browser, title: 't', band: 'b' });
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
    const page = (n) => execFileSync('pdftotext', ['-raw', '-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ').replace(/([a-z])- ([a-z])/g, '$1-$2');
    const all = Array.from({ length: pages }, (_, i) => page(i + 1)).join(' ');
    const at = (i) => all.indexOf(`${S.number} ${P.claims[i].claimNumber}`);
    const block = (i) => (insurer === 'a' ? page(i + 2) : all.slice(at(i), i + 1 < P.claims.length ? at(i + 1) : undefined));
    P.claims.forEach((c, i) => {
      const b = block(i); const where = `${s} ${insurer} claim ${i}`;
      for (const [label, value] of [[S.number, c.claimNumber], [S.provider, c.provider], [S.specialty, c.specialty], [S.network, c.network], [S.place, c.place], [S.emergency, c.emergency]])
        assert.ok(b.includes(`${label} ${value}`), `${where}: "${label} ${value}"`);
      for (const l of c.lineItems) {
        const row = `${l.code} $${money(l.billed)} $${money(l.allowed)} $${money(l.planPaid)} ${dash(l.deductible)} ${dash(l.copay)} ${dash(l.coinsurance)} ${dash(l.notCovered)} $${money(l.youMayOwe)}${l.remark ? ` ${l.remark}` : ''}`;
        assert.ok(b.includes(row), `${where}: row "${row}"`);
      }
      for (const n of c.notes) assert.ok(b.includes(n), `${where}: note "${n.slice(0, 60)}"`);
    });
    for (const r of P.accumulators) assert.ok(all.includes(`${r.label} $${money(r.before)} $${money(r.thisStatement)} $${money(r.yearToDate)}${r.met ? ` (${TEXT.accumulators.metNote})` : ''} $${money(r.limit)}`), `${s} ${insurer}: accumulator ${r.label}`);
    const back = page(pages);
    assert.equal(back.includes(TEXT.appeal.title) && back.includes(TEXT.appeal.civilAction), P.sections.appeal, `${s} ${insurer}: the appeal rights section`);
    assert.equal(all.includes(TEXT.nsa.title), P.sections.noSurprises, `${s} ${insurer}: the No Surprises notice`);
    if (P.sections.appeal) withAppeal++; else withoutAppeal++;
  }
  assert.ok(withAppeal > 0 && withoutAppeal > 0, 'pages with and without the appeal rights section');
});

// Cases beyond the published scenarios that reach every path of the operations: kind 2 on emergency care and in its OA
// form, at an ambulatory surgical center; kind 3 on a vaccine; kind 4 shifted down; the out-of-network authorization
// denial; a radiologist out of network at an imaging center (no protection).
const EXTRA = {
  'kind-2-emergency': { claims: [{ shape: 'emergency', network: 'out', facilityNetwork: 'in', xray: false }], mutations: [{ op: 'ce-unprotect-line', args: { claim: 0, line: 'er-physician' } }] },
  'kind-2-oa': { claims: [{ shape: 'surgery', anesthesiaNetwork: 'out' }], mutations: [{ op: 'ce-unprotect-line', args: { claim: 0, line: 'knee-anesthesia' } }] },
  'kind-2-asc': { claims: [{ shape: 'surgery', facilityType: 'ambulatory-surgical-center', pathologyNetwork: 'out' }], mutations: [{ op: 'ce-unprotect-line', args: { claim: 0, line: 'tissue-exam' } }] },
  'kind-3-vaccine': { claims: [{ shape: 'preventive-adult', flu: true }], before: {}, mutations: [{ op: 'ce-preventive-cost-share', args: { claim: 0, line: 'flu-vaccine' } }] },
  // the member's id comes from the seed, so the starting totals near the limit are written for each seed
  'kind-4-down': (seed) => { const base = { design: 'ppo', tier: 'self', claims: ['office-primary'] };
    const id = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: base }).data.patient.memberId;
    return { ...base, before: { person: { [id]: { in: { ded: 1450, oop: 1450 } } } }, mutations: [{ op: 'ce-accumulator-off', args: { group: 'person', network: 'in', kind: 'deductible', by: 100 } }] }; },
  // the true year to date at the limit ("(Met)"), shifted down below it: "(Met)" follows the printed value
  'kind-4-met': (seed) => { const base = { design: 'ppo', tier: 'self', claims: ['office-primary'] };
    const id = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: base }).data.patient.memberId;
    return { ...base, before: { person: { [id]: { in: { ded: 1500, oop: 1500 } } } }, mutations: [{ op: 'ce-accumulator-off', args: { group: 'person', network: 'in', kind: 'deductible', by: 100 } }] }; },
  'denial-out': { claims: [{ shape: 'surgery', surgeonNetwork: 'out', priorAuthObtained: false }] },
  'imaging-center': { claims: [{ shape: 'imaging', facilityType: 'independent-imaging-center', network: 'out' }] },
};
const CASES_ALL = [...SCENARIOS.map((s) => ({ name: s, scenario: s, over: {} })), ...Object.entries(EXTRA).map(([name, over]) => ({ name, scenario: 'baseline-clean', over }))];
const overOf = (c, seed) => (typeof c.over === 'function' ? c.over(seed) : c.over);

test('every error entry says what is right: expected from the true adjudication of the same (pinned) charge, actual as printed, delta, the rule for the case; kind 4 up or down by the rule with "(Met)" from the printed value; the plan\'s denials keyed once each with the rule for their reason and network, never on a kind-5 line; x12Ref null where the 835 is right', async () => {
  const { buildRemittance } = await import('../src/x12/remittance.js');
  const R = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/operations.json'), 'utf-8')).rules;
  const reached = new Set();
  for (const c of CASES_ALL) for (let i = 1; i <= 15; i++) {
    const seed = `en-${i}`; const where = `${c.name} ${seed}`;
    const gen = generateDocument({ type: 'commercial-eob', scenario: c.scenario, seed, overrides: overOf(c, seed) });
    const { groundTruth: k, data, context } = gen; const g = context.commercial;
    // key line -> its true and printed adjudication lines (same encounter, the payee's lines in order)
    const lineOf = (ref) => { const [ki, j] = ref.match(/\d+/g).map(Number); const enc = g.keyClaims[ki].encounter; const pick = (adj) => adj.claims[enc].lines.filter((l) => (l.providerId ?? 'facility') === g.keyClaims[ki].payee.key)[j];
      return { key: k.claims[ki].lines[j], truth: pick(g.truth), printed: pick(g.adjudicated), emergency: !!k.claims[ki].emergency, ki, j }; };
    k.claims.forEach((kc, ki) => kc.lines.forEach((l, j) => assert.equal(l.charged, lineOf(`claims[${ki}].lines[${j}]`).truth.billed, `${where}: the charge is the true one`)));
    const x12 = buildRemittance({ type: 'commercial-eob', scenario: c.scenario, seed, generated: { data: gen.data, groundTruth: gen.groundTruth } }).x12Refs;
    const kind5 = new Set(k.errors.filter((e) => e.kind === 'emergency-authorization-denial').map((e) => e.lineRef));
    k.errors.forEach((e, n) => {
      const cents = (x) => Math.round(x * 100);
      if (PRE_KINDS.has(e.kind)) {
        const L = lineOf(e.lineRef);
        assert.equal(e.expected, L.truth.memberOwes, `${where} ${e.kind}: expected`); assert.equal(e.actual, L.key.patientMayBeBilled, `${where} ${e.kind}: actual`);
        assert.equal(cents(e.delta), cents(e.actual) - cents(e.expected), `${where}: delta`);
        if (e.kind !== 'emergency-authorization-denial') assert.ok(cents(e.delta) > 0, `${where} ${e.kind}: the member is charged more`);
        assert.equal(e.rule, e.kind === 'surprise-balance-bill' ? (L.emergency ? R.surpriseEmergency : R.surpriseFacility) : e.kind === 'preventive-cost-sharing' ? R.preventive : R.emergencyAuthorization, `${where}: ${e.kind} rule`);
        assert.ok(x12[n], `${where}: ${e.kind} is in the 835`); reached.add(e.rule);
      } else if (e.kind === 'in-network-balance-bill') {
        const L = lineOf(e.lineRef);
        assert.equal(e.expected, L.truth.memberOwes); assert.equal(cents(e.actual) - cents(e.expected), cents(L.key.charged) - cents(L.key.allowed), `${where}: the whole difference`);
        assert.equal(e.actual, L.key.patientMayBeBilled); assert.equal(e.rule, R.inNetworkBalance); assert.equal(x12[n], null, `${where}: the 835 is right`);
      } else if (e.kind === 'math-error') {
        const r = Number(e.fieldRef.match(/\d+/)[0]); const row = data.accumulators[r]; const by = cents(Math.abs(e.delta));
        assert.equal(cents(e.expected), cents(row.before) + cents(row.thisStatement), `${where}: expected is before + this statement`);
        assert.equal(e.actual, row.yearToDate); assert.equal(cents(e.actual), cents(e.expected) + (cents(e.expected) + by >= cents(row.limit) ? -by : by), `${where}: up unless that reaches the limit`);
        assert.equal(row.met, cents(row.yearToDate) >= cents(row.limit), `${where}: "(Met)" by the printed value`);
        assert.equal(e.rule, R.accumulator); assert.equal(x12[n], null); reached.add(cents(e.delta) < 0 ? 'down' : 'up');
        if (cents(e.expected) >= cents(row.limit) && !row.met) reached.add('met-differs');
      } else if (e.kind === 'missing-required-section') {
        assert.equal(x12[n], null, `${where}: the 835 is right`);
        if (e.lineRef === null) { assert.equal(e.rule, R.missingAppeal); assert.equal(e.fieldRef, null); assert.equal(e.relatedFieldRef, undefined); }
        else { const L = lineOf(e.lineRef); assert.equal(e.rule, R.missingProvision); assert.ok(L.key.denial); assert.equal(e.relatedFieldRef, `claims[${L.ki}].lineItems[${L.j}]`);
          const notes = data.claims[L.ki].lineItems.slice(0, L.j).reduce((x, l) => x + (l.denial ? 1 : 0) + (l.protectedShare !== null ? 1 : 0), 0); assert.equal(e.fieldRef, `claims[${L.ki}].notes[${notes}]`); }
      } else if (e.kind === 'coverage-denial') {
        const L = lineOf(e.lineRef); assert.equal(e.severity, 'info'); assert.ok(!kind5.has(e.lineRef), `${where}: no correct-denial entry on a kind-5 line`);
        assert.equal(e.rule, L.key.denial === 'visit-limit' ? R.denialVisitLimit : L.key.network === 'in' ? R.denialAuthorization : R.denialAuthorizationOut, `${where}: denial rule`); reached.add(e.rule);
      } else assert.fail(`${where}: unexpected kind ${e.kind}`);
    });
    // each line the plan denied (not by an operation) has exactly one correct-denial entry
    k.claims.forEach((kc, ki) => kc.lines.forEach((l, j) => { const ref = `claims[${ki}].lines[${j}]`;
      assert.equal(k.errors.filter((e) => e.kind === 'coverage-denial' && e.lineRef === ref).length, l.denial && !kind5.has(ref) ? 1 : 0, `${where}: ${ref} coverage-denial`); }));
  }
  for (const r of [R.surpriseEmergency, R.surpriseFacility, R.preventive, R.emergencyAuthorization, R.denialAuthorization, R.denialAuthorizationOut, R.denialVisitLimit, 'up', 'down', 'met-differs']) assert.ok(reached.has(r), `reached: ${r.slice(0, 40)}`);
});

test('the notes the operations rest on, from the key\'s lines: the out-of-pocket note once on each claim with an amount not covered or a difference billed and on no other; every denied line\'s note with the appeal pointer and, unless kind 6 dropped it, its plan section; no claim description numbers a claim', () => {
  const pointer = TEXT.denial.appealPointer.replace('{title}', TEXT.appeal.title);
  for (const c of CASES_ALL) for (let i = 1; i <= 10; i++) {
    const { data, groundTruth: k } = generateData({ type: 'commercial-eob', scenario: c.scenario, seed: `nt-${i}`, overrides: overOf(c, `nt-${i}`) });
    const P = printedFields(data, TEXT); const dropped = new Set(k.errors.filter((e) => e.kind === 'missing-required-section' && e.lineRef).map((e) => e.lineRef));
    k.claims.forEach((kc, ki) => {
      const want = kc.lines.some((l) => l.nonCovered > 0 || l.balanceBillable > 0) ? 1 : 0;
      assert.equal(P.claims[ki].notes.filter((n) => n === TEXT.lineNotes.oopExcluded).length, want, `${c.name} nt-${i} claim ${ki}: the out-of-pocket note`);
      const denialNotes = P.claims[ki].notes.filter((n) => n.includes(`: ${TEXT.denial.reasonLabel}: `));
      const denied = kc.lines.map((l, j) => ({ l, j })).filter(({ l }) => l.denial);
      assert.equal(denialNotes.length, denied.length, `${c.name} nt-${i} claim ${ki}: a note per denied line`);
      denied.forEach(({ l, j }, n) => {
        assert.ok(denialNotes[n].startsWith(`${l.code}: `) && denialNotes[n].endsWith(pointer), `${c.name}: the appeal pointer`);
        assert.equal(denialNotes[n].includes(`${TEXT.denial.provisionLabel}: `), !dropped.has(`claims[${ki}].lines[${j}]`), `${c.name}: the plan section`);
      });
    });
  }
  for (const s of SCENARIOS) assert.doesNotMatch(loadScenario('commercial-eob', s).description, /\bclaims? \d/i, `${s}: a claim named by number`);
});

test('every refusal of an operation or decoy gives its own message, naming only the operation', async () => {
  const { locate, planOperations } = await import('../src/generate/commercial-operations.js');
  const M = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/operations.json'), 'utf-8')).messages;
  const run = (over) => () => generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'rf-1', overrides: over });
  const is = (key, op) => (e) => e.message === M[key].replace('{op}', op);
  const one = (claims, op, args, extra = {}) => ({ claims, mutations: [{ op, args }], ...extra });
  const cases = [
    ['noClaim', 'ce-in-network-balance-bill', one(['office-primary'], 'ce-in-network-balance-bill', { claim: 3, line: 'office-primary' })],
    ['noLine', 'ce-in-network-balance-bill', one(['office-primary'], 'ce-in-network-balance-bill', { claim: 0, line: 'blood-draw' })],
    ['noLine', 'ce-preventive-cost-share', one([{ shape: 'preventive-adult', flu: true }], 'ce-preventive-cost-share', { claim: 0, line: 'hiv-test' }, { before: {} })],
    ['lineTaken', 'ce-decoy-out-of-network-balance', { claims: [{ shape: 'office-specialist', network: 'out' }], mutations: [], decoys: [{ op: 'ce-decoy-out-of-network-balance', args: { claim: 0, line: 'office-specialist' } }, { op: 'ce-decoy-out-of-network-balance', args: { claim: 0, line: 'office-specialist' } }] }],
    ['lineTaken', 'ce-accumulator-off', { design: 'ppo', tier: 'self', claims: ['office-primary'], mutations: [{ op: 'ce-accumulator-off', args: { group: 'person', network: 'in', kind: 'deductible', by: 5 } }, { op: 'ce-accumulator-off', args: { group: 'person', network: 'in', kind: 'outOfPocket', by: 5 } }] }],
    ['notBalanceable', 'ce-in-network-balance-bill', one([{ shape: 'office-specialist', network: 'out' }], 'ce-in-network-balance-bill', { claim: 0, line: 'office-specialist' })],
    ['notProtected', 'ce-unprotect-line', one(['ambulance'], 'ce-unprotect-line', { claim: 0, line: 'ambulance-transport' })],
    ['notProtected', 'ce-unprotect-line', one([{ shape: 'surgery', surgeonNetwork: 'out', consent: ['surgeon'] }], 'ce-unprotect-line', { claim: 0, line: 'knee-surgery-surgeon' })],
    ['notPreventive', 'ce-preventive-cost-share', one([{ shape: 'preventive-adult', network: 'out' }], 'ce-preventive-cost-share', { claim: 0, line: 'well-visit' }, { before: {} })],
    ['notEmergency', 'ce-deny-emergency-for-auth', one(['office-primary'], 'ce-deny-emergency-for-auth', { claim: 0, line: 'office-primary' })],
    ['notEmergency', 'ce-deny-emergency-for-auth', one(['ambulance'], 'ce-deny-emergency-for-auth', { claim: 0, line: 'ambulance-transport' })],
    ['noRow', 'ce-accumulator-off', one(['office-primary'], 'ce-accumulator-off', { group: 'family', network: 'in', kind: 'deductible', by: 5 }, { design: 'ppo', tier: 'self' })],
    ['noRow', 'ce-accumulator-off', one(['office-primary'], 'ce-accumulator-off', { group: 'person', network: 'out', kind: 'deductible', by: 5 }, { design: 'hsa', tier: 'self' })],
    ['badBy', 'ce-accumulator-off', one(['office-primary'], 'ce-accumulator-off', { group: 'person', network: 'in', kind: 'deductible', by: 1000 }, { design: 'ppo', tier: 'self' })],
    ['badBy', 'ce-accumulator-off', one(['office-primary'], 'ce-accumulator-off', { group: 'person', network: 'in', kind: 'deductible', by: 0.001 }, { design: 'ppo', tier: 'self' })],
    ['needsBefore', 'ce-preventive-cost-share', one([{ shape: 'preventive-adult' }], 'ce-preventive-cost-share', { claim: 0, line: 'well-visit' })],
    ['needsOptionTier', 'ce-accumulator-off', one(['office-primary'], 'ce-accumulator-off', { group: 'person', network: 'in', kind: 'deductible', by: 5 })],
    ['notDenied', 'ce-drop-denial-element', one(['office-primary'], 'ce-drop-denial-element', { claim: 0, line: 'office-primary', element: 'provision' })],
    ['noDenial', 'ce-drop-denial-element', one(['office-primary'], 'ce-drop-denial-element', { element: 'appeal' })],
    ['lineTaken', 'ce-drop-denial-element', { claims: ['acupuncture'], visitsUsed: { acupuncture: 12 }, mutations: [{ op: 'ce-drop-denial-element', args: { element: 'appeal' } }, { op: 'ce-drop-denial-element', args: { element: 'appeal' } }] }],
    ['badElement', 'ce-drop-denial-element', one(['acupuncture'], 'ce-drop-denial-element', { claim: 0, line: 'acupuncture', element: 'reason' }, { visitsUsed: { acupuncture: 12 } })],
    ['unknownOp', 'scenario', one(['office-primary'], 'ce-no-such-op', { claim: 0, line: 'office-primary' })],
    ['unknownDecoy', 'scenario', { claims: ['office-primary'], mutations: [], decoys: [{ op: 'ce-no-such-decoy', args: { claim: 0, line: 'office-primary' } }] }],
  ];
  for (const [d, line, claims] of [['ce-decoy-out-of-network-balance', 'office-specialist', ['office-specialist']], ['ce-decoy-consented-balance', 'knee-anesthesia', [{ shape: 'surgery', consent: ['anesthesia'] }]],
    ['ce-decoy-ambulance-balance', 'office-primary', ['office-primary']], ['ce-decoy-problem-visit', 'office-primary', ['office-primary']], ['ce-decoy-oop-excludes', 'office-primary', ['office-primary']],
    ['ce-decoy-elective-denial', 'knee-surgery-surgeon', ['surgery']], ['ce-decoy-appeal-by-section', 'office-primary', ['office-primary']]])
    cases.push(['decoyNotHere', d, { claims, mutations: [], decoys: [{ op: d, args: { claim: 0, line } }] }]);
  const used = new Set();
  for (const [key, op, over] of cases) { assert.throws(run(over), is(key, op), `${key} ${op}`); used.add(key); }
  // a line billed twice in one claim is ambiguous (no shape bills one twice today)
  assert.throws(() => locate([{ _index: 0, lines: [{ service: 'blood-draw' }, { service: 'blood-draw' }] }], { claim: 0, line: 'blood-draw' }, 'ce-in-network-balance-bill'), is('lineTwice', 'ce-in-network-balance-bill')); used.add('lineTwice');
  assert.throws(() => planOperations({ claims: ['office-primary'], mutations: [{ op: 'ce-in-network-balance-bill', args: null }] }), is('noClaim', 'ce-in-network-balance-bill'));
  // mutations or decoys that are not a list are refused as the scenario's, before any entry is read
  for (const bad of ['x', {}, 1, true]) {
    assert.throws(() => planOperations({ claims: ['office-primary'], mutations: bad }), is('unknownOp', 'scenario'));
    assert.throws(() => planOperations({ claims: ['office-primary'], mutations: [], decoys: bad }), is('unknownOp', 'scenario'));
  }
  assert.deepEqual([...used].sort(), Object.keys(M).sort(), 'every message has its case');
});

test('verify matches a located entry before a document-level one of the same kind, in either order of the reports', () => {
  const { groundTruth: k } = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'vo-1', overrides: { claims: [{ shape: 'surgery', priorAuthObtained: false }, 'acupuncture'], visitsUsed: { acupuncture: 12 },
    mutations: [{ op: 'ce-drop-denial-element', args: { claim: 0, line: 'knee-surgery-surgeon', element: 'provision' } }, { op: 'ce-drop-denial-element', args: { element: 'appeal' } }] } });
  const located = k.errors.find((e) => e.kind === 'missing-required-section' && e.lineRef);
  for (const errors of [[{ kind: 'missing-required-section' }, { kind: 'missing-required-section', fieldRef: located.fieldRef }], [{ kind: 'missing-required-section', fieldRef: located.relatedFieldRef }, { kind: 'missing-required-section' }]]) {
    const r = scoreExtraction(k, { fields: {}, errors }).errors; assert.equal(r.found, 2, JSON.stringify(errors)); assert.equal(r.falseAlarms, 0);
  }
});

test('decidable on the paths no scenario publishes: kind 2 on emergency care, in its OA form and at a surgical center; kind 3 on a vaccine; kind 4 shifted down; an out-of-network denial; a radiologist out of network at an imaging center (unprotected, not flagged)', () => {
  for (const [name, over] of Object.entries(EXTRA)) for (const insurer of ['a', 'b']) for (let i = 1; i <= 10; i++) {
    const seed = `dx-${i}`; const o = typeof over === 'function' ? over(seed) : over;
    const { data, groundTruth: k } = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed, overrides: { ...o, insurer } });
    assert.deepEqual(checkCommercialPage(printedFields(data, TEXT), TEXT).map(key).sort(), k.errors.filter((e) => e.severity !== 'info').map(key).sort(), `${name} ${insurer} ${seed}`);
    // at an independent imaging center the out-of-network radiologist is not protected: OA, the difference owed
    if (name === 'imaging-center') { const ki = k.claims.findIndex((c) => c.payee.network === 'out'); assert.ok(ki >= 0 && k.claims[ki].lines.every((l) => !l.protected), `${seed}: unprotected`); assert.ok(data.claims[ki].lineItems.every((l) => l.remark === 'OA'), `${seed}: OA`); }
  }
});

test('the statement beside a commercial EOB, rendered: the contractual and the No Surprises Act adjustment rows, none out of network unprotected, the denied row; both keys valid (1.7 EOB with its pair, 1.6 statement), blind too; the EOB reference, the rule for the claim, the date after the EOB, the payer the insurer named', { skip, timeout: 600000 }, async () => {
  const { render } = await import('../src/index.js');
  const { generatePair } = await import('../src/generate/index.js');
  const { PAIR_STRINGS } = await import('../src/generate/provider-statement.js');
  const Ajv = (await import('ajv/dist/2020.js')).default; const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8')));
  const L = PAIR_STRINGS.labels; const CR = PAIR_STRINGS.commercialRules;
  // a seed whose drawn claim is of the wanted kind, found without rendering
  const find = (scenario, insurer, bill, ok) => { for (let i = 1; i <= 300; i++) { const p = generatePair({ type: 'commercial-eob', scenario, seed: `sr-${i}`, overrides: { insurer }, bill, orClean: true }); if (ok(p)) return `sr-${i}`; } throw new Error(`no seed for ${scenario} ${bill}`); };
  const claimOf = (p) => p.eob.groundTruth.claims[p.statement.groundTruth.pair.claim];
  const cases = [
    { scenario: 'preventive-cost-sharing', insurer: 'a', bill: 'over-owed', want: 'contract', ok: (p) => p.statement.groundTruth.pair.variant === 'over-owed' },
    { scenario: 'emergency-authorization-denial', insurer: 'b', bill: 'over-owed', want: 'nsa', ok: (p) => p.statement.groundTruth.pair.variant === 'over-owed' && claimOf(p).lines.some((l) => l.protected) },
    { scenario: 'in-network-balance-bill', insurer: 'a', bill: 'payment-misposted', want: 'none', ok: (p) => claimOf(p).lines.some((l) => l.network === 'out') },
    { scenario: 'emergency-authorization-denial', insurer: 'a', bill: 'denied-line-billed', want: 'contract', ok: (p) => p.statement.groundTruth.pair.variant === 'denied-line-billed' },
  ];
  for (const c of cases) {
    const seed = find(c.scenario, c.insurer, c.bill, c.ok); const out = fs.mkdtempSync(path.join(dir, 'pair-'));
    await render({ type: 'commercial-eob', scenario: c.scenario, seed, insurer: c.insurer, also: ['bill', '835'], bill: c.bill, billOrClean: true, outDir: out, browser });
    const base = `commercial-eob_${c.scenario}_${seed}.${c.insurer}`; const where = `${c.scenario} ${seed} ${c.bill}`;
    const eob = JSON.parse(fs.readFileSync(path.join(out, `${base}.ground-truth.json`), 'utf-8')); const st = JSON.parse(fs.readFileSync(path.join(out, `${base}.bill.ground-truth.json`), 'utf-8'));
    assert.ok(validate(eob), `${where}: EOB key ${JSON.stringify(validate.errors)}`); assert.ok(validate(st), `${where}: statement key ${JSON.stringify(validate.errors)}`);
    assert.deepEqual([eob.schemaVersion, eob.pair.role, st.schemaVersion, st.pair.role], ['1.7', 'eob', '1.6', 'bill']);
    const text = execFileSync('pdftotext', ['-layout', path.join(out, `${base}.bill.pdf`), '-'], { encoding: 'utf-8' });
    assert.equal(text.includes(L.contractualAdjustment), c.want === 'contract', `${where}: the contractual adjustment row`);
    assert.equal(text.includes(L.adjustmentNoSurprises), c.want === 'nsa', `${where}: the No Surprises Act adjustment row`);
    if (c.bill === 'denied-line-billed') assert.ok(!text.includes(L.denied), `${where}: the denied line left in the balance`);
    const k = st.pair.claim; const eobData = generateData({ type: 'commercial-eob', scenario: c.scenario, seed, overrides: { insurer: c.insurer } }).data;
    assert.equal(st.documents[0].entities.payer.name, eobData.insurer.name, `${where}: the payer is the insurer named`);
    for (const e of st.errors) assert.match(e.relatedDocumentFieldRef, new RegExp(`^claims\\[${k}\\]\\.(totals\\.(youMayOwe|planPaid)|lineItems\\[\\d+\\])$`), `${where}: the EOB reference`);
    if (st.pair.variant === 'over-owed') assert.equal(st.errors[0].rule, c.want === 'nsa' ? CR.overOwedProtected : CR.overOwed, `${where}: the rule for the claim`);
    if (st.pair.variant === 'payment-misposted') assert.equal(st.errors[0].rule, CR.paymentMisposted);
    if (st.pair.variant === 'denied-line-billed') assert.equal(st.errors[0].rule, CR.deniedLineBilled);
    if (c.want === 'none') assert.equal(st.pair.variant, 'clean', `${where}: out of network unprotected, clean only`);
    const [mm, dd, yy] = eobData.processed.split('/').map(Number);
    assert.ok(Date.parse(st.documents[0].fields['metadata.statementDate']) > Date.UTC(yy, mm - 1, dd), `${where}: the statement after the EOB`);
  }
  // blind: both keys valid, the statement's record beside the EOB's
  const out = fs.mkdtempSync(path.join(dir, 'pair-blind-')); const keys = fs.mkdtempSync(path.join(dir, 'pair-blind-keys-'));
  await render({ type: 'commercial-eob', scenario: 'surprise-balance-bill', seed: 'sr-blind', also: ['bill'], blind: true, outDir: out, keysDir: keys, browser });
  const blindKeys = fs.readdirSync(keys).filter((x) => x.endsWith('.json')); assert.equal(blindKeys.length, 2, 'the EOB\'s and the statement\'s keys');
  for (const f of blindKeys) { const kk = JSON.parse(fs.readFileSync(path.join(keys, f), 'utf-8')); assert.ok(validate(kk), `blind ${f}: ${JSON.stringify(validate.errors)}`); assert.ok(kk.blind, `blind ${f}`); }
});
