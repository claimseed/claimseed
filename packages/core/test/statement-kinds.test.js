// The commercial provider's statement from each kind of provider the EOB names as the payee: a hospital, a clinician's
// group practice, an urgent care center, a lab and an ambulance service. The expected values come from the EOB (its
// printed claim, its key and its 835), never from the statement's own data: the title by a kind map written out here,
// the provider block, the lines and the balance. Also: the urgent care visit's price, the payee kinds no statement is
// made for, the Medicare Advantage statements unchanged, and the tool texts that name the types.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { listScenarios, loadScenario, findChrome, launchBrowser, render, generateData } from '../src/index.js';
import { generatePair } from '../src/generate/index.js';
import { printedFields } from '../src/generate/commercial-eob.js';
import { PAIR_STRINGS, PAIRED_TYPES } from '../src/generate/provider-statement.js';
import { isSyntheticNpi } from '../src/generate/identifiers.js';
import { SERVICES } from '../src/generate/commercial/adjudicate.js';
import { buildRemittance, REMITTANCE_TYPES } from '../src/x12/remittance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEXT = JSON.parse(fs.readFileSync(path.join(here, '../data/commercial-eob/stock-content.json'), 'utf-8'));
const SCENARIOS = listScenarios('commercial-eob');
// the title for each payee kind the EOB can name (the titles, written out)
const TITLE = {
  'hospital-outpatient': 'Hospital Patient Statement', 'hospital-emergency-department': 'Hospital Patient Statement',
  clinician: 'Medical Group Statement', 'urgent-care': 'Urgent Care Statement', 'clinical-laboratory': 'Laboratory Statement',
  ambulance: 'Ambulance Statement',
};
const GROUP_WORD = 'Health Associates';
const c = (x) => Math.round(x * 100);
const npisOf835 = (text) => text.split('~').map((s) => s.trim().split('*')).filter((f) => (f[0] === 'N1' && f[1] === 'PE') || f[0] === 'NM1').map((f) => (f[0] === 'N1' ? f[4] : f[9])).filter(Boolean);

// What a statement must say, from its EOB: the title, the provider block, the lines and the clean balance.
function expectFromEob(p, where) {
  const k = p.statement.groundTruth.pair.claim; const eobKey = p.eob.groundTruth;
  const payee = eobKey.claims[k].payee; const shown = printedFields(p.eob.data, TEXT).claims[k]; const eobEntity = eobKey.documents[0].entities.providers[k];
  const md = p.statement.data.metadata; const fields = p.statement.groundTruth.documents[0].fields; const ents = p.statement.groundTruth.documents[0].entities.providers;
  assert.ok(TITLE[payee.kind], `${where}: payee kind ${payee.kind} has a statement`);
  assert.equal(md.title, TITLE[payee.kind], `${where}: title`); assert.equal(fields['metadata.title'], TITLE[payee.kind], `${where}: the key's title`);
  const address = md.providerAddress;
  assert.ok(!('providerCityStateZip' in md) && address.endsWith(p.eob.data.mailing.cityStateZip), `${where}: the address on one line`);
  if (payee.kind === 'clinician') {
    assert.ok(md.providerName.endsWith(` ${GROUP_WORD}`), `${where}: a group practice`);
    assert.ok(!eobKey.documents[0].entities.providers.some((e) => e.name === md.providerName), `${where}: the group is none of the EOB's providers`);
    assert.ok(isSyntheticNpi(md.npi), `${where}: the group's NPI is synthetic with a valid check digit`);
    assert.ok(!eobKey.claims.some((x) => x.payee.npi === md.npi), `${where}: the group's NPI is none of the EOB's`);
    assert.equal(md.treatingProvider, shown.provider, `${where}: the treating clinician as the EOB prints it`);
    assert.equal(md.treatingSpecialty, shown.specialty, `${where}: the specialty as the EOB prints it`);
    assert.deepEqual(ents, [{ name: md.providerName, npi: md.npi, address }, { name: shown.provider, specialty: shown.specialty }], `${where}: the key's providers`);
  } else {
    assert.equal(md.providerName, shown.provider, `${where}: the provider as the EOB prints it`);
    assert.equal(md.npi, payee.npi, `${where}: the EOB's payee NPI`); assert.equal(eobEntity.npi, payee.npi);
    assert.ok(!('treatingProvider' in md) && !('treatingSpecialty' in md), `${where}: no treating row`);
    assert.deepEqual(ents, [{ name: shown.provider, npi: payee.npi, address }], `${where}: the key's provider`);
  }
  assert.deepEqual(p.statement.data.lineItems.map((l) => [l.date, l.code, l.description, l.units, c(l.charge)]),
    shown.lineItems.map((l, j) => [l.date, l.code, l.service, eobKey.claims[k].lines[j].units, c(l.billed)]), `${where}: the lines`);
  if (p.statement.groundTruth.pair.variant === 'clean') assert.equal(c(p.statement.data.summary.balanceDue), c(shown.totals.youMayOwe), `${where}: the balance is the claim's printed amount the member may owe`);
  return { k, kind: payee.kind, shown };
}

