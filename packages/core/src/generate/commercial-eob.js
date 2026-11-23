// commercial-eob.js — the commercial employer-plan EOB (type commercial-eob): one patient on a fictional self-funded
// plan, the claims the plan processed for that patient, each encounter split into one printed claim per billing
// provider (the facility, and each clinician). The numbers are the commercial model's (commercial/adjudicate.js); this
// module only draws the people, places and names around them and lays out what the page prints. Keys starting with "_"
// are not printed and not flattened into the answer key's fields.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeRng, pickOne, intBetween } from './rng.js';
import { makeHousehold, commercialPlace } from './commercial/household.js';
import { makeCommercialClaims, SHAPE_NAMES, SHAPE_MEMBER } from './commercial/encounters.js';
import { adjudicateCommercial, checkStartingTotals, DESIGNS, SERVICES } from './commercial/adjudicate.js';
import { planOperations, runCommercialOperations, shiftAccumulator } from './commercial-operations.js';
import { FACILITY_PARTS, PLACES as LEXICON_PLACES, STREET_NAMES } from './lexicon.js';
import { syntheticNpi, claimNumber, phone555, digits } from './identifiers.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/commercial-eob');
export const INSURERS = JSON.parse(fs.readFileSync(path.join(DATA, 'insurers.json'), 'utf-8'));
export const INSURER_IDS = Object.freeze(INSURERS.insurers.map((i) => i.id));
export const COMMERCIAL_TYPE = 'commercial-eob';
// the tool texts for the type: list_document_types, the insurer option and its refusals
export const COMMERCIAL_TEXT = JSON.parse(fs.readFileSync(path.join(DATA, 'tool-text.json'), 'utf-8'));
// the printed words, which the answer key's fields are written in
const TEXT = JSON.parse(fs.readFileSync(path.join(DATA, 'stock-content.json'), 'utf-8'));
export const insurerMessage = (key, who) => COMMERCIAL_TEXT.messages[key].replace('{who}', who);
// The insurer option as a caller gives it: null (drawn from the seed) or a or b, for the commercial EOB only and never
// for a blind render. Checked before anything is converted or drawn.
export function checkInsurer({ type, insurer = null, blind = false }, who) {
  if (insurer === null || insurer === undefined) return null;
  if (type !== COMMERCIAL_TYPE) throw new Error(insurerMessage('insurerType', who));
  if (typeof insurer !== 'string' || !INSURER_IDS.includes(insurer)) throw new Error(insurerMessage('insurerValue', who));
  if (blind !== false && blind !== null && blind !== undefined) throw new Error(insurerMessage('insurerBlind', who));
  return insurer;
}

const cents = (x) => Math.round(x * 100);
const dollars = (c) => Math.round(c) / 100;
const sumC = (xs) => xs.reduce((s, x) => s + cents(x), 0);
const shortDate = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const fail = (what) => Object.assign(new Error(`commercial-eob: ${what}`), { code: 'SCENARIO' });

// The organization that bills when the billing provider is not a clinician: the facility, a laboratory, an ambulance
// service or an urgent care center. Names take a word no licensed facility carries (lexicon FACILITY_PARTS).
const ORG_KIND = { 'hospital-outpatient': 'Medical Center', 'hospital-emergency-department': 'Community Hospital', 'ambulatory-surgical-center': 'Medical Center',
  'independent-imaging-center': 'Imaging Center', 'clinical-laboratory': 'Diagnostic Laboratory', ambulance: 'Ambulance Service', 'urgent-care': 'Family Clinic' };
const orgName = (rng, kind) => `${pickOne(rng, FACILITY_PARTS.prefix)} ${ORG_KIND[kind]}`;
const ORG_SPECIALTY = new Set(['clinical-laboratory', 'ambulance', 'urgent-care']);
// the fictional plan document's sections a denial cites
const PLAN_SECTION = { 'prior-authorization': '4.3', 'visit-limit': '6.2' };

