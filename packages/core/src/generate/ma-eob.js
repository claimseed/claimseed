// ma-eob.js — Medicare Advantage adjudication + assemblers for the two MA layouts (ppo-eob landscape,
// hmo-eob portrait). Plan designs are fictional but shaped like real MA benefits (copays by service
// category, $0 labs and preventive, a yearly out-of-pocket maximum under the CMS MOOP ceiling).
// Sources: 42 CFR 422.100(f) (MOOP), CMS Plan Benefit Package public-use files (typical copay ranges).
import { claimNumber, memberId, digits } from './identifiers.js';
import { intBetween } from './rng.js';
const r2 = (x) => Math.round(x * 100) / 100;
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const shortDate = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export const PLANS = {
  'ppo-eob': { name: 'Corvane Medicare Advantage Choice (PPO)', deductible: 150, oopMax: 5500,
    copay: { visit: 20, 'eye-exam': 40, lab: 0, imaging: 25, therapy: 30, diagnostic: 0, preventive: 0 }, coinsurance: { procedure: 0.20, diagnostic: 0.20 } },
  'hmo-eob': { name: 'Tessara Complete (HMO)', deductible: 0, oopMax: 4900,
    copay: { visit: 0, 'eye-exam': 35, lab: 0, imaging: 20, therapy: 25, diagnostic: 10, preventive: 0 }, coinsurance: { procedure: 0.20 } },
};

// Re-adjudicate Part-B-style claims under an MA plan design. Keeps provider charges and allowed amounts;
// replaces the cost-sharing with the plan's copay/coinsurance rules and tracks deductible and MOOP.
export function adjudicateMa(claims, plan, { oopUsedBefore = 0, deductibleMetBefore = 0 }) {
  let oopUsed = oopUsedBefore, dedRemaining = r2(Math.max(0, plan.deductible - deductibleMetBefore));
  const out = claims.map((c) => {
    const lines = c.lines.map((ln) => {
      const approved = ln.allowed; let yourShare = 0;
      const cat = ln.category || 'visit';
      if (ln.preventiveNoCostShare || ln.labNoCostShare) yourShare = 0;
      else if (plan.coinsurance[cat] != null) {
        const ded = r2(Math.min(dedRemaining, approved)); dedRemaining = r2(dedRemaining - ded);
        yourShare = r2(ded + (approved - ded) * plan.coinsurance[cat]);
      } else yourShare = r2(Math.min(plan.copay[cat] ?? 0, approved));
      if (oopUsed + yourShare > plan.oopMax) yourShare = r2(Math.max(0, plan.oopMax - oopUsed));
      oopUsed = r2(oopUsed + yourShare);
      return { ...ln, approved, yourShare, planShare: r2(approved - yourShare), deductibleApplied: 0 };
    });
    const totals = lines.reduce((t, l) => ({ charged: r2(t.charged + l.charged), approved: r2(t.approved + l.approved), planShare: r2(t.planShare + l.planShare), yourShare: r2(t.yourShare + l.yourShare) }), { charged: 0, approved: 0, planShare: 0, yourShare: 0 });
    return { ...c, lines, totals };
  });
  return { claims: out, oopUsed, deductibleMet: r2(plan.deductible - dedRemaining) };
}

// Ground-truth claim model for MA documents: the plan's adjudication, not the Part B one it was derived from.
function maClaimModel(maClaims, rendered) {
  return maClaims.map((c, i) => ({ claimNumber: rendered[i].claimNumber, provider: c.provider.name, dateOfService: c.dateOfService,
    lines: c.lines.map((l) => ({ code: l.code, units: l.units, dateOfService: l.dateOfService, charged: l.charged, allowed: l.approved, approved: true, paid: l.planShare, toDeductible: null, patientMayBeBilled: l.yourShare })),
    totals: { charged: c.totals.charged, allowed: c.totals.approved, paid: c.totals.planShare, patientMayBeBilled: c.totals.yourShare } }));
}
// Mutation ops act on the Part B adjudication, which MA documents re-adjudicate, so an MA scenario with mutations
// would report errors that do not appear on the page. Refuse until MA-aware ops exist.
function assertNoMutations(groundTruthErrors, type) {
  if (groundTruthErrors && groundTruthErrors.length) throw new Error(`${type}: mutation ops are not supported for Medicare Advantage layouts yet`);
}
const MA_FIELD_PATHS = { line: (i, j) => `claims[${i}].lineItems[${j}]`, totals: (i, field) => `claims[${i}].claimTotal.${field}` };

function noteFor(line, plan) {
  if (line.preventiveNoCostShare) return ['P1', 'Covered preventive service. No copayment, coinsurance, or deductible applies.'];
  if (line.labNoCostShare) return ['L1', 'Laboratory services are covered in full under this plan.'];
  if (plan.coinsurance[line.category] != null) return ['C1', `You pay ${Math.round(plan.coinsurance[line.category] * 100)}% of the plan-approved amount for this service after any deductible.`];
  return ['K1', 'Your share is the plan copayment for this type of service.'];
}

