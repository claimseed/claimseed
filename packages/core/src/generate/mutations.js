// mutations.js — error injection on adjudicated claims. Each op mutates the claim set AND records a
// ground-truth entry. Ops are generic; the scenario file decides which line, how much, and cites why.
// Line refs: claims[i].lines[j]. A mutation never reaches into entities, so names and identifiers
// stay consistent across every document generated from the same seed.
const r2 = (x) => Math.round(x * 100) / 100;
import { sum } from './rules.js';
import { fail, entryOf, wholeCents, MAX_FACTOR } from './ma-mutations.js';
// the claim and line an operation names, as whole-number indices of the claims as they stand
function claimAt(ctx, claim, op) { const c = Number.isInteger(claim) && claim >= 0 ? ctx.claims[claim] : undefined; if (!c) throw fail('noLine', { op }); return c; }
function lineAt(ctx, claim, line, op) { const c = claimAt(ctx, claim, op); const l = Number.isInteger(line) && line >= 0 ? c.lines[line] : undefined; if (!l) throw fail('noLine', { op }); return { c, l }; }
const factorOk = (f) => typeof f === 'number' && Number.isFinite(f) && f > 1 && f <= MAX_FACTOR;
// the claim totals each layout prints, by the generator's names: the MSN's claim table; the itemized bill's department
// subtotal (the claim's charge) and the approved, paid, deductible, coinsurance and balance-due sums of its insurance
// summary
const PRINTED_TOTALS = { msn: ['charged', 'allowed', 'paid', 'patientMayBeBilled'], 'itemized-bill': ['charged', 'allowed', 'paid', 'toDeductible', 'coinsurance', 'providerBilled'] };
// the totals a layout prints only as their sum over the claims (the itemized bill's insurance summary): there the error
// is the summed figure, so one shift per figure
const SUMMED_TOTALS = { 'itemized-bill': ['allowed', 'paid', 'toDeductible', 'coinsurance', 'providerBilled'] };
// an operation that only one kind of document shows: the provider's bill to the patient prints only on the itemized bill
const ONLY_ON = { 'bill-above-approved': ['itemized-bill'] };

