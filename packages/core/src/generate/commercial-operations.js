// commercial-operations.js — the planted errors and decoys of the commercial EOB (commercial-eob), on the pattern of
// ma-mutations.js. A scenario's `mutations` and `decoys` name a claim by its index in the scenario and a line by the
// catalog service it bills (or the role `well-visit`), checked against the shapes when the scenario is loaded, never
// per seed. The pre operations (PRE: ce-unprotect-line, ce-preventive-cost-share, ce-deny-emergency-for-auth) act on
// the plan's adjudication: the claims are adjudicated once as the model does (the truth), every line's charge is pinned
// from that result, the operation's flag is set on its line, and the claims are adjudicated again; the page, the answer
// key's lines and the 835 are that second adjudication, and the truth of each planted error is its entry (expected,
// actual, delta, rule). The post operations (POST: ce-in-network-balance-bill, ce-accumulator-off,
// ce-drop-denial-element) change what is printed after the adjudication. No operation draws from the random stream, and
// a refusal names only the operation.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { entryOf } from './ma-mutations.js';
import { SERVICES, DESIGNS, NOT_WAIVABLE, NSA_FACILITIES } from './commercial/adjudicate.js';

const STRINGS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/commercial-eob/operations.json'), 'utf-8'));
const refuse = (key, op) => Object.assign(new Error(STRINGS.messages[key].replace('{op}', op)), { code: 'SCENARIO' });
const RULE = STRINGS.rules; const DECOY_RULE = STRINGS.decoyRules;
const cents = (d) => Math.round(d * 100);
const r2 = (c) => Math.round(c) / 100 + 0;

// The lines each shape always bills, and those it bills only when the claim's option is on; the age- and
// flag-dependent screening lines are never named. `well-visit` is the preventive visit, whose service id follows the
// member's age.
export const WELL_VISITS = new Set(['wellchild-infant', 'wellchild-1-4', 'wellchild-5-11', 'wellteen-12-17', 'welladult-18-39', 'welladult-40-64']);
const ADDRESSABLE = {
  'office-primary': { always: ['office-primary'], when: { labs: ['blood-draw', 'metabolic-panel'] } },
  'office-specialist': { always: ['office-specialist'] },
  'preventive-adult': { always: ['well-visit'], when: { flu: ['vaccine-admin-adult', 'flu-vaccine'] } },
  'preventive-child': { always: ['well-visit'] },
  'problem-visit-listed': { always: ['office-primary', 'hiv-test'] },
  lab: { always: ['blood-draw', 'metabolic-panel', 'blood-count'] },
  imaging: { always: ['chest-xray-facility', 'chest-xray-reading'] },
  emergency: { always: ['er-facility', 'er-physician'], when: { xray: ['chest-xray-reading'] } },
  surgery: { always: ['knee-surgery-facility', 'knee-surgery-surgeon', 'knee-anesthesia', 'tissue-exam', 'knee-xray-reading'] },
  ambulance: { always: ['ambulance-transport', 'ambulance-mileage'] },
  'urgent-care': { always: ['urgent-care-visit'] },
  acupuncture: { always: ['acupuncture'] },
};
const ROW_GROUPS = ['person', 'family']; const ROW_NETWORKS = ['in', 'out', 'all']; const ROW_KINDS = ['deductible', 'outOfPocket'];