test('every payee kind: the title, the provider block, the lines and the clean balance from the EOB; every kind reached over the commercial scenarios, seeds 1-50; each NPI one name across the EOB key, its 835 and the statement key', () => {
  const reach = {};
  for (const s of SCENARIOS) for (let i = 1; i <= 50; i++) {
    const seed = `sk-${i}`; const p = generatePair({ type: 'commercial-eob', scenario: s, seed, bill: 'clean' }); const where = `${s} ${seed}`;
    const { kind } = expectFromEob(p, where); reach[kind] = (reach[kind] || 0) + 1;
    // one NPI, one name: the statement's NPI names only what the EOB names under it, and a group's appears nowhere else
    const x12 = buildRemittance({ type: 'commercial-eob', scenario: s, seed, generated: { data: p.eob.data, groundTruth: p.eob.groundTruth } }).text;
    const md = p.statement.data.metadata; const named = new Map(p.eob.groundTruth.documents[0].entities.providers.map((e) => [e.npi, e.name]));
    if (kind === 'clinician') assert.ok(!named.has(md.npi) && !npisOf835(x12).includes(md.npi), `${where}: the group's NPI only on the statement`);
    else assert.equal(named.get(md.npi), md.providerName, `${where}: the NPI's one name`);
  }
  const kinds = { hospital: (reach['hospital-outpatient'] || 0) + (reach['hospital-emergency-department'] || 0), clinician: reach.clinician, urgent: reach['urgent-care'], lab: reach['clinical-laboratory'], ambulance: reach.ambulance };
  for (const [k, n] of Object.entries(kinds)) assert.ok(n > 0, `${k} reached (${JSON.stringify(reach)})`);
});

test('the draw ranges over every printed claim: each claim of a surgery EOB (the facility, four clinicians, the ambulance) is billed by some seed', () => {
  const drawn = new Set(); let claims = 0;
  for (let i = 1; i <= 50; i++) {
    const p = generatePair({ type: 'commercial-eob', scenario: 'surprise-balance-bill', seed: `dr-${i}`, bill: 'clean' });
    claims = p.eob.groundTruth.claims.length; drawn.add(p.statement.groundTruth.pair.claim);
  }
  assert.equal(claims, 6); assert.deepEqual([...drawn].sort(), [0, 1, 2, 3, 4, 5]);
});

test('the urgent care visit: code 99213, its catalog description, the office visit\'s Medicare amount and source, and the office visit\'s allowed amount for the same plan and network', () => {
  const uc = SERVICES['urgent-care-visit']; const op = SERVICES['office-primary'];
  assert.deepEqual([uc.code, uc.system, uc.description, uc.costShare, uc.multiple], ['99213', 'CPT', 'Visit to an urgent care center, low complexity', op.costShare, op.multiple]);
  assert.deepEqual(uc.medicare, op.medicare);
  for (const design of ['ppo', 'hsa']) for (let i = 1; i <= 5; i++) {
    const g = generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: `uc-${i}`, overrides: { claims: ['urgent-care', 'office-primary'], design } });
    const lines = printedFields(g.data, TEXT).claims.flatMap((x) => x.lineItems).filter((l) => l.code === '99213');
    const visit = lines.find((l) => l.service === uc.description); const office = lines.find((l) => l.service === op.description);
    assert.ok(visit && office, `${design} uc-${i}: both visits`); assert.equal(c(visit.allowed), c(office.allowed), `${design} uc-${i}: the same allowed amount`);
  }
});

test('no statement for a payee kind outside the five: an ambulatory surgical center or an independent imaging center (whose facility lines are priced and described as a hospital\'s) is in no published scenario, and its claim refuses a statement', () => {
  for (const s of SCENARIOS) for (const cl of loadScenario('commercial-eob', s).claims) {
    const t = typeof cl === 'string' ? undefined : cl.facilityType; assert.ok(t === undefined || t.startsWith('hospital-'), `${s}: facility type ${t}`);
  }
  let hit = 0;
  for (let i = 1; i <= 40 && hit < 2; i++) {
    const o = { type: 'commercial-eob', scenario: 'baseline-clean', seed: `nk-${i}`, overrides: { claims: [{ shape: 'imaging', facilityType: 'independent-imaging-center' }] } };
    const kinds = generateData(o).groundTruth.claims.map((x) => x.payee.kind);
    let k; try { k = generatePair(o).statement.groundTruth.pair.claim; } catch (e) { assert.equal(e.message, 'no statement kind: independent-imaging-center'); hit++; continue; }
    assert.equal(kinds[k], 'clinician', `nk-${i}: only the radiologist's claim makes a statement`);
  }
  assert.ok(hit > 0, 'the imaging center\'s claim was drawn');
});