export const OPS = {
  // Bill the same line twice (duplicate-charge). Copies line j of claim i and re-adjudicates it as paid.
  'duplicate-line'(ctx, { claim, line }) {
    const { c, l: src } = freeLine(ctx, claim, line, 'duplicate-line');
    // the copy goes in after its source: a later line that already carries an error would move from under it
    if ((ctx.errors || []).some((e) => [e.lineRef, e.relatedLineRef].some((ref) => { const m = /^claims\[(\d+)\]\.lines\[(\d+)\]$/.exec(ref || ''); return m && Number(m[1]) === claim && Number(m[2]) > line; }))) throw fail('dupMovesLine');
    // The duplicate is adjudicated like any other line: no second deductible, coinsurance on the full amount.
    const dup = { ...src, toDeductible: 0 };
    if (!dup.preventiveNoCostShare && !dup.labNoCostShare) { dup.coinsurance = r2(dup.allowed * ctx.params.partB.coinsuranceRate); dup.paid = r2(dup.allowed - dup.coinsurance); dup.patientMayBeBilled = dup.coinsurance; }
    c.lines.splice(line + 1, 0, dup); c.totals = sum(c.lines);
    return { kind: 'duplicate-charge', lineRef: `claims[${claim}].lines[${line + 1}]`, relatedLineRef: `claims[${claim}].lines[${line}]`, expected: null, actual: dup.code,
      delta: dup.patientMayBeBilled, severity: 'high', rule: 'CMS Claims Processing Manual ch.1 §120; NCCI MUE' };
  },
  // Printed total disagrees with the lines (math-error). Shifts one total field by `by` dollars. The shift is settled
  // once every mutation and decoy has run (settleTotals), on the claim's final lines, so a later operation on the same
  // claim cannot undo it; the error's expected and actual amounts are filled in then.
  'break-claim-total'(ctx, { claim, field = 'patientMayBeBilled', by = 10 }) {
    const ALIAS = { maxYouMayBeBilled: 'patientMayBeBilled', amountProviderCharged: 'charged', medicareApprovedAmount: 'allowed', amountMedicarePaid: 'paid' };
    if (typeof field !== 'string') throw fail('unknownField', { op: 'break-claim-total' });   // never converted to look it up
    field = Object.prototype.hasOwnProperty.call(ALIAS, field) ? ALIAS[field] : field;
    const c = claimAt(ctx, claim, 'break-claim-total');
    const printed = Object.prototype.hasOwnProperty.call(PRINTED_TOTALS, ctx.type) ? PRINTED_TOTALS[ctx.type] : [];
    if (!printed.includes(field) || typeof c.totals[field] !== 'number') throw fail('unknownField', { op: 'break-claim-total' });
    if (!wholeCents(by) || (field === 'charged' && by < 0)) throw fail('badBy', { op: 'break-claim-total' });
    ctx.shifts = ctx.shifts || [];
    const summed = (SUMMED_TOTALS[ctx.type] || []).includes(field);
    if (ctx.shifts.some((x) => x.field === field && (summed || x.c === c))) throw fail('lineTaken', { op: 'break-claim-total' });
    const rec = { kind: 'math-error', lineRef: `claims[${claim}].totals.${field}`, expected: null, actual: null, delta: null, severity: 'medium', rule: 'internal consistency' };
    ctx.shifts.push({ c, field, by, rec, summed });
    return rec;
  },
  // Deductible charged on a line that should be $0 (lab or preventive) — cost-sharing error.
  'apply-cost-share-to-exempt-line'(ctx, { claim, line, rate = 0.2 }) {
    const { c, l } = freeLine(ctx, claim, line, 'apply-cost-share-to-exempt-line');
    if (typeof rate !== 'number' || !Number.isFinite(rate) || !(rate > 0) || rate > 1) throw fail('badRate');
    const expected = l.patientMayBeBilled; const coins = r2(l.allowed * rate);
    if (coins === expected) throw fail('noChange', { op: 'apply-cost-share-to-exempt-line' });
    l.coinsurance = coins; l.paid = r2(l.allowed - coins); l.patientMayBeBilled = coins; c.totals = sum(c.lines);
    const kind = l.preventiveNoCostShare ? 'preventive-cost-sharing' : 'cost-sharing-error';
    return { kind, lineRef: `claims[${claim}].lines[${line}]`, expected, actual: coins, delta: r2(coins - expected), severity: 'high',
      rule: l.preventiveNoCostShare ? 'SSA §1861(ddd); 42 CFR 410.152(l)' : 'SSA §1833(a)(1)(D) — CLFS tests carry no cost sharing' };
  },
  // Deductible applied again (deductible-misapplied): take up to a full deductible out of a line that was
  // already adjudicated (typically after the annual deductible was met), then recompute coinsurance and
  // the Medicare payment on the remainder so the line still foots.
  'reapply-deductible'(ctx, { claim, line }) {
    const { c, l } = freeLine(ctx, claim, line, 'reapply-deductible'); const ded = ctx.params.partB.deductible;
    const expected = l.patientMayBeBilled; const extra = r2(Math.min(ded, l.allowed - l.toDeductible));
    if (!(extra > 0)) throw fail('noChange', { op: 'reapply-deductible' });
    l.toDeductible = r2(l.toDeductible + extra);
    l.coinsurance = r2((l.allowed - l.toDeductible) * ctx.params.partB.coinsuranceRate);
    l.paid = r2(l.allowed - l.toDeductible - l.coinsurance);
    l.patientMayBeBilled = r2(l.toDeductible + l.coinsurance); c.totals = sum(c.lines);
    return { kind: 'deductible-misapplied', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.patientMayBeBilled, delta: r2(l.patientMayBeBilled - expected), severity: 'high',
      rule: '42 CFR 410.160(a) — one Part B deductible per calendar year; amount per CMS annual parameters' };
  },
  // Deny a line (denied-service): Medicare paid $0, patient may be billed the charge, note letter attached.
  'deny-line'(ctx, { claim, line, note }) {
    // the note's text and rule print and go into the answer key as given: capped as the Medicare Advantage denial's
    if (note !== undefined && (!note || typeof note !== 'object' || (note.text !== undefined && (typeof note.text !== 'string' || note.text.length > 500))
      || (note.rule !== undefined && (typeof note.rule !== 'string' || note.rule.length > 1000)))) throw fail('denyNoteTooLong');
    const { c, l } = freeLine(ctx, claim, line, 'deny-line');
    if (!l.approved) throw fail('lineTaken', { op: 'deny-line' });   // denied already: a second denial would change nothing
    const expected = l.patientMayBeBilled;
    l.approved = false; l.paid = 0; l.allowed = 0; l.toDeductible = 0; l.coinsurance = 0; l.patientMayBeBilled = l.charged; l.denialNote = note; c.totals = sum(c.lines);
    return { kind: 'coverage-denial', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.charged, delta: r2(l.charged - expected), severity: 'info', rule: note?.rule || 'Initial determination (42 CFR 405.920)' };
  },
  // Shift a date of service (service-date-anomaly) by n days.
  'shift-date'(ctx, { claim, line, days }) {
    const { l } = freeLine(ctx, claim, line, 'shift-date');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw fail('badDays', { op: 'shift-date' });
    const expected = l.dateOfService;
    const d = new Date(expected + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); l.dateOfService = d.toISOString().slice(0, 10);
    return { kind: 'service-date-anomaly', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.dateOfService, delta: null, severity: 'low', rule: 'internal consistency' };
  },
  // Raise the approved amount above the fee schedule (fee-schedule-overcharge).
  'overprice-line'(ctx, { claim, line, factor = 1.5 }) {
    const { c, l } = freeLine(ctx, claim, line, 'overprice-line'); const expected = l.allowed;
    if (!factorOk(factor)) throw fail('factorAbove', { op: 'overprice-line', min: 1, max: MAX_FACTOR });
    if (r2(l.allowed * factor) === expected) throw fail('noChange', { op: 'overprice-line' });
    l.allowed = r2(l.allowed * factor); l.coinsurance = r2((l.allowed - l.toDeductible) * ctx.params.partB.coinsuranceRate); l.paid = r2(l.allowed - l.toDeductible - l.coinsurance); l.patientMayBeBilled = r2(l.toDeductible + l.coinsurance); c.totals = sum(c.lines);
    return { kind: 'fee-schedule-overcharge', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: l.allowed, delta: r2(l.patientMayBeBilled - r2(l.toDeductible + (expected - l.toDeductible) * ctx.params.partB.coinsuranceRate)), severity: 'medium', rule: 'Medicare Physician Fee Schedule for the code, locality and year' };
  },
  // Provider bills the patient more than the Medicare-approved cost sharing (assignment-violation).
  // Medicare's own figures are untouched — the MSN still prints the correct "maximum you may be billed" —
  // but the provider-side documents (itemized bill, statement) read `providerBilledPatient` instead.
  // mode 'unpaid-balance' (default): the provider bills its full charge minus what Medicare paid.
  // mode 'extra': the provider adds `by` dollars on top of the approved patient share.
  'bill-above-approved'(ctx, { claim, line, mode = 'unpaid-balance', by = 25 }) {
    const { c, l } = freeLine(ctx, claim, line, 'bill-above-approved');
    if (mode !== 'unpaid-balance' && mode !== 'extra') throw fail('badMode');
    if (mode === 'extra' && !(wholeCents(by) && by > 0)) throw fail('badBy', { op: 'bill-above-approved' });
    const expected = l.patientMayBeBilled;
    const billed = mode === 'extra' ? r2(expected + by) : r2(l.charged - l.paid);
    if (billed <= expected) throw fail('billNothingAbove');
    l.providerBilledPatient = billed;
    c.totals = sum(c.lines);
    return { kind: 'assignment-violation', lineRef: `claims[${claim}].lines[${line}]`, expected, actual: billed, delta: r2(billed - expected), severity: 'high',
      rule: '42 U.S.C. §1395u(b)(3)(B)(ii) (SSA §1842) — a participating provider accepts the approved amount as the full charge; 42 CFR 424.55(b)' };
  },
};

