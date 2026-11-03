// ma-mutations.js — error injection and decoys on the Medicare Advantage EOBs (ppo-eob, hmo-eob). The Part B
// operations in mutations.js change the Part B adjudication, which these documents then re-adjudicate under the plan,
// so they cannot be used here. These operations act on the plan's own figures instead:
//   - before adjudication (they change the claims the plan adjudicates): ma-duplicate-line, ma-shift-date,
//     ma-deny-line and the decoys ma-repeat-service-other-date and ma-approved-below-copay;
//   - adjudicateMa, once, so deductible, copays, coinsurance and the out-of-pocket cap apply in claim order;
//   - after adjudication: ma-break-claim-total, ma-cost-share-on-exempt-line, ma-reapply-deductible,
//     ma-share-after-oop-max, then the decoys ma-charge-far-above-approved, ma-oop-cap-partial-share and
//     ma-partial-deductible.
// Errors come before decoys within each stage. Indices name the claims and lines as they stand when the operation
// runs. Every line an operation records is tagged, and the references are resolved from the tags at the end, so an
// inserted line never leaves a stale reference. No operation draws from the random stream. Refusal messages never
// carry a value from the scenario or the caller.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const STRINGS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/ma-operations.json'), 'utf-8'));
// a refusal: the message from the strings file, with only the operation, layout or entry kind filled in
export const fail = (key, fill = {}) => new Error(STRINGS.messages[key].replace(/\{(op|type|what|min|max|known)\}/g, (m, k) => (k in fill ? fill[k] : m)));
// An amount an operation adds to a printed figure: a non-zero whole number of cents of at most MAX_AMOUNT dollars either
// way, so the change always shows once the figure is rounded to cents and never leaves a finite range. A factor that
// scales an amount is at most MAX_FACTOR.
export const MAX_AMOUNT = 100000; export const MAX_FACTOR = 100;
// a figure in whole cents (zero allowed), for the amounts a scenario sets
export const inCents = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
export const wholeCents = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_AMOUNT
  && Math.round(v * 100) !== 0 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const RULE = STRINGS.rules;
const r2 = (x) => Math.round(x * 100) / 100;
const MODEL_TOTAL = { charged: 'charged', allowed: 'approved', paid: 'planShare', patientMayBeBilled: 'yourShare' };
const PRE_ERRORS = new Set(['ma-duplicate-line', 'ma-shift-date', 'ma-deny-line']);
const PRE_DECOYS = new Set(['ma-repeat-service-other-date', 'ma-approved-below-copay']);

export function sumMaLines(lines) {
  return lines.reduce((t, l) => ({ charged: r2(t.charged + l.charged), approved: r2(t.approved + l.approved), planShare: r2(t.planShare + l.planShare), yourShare: r2(t.yourShare + l.yourShare) }),
    { charged: 0, approved: 0, planShare: 0, yourShare: 0 });
}
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// the member's share under the plan's rule for this line, before the cap; the deductible counts as already met
function uncappedShare(line, plan) {
  if (line.preventiveNoCostShare || line.labNoCostShare) return { copay: 0, coinsurance: 0 };
  if (plan.coinsurance[line.category] != null) return { copay: 0, coinsurance: r2(line.approved * plan.coinsurance[line.category]) };
  return { copay: r2(Math.min(plan.copay[line.category] ?? 0, line.approved)), coinsurance: 0 };
}
const isCopayLine = (l, plan) => !l.preventiveNoCostShare && !l.labNoCostShare && plan.coinsurance[l.category] == null;
const isCoinsuranceLine = (l, plan) => !l.preventiveNoCostShare && !l.labNoCostShare && plan.coinsurance[l.category] != null;
// before adjudication a line carries the Part B fields: its approved amount is `allowed`
const zeroUnderPlan = (l, plan) => { const u = uncappedShare({ ...l, approved: l.allowed }, plan); return r2(u.copay + u.coinsurance) <= 0; };