// The scenario's own figures, checked before anything is drawn: the design and tier (or null, drawn), the patient
// ("subscriber", "spouse" or "child"), and one to eight claim shapes with their options.
const FACILITY_TYPES = ['hospital-outpatient', 'hospital-emergency-department', 'ambulatory-surgical-center', 'independent-imaging-center'];
const OPTION_KEYS = new Set(['shape', 'network', 'facilityNetwork', 'facilityType', 'surgeonNetwork', 'anesthesiaNetwork', 'pathologyNetwork', 'radiologyNetwork',
  'consent', 'priorAuthObtained', 'labs', 'flu', 'xray', 'miles', 'minutes']);
const VISIT_LIMITED = new Set(Object.values(DESIGNS.designs).map((d) => d.visitLimit?.service).filter(Boolean));
export function checkCommercialScenario(sc) {
  if (sc.design != null && (typeof sc.design !== 'string' || !Object.prototype.hasOwnProperty.call(DESIGNS.designs, sc.design))) throw fail('unknown design');
  if (sc.tier != null && !['self', 'family'].includes(sc.tier)) throw fail('unknown tier');
  if (sc.patient != null && !['subscriber', 'spouse', 'child'].includes(sc.patient)) throw fail('unknown patient');
  if ((sc.patient === 'spouse' || sc.patient === 'child') && sc.tier === 'self') throw fail('a dependent needs family coverage');
  if (sc.visitsUsed !== undefined && !(sc.visitsUsed && typeof sc.visitsUsed === 'object' && !Array.isArray(sc.visitsUsed) && Object.keys(sc.visitsUsed).length > 0
    && Object.entries(sc.visitsUsed).every(([k, v]) => VISIT_LIMITED.has(k) && Number.isInteger(v) && v >= 0 && v <= 50))) throw fail('visits used not allowed');
  if (!Array.isArray(sc.claims) || sc.claims.length < 1 || sc.claims.length > 8) throw fail('one to eight claims');
  // a scenario's own starting totals: { person?: { [member id]: { in?, out?: { ded?, oop? } } }, family?: { in?, out? } }, dollars
  const visitCounts = (o) => o === undefined || (o && typeof o === 'object' && !Array.isArray(o) && Object.entries(o).every(([k, v]) => VISIT_LIMITED.has(k) && Number.isInteger(v) && v >= 0 && v <= 50));
  const amounts = (o) => o === undefined || (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => ['ded', 'oop'].includes(k)) && Object.values(o).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6));   // dollars in whole cents
  const nets = (o) => o === undefined || (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => ['in', 'out', 'visits'].includes(k)) && amounts(o.in) && amounts(o.out) && visitCounts(o.visits));
  if (sc.before !== undefined && !(sc.before && typeof sc.before === 'object' && !Array.isArray(sc.before) && Object.keys(sc.before).every((k) => ['person', 'family'].includes(k)) && nets(sc.before.family)
    && (sc.before.person === undefined || (sc.before.person !== null && typeof sc.before.person === 'object' && !Array.isArray(sc.before.person) && Object.keys(sc.before.person).length <= 8 && Object.values(sc.before.person).every(nets))))) throw fail('before not allowed');
  const NET = (v) => v === undefined || v === 'in' || v === 'out'; const BOOL = (v) => v === undefined || typeof v === 'boolean';
  const COUNT = (v, max) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= max);
  for (const c of sc.claims) {
    const o = typeof c === 'string' ? { shape: c } : c;
    if (!o || typeof o !== 'object' || !SHAPE_NAMES.includes(o.shape) || Object.keys(o).some((k) => !OPTION_KEYS.has(k))) throw fail('unknown claim shape or option');
    const ok = ['network', 'facilityNetwork', 'surgeonNetwork', 'anesthesiaNetwork', 'pathologyNetwork', 'radiologyNetwork'].every((k) => NET(o[k]))
      && ['priorAuthObtained', 'labs', 'flu', 'xray'].every((k) => BOOL(o[k])) && COUNT(o.miles, 100) && COUNT(o.minutes, 600)
      && (o.facilityType === undefined || FACILITY_TYPES.includes(o.facilityType))
      && (o.consent === undefined || (Array.isArray(o.consent) && o.consent.every((x) => typeof x === 'string')));
    if (!ok) throw fail('claim option value not allowed');
  }
}

/**
 * generateCommercial({ scenario, sc, seed, insurer }) -> { data, groundTruth parts, context }
 * The insurer is drawn from a stream of its own (the seed, the type and "insurer") unless given, so it moves no other draw.
 */