const PRE = { 'ce-unprotect-line': 'surprise-balance-bill', 'ce-preventive-cost-share': 'preventive-cost-sharing', 'ce-deny-emergency-for-auth': 'emergency-authorization-denial' };
const POST = { 'ce-in-network-balance-bill': 'in-network-balance-bill', 'ce-accumulator-off': 'math-error', 'ce-drop-denial-element': 'missing-required-section' };
const DECOYS = {
  'ce-decoy-out-of-network-balance': ['out-of-network-balance', 'outOfNetworkBalance'],
  'ce-decoy-consented-balance': ['consented-balance', 'consentedBalance'],
  'ce-decoy-ambulance-balance': ['ground-ambulance-balance', 'groundAmbulance'],
  'ce-decoy-problem-visit': ['problem-visit-beside-listed', 'problemVisit'],
  'ce-decoy-oop-excludes': ['oop-excludes-non-covered', 'oopExcludes'],
  'ce-decoy-elective-denial': ['elective-authorization-denial', 'electiveDenial'],
  'ce-decoy-appeal-by-section': ['appeal-rights-by-section', 'appealBySection'],
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A line named by an entry, checked against the scenario's claim and its shape's lines (load time).
function addressOf(sc, args, op) {
  if (!args || typeof args !== 'object' || !Number.isInteger(args.claim) || args.claim < 0 || args.claim >= sc.claims.length) throw refuse('noClaim', op);
  const spec = typeof sc.claims[args.claim] === 'string' ? { shape: sc.claims[args.claim] } : sc.claims[args.claim];
  const a = ADDRESSABLE[spec.shape]; const line = args.line;
  const on = typeof line === 'string' && (a.always.includes(line) || Object.entries(a.when || {}).some(([opt, ids]) => spec[opt] === true && ids.includes(line)));
  if (!on) throw refuse('noLine', op);
  return { claim: args.claim, line };
}

/** Load-time check of a scenario's entries; returns the plan the generator runs. */
export function planOperations(sc) {
  if (!Array.isArray(sc.mutations || []) || !Array.isArray(sc.decoys || [])) throw refuse('unknownOp', 'scenario');
  const errors = (sc.mutations || []).map((m) => entryOf(m, 'mutation')); const decoys = (sc.decoys || []).map((d) => entryOf(d, 'decoy'));
  const taken = new Set(); const take = (at, op) => { const k = `${at.claim}:${at.line}`; if (taken.has(k)) throw refuse('lineTaken', op); taken.add(k); };
  const once = (k, op) => take({ claim: k, line: '' }, op);   // an accumulator shift and a missing appeal section are each one per EOB
  const plan = { errors: [], decoys: [] };
  for (const m of errors) {
    if (!own(PRE, m.op) && !own(POST, m.op)) throw refuse('unknownOp', 'scenario');
    const args = m.args || {};
    if (m.op === 'ce-accumulator-off') {
      if (sc.design == null || sc.tier == null) throw refuse('needsOptionTier', m.op);
      const d = DESIGNS.designs[sc.design]; const net = args.network;
      if (!ROW_GROUPS.includes(args.group) || !ROW_NETWORKS.includes(net) || !ROW_KINDS.includes(args.kind) || (args.group === 'family' && sc.tier !== 'family')
        || (d.combinedAccumulators ? net !== 'all' : net === 'all')) throw refuse('noRow', m.op);
      const terms = d[net === 'out' ? 'outOfNetwork' : 'inNetwork']; const limit = (args.kind === 'deductible' ? terms.deductible : terms.outOfPocket)[args.group === 'family' ? 'family' : 'self'];
      if (!(typeof args.by === 'number' && Number.isFinite(args.by) && Math.abs(args.by * 100 - Math.round(args.by * 100)) < 1e-6 && args.by > 0 && cents(args.by) * 4 <= cents(limit))) throw refuse('badBy', m.op);
      once('accumulator', m.op); plan.errors.push({ entry: m, op: m.op, row: { group: args.group, network: net, kind: args.kind }, by: args.by, limit });
    } else if (m.op === 'ce-drop-denial-element') {
      if (args.element === 'appeal') { once('appeal', m.op); plan.errors.push({ entry: m, op: m.op, element: 'appeal' }); }
      else if (args.element === 'provision') { const at = addressOf(sc, args, m.op); take(at, m.op); plan.errors.push({ entry: m, op: m.op, element: 'provision', at }); }
      else throw refuse('badElement', m.op);
    } else {
      if (m.op === 'ce-preventive-cost-share' && sc.before == null) throw refuse('needsBefore', m.op);
      const at = addressOf(sc, args, m.op); take(at, m.op); plan.errors.push({ entry: m, op: m.op, at });
    }
  }
  for (const d of decoys) {
    if (!own(DECOYS, d.op)) throw refuse('unknownDecoy', 'scenario');
    const at = addressOf(sc, d.args || {}, d.op); take(at, d.op); plan.decoys.push({ entry: d, op: d.op, at });
  }
  return plan;
}

// The position of an addressed line in the generated (service-ordered) claims: [claim position, line position].
export function locate(claims, at, op) {
  const ci = claims.findIndex((c) => c._index === at.claim);
  const hits = claims[ci].lines.map((l, li) => ((at.line === 'well-visit' ? WELL_VISITS.has(l.service) : l.service === at.line) ? li : -1)).filter((x) => x >= 0);
  if (hits.length !== 1) throw refuse(hits.length ? 'lineTwice' : 'noLine', op);
  return [ci, hits[0]];
}
const lineOf = (adj, [ci, li]) => adj.claims[ci].lines[li];
const isAmbulance = (l) => SERVICES[l.service].setting === 'ambulance';

/**
 * Run the plan around the adjudication. `adjudicate(claims)` is the model; `claims` the service-ordered input claims
 * (each with `_index`, its scenario position). Returns the truth and the printed adjudication, and the entries with
 * their positions ("ci:li"), for the generator to key.
 */
export function runCommercialOperations(plan, claims, adjudicate) {
  const truth = adjudicate(claims);
  const pre = plan.errors.filter((e) => own(PRE, e.op));
  for (const e of pre) {
    const at = locate(claims, e.at, e.op); const t = lineOf(truth, at); const c = claims[at[0]];
    if (e.op === 'ce-unprotect-line' && !(t.protected && !t.denial && !isAmbulance(t))) throw refuse('notProtected', e.op);
    if (e.op === 'ce-preventive-cost-share' && !(t.preventive && t.network === 'in' && (WELL_VISITS.has(t.service) || ['vaccine-admin-adult', 'vaccine-admin-child', 'flu-vaccine'].includes(t.service)))) throw refuse('notPreventive', e.op);
    if (e.op === 'ce-deny-emergency-for-auth' && !(c.emergency && !t.denial && !isAmbulance(t))) throw refuse('notEmergency', e.op);
    e.pos = at;
  }
  let printed = structuredClone(truth);   // the post operations change the printed adjudication, never the truth
  if (pre.length) {
    // the same charges in both adjudications, so expected and actual are about the same bill
    claims.forEach((c, ci) => c.lines.forEach((l, li) => { l.billed = truth.claims[ci].lines[li].billed; }));
    for (const e of pre) {
      const l = claims[e.pos[0]].lines[e.pos[1]];
      if (e.op === 'ce-unprotect-line') l._unprotect = true; else if (e.op === 'ce-preventive-cost-share') l._ignorePreventive = true; else l._denyForAuth = true;
    }
    printed = adjudicate(claims);
  }
  const out = { truth, printed, errors: [], decoys: [], accumulatorShift: null, omitAppeal: false, dropProvision: new Set() };
  const entryText = (e, kind, rule, severity) => {
    const m = e.entry; return { kind: m.kind || kind, severity: m.severity || severity, rule: m.rule || rule, ...(m.note ? { note: m.note } : {}) };
  };
  for (const e of plan.errors) {
    if (own(PRE, e.op)) {
      const t = lineOf(truth, e.pos); const p = lineOf(printed, e.pos); const c = claims[e.pos[0]];
      const rule = e.op === 'ce-unprotect-line' ? (c.emergency ? RULE.surpriseEmergency : RULE.surpriseFacility) : e.op === 'ce-preventive-cost-share' ? RULE.preventive : RULE.emergencyAuthorization;
      if (e.op === 'ce-preventive-cost-share' && !(cents(p.memberOwes) > 0)) throw refuse('notPreventive', e.op);
      out.errors.push({ at: `${e.pos[0]}:${e.pos[1]}`, expected: t.memberOwes, actual: p.memberOwes, delta: r2(cents(p.memberOwes) - cents(t.memberOwes)), ...entryText(e, PRE[e.op], rule, 'high') });
    } else if (e.op === 'ce-in-network-balance-bill') {
      const pos = locate(claims, e.at, e.op); const p = lineOf(printed, pos);
      if (!(p.network === 'in' && !p.denial && !p.preventive && !p.protected && cents(p.allowed) < cents(p.billed))) throw refuse('notBalanceable', e.op);
      const expected = p.memberOwes; p.memberOwes = r2(cents(p.memberOwes) + cents(p.billed) - cents(p.allowed));
      out.errors.push({ at: `${pos[0]}:${pos[1]}`, expected, actual: p.memberOwes, delta: r2(cents(p.memberOwes) - cents(expected)), ...entryText(e, POST[e.op], RULE.inNetworkBalance, 'high') });
    } else if (e.op === 'ce-drop-denial-element' && e.element === 'provision') {
      const pos = locate(claims, e.at, e.op); if (!lineOf(printed, pos).denial) throw refuse('notDenied', e.op);
      out.dropProvision.add(`${pos[0]}:${pos[1]}`);
      out.errors.push({ at: `${pos[0]}:${pos[1]}`, note: true, expected: null, actual: null, delta: null, ...entryText(e, POST[e.op], RULE.missingProvision, 'medium') });
    } else if (e.op === 'ce-drop-denial-element') {
      if (!printed.claims.some((c) => c.lines.some((l) => l.denial))) throw refuse('noDenial', e.op);
      out.omitAppeal = true;
      out.errors.push({ at: null, expected: null, actual: null, delta: null, ...entryText(e, POST[e.op], RULE.missingAppeal, 'medium') });
    } else {
      // applied to the printed row by the generator (accumulatorRows), up unless that reaches the limit, then down
      out.accumulatorShift = { ...e, text: entryText(e, POST[e.op], RULE.accumulator, 'medium') };
      out.errors.push({ accumulator: true });   // its place among the entries: the scenario's order
    }
  }
  // the plan's own denials are keyed at severity info, except a line an operation denied (its error is the entry)
  printed.claims.forEach((c, ci) => c.lines.forEach((l, li) => {
    const k = `${ci}:${li}`; if (!l.denial || pre.some((e) => e.op === 'ce-deny-emergency-for-auth' && `${e.pos[0]}:${e.pos[1]}` === k)) return;
    const rule = l.denial.reason === 'visit-limit' ? RULE.denialVisitLimit : l.network === 'in' ? RULE.denialAuthorization : RULE.denialAuthorizationOut;
    out.errors.push({ at: k, expected: null, actual: null, delta: null, kind: 'coverage-denial', severity: 'info', rule, info: true });
  }));
  for (const d of plan.decoys) {
    const pos = locate(claims, d.at, d.op); const l = lineOf(printed, pos); const c = claims[pos[0]];
    const consent = (c.consent || []).includes(l.providerId); const balance = cents(l.balanceBillable) > 0;
    const ok = {
      'ce-decoy-out-of-network-balance': l.network === 'out' && !l.protected && !l.denial && balance && !consent && !isAmbulance(l),
      'ce-decoy-consented-balance': l.network === 'out' && !l.protected && balance && consent && !NOT_WAIVABLE.has(l.specialty) && c.facility?.network === 'in' && NSA_FACILITIES.has(c.facility.type),
      'ce-decoy-ambulance-balance': isAmbulance(l) && l.network === 'out' && balance,
      'ce-decoy-problem-visit': /^9921[1-5]$/.test(l.code) && cents(l.memberOwes) > 0 && printed.claims[pos[0]].lines.some((x) => x.preventive && cents(x.memberOwes) === 0),
      'ce-decoy-oop-excludes': cents(l.notCovered) > 0 || balance,
      'ce-decoy-elective-denial': l.denial?.reason === 'prior-authorization' && !c.emergency,
      'ce-decoy-appeal-by-section': !!l.denial,
    }[d.op];
    if (!ok) throw refuse('decoyNotHere', d.op);
    const [kind, ruleKey] = DECOYS[d.op];
    out.decoys.push({ at: `${pos[0]}:${pos[1]}`, kind: d.entry.kind || kind, rule: d.entry.rule || DECOY_RULE[ruleKey], ...(d.entry.note ? { note: d.entry.note } : {}) });
  }
  return out;
}

// Kind 4 on the printed rows: { rows (printed accumulator rows), shift } -> the error entry, the row changed in place.
export function shiftAccumulator(rows, shift) {
  const k = rows.findIndex((r) => r.who === shift.row.group && r.network === shift.row.network && r.kind === shift.row.kind);
  if (k < 0) throw refuse('noRow', shift.op);
  const r = rows[k]; const limit = cents(r.limit); const ytd = cents(r.yearToDate); const by = cents(shift.by);
  const up = ytd + by; const value = up >= limit ? ytd - by : up;
  // the row prints "(Met)" by its printed year to date, which then stays consistent with itself
  const expected = r.yearToDate; r.yearToDate = r2(value); r.met = value >= limit;
  return { row: k, entry: { expected, actual: r.yearToDate, delta: r2(value - ytd), ...shift.text } };
}
