// provider-statement.js — the provider's statement for one claim of a Medicare Advantage EOB (ppo-eob, hmo-eob): the
// same patient, member id, plan, provider, claim number, date of service and lines as that claim on the EOB, after
// the plan adjudicated it, asking the patient for the balance. On a correct statement the balance is the member share
// the EOB prints for the claim.
//
// Built from the EOB's finished data and key and from what the EOB was generated from (its beneficiary and the
// providers of its claims), with a stream of its own: nothing here draws from the EOB's stream, so the EOB is the same
// with or without its statement. The claim billed is the first draw of that stream over all of the EOB's claims, so
// which claim it is says nothing about the EOB's planted errors.
//
// Printed rows (summary): total charges; contractual adjustment (charges minus the plan-approved amounts, over the
// lines the plan approved); denied by the plan, not billed to the patient (charges of the lines the plan denied, shown
// only when there are any); paid by the plan; payments received; balance due = total charges - contractual adjustment
// - denied - paid by the plan - payments received. Lines carry date, code, description, units and charge, and never
// mark a line as denied.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { accountNumber, digits, phone555 } from './identifiers.js';
import { intBetween } from './rng.js';

export const PAIR_STRINGS = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/pair.json'), 'utf-8'));
export const pairMessage = (key, who) => PAIR_STRINGS.messages[key].replace('{who}', who).replace('{variants}', BILL_VARIANTS.join(', '));
const refuse = (key, who) => { throw Object.assign(new Error(pairMessage(key, who)), { code: 'PAIR' }); };

const r2 = (x) => Math.round(x * 100) / 100 + 0;   // + 0 turns a -0 into 0
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const shortDate = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sum = (xs) => r2(xs.reduce((s, x) => s + x, 0));

export const STATEMENT_TYPE = 'provider-statement';
export const PAIRED_TYPES = Object.freeze(['ppo-eob', 'hmo-eob']);
// The statement's variants: one clean, three errors, one decoy, and the decoy with an error. Each applies only where
// the billed claim, as the EOB prints it, allows it.
export const BILL_VARIANTS = Object.freeze(['clean', 'over-owed', 'denied-line-billed', 'payment-misposted', 'paid-at-visit', 'over-owed-with-payment']);
const PARAM_OF = { 'over-owed': ['by'], 'payment-misposted': ['by'], 'paid-at-visit': ['amount'], 'over-owed-with-payment': ['by', 'amount'], clean: [], 'denied-line-billed': [] };
// the EOB's claim totals the statement is compared with, by layout
const EOB_TOTAL = { 'ppo-eob': { share: 'yourShare', paid: 'planShare' }, 'hmo-eob': { share: 'maxYouMayBeBilled', paid: 'amountPlanPaid' } };
const cents = (x) => Math.round(x * 100);
const wholeCents = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(cents(v) - v * 100) < 1e-6;

// The EOB's errors and decoys a statement of the same claim shows too, keyed on the statement as well: a line the
// provider billed twice, a line whose date of service is wrong, and the decoys that sit on the provider's own lines.
// Every other operation is the plan's (cost sharing, deductible, the out-of-pocket maximum, a denial) and the statement
// takes the EOB's figures for it with no error of its own; a claim total the EOB misprints is not used (the statement
// sums its lines).
const PASSED_ERRORS = new Set(['duplicate-charge', 'service-date-anomaly']);
const PASSED_DECOYS = new Set(['repeat-service-different-date', 'charge-above-approved']);