export function assemblePpoEob({ rng, beneficiary, adjudicated, period, dateOfNotice, year, stock, groundTruthErrors, catalogByCode }) {
  const plan = PLANS['ppo-eob']; assertNoMutations(groundTruthErrors, 'ppo-eob');
  const enriched = adjudicated.claims.map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, category: catalogByCode[l.code]?.category || 'visit' })) }));
  const [, ms0] = period.start.split('-'); const oopBefore = Number(ms0) === 1 ? 0 : r2(rng() * 120 * (Number(ms0) - 1)); const ma = adjudicateMa(enriched, plan, { oopUsedBefore: oopBefore, deductibleMetBefore: Math.min(plan.deductible, oopBefore) });
  const notes = []; const noteIds = {};
  const addNote = (id, text) => { if (!noteIds[id]) { noteIds[id] = true; notes.push({ id, text }); } return id; };
  const claims = ma.claims.map((c) => ({
    providerName: c.provider.name, networkStatus: 'In-network provider', claimNumber: claimNumber(rng, 'ma'), section: 'medical',
    lineItems: c.lines.map((l) => { const [id, text] = noteFor(l, plan); addNote(id, text); return {
      description: l.lay, dateOfService: shortDate(l.dateOfService), cptCode: l.code, providerBilled: l.charged, planApproved: l.approved,
      notes: [id], planShare: l.planShare, yourShare: l.yourShare, yourShareNotes: l.yourShare > 0 ? [id] : [] }; }),
    claimTotal: { providerBilled: c.totals.charged, planApproved: c.totals.approved, planShare: c.totals.planShare, yourShare: c.totals.yourShare },
  }));
  const monthly = claims.reduce((t, c) => ({ providerBilled: r2(t.providerBilled + c.claimTotal.providerBilled), planApproved: r2(t.planApproved + c.claimTotal.planApproved), planShare: r2(t.planShare + c.claimTotal.planShare), yourShare: r2(t.yourShare + c.claimTotal.yourShare) }), { providerBilled: 0, planApproved: 0, planShare: 0, yourShare: 0 });
  // Year to date = this month plus a simulated prior-months block with the same approved/billed ratio and the
  // plan's share derived, so the four YTD figures always reconcile (billed >= approved = planShare + yourShare).
  const priorMonths = Number(period.start.split('-')[1]) - 1; const priorFactor = priorMonths * (0.5 + rng() * 0.8);
  const priorYour = r2(ma.oopUsed - monthly.yourShare);
  const priorApproved = r2(Math.max(monthly.planApproved * priorFactor, priorYour * 1.5)); // = oopUsedBefore, so YTD your share equals the out-of-pocket figure
  const ytdBase = { providerBilled: r2(monthly.providerBilled + priorApproved * (monthly.providerBilled / Math.max(monthly.planApproved, 0.01))),
    planApproved: r2(monthly.planApproved + priorApproved), planShare: r2(monthly.planShare + priorApproved - Math.max(priorYour, 0)), yourShare: r2(monthly.yourShare + Math.max(priorYour, 0)) };
  const paymentSummary = ma.claims.map((c) => ({ sendDate: shortDate([addDays(c.dateOfService, intBetween(rng, 12, 28)), period.end].sort()[0]), sendTo: 'Provider', provider: c.provider.name, amount: c.totals.planShare }));
  const [ys, ms] = period.start.split('-');
  return {
    carrier: 'ppo-eob', scenario: null,
    metadata: {
      documentId: `SPEC-${digits(rng, 8)}-${ys}${ms}`, statementDate: longDate(dateOfNotice), memberName: beneficiary.nameUpper, memberId: beneficiary.memberId, planName: plan.name,
      processingPeriod: { start: shortDate(period.start), end: shortDate(period.end), month: `${MONTHS[Number(ms) - 1]} ${ys}`, year: ys },
      issuer: { name: stock.payer.legalName, address: stock.payer.address.slice(1), phone: stock.payer.phone, tty: stock.payer.tty, hours: stock.payer.hours, fax: stock.payer.fax ?? null, website: stock.payer.website },
      memberAddress: beneficiary.addressLines,
    },
    financialSummary: {
      oopAsOfDate: longDate(period.end), deductibleAsOfDate: longDate(period.end), oopMax: plan.oopMax, oopUsed: ma.oopUsed,
      deductible: plan.deductible, deductibleMet: ma.deductibleMet, deductibleFullyMet: ma.deductibleMet >= plan.deductible, deductibleType: 'In-network medical deductible',
      monthly: { label: 'This month', sublabel: `Claims processed in ${MONTHS[Number(ms) - 1]}`, ...monthly },
      ytd: { label: 'Year to date', sublabel: `January 1 through ${longDate(period.end)}`, ...ytdBase },
    },
    paymentSummary, claims, notes, hasDenial: false,
    _groundTruthErrors: groundTruthErrors,
    _fieldPaths: MA_FIELD_PATHS,
    _groundTruth: { payer: { name: stock.payer.legalName, planType: 'Medicare Advantage PPO', planName: plan.name }, claims: maClaimModel(ma.claims, claims), identifiers: { memberId: beneficiary.memberId, ...Object.fromEntries(claims.map((c, i) => [`claimNumber[${i}]`, c.claimNumber])) } },
  };
}

