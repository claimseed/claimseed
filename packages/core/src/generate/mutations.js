// mutations.js — error injection on adjudicated claims. Each op mutates the claim set AND records a
// ground-truth entry. Ops are generic; the scenario file decides which line, how much, and cites why.
// Line refs: claims[i].lines[j]. A mutation never reaches into entities, so names and identifiers
// stay consistent across every document generated from the same seed.
const r2 = (x) => Math.round(x * 100) / 100;
import { sum } from './rules.js';

export const OPS = {
  // Bill the same line twice (duplicate-charge). Copies line j of claim i and re-adjudicates it as paid.
  'duplicate-line'(ctx, { claim, line }) {
    const c = ctx.claims[claim]; const src = c.lines[line];
    // The duplicate is adjudicated like any other line: no second deductible, coinsurance on the full amount.
    const dup = { ...src, toDeductible: 0 };
    if (!dup.preventiveNoCostShare && !dup.labNoCostShare) { dup.coinsurance = r2(dup.allowed * ctx.params.partB.coinsuranceRate); dup.paid = r2(dup.allowed - dup.coinsurance); dup.patientMayBeBilled = dup.coinsurance; }
    c.lines.splice(line + 1, 0, dup); c.totals = sum(c.lines);
    return { kind: 'duplicate-charge', lineRef: `claims[${claim}].lines[${line + 1}]`, relatedLineRef: `claims[${claim}].lines[${line}]`, expected: null, actual: dup.code,
      delta: dup.patientMayBeBilled, severity: 'high', rule: 'CMS Claims Processing Manual ch.1 §120; NCCI MUE' };
  },
  // Printed total disagrees with the lines (math-error). Shifts one total field by `by` dollars.
  'break-claim-total'(ctx, { claim, field = 'patientMayBeBilled', by = 10 }) {
    const ALIAS = { maxYouMayBeBilled: 'patientMayBeBilled', amountProviderCharged: 'charged', medicareApprovedAmount: 'allowed', amountMedicarePaid: 'paid' };
    field = ALIAS[field] || field;
    const c = ctx.claims[claim]; const expected = c.totals[field];
    if (expected === undefined) throw new Error(`break-claim-total: unknown field ${field}`);
    c.totals[field] = r2(expected + by);
    return { kind: 'math-error', lineRef: `claims[${claim}].totals.${field}`, expected, actual: c.totals[field], delta: by, severity: 'medium', rule: 'internal consistency' };
  },
  // Deductible charged on a line that should be $0 (lab or preventive) — cost-sharing error.
  'apply-cost-share-to-exempt-line'(ctx, { claim, line, rate = 0.2 }) {
    const c = ctx.claims[claim]; const l = c.lines[line];
    const expected = l.patientMayBeBilled; const coins = r2(l.allowed * rate);
    l.coinsurance = coins; l.paid = r2(l.allowed - coins); l.patientMayBeBilled = coins; c.totals = sum(c.lines);
    const kind = l.preventiveNoCostShare ? 'preventive-cost-sharing' : 'cost-sharing-error';
    return { kind, lineRef: `claims[${claim}].lines[${line}]`, expected, actual: coins, delta: r2(coins - expected), severity: 'high',
      rule: l.preventiveNoCostShare ? 'SSA §1861(ddd); 42 CFR 410.152(l)' : 'SSA §1833(a)(1)(D) — CLFS tests carry no cost sharing' };
  },
  // Deductible applied again (deductible-misapplied): take up to a full deductible out of a line that was
  // already adjudicated (typically after the annual deductible was met), then recompute coinsurance and
  // the Medicare payment on the remainder so the line still foots.
  'reapply-deductible'(ctx, { claim, line }) {
    const c = ctx.claims[claim]; const l = c.lines[line]; const ded = ctx.params.partB.deductible;
    const expected = l.patientMayBeBilled; const extra = r2(Math.min(ded, l.allowed - l.toDeductible));
    l.toDeductible = r2(l.toDeductible + extra);
    l.coinsurance = r2((l.allowed - l.toDeductible) * ctx.params.partB.coinsuranceRate);
    l.paid = r2(l.allowed - l.toDeductible - l.coinsurance);
    l.patientMayBeBilled = r2(l.toDeductible + l.coinsurance); c.totals = sum(c.lines);
    return { kind: 'deductible-misapplied', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.patientMayBeBilled, delta: r2(l.patientMayBeBilled - expected), severity: 'high',
      rule: '42 CFR 410.160(a) — one Part B deductible per calendar year; amount per CMS annual parameters' };
  },
  // Deny a line (denied-service): Medicare paid $0, patient may be billed the charge, note letter attached.
  'deny-line'(ctx, { claim, line, note }) {
    const c = ctx.claims[claim]; const l = c.lines[line];
    const expected = l.patientMayBeBilled;
    l.approved = false; l.paid = 0; l.allowed = 0; l.toDeductible = 0; l.coinsurance = 0; l.patientMayBeBilled = l.charged; l.denialNote = note; c.totals = sum(c.lines);
    return { kind: 'coverage-denial', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.charged, delta: r2(l.charged - expected), severity: 'info', rule: note?.rule || 'Initial determination (42 CFR 405.920)' };
  },
  // Shift a date of service (service-date-anomaly) by n days.
  'shift-date'(ctx, { claim, line, days }) {
    const c = ctx.claims[claim]; const l = c.lines[line]; const expected = l.dateOfService;
    const d = new Date(expected + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); l.dateOfService = d.toISOString().slice(0, 10);
    return { kind: 'service-date-anomaly', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.dateOfService, delta: null, severity: 'low', rule: 'internal consistency' };
  },
  // Raise the approved amount above the fee schedule (fee-schedule-overcharge).
  'overprice-line'(ctx, { claim, line, factor = 1.5 }) {
    const c = ctx.claims[claim]; const l = c.lines[line]; const expected = l.allowed;
    l.allowed = r2(l.allowed * factor); l.coinsurance = r2((l.allowed - l.toDeductible) * ctx.params.partB.coinsuranceRate); l.paid = r2(l.allowed - l.toDeductible - l.coinsurance); l.patientMayBeBilled = r2(l.toDeductible + l.coinsurance); c.totals = sum(c.lines);
    return { kind: 'fee-schedule-overcharge', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.allowed, delta: r2(l.patientMayBeBilled - r2(l.toDeductible + (expected - l.toDeductible) * ctx.params.partB.coinsuranceRate)), severity: 'medium', rule: 'Medicare Physician Fee Schedule for the code, locality and year' };
  },
  // Provider bills the patient more than the Medicare-approved cost sharing (assignment-violation).
  // Medicare's own figures are untouched — the MSN still prints the correct "maximum you may be billed" —
  // but the provider-side documents (itemized bill, statement) read `providerBilledPatient` instead.
  // mode 'unpaid-balance' (default): the provider bills its full charge minus what Medicare paid.
  // mode 'extra': the provider adds `by` dollars on top of the approved patient share.
  'bill-above-approved'(ctx, { claim, line, mode = 'unpaid-balance', by = 25 }) {
    const c = ctx.claims[claim]; const l = c.lines[line];
    const expected = l.patientMayBeBilled;
    const billed = mode === 'extra' ? r2(expected + by) : r2(l.charged - l.paid);
    if (billed <= expected) throw new Error(`bill-above-approved: computed bill ${billed} does not exceed approved share ${expected} on claims[${claim}].lines[${line}]`);
    l.providerBilledPatient = billed;
    c.totals = sum(c.lines);
    return { kind: 'assignment-violation', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: billed, delta: r2(billed - expected), severity: 'high',
      rule: '42 U.S.C. §1395u(b)(3)(B)(ii) (SSA §1842) — a participating provider accepts the approved amount as the full charge; 42 CFR 424.55(b)' };
  },
};