export function generateCommercial({ scenario, sc, seed, insurer = null }) {
  checkCommercialScenario(sc);
  const opPlan = planOperations(sc);   // the scenario's errors and decoys, checked before anything is drawn
  if (insurer !== null && !INSURER_IDS.includes(insurer)) throw fail('unknown insurer');
  const ins = INSURERS.insurers.find((i) => i.id === (insurer ?? pickOne(makeRng(seed, COMMERCIAL_TYPE, 'insurer'), INSURER_IDS)));
  const rng = makeRng(seed, COMMERCIAL_TYPE, scenario);
  const design = sc.design ?? pickOne(rng, ['ppo', 'hsa']);
  const tier = sc.tier ?? (sc.patient === 'spouse' || sc.patient === 'child' ? 'family' : pickOne(rng, ['self', 'family']));
  const place = commercialPlace(rng);
  const lex = LEXICON_PLACES.find((p) => p.city === place.city && p.zip === place.zip);
  const household = makeHousehold(rng, { tier });
  const want = sc.patient || 'subscriber';
  const patient = household.members.find((m) => m.relation === want) || household.members[0];
  // the patient must fit every claim's shape (a child's checkup is a child's, an adult's an adult's)
  for (const c of sc.claims) { const test = SHAPE_MEMBER[typeof c === 'string' ? c : c.shape]; if (test && !test(patient)) throw fail('patient does not fit a claim shape'); }
  const subscriber = household.members[0];
  const street = () => `${intBetween(rng, 100, 9899)} ${pickOne(rng, STREET_NAMES)}`;
  const mailing = { name: `${subscriber.firstName} ${subscriber.lastName}`, street: street(), cityStateZip: `${place.city}, ${place.state} ${place.zip}` };
  // the EOB is the plan's statement for one processing date: every claim on it was received 1 to 30 days before that
  // date (so it is decided within 30 days of receipt, 29 CFR 2560.503-1(f)(2)(iii)(B); no claim waits on a request for
  // information), its services 3 to 20 days before receipt. The page prints the services and the processing date,
  // not the receipts.
  const first = intBetween(rng, 0, 280);
  const claims = makeCommercialClaims(rng, household, { shapes: sc.claims.map((c) => ({ infoRequested: false, ...(typeof c === 'string' ? { shape: c } : c), memberId: patient.id })), days: [first, first] });
  const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000; const isoOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const processedDay = dayOf(claims[0].dateOfService) + 50;
  for (const c of claims) {
    const received = processedDay - intBetween(rng, 1, 30);
    c.dates = { ...c.dates, received: isoOf(received), decidable: isoOf(received) };
    c.dateOfService = isoOf(received - intBetween(rng, 3, 20)); c.decisionDays = processedDay - received;
  }
  claims.forEach((c, i) => { c._index = i; });   // the scenario's own position, which its errors and decoys name
  claims.sort((a, b) => dayOf(a.dateOfService) - dayOf(b.dateOfService));
  // what the family and the patient had met before these claims: drawn under each limit, or the scenario's own
  const before = sc.before ? structuredClone(sc.before) : drawBefore(rng, design, tier, household);
  // visits of a visit-limited service the patient already used this year (a scenario's own)
  if (sc.visitsUsed) before.person = { ...(before.person || {}), [patient.id]: { ...(before.person || {})[patient.id], visits: { ...sc.visitsUsed } } };
  // a scenario's own totals must be ones this plan, tier and household could hold
  if (sc.before !== undefined) { try { checkStartingTotals(design, tier, household.members, before); } catch { throw fail('before not allowed'); } }
  const ops = runCommercialOperations(opPlan, claims, (cs) => adjudicateCommercial({ design, tier, members: household.members, claims: cs, before }));
  const adj = ops.printed;
  const sponsor = pickOne(rng, INSURERS.sponsors);
  const groupNumber = `${digits(rng, 6)}`;
  const phone = phone555(rng, lex.areaCode);

  // one printed claim per billing provider of each encounter, in the order the lines bill
  const printed = []; const keyClaims = []; const posOf = new Map();   // "encounter:line" -> { k, j }, the key claim and its line
  for (const [ci, c] of claims.entries()) {
    const a = adj.claims[ci];
    const facility = c.facility ? { name: orgName(rng, c.facility.type === 'hospital-emergency-department' ? 'hospital-emergency-department' : c.facility.type), npi: syntheticNpi(rng), type: c.facility.type, network: c.facility.network } : null;
    const payees = [...new Set(a.lines.map((l) => l.providerId ?? 'facility'))];
    for (const [pi, payee] of payees.entries()) {
      const lines = a.lines.map((l, li) => ({ l, li })).filter(({ l }) => (l.providerId ?? 'facility') === payee);
      const clin = payee === 'facility' ? null : c.providers[payee];
      const org = clin && ORG_SPECIALTY.has(clin.specialty);
      const provider = payee === 'facility' ? { name: facility.name, npi: facility.npi, specialty: null, network: facility.network, kind: facility.type }
        : { name: org ? orgName(rng, clin.specialty) : clin.name, npi: clin.npi, specialty: clin.specialty, network: clin.network, kind: org ? clin.specialty : 'clinician' };
      const number = pi === 0 ? c.id : claimNumber(rng, 'ma');
      const consent = !!(clin && (c.consent || []).includes(payee));
      lines.forEach(({ li }, j) => posOf.set(`${ci}:${li}`, { k: keyClaims.length, j }));
      const lineItems = lines.map(({ l, li }) => printedLine(l, consent, shortDate(c.dateOfService), ops.dropProvision.has(`${ci}:${li}`)));
      const t = (k) => dollars(sumC(lines.map(({ l }) => l[k])));
      printed.push({ claimNumber: number, provider: { name: provider.name, specialty: provider.specialty, network: provider.network, kind: provider.kind },
        place: facility ? { name: facility.name, type: facility.type, network: facility.network } : null, emergency: !!c.emergency, consent,
        oopExcluded: lines.some(({ l }) => cents(l.notCovered) > 0 || cents(l.balanceBillable) > 0), lineItems,
        totals: { billed: t('billed'), allowed: t('allowed'), planPaid: t('planPaid'), deductible: t('deductible'), copay: t('copay'), coinsurance: t('coinsurance'), notCovered: t('notCovered'), youMayOwe: t('memberOwes') } });
      keyClaims.push({ claimNumber: number, provider: provider.name, specialty: provider.specialty, payee: { key: payee, npi: provider.npi, network: provider.network, kind: provider.kind },
        encounter: ci, dateOfService: c.dateOfService, emergency: !!c.emergency, facility: c.facility ? { ...c.facility, name: facility.name } : null,
        lines: lines.map(({ l }) => keyLine(l, c.dateOfService)), totals: { charged: t('billed'), allowed: t('allowed'), paid: t('planPaid'), patientMayBeBilled: t('memberOwes') } });
    }
  }
  const processed = shortDate(adj.claims.map((a) => a.dates.decided).sort().at(-1));
  const summary = { claims: printed.length, billed: dollars(sumC(printed.map((p) => p.totals.billed))), allowed: dollars(sumC(printed.map((p) => p.totals.allowed))),
    planPaid: dollars(sumC(printed.map((p) => p.totals.planPaid))), youMayOwe: dollars(sumC(printed.map((p) => p.totals.youMayOwe))) };
  const d = DESIGNS.designs[design];
  const data = {
    insurer: { name: ins.name, shortName: ins.shortName, network: ins.network },
    plan: { name: sponsor.planName, option: INSURERS.designNames[design], sponsor: sponsor.name, groupNumber, memberId: patient.id, phone },
    mailing, patient: { name: `${patient.firstName} ${patient.lastName}`, memberId: patient.id }, processed,
    terms: termsOf(d), summary, claims: printed,
    accumulators: accumulatorRows(d, tier, before, adj.accumulators, patient.id),
    hasProtected: printed.some((p) => p.lineItems.some((l) => l.remark === 'NS')),
    omitAppeal: ops.omitAppeal,
    appealDays: 180,
    _insurerId: ins.id, _design: design, _tier: tier,
    _dateOfNotice: adj.claims.map((a) => a.dates.decided).sort().at(-1),   // not printed: the date an 835 written beside it carries
  };
  // the planted errors and decoys, keyed where the page prints them (the container: a line, a note, a row)
  const at = (x) => posOf.get(x); const lineRefs = ({ k, j }) => ({ lineRef: `claims[${k}].lines[${j}]`, fieldRef: `claims[${k}].lineItems[${j}]` });
  const shifted = ops.accumulatorShift ? shiftAccumulator(data.accumulators, ops.accumulatorShift) : null;
  // the planted errors in the scenario's order, then the plan's own denials
  const errors = ops.errors.map(({ at: where, note, info: _info, accumulator, ...e }) => {
    if (accumulator) return { ...shifted.entry, lineRef: null, fieldRef: `accumulators[${shifted.row}]` };
    if (where === null) return { ...e, lineRef: null, fieldRef: null };
    const p = at(where);
    return note ? { ...e, lineRef: `claims[${p.k}].lines[${p.j}]`, fieldRef: `claims[${p.k}].notes[${denialNoteIndex(printed[p.k], p.j)}]`, relatedFieldRef: `claims[${p.k}].lineItems[${p.j}]` }
      : { ...e, ...lineRefs(p) };
  });
  const decoys = ops.decoys.map(({ at: where, ...d }, i) => ({ id: `decoy-${i + 1}`, ...d, ...lineRefs(at(where)) }));
  return { data, design, tier, household, patient, adjudicated: adj, truth: ops.truth, keyClaims, insurer: ins, before, sponsor, errors, decoys, scenarioIndex: claims.map((c) => c._index) };
}

