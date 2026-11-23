// adjudicate.js — the commercial employer-plan model: what a fictional 2026 self-funded ERISA plan (a PPO design or an
// HSA-qualified high-deductible design) allows, pays and leaves to each member, and what it tells the provider on a
// No Surprises claim. Numbers are data (reference-data/commercial); the rules are here, each with its citation. Money
// is kept in whole cents. Nothing here renders.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../reference-data/commercial');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
export const CATALOG = read('service-catalog.json');
export const DESIGNS = read('plan-designs.json');
export const PLACES = read('places.json');
export const SERVICES = Object.freeze(Object.fromEntries(CATALOG.services.map((s) => [s.id, s])));

// 45 CFR 149.30: a health care facility for non-emergency services is a hospital, a hospital outpatient department, a
// critical access hospital or an ambulatory surgical center (plan-designs.json, limits.nsaFacilities, with its read date).
export const NSA_FACILITIES = new Set(DESIGNS.limits.nsaFacilities.types);
// 45 CFR 149.420(b)(1): notice and consent never waive protection for these.
export const NOT_WAIVABLE = new Set(['emergency-medicine', 'anesthesiology', 'pathology', 'radiology', 'neonatology', 'assistant-surgeon', 'hospitalist', 'intensivist', 'diagnostic']);
// CARC codes the model gives a denied line (X12 claim adjustment reason codes)
// (prior authorization: the plan's terms, elective care only, never emergency care, 45 CFR 149.110(b)(1); the visit
// limit: the plan's terms on a service outside its benchmark, which 45 CFR 147.126 permits)
export const DENIAL = Object.freeze({
  'prior-authorization': { carc: '197', citation: 'plan terms; 45 CFR 149.110(b)(1)' },
  'visit-limit': { carc: '119', citation: 'plan terms; 45 CFR 147.126' },
});

const cents = (d) => Math.round(d * 100);
export const dollars = (c) => Math.round(c) / 100;
const MULTIPLE = { facility: CATALOG.multiples.facility.value, physician: CATALOG.multiples.physician.value };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// The 2026 Medicare national amount for a line, in cents: the catalog's amount x units; anesthesia from base units plus
// one time unit per 15 minutes (rounded up) x the national anesthesia conversion factor.
export function medicareCents(svc, { units = 1, minutes = 0 } = {}) {
  if (svc.setting === 'anesthesia') {
    if (!(minutes > 0)) throw new Error(`${svc.id}: minutes needed`);
    return Math.round((svc.medicare.baseUnits + Math.ceil(minutes / 15)) * svc.medicare.nationalConversionFactor * 100);
  }
  return cents(svc.medicare.amount) * units;
}
export const inNetworkRate = (svc, medicare) => Math.round(medicare * MULTIPLE[svc.multiple]);
export const outOfNetworkAllowance = (medicare) => Math.round(medicare * CATALOG.outOfNetworkAllowance.value);
export const qpaOf = (inRate) => Math.round(inRate * CATALOG.qpaFactor.value);

// Does a member meet one preventive basis on this claim? Age and sex as stored; a stored condition must be a flag the
// member carries; a basis tied to another service ("with": a vaccine's administration) needs that line on the claim.
// The visit code decides the office-visit cases (147.130(a)(2)): a preventive visit code is a visit whose main purpose
// is preventive; a problem visit code (9921x) never is.
function basisMet(b, member, claimServiceIds) {
  if (b.ages && (member.age < b.ages[0] || member.age > b.ages[1])) return false;
  if (b.sex && b.sex !== 'any' && b.sex !== member.sex) return false;
  if (b.condition && !member.flags?.[b.condition]) return false;
  if (b.with && !claimServiceIds.includes(b.with)) return false;
  return true;
}
export function preventiveFor(svc, member, claimServiceIds = []) {
  return (svc.preventive || []).find((b) => basisMet(b, member, claimServiceIds)) || null;
}