function lineAt(claims, claim, line, op) {
  const c = Number.isInteger(claim) ? claims[claim] : undefined; const l = c && Number.isInteger(line) ? c.lines[line] : undefined;
  if (!l) throw fail('noLine', { op });
  return { c, l };
}
function free(l, op) { if (l._tags && l._tags.length) throw fail('lineTaken', { op }); }
const tag = (l, t) => { l._tags = [...(l._tags || []), t]; };
function setShare(l, { deductibleApplied = 0, coinsurance = 0, copay = 0 }) {
  l.deductibleApplied = r2(deductibleApplied); l.coinsurance = r2(coinsurance); l.copay = r2(copay);
  l.yourShare = r2(l.deductibleApplied + l.coinsurance + l.copay); l.planShare = r2(l.approved - l.yourShare);
}

const PRE_OPS = {
  'ma-duplicate-line'(ctx, { claim, line }, t) {
    const { c, l } = lineAt(ctx.claims, claim, line, 'ma-duplicate-line'); free(l, 'ma-duplicate-line');
    if (zeroUnderPlan(l, ctx.plan)) throw fail('chargesNothing', { op: 'ma-duplicate-line' });
    const copy = { ...l, _tags: [t] }; tag(l, `${t}:rel`);
    c.lines.splice(line + 1, 0, copy);
    return { kind: 'duplicate-charge', ref: t, relatedRef: `${t}:rel`, expected: null, actual: l.code, severity: 'high', after: (x) => {
      if (x.line.yourShare <= 0) throw fail('chargesNothing', { op: 'ma-duplicate-line' });
      return { delta: x.line.yourShare };
    }, rule: RULE.ruleDuplicate };
  },
  'ma-shift-date'(ctx, { claim, line, days }, t) {
    const { l } = lineAt(ctx.claims, claim, line, 'ma-shift-date'); free(l, 'ma-shift-date');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw fail('badDays', { op: 'ma-shift-date' });
    const expected = l.dateOfService; l.dateOfService = addDays(ctx.dateOfNotice, days); tag(l, t);
    return { kind: 'service-date-anomaly', ref: t, expected, actual: l.dateOfService, delta: null, severity: 'low', rule: RULE.ruleDateAfterStatement };
  },
  // A denied line is approved at $0 before adjudication, so it takes no deductible and no share of the out-of-pocket
  // maximum, and every later line is adjudicated in claim order as if it were never covered. The member's change is
  // what the line would have cost them had it been covered, from a second adjudication without the denial.
  'ma-deny-line'(ctx, { claim, line, note }, t) {
    const { l } = lineAt(ctx.claims, claim, line, 'ma-deny-line'); free(l, 'ma-deny-line');
    if (!note || typeof note.text !== 'string' || !note.text.trim()) throw fail('needsNote');
    if (note.text.length > 500 || (note.rule !== undefined && (typeof note.rule !== 'string' || note.rule.length > 1000))) throw fail('denialNoteTooLong');
    const expected = l.allowed;
    l._undeny = { allowed: l.allowed }; l.allowed = 0; l.denied = true; l.denialNote = { text: note.text, rule: note.rule }; tag(l, t);
    return { kind: 'coverage-denial', ref: t, expected, actual: 0, severity: 'info', rule: note.rule || RULE.ruleDenial,
      after: (x) => ({ delta: r2(-(x.covered?.yourShare ?? 0)) || 0 }) };
  },
};
const PRE_DECOY_OPS = {
  'ma-repeat-service-other-date'(ctx, { claim, line, days }, t) {
    const { c, l } = lineAt(ctx.claims, claim, line, 'ma-repeat-service-other-date'); free(l, 'ma-repeat-service-other-date');
    if (l.preventiveNoCostShare || /^9920[2-5]$/.test(l.code) || l.code === '83036') throw fail('repeatIsError', { op: 'ma-repeat-service-other-date' });
    if (!Number.isInteger(days) || days < 1 || days > 365) throw fail('badDays', { op: 'ma-repeat-service-other-date' });
    const inPeriod = (x) => x >= ctx.period.start && x <= ctx.period.end;
    const date = inPeriod(addDays(l.dateOfService, days)) ? addDays(l.dateOfService, days) : addDays(l.dateOfService, -days);
    if (!inPeriod(date)) throw fail('outsidePeriod', { op: 'ma-repeat-service-other-date' });
    if (c.lines.some((x) => x.code === l.code && x.dateOfService === date)) throw fail('sameDate', { op: 'ma-repeat-service-other-date' });
    c.lines.push({ ...l, dateOfService: date, _tags: [t] });
    return { kind: 'repeat-service-different-date', ref: t };
  },
  'ma-approved-below-copay'(ctx, { claim, line }, t) {
    const { l } = lineAt(ctx.claims, claim, line, 'ma-approved-below-copay'); free(l, 'ma-approved-below-copay');
    const copay = ctx.plan.copay[l.category] ?? 0;
    if (!isCopayLine(l, ctx.plan) || !(copay > 0)) throw fail('noCopay');
    l.allowed = r2(copay * 0.6); tag(l, t);
    return { kind: 'approved-below-copay', ref: t };
  },
};