export function assembleHmoEob({ rng, beneficiary, adjudicated, period, dateOfNotice, year, stock, groundTruthErrors, catalogByCode }) {
  const plan = PLANS['hmo-eob']; assertNoMutations(groundTruthErrors, 'hmo-eob');
  const enriched = adjudicated.claims.map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, category: catalogByCode[l.code]?.category || 'visit' })) }));
  const [, ms0] = period.start.split('-'); const ma = adjudicateMa(enriched, plan, { oopUsedBefore: Number(ms0) === 1 ? 0 : r2(rng() * 100 * (Number(ms0) - 1)), deductibleMetBefore: 0 });
  const notes = []; const noteIds = {};
  const addNote = (id, text) => { if (!noteIds[id]) { noteIds[id] = true; notes.push({ id, text }); } return id; };
  const claims = ma.claims.map((c) => ({
    providerName: c.provider.nameUpper, networkStatus: 'Plan provider', claimNumber: claimNumber(rng, 'ma'), section: 'medical',
    lineItems: c.lines.map((l) => { const [id, text] = noteFor(l, plan); addNote(id, text); return {
      description: l.lay, dateOfService: shortDate(l.dateOfService), billingCode: l.code, providersCharged: l.charged, planApproved: l.approved,
      amountPlanPaid: l.planShare, maxYouMayBeBilled: l.yourShare, notes: [id] }; }),
    claimTotal: { providersCharged: c.totals.charged, planApproved: c.totals.approved, amountPlanPaid: c.totals.planShare, maxYouMayBeBilled: c.totals.yourShare },
  }));
  const monthly = claims.reduce((t, c) => ({ providersCharged: r2(t.providersCharged + c.claimTotal.providersCharged), planApproved: r2(t.planApproved + c.claimTotal.planApproved), amountPlanPaid: r2(t.amountPlanPaid + c.claimTotal.amountPlanPaid), maxYouMayBeBilled: r2(t.maxYouMayBeBilled + c.claimTotal.maxYouMayBeBilled) }), { providersCharged: 0, planApproved: 0, amountPlanPaid: 0, maxYouMayBeBilled: 0 });
  const priorMonths = Number(period.start.split('-')[1]) - 1; const priorFactor = priorMonths * (0.5 + rng() * 0.8);
  const priorYour = r2(ma.oopUsed - monthly.maxYouMayBeBilled);
  const priorApproved = r2(Math.max(monthly.planApproved * priorFactor, priorYour * 1.5));
  const ytd = { providersCharged: r2(monthly.providersCharged + priorApproved * (monthly.providersCharged / Math.max(monthly.planApproved, 0.01))),
    planApproved: r2(monthly.planApproved + priorApproved), amountPlanPaid: r2(monthly.amountPlanPaid + priorApproved - priorYour), maxYouMayBeBilled: r2(monthly.maxYouMayBeBilled + priorYour) };
  const [ys, ms] = period.start.split('-');
  return {
    carrier: 'hmo-eob', scenario: null,
    metadata: {
      documentId: `SPEC-${digits(rng, 8)}-${ys}${ms}`, dateOfNotice: longDate(dateOfNotice), memberName: beneficiary.nameUpper, memberId: beneficiary.memberId, planName: plan.name,
      memberAddress: beneficiary.addressLines, processingPeriod: { start: longDate(period.start), end: longDate(period.end), month: MONTHS[Number(ms) - 1], year: ys },
      issuer: { name: stock.payer.legalName, address: stock.payer.address.slice(1), phone: stock.payer.phone, tty: stock.payer.tty, hours: stock.payer.hours, fax: stock.payer.fax ?? null, website: stock.payer.website },
    },
    financialSummary: { oopAsOfDate: longDate(period.end), oopMax: plan.oopMax, oopUsed: ma.oopUsed,
      monthly: { label: 'This month', sublabel: `Claims processed in ${MONTHS[Number(ms) - 1]} ${ys}`, ...monthly },
      ytd: { label: 'Year to date', sublabel: `January 1 through ${longDate(period.end)}`, ...ytd } },
    claims, notes, hasDenial: false,
    _groundTruthErrors: groundTruthErrors,
    _fieldPaths: MA_FIELD_PATHS,
    _groundTruth: { payer: { name: stock.payer.legalName, planType: 'Medicare Advantage HMO', planName: plan.name }, claims: maClaimModel(ma.claims, claims), identifiers: { memberId: beneficiary.memberId, ...Object.fromEntries(claims.map((c, i) => [`claimNumber[${i}]`, c.claimNumber])) } },
  };
}