// The Medicare Advantage statements are unchanged by the commercial kinds. Fixed values, recorded at 18896d5 (the
// commit before the change): the first 16 hex of sha256(JSON.stringify([statement data, statement key])). They are
// never computed into this file: an intended change to the MA statement edits them by hand in a reviewed commit.
const MA_DIGESTS = [
  ['ppo-eob', 'baseline-clean', 'ma-0', 'clean', 'df8bc0e74e251eb5'], ['ppo-eob', 'claim-total-math-error', 'ma-1', 'over-owed', '6df1c35d72310d38'],
  ['ppo-eob', 'combined-three-errors', 'ma-2', 'denied-line-billed', '58d521aec94a146c'], ['ppo-eob', 'decoys-partial-deductible', 'ma-3', 'payment-misposted', '8f8f9ed85fdbd20f'],
  ['ppo-eob', 'deductible-reapplied', 'ma-4', 'paid-at-visit', '77a65f5a7daf4004'], ['ppo-eob', 'denied-service', 'ma-5', 'over-owed-with-payment', '51da033de91985a2'],
  ['ppo-eob', 'duplicate-visit', 'ma-6', 'clean', '78e60b67860f32fb'], ['ppo-eob', 'preventive-cost-sharing', 'ma-7', 'over-owed', '59de2901915f0a8e'],
  ['hmo-eob', 'baseline-clean', 'ma-0', 'payment-misposted', 'be3e60123d6d9ff6'], ['hmo-eob', 'claim-total-math-error', 'ma-1', 'paid-at-visit', '799c030dac494653'],
  ['hmo-eob', 'combined-three-errors', 'ma-2', 'over-owed-with-payment', 'b7099c5f1e51a4ba'], ['hmo-eob', 'decoys-oop-cap-partial', 'ma-3', 'clean', '69c7a947acb536cc'],
  ['hmo-eob', 'denied-service', 'ma-4', 'over-owed', 'fd033d2d5debe5f4'], ['hmo-eob', 'duplicate-therapy-visit', 'ma-5', 'denied-line-billed', '975cfd883f16dad5'],
  ['hmo-eob', 'lab-cost-sharing', 'ma-6', 'payment-misposted', 'bf02840063c38519'], ['hmo-eob', 'share-after-oop-max', 'ma-7', 'paid-at-visit', '5bf0e14adfb281cb'],
];
test('the Medicare Advantage statements are unchanged: data and key digests of 16 cases over both types and every variant', () => {
  for (const [type, scenario, seed, bill, want] of MA_DIGESTS) {
    const st = generatePair({ type, scenario, seed, bill, orClean: true }).statement;
    assert.equal(crypto.createHash('sha256').update(JSON.stringify([st.data, st.groundTruth])).digest('hex').slice(0, 16), want, `${type} ${scenario} ${seed} ${bill}`);
    assert.ok(!('title' in st.data.metadata), `${type}: the MA statement takes the label's title`);
  }
});