const POST_OPS = {
  'ma-break-claim-total'(ctx, { claim, field, by }, t) {
    const c = Number.isInteger(claim) ? ctx.claims[claim] : undefined; if (!c) throw fail('noLine', { op: 'ma-break-claim-total' });
    if (typeof field !== 'string') throw fail('unknownField', { op: 'ma-break-claim-total' });   // never converted to look it up
    const key = MODEL_TOTAL[field]; if (!key || !Object.prototype.hasOwnProperty.call(MODEL_TOTAL, field)) throw fail('unknownField', { op: 'ma-break-claim-total' });
    if (!wholeCents(by) || (field === 'charged' && by < 0)) throw fail('badBy', { op: 'ma-break-claim-total' });
    if (c._shifts && Object.prototype.hasOwnProperty.call(c._shifts, key)) throw fail('lineTaken', { op: 'ma-break-claim-total' });
    c._shifts = { ...(c._shifts || {}), [key]: by };
    // the printed total is the final line sum plus the shift, settled once every operation has run
    return { kind: 'math-error', lineRef: `claims[${claim}].totals.${field}`, severity: 'medium', rule: 'internal consistency',
      after: () => ({ expected: c.totals[key], actual: c.printedTotals[key], delta: r2(c.printedTotals[key] - c.totals[key]) }) };
  },
  'ma-cost-share-on-exempt-line'(ctx, { claim, line }, t) {
    const { l } = lineAt(ctx.claims, claim, line, 'ma-cost-share-on-exempt-line'); free(l, 'ma-cost-share-on-exempt-line');
    if (!l.preventiveNoCostShare && !l.labNoCostShare) throw fail('notExemptLine');
    const visitCopay = ctx.plan.copay.visit ?? 0;
    const want = visitCopay > 0 ? { copay: r2(Math.min(visitCopay, l.approved)) } : { coinsurance: r2(l.approved * 0.2) };
    const room = r2(ctx.plan.oopMax - ctx.state.oopUsed); const amount = r2(Math.min(want.copay ?? want.coinsurance, room));
    if (!(amount > 0)) throw fail('capLeavesNothing', { op: 'ma-cost-share-on-exempt-line' });
    setShare(l, want.copay != null ? { copay: amount } : { coinsurance: amount }); ctx.state.oopUsed = r2(ctx.state.oopUsed + amount); tag(l, t);
    return { kind: l.preventiveNoCostShare ? 'preventive-cost-sharing' : 'cost-sharing-error', ref: t, expected: 0, actual: amount, delta: amount, severity: 'high',
      rule: l.preventiveNoCostShare ? RULE.rulePreventive : RULE.ruleLab };
  },
  'ma-reapply-deductible'(ctx, { claim, line }, t) {
    if (!(ctx.plan.deductible > 0)) throw fail('noDeductible', { op: 'ma-reapply-deductible', type: ctx.type });
    if (!ctx.state.forced || ctx.state.deductibleMetBefore < ctx.plan.deductible) throw fail('needsState', { op: 'ma-reapply-deductible' });
    const { l } = lineAt(ctx.claims, claim, line, 'ma-reapply-deductible'); free(l, 'ma-reapply-deductible');
    if (!isCoinsuranceLine(l, ctx.plan)) throw fail('notCoinsuranceLine');
    const expected = l.yourShare; const ded = r2(Math.min(ctx.plan.deductible, l.approved));
    let next = { deductibleApplied: ded, coinsurance: r2((l.approved - ded) * ctx.plan.coinsurance[l.category]) };
    const room = r2(ctx.plan.oopMax - ctx.state.oopUsed + expected); let share = r2(next.deductibleApplied + next.coinsurance);
    if (share > room) { const cut = r2(share - room); next = { deductibleApplied: next.deductibleApplied, coinsurance: r2(Math.max(0, next.coinsurance - cut)) }; share = r2(next.deductibleApplied + next.coinsurance); }
    // the cap cuts coinsurance only, never the deductible: a month too close to the maximum cannot take it again
    if (share > room) throw fail('capBelowDeductible', { op: 'ma-reapply-deductible' });
    if (!(share > expected)) throw fail('capLeavesNothing', { op: 'ma-reapply-deductible' });
    setShare(l, next); ctx.state.oopUsed = r2(ctx.state.oopUsed + share - expected); tag(l, t);
    return { kind: 'deductible-misapplied', ref: t, expected, actual: share, delta: r2(share - expected), severity: 'high',
      rule: RULE.ruleDeductible };
  },
  'ma-share-after-oop-max'(ctx, { claim, line }, t) {
    const needDed = ctx.plan.deductible > 0 && ctx.state.deductibleMetBefore < ctx.plan.deductible;
    if (!ctx.state.forced || ctx.state.oopUsedBefore < ctx.plan.oopMax || needDed) throw fail('needsState', { op: 'ma-share-after-oop-max' });
    const { l } = lineAt(ctx.claims, claim, line, 'ma-share-after-oop-max'); free(l, 'ma-share-after-oop-max');
    const u = uncappedShare(l, ctx.plan); const share = r2(u.copay + u.coinsurance);
    if (!(share > 0)) throw fail('chargesNothing', { op: 'ma-share-after-oop-max' });
    setShare(l, u); ctx.flags.ytdFromPrior = true; tag(l, t);
    return { kind: 'oop-max-exceeded', ref: t, expected: 0, actual: share, delta: share, severity: 'high',
      rule: RULE.ruleOopMax };
  },
};
const POST_DECOY_OPS = {
  'ma-charge-far-above-approved'(ctx, { claim, line, factor = 4 }, t) {
    const { l } = lineAt(ctx.claims, claim, line, 'ma-charge-far-above-approved'); free(l, 'ma-charge-far-above-approved');
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 4 || factor > MAX_FACTOR) throw fail('factorAtLeast', { op: 'ma-charge-far-above-approved', min: 4, max: MAX_FACTOR });
    if (!(r2(l.approved * factor) > l.approved)) throw fail('noChange', { op: 'ma-charge-far-above-approved' });
    l.charged = r2(l.approved * factor); tag(l, t);
    return { kind: 'charge-above-approved', ref: t };
  },
  'ma-oop-cap-partial-share'(ctx, { claim, line }, t) {
    if (!ctx.state.forced) throw fail('needsState', { op: 'ma-oop-cap-partial-share' });
    const { l } = lineAt(ctx.claims, claim, line, 'ma-oop-cap-partial-share'); free(l, 'ma-oop-cap-partial-share');
    // the line's share before the cap: its deductible, then coinsurance on the rest, or its copay
    const ded = l.deductibleApplied || 0;
    const full = isCoinsuranceLine(l, ctx.plan) ? r2(ded + (l.approved - ded) * ctx.plan.coinsurance[l.category]) : uncappedShare(l, ctx.plan).copay;
    // a line below that share is one the cap cut (adjudication gives every other line exactly that share)
    if (!(l.yourShare > 0 && l.yourShare < full)) throw fail('notPartialCap');
    tag(l, t); return { kind: 'oop-cap-partial-share', ref: t };
  },
  'ma-partial-deductible'(ctx, { claim, line }, t) {
    if (!(ctx.plan.deductible > 0)) throw fail('noDeductible', { op: 'ma-partial-deductible', type: ctx.type });
    if (!ctx.state.forced) throw fail('needsState', { op: 'ma-partial-deductible' });
    const { l } = lineAt(ctx.claims, claim, line, 'ma-partial-deductible'); free(l, 'ma-partial-deductible');
    if (!isCoinsuranceLine(l, ctx.plan) || !(l.deductibleApplied > 0 && l.deductibleApplied < l.approved)) throw fail('notPartialDeductible');
    tag(l, t); return { kind: 'partial-deductible', ref: t };
  },
};
export const MA_OPS = Object.freeze([...Object.keys(PRE_OPS), ...Object.keys(POST_OPS)]);
export const MA_DECOY_OPS = Object.freeze([...Object.keys(PRE_DECOY_OPS), ...Object.keys(POST_DECOY_OPS)]);