// The remark a line prints, from the model's facts: denied lines first, then protection and consent, then preventive,
// then the out-of-network difference, then the cost sharing that applied.
function remarkOf(l, consent) {
  if (l.denial) return l.denial.reason === 'visit-limit' ? 'VL' : l.network === 'in' ? 'PI' : 'PO';
  if (l.protected) return 'NS';
  if (l.preventive) return 'PV';
  if (consent && l.balanceBillable > 0) return 'CN';
  if (l.balanceBillable > 0) return 'OA';
  if (l.deductible > 0) return 'DD';
  if (l.copay > 0) return 'CP';
  if (l.coinsurance > 0) return 'CI';
  return null;
}
function printedLine(l, consent, date, dropProvision = false) {
  const svc = SERVICES[l.service];
  return { date, service: svc.description, code: l.code + (l.modifier ? `-${l.modifier}` : ''), billed: l.billed, allowed: l.allowed, planPaid: l.planPaid,
    deductible: l.deductible, copay: l.copay, coinsurance: l.coinsurance, notCovered: l.notCovered, youMayOwe: l.memberOwes, remark: remarkOf(l, consent),
    denial: l.denial ? { code: l.denial.reason === 'visit-limit' ? 'VL' : l.network === 'in' ? 'PI' : 'PO', section: dropProvision ? null : PLAN_SECTION[l.denial.reason] } : null,
    protectedShare: l.protected ? dollars(cents(l.deductible) + cents(l.copay) + cents(l.coinsurance)) : null };
}
function keyLine(l, dateOfService) {
  return { code: l.code, modifier: l.modifier || null, units: l.units, dateOfService, charged: l.billed, allowed: l.allowed, approved: !l.denial, paid: l.planPaid, toDeductible: l.deductible,
    coinsurance: l.coinsurance, copay: l.copay, nonCovered: l.notCovered, patientMayBeBilled: l.memberOwes,
    network: l.network, protected: !!l.protected, recognized: l.recognized ?? null, qpa: l.qpa ?? null, balanceBillable: l.balanceBillable, preventive: l.preventive || null,
    denial: l.denial ? l.denial.reason : null };
}
// The plan-terms box: in and out of network, for the design's own terms.
function termsOf(d) {
  const i = d.inNetwork; const o = d.outOfNetwork;
  return { deductibleIn: i.deductible.self, deductibleFamilyIn: i.deductible.family, deductibleOut: d.combinedAccumulators ? null : o.deductible?.self ?? null, deductibleFamilyOut: d.combinedAccumulators ? null : o.deductible?.family ?? null,
    coinsuranceIn: Math.round(i.coinsurance * 100), coinsuranceOut: Math.round(o.coinsurance * 100),
    copayPrimary: i.copay?.primary ?? null, copaySpecialist: i.copay?.specialist ?? null, copayEmergency: i.copay?.emergencyRoom ?? null,
    outOfPocketIn: i.outOfPocket.self, outOfPocketFamilyIn: i.outOfPocket.family, outOfPocketOut: d.combinedAccumulators ? null : o.outOfPocket?.self ?? null, outOfPocketFamilyOut: d.combinedAccumulators ? null : o.outOfPocket?.family ?? null, combined: !!d.combinedAccumulators };
}
// Accumulator rows, person (the patient) and family: before this statement, this statement, year to date, limit.
function accumulatorRows(d, tier, before, after, pid) {
  const sets = d.combinedAccumulators ? ['in'] : ['in', 'out'];
  const rows = [];
  for (const who of tier === 'family' ? ['person', 'family'] : ['person']) for (const net of sets) for (const kind of ['ded', 'oop']) {
    const terms = d[net === 'in' ? 'inNetwork' : 'outOfNetwork'];
    const lim = kind === 'ded' ? terms.deductible : terms.outOfPocket;
    const limit = who === 'family' ? lim.family : tier === 'family' ? lim.perPerson : lim.self;
    const b = who === 'family' ? before.family?.[net]?.[kind] ?? 0 : before.person?.[pid]?.[net]?.[kind] ?? 0;
    const y = who === 'family' ? after.family[net][kind] : after.person[pid][net][kind];
    rows.push({ who, network: d.combinedAccumulators ? 'all' : net, kind: kind === 'ded' ? 'deductible' : 'outOfPocket', before: b, thisStatement: dollars(cents(y) - cents(b)), yearToDate: y, limit, met: cents(y) >= cents(limit) });
  }
  return rows;
}
// What was met before: for each member and network, a deductible amount under its limit and an out-of-pocket amount at
// least that, the family's the members' sum; the patient's own amounts at most half the limit, so these claims still move them.
function drawBefore(rng, design, tier, household) {
  const d = DESIGNS.designs[design]; const sets = d.combinedAccumulators ? ['in'] : ['in', 'out'];
  const person = {}; const family = {};
  for (const m of household.members) person[m.id] = {};
  for (const net of sets) {
    const terms = d[net === 'in' ? 'inNetwork' : 'outOfNetwork'];
    const dedCap = tier === 'family' ? terms.deductible.perPerson : terms.deductible.self;
    let fd = 0, fo = 0;
    for (const m of household.members) {
      const ded = net === 'out' ? 0 : Math.round(rng() * dedCap * 0.5);
      const oop = ded + (net === 'out' ? 0 : Math.round(rng() * 200));
      person[m.id][net] = { ded, oop }; fd += ded; fo += oop;
    }
    if (tier === 'family') {
      const famCap = terms.deductible.family;
      if (fd > famCap) { for (const m of household.members) { person[m.id][net] = { ded: 0, oop: 0 }; } fd = 0; fo = 0; }
      family[net] = { ded: fd, oop: fo };
    }
  }
  return tier === 'family' ? { person, family } : { person };
}