// Starting year-to-date accumulators, in cents: { person: { [memberId]: { in: {ded, oop}, out: {ded, oop}, visits: {} } },
// family: { in: {ded, oop}, out: {ded, oop} } }. Refuses values a real plan year could not hold.
export function startingAccumulators(design, tier, members, before = {}) {
  const zero = () => ({ ded: 0, oop: 0 });
  const acc = { person: {}, family: { in: { ...zero(), ...before.family?.in }, out: { ...zero(), ...before.family?.out } } };
  for (const id of Object.keys(before.person || {})) if (!members.some((m) => m.id === id)) throw new Error('accumulators: no such member');
  for (const m of members) {
    const b = before.person?.[m.id] || {};
    acc.person[m.id] = { in: { ...zero(), ...b.in }, out: { ...zero(), ...b.out }, visits: { ...b.visits } };
  }
  const sets = design.combinedAccumulators ? ['in'] : ['in', 'out'];
  for (const net of sets) {
    const terms = design[net === 'in' ? 'inNetwork' : 'outOfNetwork'];
    const L = limits(terms, tier);
    for (const m of members) {
      const p = acc.person[m.id][net];
      if (p.ded > p.oop) throw new Error(`accumulators ${m.id} ${net}: ded > oop`);
      if (p.ded > L.dedPerson || p.oop > L.oopPerson) throw new Error(`accumulators ${m.id} ${net}: over limit`);
    }
    const f = acc.family[net];
    if (tier === 'family') {
      if (f.ded > f.oop) throw new Error(`accumulators family ${net}: ded > oop`);
      if (f.ded > L.dedFamily || f.oop > L.oopFamily) throw new Error(`accumulators family ${net}: over limit`);
      for (const k of ['ded', 'oop']) if (sum(members.map((m) => acc.person[m.id][net][k])) !== f[k]) throw new Error(`accumulators family ${net} ${k}: not members' sum`);
    } else if (f.ded || f.oop) throw new Error('accumulators: self-only, no family');
  }
  if (design.combinedAccumulators && (acc.family.out.ded || acc.family.out.oop || members.some((m) => acc.person[m.id].out.ded || acc.person[m.id].out.oop))) throw new Error('accumulators: one set (combined)');
  return acc;
}
// The limits of one accumulator set, in cents. Self-only: the self amounts. Family: each person's embedded amount and
// the family's (the self-only out-of-pocket limit applies to each person, DOL ACA FAQs Part XXVII).
function limits(terms, tier) {
  const d = terms.deductible, o = terms.outOfPocket;
  return tier === 'family'
    ? { dedPerson: cents(d.perPerson), dedFamily: cents(d.family), oopPerson: cents(o.perPerson), oopFamily: cents(o.family) }
    : { dedPerson: cents(d.self), dedFamily: Infinity, oopPerson: cents(o.self), oopFamily: Infinity };
}

// Cost sharing on the allowed amount (Uniform Glossary: "a percentage ... of the allowed amount"), never on the billed
// charge, by the line's cost-sharing type and the terms (in-network terms also on a No Surprises line, 149.110(b)(3)).
function costShare({ design, tier, acc, member, terms, type, allowed }) {
  const net = design.combinedAccumulators ? 'in' : terms;
  const t = design[terms === 'in' ? 'inNetwork' : 'outOfNetwork'];
  const accTerms = design[net === 'in' ? 'inNetwork' : 'outOfNetwork'];
  const L = limits(accTerms, tier); const p = acc.person[member.id][net]; const f = acc.family[net];
  const dedLeft = Math.max(0, Math.min(L.dedPerson - p.ded, L.dedFamily - f.ded));
  const oopLeft = Math.max(0, Math.min(L.oopPerson - p.oop, L.oopFamily - f.oop));
  const rate = t.coinsurance;
  const copays = t.copay; // null on the hsa and out of network: copay types fall back to deductible and coinsurance
  let copay = 0, ded = 0, coins = 0;
  if (copays && (type === 'copay-primary' || type === 'copay-specialist')) {
    copay = Math.min(cents(copays[type === 'copay-primary' ? 'primary' : 'specialist']), allowed);
  } else if (copays && type === 'er-copay-coinsurance') {
    copay = Math.min(cents(copays.emergencyRoom), allowed);
    ded = Math.min(dedLeft, allowed - copay);
    coins = Math.round((allowed - copay - ded) * rate);
  } else {
    ded = Math.min(dedLeft, allowed);
    coins = Math.round((allowed - ded) * rate);
  }
  // the out-of-pocket maximum stops all cost sharing (coinsurance first, then copay, then deductible)
  let excess = copay + ded + coins - oopLeft;
  for (const k of ['coins', 'copay', 'ded']) {
    if (excess <= 0) break;
    const cut = Math.min(excess, k === 'coins' ? coins : k === 'copay' ? copay : ded);
    if (k === 'coins') coins -= cut; else if (k === 'copay') copay -= cut; else ded -= cut;
    excess -= cut;
  }
  p.ded += ded; p.oop += copay + ded + coins;
  if (tier === 'family') { f.ded += ded; f.oop += copay + ded + coins; }
  return { copay, ded, coins, net };
}