// What a scenario or caller gives for an entry (rule, note, kind, severity) goes into the answer key as given, so its
// length and shape are checked; the Part B operations (mutations.js) check their entries the same way. A decoy without
// a rule as text is refused by its own runner, with its own message.
const SEVERITIES = ['info', 'low', 'medium', 'high'];
export function checkEntry(m, what) {
  const bad = (v, max) => v !== undefined && (typeof v !== 'string' || v.length > max);
  const badRule = what === 'decoy' ? typeof m.rule === 'string' && m.rule.length > 1000 : bad(m.rule, 1000);
  if (badRule || bad(m.note, 500)) throw fail('entryTextTooLong', { what });
  if (m.kind !== undefined && !(typeof m.kind === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(m.kind))) throw fail('entryKindInvalid', { what });
  if (m.severity !== undefined && !SEVERITIES.includes(m.severity)) throw fail('entrySeverityInvalid', { what });
  return m;
}
export function entryOf(m, what) {
  if (!m || typeof m !== 'object' || typeof m.op !== 'string') throw fail('entryNeedsOp', { what });
  return checkEntry(m, what);
}
// Resolve every tag to its claims[i].lines[j] reference in the adjudicated claims.
function resolver(claims) {
  const where = new Map();
  claims.forEach((c, i) => c.lines.forEach((l, j) => (l._tags || []).forEach((t) => where.set(t, `claims[${i}].lines[${j}]`))));
  return (t) => where.get(t) || null;
}
function findTagged(claims, t) { for (const c of claims) for (const l of c.lines) if ((l._tags || []).includes(t)) return l; return null; }