// What the page prints, in the words it prints (the stock labels for every slug), and nothing it does not: the
// answer key's fields and the renderer's notes come from here, so a reader's report can be scored against the page.
const money = (x) => `$${(Math.round(x * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const fillText = (t, vars) => String(t).replace(/\{([A-Za-z]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
// the position of a line's denial note among its claim's notes (printedFields writes a line's denial note, then its
// protected note, line by line)
export function denialNoteIndex(claim, j) {
  return claim.lineItems.slice(0, j).reduce((n, l) => n + (l.denial ? 1 : 0) + (l.protectedShare !== null ? 1 : 0), 0);
}
export function printedFields(data, text = TEXT) {
  const net = (n) => (n === 'in' ? text.claim.inNetwork : text.claim.outOfNetwork);
  const remark = Object.fromEntries(text.remarks.map((r) => [r.code, r.meaning]));
  const claims = data.claims.map((c) => {
    const notes = [];
    for (const l of c.lineItems) {
      if (l.denial) notes.push(`${l.code}: ${text.denial.reasonLabel}: ${remark[l.denial.code]} ${text.denial.codeLabel}: ${l.denial.code}.${l.denial.section ? ` ${text.denial.provisionLabel}: ${fillText(text.denial.provisionText, { section: l.denial.section })}.` : ''} ${fillText(text.denial.appealPointer, { title: text.appeal.title })}`);
      if (l.protectedShare !== null) notes.push(`${l.code}: ${fillText(text.lineNotes.protected, { amount: money(l.protectedShare) })}`);
    }
    if (c.consent && c.lineItems.some((l) => l.remark === 'CN')) notes.push(text.lineNotes.consent);
    // a ground ambulance out of network is outside the No Surprises Act, emergency or not (the notice speaks of emergency care)
    if (c.provider.kind === 'ambulance' && c.provider.network === 'out') notes.push(text.lineNotes.groundAmbulance);
    if (c.oopExcluded) notes.push(text.lineNotes.oopExcluded);
    const placeKind = c.provider.kind === 'clinician' ? 'office' : c.provider.kind;
    return {
      claimNumber: c.claimNumber, provider: c.provider.name,
      specialty: c.provider.specialty ? text.specialties[c.provider.specialty] : text.facilityTypes[c.provider.kind],
      network: net(c.provider.network),
      place: c.place ? `${c.place.name}, ${text.facilityTypes[c.place.type]}, ${net(c.place.network)}` : text.facilityTypes[placeKind],
      emergency: c.emergency ? text.claim.yes : text.claim.no,
      lineItems: c.lineItems.map((l) => ({ date: l.date, service: l.service, code: l.code, billed: l.billed, allowed: l.allowed, planPaid: l.planPaid, deductible: l.deductible,
        copay: l.copay, coinsurance: l.coinsurance, notCovered: l.notCovered, youMayOwe: l.youMayOwe, remark: l.remark })),
      totals: c.totals, notes,
    };
  });
  const rowLabel = (r) => (r.kind === 'deductible' ? (r.network === 'all' ? text.accumulators.deductibleAll : r.network === 'in' ? text.accumulators.deductibleIn : text.accumulators.deductibleOut)
    : r.network === 'all' ? text.terms.outOfPocket : r.network === 'in' ? text.accumulators.outOfPocketIn : text.accumulators.outOfPocketOut);
  return {
    insurer: data.insurer.name, plan: data.plan.name, option: data.plan.option, sponsor: data.plan.sponsor, groupNumber: data.plan.groupNumber, memberId: data.plan.memberId,
    phone: data.plan.phone, mailing: data.mailing, patient: data.patient.name, processed: data.processed,
    terms: printedTerms(data.terms, text), summary: data.summary, claims, sections: { appeal: !data.omitAppeal, noSurprises: !!data.hasProtected },
    accumulators: data.accumulators.map((r) => ({ group: text.accumulators[r.who], label: rowLabel(r), before: r.before, thisStatement: r.thisStatement, yearToDate: r.yearToDate, limit: r.limit, met: r.met })),
  };
}
// the plan-terms box as printed: individual and family amounts, the HSA option's one deductible and maximum in both
// columns, and "none" where an option has no copay
function printedTerms(t, text) {
  const pair = (a, b) => `${money(a)} (${text.accumulators.person}) / ${money(b)} (${text.accumulators.family})`;
  const none = text.terms.none;
  return {
    deductibleIn: pair(t.deductibleIn, t.deductibleFamilyIn), deductibleOut: t.combined ? pair(t.deductibleIn, t.deductibleFamilyIn) : pair(t.deductibleOut, t.deductibleFamilyOut),
    coinsuranceIn: `${t.coinsuranceIn}%`, coinsuranceOut: `${t.coinsuranceOut}%`,
    copayPrimary: t.copayPrimary ? money(t.copayPrimary) : none, copaySpecialist: t.copaySpecialist ? money(t.copaySpecialist) : none, copayEmergency: t.copayEmergency ? money(t.copayEmergency) : none,
    outOfPocketIn: pair(t.outOfPocketIn, t.outOfPocketFamilyIn), outOfPocketOut: t.combined ? pair(t.outOfPocketIn, t.outOfPocketFamilyIn) : pair(t.outOfPocketOut, t.outOfPocketFamilyOut),
  };
}