/**
 * Adjudicate a household's claims under one design.
 * opts: { design: 'ppo'|'hsa', tier: 'self'|'family', members: [{ id, age, sex, flags }],
 *         before: starting accumulators in dollars, { person: { [id]: { in: {ded, oop}, out: {ded, oop}, visits } }, family },
 *         claims: [{ id, memberId, emergency, priorAuthObtained, consent: [providerId], markup, decisionDays,
 *                    dates: { received, infoRequested, decidable }, facility: { network, type } | null,
 *                    providers: { [providerId]: { network, specialty, groupId } },
 *                    lines: [{ service, providerId, units, minutes, billed, _unprotect, _ignorePreventive, _denyForAuth }] }] }
 *         (the three underscore flags are the planted-error operations' only way in: commercial-operations.js)
 * Returns { design, tier, claims: [...adjudicated], accumulators (dollars), provider notices }.
 */
export function adjudicateCommercial({ design: designId, tier, members, claims, before }) {
  const design = DESIGNS.designs[designId]; if (!design) throw new Error(`unknown design ${designId}`);
  if (!['self', 'family'].includes(tier)) throw new Error(`unknown coverage tier ${tier}`);
  if (tier === 'self' && members.length !== 1) throw new Error('self-only: one member');
  const acc = startingAccumulators(design, tier, members, centsDeep(before));
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const out = claims.map((c) => adjudicateClaim({ design, designId, tier, acc, member: byId[c.memberId] || fail(`claim ${c.id}: unknown member ${c.memberId}`), claim: c }));
  return { design: designId, tier, claims: out, accumulators: dollarsDeep(acc), stateLaw: 'none', notModelled: DESIGNS.notModelled };
}
function fail(m) { throw new Error(m); }
// A scenario's own starting totals (dollars) against the plan, the tier and the household: throws as the
// adjudication would.
export function checkStartingTotals(designId, tier, members, before) { startingAccumulators(DESIGNS.designs[designId], tier, members, centsDeep(before)); }
// starting accumulators in dollars (as callers and keys write them) to cents; visit counts stay counts
function centsDeep(o) {
  if (o == null) return {};
  const set = (s) => (s ? { ded: cents(s.ded || 0), oop: cents(s.oop || 0) } : undefined);
  return {
    person: Object.fromEntries(Object.entries(o.person || {}).map(([id, p]) => [id, { in: set(p.in), out: set(p.out), visits: { ...p.visits } }])),
    family: o.family ? { in: set(o.family.in), out: set(o.family.out) } : undefined,
  };
}
function dollarsDeep(acc) {
  const d = (s) => ({ ded: dollars(s.ded), oop: dollars(s.oop) });
  return { person: Object.fromEntries(Object.entries(acc.person).map(([id, p]) => [id, { in: d(p.in), out: d(p.out), visits: { ...p.visits } }])), family: { in: d(acc.family.in), out: d(acc.family.out) } };
}