/** Run a scenario's MA mutations and decoys around one adjudication.
 *  ctx: { type, plan, period, dateOfNotice, enriched, state: { forced, oopUsedBefore, deductibleMetBefore } },
 *  adjudicate(claims) -> adjudicateMa's result. Returns { ma, errors, decoys, flags }. */
export function runMaOperations(ctx, adjudicate, mutations = [], decoys = []) {
  const pre = { type: ctx.type, plan: ctx.plan, period: ctx.period, dateOfNotice: ctx.dateOfNotice, claims: ctx.enriched };
  const errSlots = mutations.map((m) => entryOf(m, 'mutation')); const decSlots = decoys.map((d) => entryOf(d, 'decoy'));
  // an operation is one of the tables' own entries, never a name every object has (constructor, toString)
  const own = (table, op) => Object.prototype.hasOwnProperty.call(table, op);
  for (const m of errSlots) if (!own(PRE_OPS, m.op) && !own(POST_OPS, m.op)) throw fail('unknownOp');
  for (const d of decSlots) {
    if (!own(PRE_DECOY_OPS, d.op) && !own(POST_DECOY_OPS, d.op)) throw fail('unknownDecoy');
    if (typeof d.rule !== 'string' || !d.rule.trim()) throw fail('decoyNeedsRule');
  }
  const errs = new Array(errSlots.length); const decs = new Array(decSlots.length);
  errSlots.forEach((m, i) => { if (PRE_ERRORS.has(m.op)) errs[i] = PRE_OPS[m.op](pre, m.args || {}, `e${i}`); });
  decSlots.forEach((d, i) => { if (PRE_DECOYS.has(d.op)) decs[i] = PRE_DECOY_OPS[d.op](pre, d.args || {}, `d${i}`); });
  const ma = adjudicate(pre.claims);
  // the same claims with every denial undone, for what each denied line would have cost the member
  const undone = pre.claims.some((c) => c.lines.some((l) => l._undeny))
    ? adjudicate(pre.claims.map((c) => ({ ...c, lines: c.lines.map((l) => (l._undeny ? { ...l, allowed: l._undeny.allowed, denied: false } : l)) }))) : null;
  for (const c of ma.claims) for (const l of c.lines) delete l._undeny;
  const post = { type: ctx.type, plan: ctx.plan, claims: ma.claims, flags: {}, state: { forced: !!ctx.state.forced, oopUsedBefore: ctx.state.oopUsedBefore, deductibleMetBefore: ctx.state.deductibleMetBefore, oopUsed: ma.oopUsed } };
  errSlots.forEach((m, i) => { if (!PRE_ERRORS.has(m.op)) errs[i] = POST_OPS[m.op](post, m.args || {}, `e${i}`); });
  decSlots.forEach((d, i) => { if (!PRE_DECOYS.has(d.op)) decs[i] = POST_DECOY_OPS[d.op](post, d.args || {}, `d${i}`); });
  for (const c of ma.claims) {
    c.totals = sumMaLines(c.lines);
    if (c._shifts) c.printedTotals = Object.fromEntries(Object.entries(c.totals).map(([k, v]) => [k, c._shifts[k] != null ? r2(v + c._shifts[k]) : v]));
    if (c.printedTotals && Object.values(c.printedTotals).some((v) => v < 0)) throw fail('totalBelowZero', { op: 'ma-break-claim-total' });
  }
  ma.oopUsed = post.state.oopUsed;
  const refOf = resolver(ma.claims);
  const errors = errs.map((e, i) => {
    const out = { kind: e.kind, lineRef: e.lineRef || refOf(e.ref) };
    if (e.relatedRef) out.relatedLineRef = refOf(e.relatedRef);
    const late = e.after ? e.after({ line: e.ref ? findTagged(ma.claims, e.ref) : null, covered: e.ref && undone ? findTagged(undone.claims, e.ref) : null }) : {};
    Object.assign(out, { expected: late.expected !== undefined ? late.expected : e.expected, actual: late.actual !== undefined ? late.actual : e.actual,
      delta: (late.delta !== undefined ? late.delta : e.delta) ?? null, severity: e.severity, rule: e.rule });
    const m = errSlots[i]; if (m.kind) out.kind = m.kind; if (m.severity) out.severity = m.severity; if (m.rule) out.rule = m.rule; if (m.note) out.note = m.note;
    return out;
  });
  const decoysOut = decs.map((d, i) => ({ id: `decoy-${i + 1}`, kind: decSlots[i].kind || d.kind, lineRef: refOf(d.ref), rule: decSlots[i].rule, ...(decSlots[i].note ? { note: decSlots[i].note } : {}) }));
  return { ma, errors, decoys: decoysOut, flags: post.flags };
}