test('the tool texts name every type: also for render_document and render_blind (every 835 type, every statement type), and the key schema\'s document type', () => {
  for (const f of ['alsoRender', 'alsoBlind']) {
    const t = PAIR_STRINGS.mcp[f]; const [x12, bill] = t.split('"bill"');
    for (const type of REMITTANCE_TYPES) assert.ok(x12.includes(type), `${f}: 835 for ${type}`);
    for (const type of PAIRED_TYPES) assert.ok(bill.includes(type), `${f}: the statement for ${type}`);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
  const d = schema.properties.documents.items.properties.type.description; const [types, paired] = d.split('provider-statement');
  for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob', 'commercial-eob', 'x12-835']) assert.ok(types.includes(type), `schema: ${type}`);
  for (const type of PAIRED_TYPES) assert.ok(paired.includes(type), `schema: the statement paired with ${type}`);
});

// Rendered: one statement of each kind, both insurers in turn, read back from the PDF against the EOB.
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser; let dir;
before(async () => { if (!skip) { browser = await launchBrowser(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-statement-kinds-')); } });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const money = (x) => `$${(Math.round(x * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const squash = (s) => s.replace(/\s+/g, ' ');
test('one rendered statement of each kind reads back: the title, the provider block (name, address, phone, NPI, the treating row only for a group), every line and the summary', { skip, timeout: 600000 }, async () => {
  const L = PAIR_STRINGS.labels; const wanted = ['hospital-outpatient', 'hospital-emergency-department', 'clinician', 'urgent-care', 'clinical-laboratory', 'ambulance'];
  const found = new Map();
  for (const s of SCENARIOS) for (let i = 1; i <= 30 && found.size < wanted.length; i++) {
    const insurer = found.size % 2 ? 'b' : 'a'; const p = generatePair({ type: 'commercial-eob', scenario: s, seed: `rk-${i}`, overrides: { insurer }, bill: 'clean' });
    const kind = p.eob.groundTruth.claims[p.statement.groundTruth.pair.claim].payee.kind;
    if (wanted.includes(kind) && !found.has(kind)) found.set(kind, { scenario: s, seed: `rk-${i}`, insurer, p });
  }
  assert.deepEqual([...found.keys()].sort(), [...wanted].sort(), 'a case of every kind');
  for (const [kind, { scenario, seed, insurer, p }] of found) {
    const where = `${kind} ${scenario} ${seed} ${insurer}`; const out = fs.mkdtempSync(path.join(dir, 'k-'));
    await render({ type: 'commercial-eob', scenario, seed, insurer, also: ['bill'], outDir: out, browser });
    const base = path.join(out, `commercial-eob_${scenario}_${seed}.${insurer}`);
    const text = squash(execFileSync('pdftotext', ['-layout', `${base}.bill.pdf`, '-'], { encoding: 'utf-8' }));
    const st = JSON.parse(fs.readFileSync(`${base}.bill.ground-truth.json`, 'utf-8'));
    // the rendered key is the generated one, with the page count the rendered PDF has, as every key records
    const { 'metadata.pageCount': pageCount, ...rendered } = st.documents[0].fields;
    assert.equal(pageCount, st.documents[0].pages, `${where}: the page count`);
    assert.deepEqual(rendered, p.statement.groundTruth.documents[0].fields, `${where}: the rendered key is the generated one`);
    const { shown } = expectFromEob(p, where); const md = p.statement.data.metadata;
    assert.ok(text.includes(TITLE[kind]), `${where}: the title`);
    for (const other of new Set(Object.values(TITLE))) if (other !== TITLE[kind]) assert.ok(!text.includes(other), `${where}: no other title (${other})`);
    // the header block, above the title: the provider's name, address, phone and NPI
    const head = text.slice(0, text.indexOf(TITLE[kind]));
    for (const v of [md.providerName, md.providerAddress, md.providerPhone, md.npi]) assert.ok(head.includes(v), `${where}: ${v} in the header`);
    if (kind === 'clinician') {
      assert.ok(text.includes(L.treatingProvider), `${where}: the treating row`);
      assert.ok(text.includes(shown.provider) && text.includes(shown.specialty), `${where}: the clinician and specialty the EOB prints`);
    } else assert.ok(!text.includes(L.treatingProvider), `${where}: no treating row`);
    for (const l of p.statement.data.lineItems) for (const v of [l.date, l.code, l.description, money(l.charge)]) assert.ok(text.includes(v), `${where}: line ${v}`);
    const sm = p.statement.data.summary;
    assert.ok(text.includes(`${L.totalCharges} ${money(sm.totalCharges)}`), `${where}: total charges`);
    assert.ok(text.includes(`${L.balanceDue} ${money(sm.balanceDue)}`), `${where}: balance due`);
    assert.equal(c(sm.balanceDue), c(shown.totals.youMayOwe), `${where}: the balance the EOB prints`);
  }
});

test('every claim a published commercial scenario prints is billed by a payee kind that has a statement', async () => {
  const { STATEMENT_KIND } = await import('../src/generate/provider-statement.js');
  const { listScenarios } = await import('../src/index.js');
  const seen = new Set();
  for (const scenario of listScenarios('commercial-eob')) {
    for (let i = 1; i <= 40; i++) {
      const { groundTruth } = generateData({ type: 'commercial-eob', scenario, seed: `kind-${i}` });
      for (const c of groundTruth.claims) { assert.ok(Object.hasOwn(STATEMENT_KIND, c.payee.kind), `${scenario} kind-${i}: ${c.payee.kind}`); seen.add(STATEMENT_KIND[c.payee.kind]); }
    }
  }
  assert.deepEqual([...seen].sort(), ['ambulance', 'hospital', 'lab', 'physician-group', 'urgent-care']);
});