/** Apply a scenario's mutations[] to ctx = { claims, params }. Each entry: { op, args, kind?, severity?, rule?, note? };
 *  kind/severity/rule/note override what the op reports (e.g. report break-claim-total on a bill as subtotals-mismatch). */
export function applyMutations(ctx, mutations = []) {
  const errors = []; ctx.errors = errors;   // the lines already taken, for the operations that follow
  for (const m of mutations) {
    entryOf(m, 'mutation');
    const op = Object.prototype.hasOwnProperty.call(OPS, m.op) ? OPS[m.op] : null; if (!op) throw fail('unknownOp');
    if (ONLY_ON[m.op] && !ONLY_ON[m.op].includes(ctx.type)) throw fail('unknownOp');
    const e = op(ctx, m.args || {});
    if (m.kind) e.kind = m.kind;
    if (m.severity) e.severity = m.severity;
    if (m.rule) e.rule = m.rule;
    if (m.note) e.note = m.note;
    errors.push(e);
  }
  delete ctx.errors;
  return errors;
}

/** After the mutations and decoys: each break-claim-total shift, on the claim's final line sums. Every other total is
 *  the sum of the lines. The error records the figure as it should print (expected) and as it prints (actual): the
 *  claim's total, or, for a total the layout prints only summed over the claims, that sum. */