/** The statement of one claim of a generated MA EOB. `eob` is generateDocument's result for ppo-eob or hmo-eob. */
export function assembleStatement({ rng, eob, type, variant = 'clean', params = null, orClean = false, who = 'pair' }) {
  // the variant and its amounts are checked before anything is drawn or converted
  if (typeof variant !== 'string' || !BILL_VARIANTS.includes(variant)) refuse('billVariant', who);
  if (!(params === null || params === undefined || (typeof params === 'object' && !Array.isArray(params) && Object.getPrototypeOf(params) === Object.prototype
    && Object.keys(params).every((p) => PARAM_OF[variant].includes(p)) && Object.values(params).every(wholeCents)))) refuse('billAmount', who);
  const { data: eobData, groundTruth: eobKey, context } = eob;
  const claimCount = eobKey.claims.length;
  const k = Math.floor(rng() * claimCount);   // the first draw: which claim, whatever the EOB's operations
  const claim = eobKey.claims[k]; const printed = eobData.claims[k];
  const provider = context.adjudicated.claims[k].provider;
  const providerEntity = eobKey.documents[0].entities.providers[k];
  const notice = context.dateOfNotice;
  const statementDate = addDays(notice, intBetween(rng, 5, 15));
  const acct = accountNumber(rng);
  const billingPhone = phone555(rng, provider.phone.split('-')[0]);
  const taxId = `00-${digits(rng, 7)}`;

  const lines = claim.lines.map((l, j) => ({ date: shortDate(l.dateOfService), code: l.code, description: printed.lineItems[j].description, units: l.units, charge: l.charged }));
  const approvedLines = claim.lines.filter((l) => l.approved); const deniedLines = claim.lines.filter((l) => !l.approved);
  const summary = {
    totalCharges: sum(claim.lines.map((l) => l.charged)),
    contractualAdjustment: sum(approvedLines.map((l) => l.charged - l.allowed)),
    deniedNotBilled: deniedLines.length ? sum(deniedLines.map((l) => l.charged)) : null,
    paidByPlan: sum(claim.lines.map((l) => l.paid)),
    paymentsReceived: 0,
  };
  summary.balanceDue = r2(summary.totalCharges - summary.contractualAdjustment - (summary.deniedNotBilled ?? 0) - summary.paidByPlan - summary.paymentsReceived);
  const dates = claim.lines.map((l) => l.dateOfService).sort();

  const data = {
    carrier: STATEMENT_TYPE, scenario: null,
    metadata: {
      providerName: provider.name, providerAddress: provider.addressLines[0], providerCityStateZip: provider.addressLines[1],
      providerPhone: provider.phone, billingPhone, taxId, npi: provider.npi,
      statementDate: longDate(statementDate), accountNumber: acct, claimNumber: printed.claimNumber,
      patientName: context.beneficiary.name, memberId: eobKey.documents[0].entities.identifiers.memberId,
      planName: eobKey.documents[0].entities.payer.planName,
      dateOfService: longDate(claim.dateOfService),
      serviceDateRange: dates[0] === dates[dates.length - 1] ? longDate(dates[0]) : `${longDate(dates[0])} - ${longDate(dates[dates.length - 1])}`,
    },
    lineItems: lines,
    summary,
  };
  const linePath = (j) => `lineItems[${j}]`;
  const reKey = (x) => {
    const j = Number(/^claims\[\d+\]\.lines\[(\d+)\]$/.exec(x.lineRef)[1]);
    const rel = x.relatedLineRef ? Number(/^claims\[\d+\]\.lines\[(\d+)\]$/.exec(x.relatedLineRef)[1]) : null;
    const out = { ...x, documentId: `${STATEMENT_TYPE}-1`, lineRef: `claims[0].lines[${j}]`, fieldRef: linePath(j),
      relatedDocumentId: eobKey.documents[0].id, relatedDocumentFieldRef: x.fieldRef };
    if (rel !== null) { out.relatedLineRef = `claims[0].lines[${rel}]`; out.relatedFieldRef = linePath(rel); } else { delete out.relatedLineRef; delete out.relatedFieldRef; }
    return out;
  };
  const onClaim = (x) => typeof x.lineRef === 'string' && x.lineRef.startsWith(`claims[${k}].`);
  const errors = eobKey.errors.filter((e) => onClaim(e) && PASSED_ERRORS.has(e.kind)).map(reKey)
    .map((e) => (e.kind === 'service-date-anomaly' ? { ...e, rule: PAIR_STRINGS.rules.statementDate } : e));
  const decoys = eobKey.decoys.filter((d) => onClaim(d) && PASSED_DECOYS.has(d.kind)).map(reKey);
  const applied = applyVariant({ rng, type, k, claim, summary, errors, decoys, eobDocId: eobKey.documents[0].id, variant, params: params || {}, orClean, who });
  const statementClaim = { ...claim, totals: { charged: summary.totalCharges, allowed: sum(claim.lines.map((l) => l.allowed)), paid: summary.paidByPlan, patientMayBeBilled: summary.balanceDue } };
  return {
    data, claimIndex: k, errors, decoys, claim: statementClaim, variant: applied.variant, params: applied.params,
    entities: {
      patient: eobKey.documents[0].entities.patient,
      providers: [{ ...providerEntity }],
      payer: eobKey.documents[0].entities.payer,
      identifiers: { memberId: data.metadata.memberId, claimNumber: printed.claimNumber, accountNumber: acct },
    },
  };
}

// Which variants the billed claim allows, from what the EOB prints for it, and the cents each amount may take. A claim
// whose printed totals do not add up from its lines (the EOB's own planted math error) gets only a clean statement:
// the statement follows the lines, and an error of its own beside two different EOB figures would not be decidable.
function room(claim, summary) {
  const misprinted = ['charged', 'allowed', 'paid', 'patientMayBeBilled'].some((f) => cents(claim.totals[f]) !== cents(sum(claim.lines.map((l) => l[f]))));
  const shareC = cents(sum(claim.lines.map((l) => l.patientMayBeBilled)));
  const copayC = cents(sum(claim.lines.map((l) => l.copay || 0)));
  const adjC = cents(summary.contractualAdjustment); const paidC = cents(summary.paidByPlan);
  const denied = claim.lines.findIndex((l) => !l.approved && l.charged > 0);
  const visitC = Math.min(copayC, shareC);
  return { shareC, adjC, paidC, denied, visitC, applies: {
    clean: true, 'over-owed': !misprinted && adjC >= 1, 'denied-line-billed': !misprinted && denied >= 0, 'payment-misposted': !misprinted && (adjC >= 1 || paidC >= 1),
    'paid-at-visit': !misprinted && visitC >= 1, 'over-owed-with-payment': !misprinted && adjC >= 1 && visitC >= 1 } };
}
const drawUpTo = (rng, maxC) => intBetween(rng, Math.min(500, maxC), Math.min(maxC, 25000));