/** Apply a scenario's mutations[] to ctx = { claims, params }. Each entry: { op, args, kind?, severity?, rule?, note? };
 *  kind/severity/rule/note override what the op reports (e.g. report break-claim-total on a bill as subtotals-mismatch). */
export function applyMutations(ctx, mutations = []) {
  const errors = [];
  for (const m of mutations) {
    const op = OPS[m.op]; if (!op) throw new Error(`unknown mutation op ${m.op}`);
    const e = op(ctx, m.args || {});
    if (m.kind) e.kind = m.kind;
    if (m.severity) e.severity = m.severity;
    if (m.rule) e.rule = m.rule;
    if (m.note) e.note = m.note;
    errors.push(e);
  }
  return errors;
}

// Decoys: hard negatives. A decoy op changes the claim set so that a line LOOKS wrong while following the rules, and
// records where; it never makes an error. Decoys apply after the mutations and never insert a line before an existing
// one, so every error's lineRef stays valid. The scenario names the public rule that makes the line correct (`rule`
// is required); an op only checks that the line it touches is free of errors and of other decoys.
const sameLine = (ref, claim, line) => ref === `claims[${claim}].lines[${line}]`;
function freeLine(ctx, claim, line, op) {
  const c = ctx.claims[claim]; if (!c) throw new Error(`${op}: no claims[${claim}]`);
  const l = c.lines[line]; if (!l) throw new Error(`${op}: no claims[${claim}].lines[${line}]`);
  for (const e of ctx.errors || []) if (sameLine(e.lineRef, claim, line) || sameLine(e.relatedLineRef, claim, line)) throw new Error(`${op}: claims[${claim}].lines[${line}] carries an error`);
  for (const d of ctx.decoys || []) if (sameLine(d.lineRef, claim, line)) throw new Error(`${op}: claims[${claim}].lines[${line}] already carries a decoy`);
  return { c, l };
}
export const DECOY_OPS = {
  // The same service again on another date in the period (repeat-service-different-date): a separate service, not
  // a duplicate. The copy goes `days` later, or `days` earlier when later would leave the period, is appended to the
  // claim and is adjudicated as a service of its own: what is left of the year's deductible first, then coinsurance
  // (none for a lab test). Refused where a repeat would itself be wrong: preventive services (frequency limits), a
  // new-patient visit (99202-99205; a second one with the same doctor is miscoded) and HbA1c (83036; covered only at
  // set intervals). Scenario authors still choose repeatable services, with claimShapes.
  'repeat-service-other-date'(ctx, { claim, line, days }) {
    const { c, l } = freeLine(ctx, claim, line, 'repeat-service-other-date');
    if (l.preventiveNoCostShare) throw new Error('repeat-service-other-date: a preventive service repeated in the period is an error, not a decoy');
    if (/^9920[2-5]$/.test(l.code) || l.code === '83036') throw new Error(`repeat-service-other-date: ${l.code} repeated in the period is an error, not a decoy`);
    if (!Number.isInteger(days) || days < 1) throw new Error('repeat-service-other-date: days must be a whole number of at least 1');
    const shift = (n) => { const d = new Date(l.dateOfService + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const inPeriod = (x) => !ctx.period || (x >= ctx.period.start && x <= ctx.period.end);
    const date = inPeriod(shift(days)) ? shift(days) : shift(-days);
    if (!inPeriod(date)) throw new Error(`repeat-service-other-date: neither ${days} days later nor earlier is inside the period`);
    if (c.lines.some((x) => x.code === l.code && x.dateOfService === date)) throw new Error('repeat-service-other-date: that date already has the same service');
    const copy = { ...l, dateOfService: date, toDeductible: 0, denialNote: undefined, addedByDecoy: true };
    if (copy.labNoCostShare) { copy.coinsurance = 0; copy.paid = copy.allowed; copy.patientMayBeBilled = 0; }
    else {
      const used = ctx.claims.reduce((n, x) => n + x.lines.reduce((m, y) => m + (y.toDeductible || 0), 0), 0);
      const left = Math.max(0, r2(ctx.params.partB.deductible - (ctx.deductibleMetBefore || 0) - used));
      copy.toDeductible = r2(Math.min(left, copy.allowed));
      copy.coinsurance = r2((copy.allowed - copy.toDeductible) * ctx.params.partB.coinsuranceRate);
      copy.paid = r2(copy.allowed - copy.toDeductible - copy.coinsurance); copy.patientMayBeBilled = r2(copy.toDeductible + copy.coinsurance);
    }
    delete copy.providerBilledPatient;
    c.lines.push(copy); c.totals = sum(c.lines);
    return { kind: 'repeat-service-different-date', lineRef: `claims[${claim}].lines[${c.lines.length - 1}]` };
  },
  // A charge far above the approved amount (charge-above-approved): what a provider charges is not what Medicare
  // approves, and on an assigned claim the patient owes only the cost sharing on the approved amount.
  'charge-far-above-approved'(ctx, { claim, line, factor = 4 }) {
    const { c, l } = freeLine(ctx, claim, line, 'charge-far-above-approved');
    if (!(factor > 1)) throw new Error('charge-far-above-approved: factor must be above 1');
    if (!l.approved || l.providerBilledPatient !== undefined) throw new Error('charge-far-above-approved: the line must be approved and billed at the approved share');
    l.charged = r2(l.allowed * factor); c.totals = sum(c.lines);
    return { kind: 'charge-above-approved', lineRef: `claims[${claim}].lines[${line}]` };
  },
};

/** Apply a scenario's decoys[] after its mutations. Each entry: { op, args, rule, kind?, note? }. */
export function applyDecoys(ctx, decoys = [], errors = []) {
  const out = []; ctx.errors = errors; ctx.decoys = out;
  for (const [i, m] of decoys.entries()) {
    const op = DECOY_OPS[m.op]; if (!op) throw new Error(`unknown decoy op ${m.op}`);
    if (typeof m.rule !== 'string' || !m.rule.trim()) throw new Error(`decoy ${m.op}: the scenario must cite the rule that makes the line correct`);
    const d = op(ctx, m.args || {});
    out.push({ id: `decoy-${i + 1}`, kind: m.kind || d.kind, lineRef: d.lineRef, rule: m.rule, ...(m.note ? { note: m.note } : {}) });
  }
  delete ctx.errors; delete ctx.decoys;
  return out;
}