export function settleTotals(ctx) {
  for (const s of ctx.shifts || []) s.c.totals = sum(s.c.lines);
  for (const s of ctx.shifts || []) {
    const base = sum(s.c.lines)[s.field];
    if (r2(base + s.by) < 0) throw fail('totalBelowZero', { op: 'break-claim-total' });
    s.c.totals[s.field] = r2(base + s.by);
    const expected = s.summed ? ctx.claims.reduce((t, c) => r2(t + sum(c.lines)[s.field]), 0) : base; const actual = r2(expected + s.by);
    Object.assign(s.rec, { expected, actual, delta: r2(actual - expected) });
  }
  delete ctx.shifts;
}

// Decoys: hard negatives. A decoy op changes the claim set so that a line LOOKS wrong while following the rules, and
// records where; it never makes an error. Decoys apply after the mutations and never insert a line before an existing
// one, so every error's lineRef stays valid. The scenario names the public rule that makes the line correct (`rule`
// is required); an op only checks that the line it touches is free of errors and of other decoys.
const sameLine = (ref, claim, line) => ref === `claims[${claim}].lines[${line}]`;
function freeLine(ctx, claim, line, op) {
  const { c, l } = lineAt(ctx, claim, line, op);
  for (const e of ctx.errors || []) if (sameLine(e.lineRef, claim, line) || sameLine(e.relatedLineRef, claim, line)) throw fail('lineTaken', { op });
  for (const d of ctx.decoys || []) if (sameLine(d.lineRef, claim, line)) throw fail('lineTaken', { op });
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
    // a preventive service, a new-patient visit or an HbA1c repeated in the period is an error, not a decoy
    if (l.preventiveNoCostShare || /^9920[2-5]$/.test(l.code) || l.code === '83036') throw fail('repeatIsError', { op: 'repeat-service-other-date' });
    if (!Number.isInteger(days) || days < 1 || days > 365) throw fail('badDays', { op: 'repeat-service-other-date' });
    const shift = (n) => { const d = new Date(l.dateOfService + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const inPeriod = (x) => !ctx.period || (x >= ctx.period.start && x <= ctx.period.end);
    const date = inPeriod(shift(days)) ? shift(days) : shift(-days);
    if (!inPeriod(date)) throw fail('outsidePeriod', { op: 'repeat-service-other-date' });
    if (c.lines.some((x) => x.code === l.code && x.dateOfService === date)) throw fail('sameDate', { op: 'repeat-service-other-date' });
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
    if (!factorOk(factor)) throw fail('factorAbove', { op: 'charge-far-above-approved', min: 1, max: MAX_FACTOR });
    if (!(r2(l.allowed * factor) > l.allowed)) throw fail('noChange', { op: 'charge-far-above-approved' });
    if (!l.approved || l.providerBilledPatient !== undefined) throw fail('lineTaken', { op: 'charge-far-above-approved' });   // denied or billed above: an error's line
    l.charged = r2(l.allowed * factor); c.totals = sum(c.lines);
    return { kind: 'charge-above-approved', lineRef: `claims[${claim}].lines[${line}]` };
  },
};

/** Apply a scenario's decoys[] after its mutations. Each entry: { op, args, rule, kind?, note? }. */
export function applyDecoys(ctx, decoys = [], errors = []) {
  const out = []; ctx.errors = errors; ctx.decoys = out;
  for (const [i, m] of decoys.entries()) {
    entryOf(m, 'decoy');
    const op = Object.prototype.hasOwnProperty.call(DECOY_OPS, m.op) ? DECOY_OPS[m.op] : null; if (!op) throw fail('unknownDecoy');
    if (typeof m.rule !== 'string' || !m.rule.trim()) throw fail('decoyNeedsRule');
    const d = op(ctx, m.args || {});
    out.push({ id: `decoy-${i + 1}`, kind: m.kind || d.kind, lineRef: d.lineRef, rule: m.rule, ...(m.note ? { note: m.note } : {}) });
  }
  delete ctx.errors; delete ctx.decoys;
  return out;
}