// Apply a variant to a statement's summary (in place), adding its error or decoy. Every row stays at or above 0 and
// the summary keeps adding up; only the EOB shows what is wrong.
function applyVariant({ rng, type, k, claim, summary, errors, decoys, eobDocId, variant, params, orClean, who }) {
  const r = room(claim, summary);
  if (!r.applies[variant]) { if (orClean) return { variant: 'clean', params: {} }; refuse('billNotHere', who); }
  const eobPath = (field) => `claims[${k}].claimTotal.${EOB_TOTAL[type][field]}`;
  const link = { documentId: `${STATEMENT_TYPE}-1`, relatedDocumentId: eobDocId };
  const used = {};
  const amount = (name, lo, hi, draw) => {
    if (params[name] === undefined) { const c = draw(); used[name] = c / 100; return c; }
    const c = cents(params[name]); if (!(c >= lo && c <= hi && c !== 0)) refuse('billAmount', who);
    used[name] = params[name]; return c;
  };
  const balance = () => { summary.balanceDue = r2(summary.totalCharges - summary.contractualAdjustment - (summary.deniedNotBilled ?? 0) - summary.paidByPlan - summary.paymentsReceived); };
  if (variant === 'paid-at-visit' || variant === 'over-owed-with-payment') {
    const a = amount('amount', 1, r.visitC, () => r.visitC);
    summary.paymentsReceived = a / 100; balance();
    decoys.push({ id: `decoy-statement-${decoys.length + 1}`, kind: 'paid-at-visit', ...link, fieldRef: 'summary.paymentsReceived', relatedFieldRef: 'summary.balanceDue',
      relatedDocumentFieldRef: eobPath('share'), rule: variant === 'over-owed-with-payment' ? PAIR_STRINGS.rules.paidAtVisitWithError : PAIR_STRINGS.rules.paidAtVisit });
  }
  const expected = summary.balanceDue;
  if (variant === 'over-owed' || variant === 'over-owed-with-payment') {
    const by = amount('by', 1, r.adjC, () => drawUpTo(rng, r.adjC));
    summary.contractualAdjustment = r2(summary.contractualAdjustment - by / 100); balance();
    errors.push({ ...link, kind: 'bill-vs-eob-mismatch', lineRef: 'claims[0].totals.patientMayBeBilled', fieldRef: 'summary.balanceDue', relatedFieldRef: 'summary.contractualAdjustment',
      relatedDocumentFieldRef: eobPath('share'), expected, actual: summary.balanceDue, delta: by / 100, severity: 'high', rule: variant === 'over-owed-with-payment' ? PAIR_STRINGS.rules.overOwedWithPayment : PAIR_STRINGS.rules.overOwed });
  }
  if (variant === 'denied-line-billed') {
    const j = r.denied; const charge = claim.lines[j].charged;
    const left = r2((summary.deniedNotBilled ?? 0) - charge); summary.deniedNotBilled = left > 0 ? left : null; balance();
    errors.push({ ...link, kind: 'bill-vs-eob-mismatch', lineRef: 'claims[0].totals.patientMayBeBilled', fieldRef: 'summary.balanceDue',
      relatedLineRef: `claims[0].lines[${j}]`, relatedFieldRef: `lineItems[${j}]`, relatedDocumentFieldRef: `claims[${k}].lineItems[${j}]`,
      expected, actual: summary.balanceDue, delta: charge, severity: 'high', rule: PAIR_STRINGS.rules.deniedLineBilled });
  }
  if (variant === 'payment-misposted') {
    const draw = () => (r.adjC >= 1 && (r.paidC < 1 || rng() < 0.5) ? drawUpTo(rng, r.adjC) : -drawUpTo(rng, r.paidC));
    const by = amount('by', -r.paidC, r.adjC, draw);
    const eobPaid = summary.paidByPlan;
    summary.paidByPlan = r2(summary.paidByPlan + by / 100); summary.contractualAdjustment = r2(summary.contractualAdjustment - by / 100); balance();
    errors.push({ ...link, kind: 'bill-payment-mismatch', lineRef: 'claims[0].totals.paid', fieldRef: 'summary.paidByPlan', relatedFieldRef: 'summary.contractualAdjustment',
      relatedDocumentFieldRef: eobPath('paid'), expected: eobPaid, actual: summary.paidByPlan, delta: by / 100, severity: 'low', rule: PAIR_STRINGS.rules.paymentMisposted });
  }
  return { variant, params: used };
}
