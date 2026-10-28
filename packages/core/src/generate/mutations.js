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
    return { kind: 'duplicate-charge', lineRef: `claims[${claim}].lines[${line + 1}]`, expected: null, actual: dup.code,
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