function adjudicateClaim({ design, designId, tier, acc, member, claim }) {
  const ids = claim.lines.map((l) => l.service);
  const svcOf = (l) => SERVICES[l.service] || fail(`claim ${claim.id}: unknown service ${l.service}`);
  const lines = claim.lines.map((l, i) => {
    const svc = svcOf(l);
    if (l.providerId === 'facility') fail(`claim ${claim.id}: provider id reserved`);   // the facility's payee key on a notice
    const prov = svc.setting === 'facility' ? null : (claim.providers?.[l.providerId] || fail(`claim ${claim.id} line ${i + 1}: unknown provider ${l.providerId}`));
    const network = svc.setting === 'facility' ? (claim.facility?.network || fail(`claim ${claim.id}: no facility`)) : prov.network;
    const specialty = prov?.specialty || null;
    // No Surprises Act: emergency care at any provider (149.110), and an out-of-network clinician at an in-network
    // NSA facility unless consent was given for a specialty consent can waive (149.120, 149.420). Ground ambulance is
    // outside the Act.
    const medicare = medicareCents(svc, l);
    const inRate = inNetworkRate(svc, medicare);
    const markup = claim.markup ?? 1.6;
    // a denied line: prior authorization (elective care only; emergency care never needs it, 149.110(b)(1)), or the
    // visit limit on a service outside the benchmark (no dollar limit anywhere, 147.126). Nothing is allowed or paid,
    // and a benefit denial is not a No Surprises payment decision, so the line is never protected nor on a notice.
    const vl = design.visitLimit; const used = acc.person[member.id].visits[svc.id] || 0;
    const denial = l._denyForAuth || (svc.priorAuth && !claim.emergency && !claim.priorAuthObtained) ? { reason: 'prior-authorization', ...DENIAL['prior-authorization'] }
      : svc.outsideBenchmark && vl && vl.service === svc.id && used >= vl.visits ? { reason: 'visit-limit', ...DENIAL['visit-limit'], limit: vl.visits, used } : null;
    const base = { service: svc.id, code: svc.code, modifier: svc.modifier || null, units: l.units || 1, minutes: l.minutes || null, providerId: l.providerId ?? null,
      network, specialty, medicare, inNetworkRate: inRate, copay: 0, deductible: 0, coinsurance: 0, planPaid: 0, notCovered: 0, balanceBillable: 0, preventive: null, denial };
    if (denial) {
      const billed = l.billed != null ? cents(l.billed) : Math.round(inRate * markup);
      // in network the provider cannot bill the member for its own missing authorization; past the visit limit it may
      // bill its network rate; out of network the charge
      const owed = network === 'out' ? billed : denial.reason === 'visit-limit' ? Math.min(inRate, billed) : 0;
      return finish({ ...base, protected: false, terms: network, qpa: null, recognized: null, codeChanged: null, billed, allowed: 0, notCovered: owed });
    }
    if (svc.outsideBenchmark) acc.person[member.id].visits[svc.id] = used + 1;
    const atNsaFacility = !!(claim.facility && claim.facility.network === 'in' && NSA_FACILITIES.has(claim.facility.type));
    const consentWaives = !!(prov && (claim.consent || []).includes(l.providerId) && !NOT_WAIVABLE.has(specialty));
    const isProtected = !l._unprotect && network === 'out' && svc.setting !== 'ambulance'
      && (!!claim.emergency || (svc.setting !== 'facility' && atNsaFacility && !consentWaives));
    const qpa = isProtected ? qpaOf(inRate) : null;
    const billed = l.billed != null ? cents(l.billed) : Math.round((isProtected ? qpa * Math.max(markup, 1.15) : inRate * markup));
    const rate = network === 'in' ? inRate : isProtected ? Math.min(qpa, billed) : outOfNetworkAllowance(medicare);
    const allowed = Math.min(rate, billed);
    const terms = network === 'in' || isProtected ? 'in' : 'out';
    const row = { ...base, protected: isProtected, terms, qpa, recognized: isProtected ? Math.min(qpa, billed) : null, codeChanged: isProtected ? false : null, billed, allowed };
    let type = svc.costShare;
    if (type === 'preventive') {
      const basis = terms === 'in' && network === 'in' && !l._ignorePreventive ? preventiveFor(svc, member, ids) : null;
      if (basis) { row.preventive = basis.topic || basis.rule; row.planPaid = allowed; return finish(row); }
      type = svc.fallbackCostShare;
    }
    const cs = costShare({ design, tier, acc, member, terms, type, allowed });
    row.copay = cs.copay; row.deductible = cs.ded; row.coinsurance = cs.coins; row.accumulator = cs.net;
    row.planPaid = allowed - cs.copay - cs.ded - cs.coins;
    row.balanceBillable = network === 'out' && !isProtected ? billed - allowed : 0;
    return finish(row);
  });
  const decided = claim.dates?.decidable && claim.decisionDays != null ? addDays(claim.dates.decidable, claim.decisionDays) : null;
  // the 149.140(d) notice goes to each payee of a No Surprises line: the facility, or each clinician
  const payees = [...new Set(lines.filter((l) => l.protected).map((l) => l.providerId ?? 'facility'))];
  const providerNotices = payees.map((payee) => {
    const mine = lines.filter((l) => l.protected && (l.providerId ?? 'facility') === payee);
    return { payee, lines: mine.map((l) => ({ service: l.service, code: l.code, qpa: dollars(l.qpa), recognized: dollars(l.recognized), codeChanged: false })),
      initialPayment: dollars(sum(mine.map((l) => l.planPaid))), decided, stateLaw: 'none' };
  });
  const totals = {};
  for (const k of ['billed', 'allowed', 'copay', 'deductible', 'coinsurance', 'planPaid', 'notCovered', 'balanceBillable', 'memberOwes']) totals[k] = dollars(sum(lines.map((l) => l[k])));
  return {
    id: claim.id, memberId: claim.memberId, emergency: !!claim.emergency, facility: claim.facility || null, dates: { ...claim.dates, decided },
    lines: lines.map(toDollars), totals, providerNotices,
  };
}
function finish(row) { row.memberOwes = row.copay + row.deductible + row.coinsurance + row.notCovered + row.balanceBillable; return row; }
const MONEY = ['medicare', 'inNetworkRate', 'qpa', 'recognized', 'billed', 'allowed', 'copay', 'deductible', 'coinsurance', 'planPaid', 'notCovered', 'balanceBillable', 'memberOwes'];
function toDollars(row) { const r = { ...row }; for (const k of MONEY) if (r[k] != null) r[k] = dollars(r[k]); return r; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
