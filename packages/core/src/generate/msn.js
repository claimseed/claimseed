// msn.js — assemble the Medicare Summary Notice (Part B) data object the `msn` layout renders,
// from a synthetic beneficiary + adjudicated claims. Field names match templates/msn/*.html.
import { claimNumber } from './identifiers.js';
import { intBetween } from './rng.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function longDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; }
function shortDate(iso) { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const r2 = (x) => Math.round(x * 100) / 100;

// Standard MSN note texts are CMS language; claimseed's wording here is its own paraphrase keyed by situation.
const NOTE_TEXT = {
  deductible: 'This amount was applied to your Part B deductible.',
  labNoCostShare: 'Medicare covers this laboratory test in full; you do not owe a deductible or coinsurance for it.',
  preventive: 'This is a covered preventive service. You pay nothing when a provider who accepts assignment furnishes it.',
  denied: (reason) => reason,
};

export function assembleMsn({ rng, beneficiary, adjudicated, period, dateOfNotice, year, groundTruthErrors }) {
  const notes = []; const noteByKey = {};
  const letterFor = (key, text) => {
    if (!noteByKey[key]) { const letter = String.fromCharCode(65 + notes.length); noteByKey[key] = letter; notes.push({ letter, text }); }
    return noteByKey[key];
  };
  const providersSeen = new Map();
  const claims = adjudicated.claims.map((c) => {
    const lineItems = c.lines.map((l) => {
      const letters = [];
      if (l.toDeductible > 0) letters.push(letterFor('ded', NOTE_TEXT.deductible));
      if (l.labNoCostShare && l.approved) letters.push(letterFor('lab', NOTE_TEXT.labNoCostShare));
      if (l.preventiveNoCostShare && l.approved) letters.push(letterFor('prev', NOTE_TEXT.preventive));
      if (!l.approved) letters.push(letterFor('deny:' + (l.denialNote?.text || 'x'), NOTE_TEXT.denied(l.denialNote?.text || 'This service was denied.')));
      return {
        dateOfService: shortDate(l.dateOfService), cptCode: l.code, description: l.lay + (l.units > 1 ? ` (${l.units} units)` : ''),
        serviceApproved: l.approved ? 'YES' : 'NO', amountProviderCharged: l.charged, medicareApprovedAmount: l.allowed,
        amountMedicarePaid: l.paid, maxYouMayBeBilled: l.patientMayBeBilled, noteLetters: letters,
      };
    });
    // the provider's date range covers its claims and any service a decoy repeated on another date
    const ds = [c.dateOfService, ...c.lines.filter((l) => l.addedByDecoy).map((l) => l.dateOfService)];
    const dr = providersSeen.get(c.provider.name) || { first: ds[0], last: ds[0] };
    for (const d of ds) { if (d < dr.first) dr.first = d; if (d > dr.last) dr.last = d; }
    providersSeen.set(c.provider.name, dr);
    return {
      providerName: c.provider.nameUpper, providerPhone: c.provider.phone, providerAddress: c.provider.addressLines.join(', '),
      referredBy: c.referredBy || null, claimNumber: claimNumber(rng, 'msn'), lineItems,
      claimTotal: { amountProviderCharged: c.totals.charged, medicareApprovedAmount: c.totals.allowed, amountMedicarePaid: c.totals.paid, maxYouMayBeBilled: c.totals.patientMayBeBilled },
    };
  });
  const deniedCount = adjudicated.claims.reduce((n, c) => n + c.lines.filter((l) => !l.approved).length, 0);
  const totalBilled = r2(claims.reduce((s, c) => s + c.claimTotal.maxYouMayBeBilled, 0));
  const providers = [...providersSeen.entries()].map(([name, dr]) => ({ name: name.toUpperCase(), dateRange: dr.first === dr.last ? shortDate(dr.first) : `${shortDate(dr.first)} – ${shortDate(dr.last)}` }));
  return {
    carrier: 'msn', scenario: null,
    metadata: {
      memberName: beneficiary.nameUpper, memberAddress: beneficiary.addressLines, medicareNumber: beneficiary.mbi,
      dateOfNotice: longDate(dateOfNotice), processingPeriod: { start: longDate(period.start), end: longDate(period.end) },
      appealDeadline: longDate(addDays(dateOfNotice, 120)), qmbIndicator: beneficiary.qmb ? 'Yes' : null,
    },
    deductible: { annual: adjudicated.params.partB.deductible, met: r2(Math.min(adjudicated.params.partB.deductible, (adjudicated.deductibleMetBefore || 0) + adjudicated.claims.reduce((s, c) => s + c.lines.reduce((t, l) => t + (l.toDeductible || 0), 0), 0))), year },
    summary: { totalYouMayBeBilled: totalBilled, deniedCount, allServicesApproved: deniedCount === 0 ? 'YES' : 'NO' },
    providers, claims, notes,
    _groundTruthErrors: groundTruthErrors,
    _fieldPaths: { line: (i, j) => `claims[${i}].lineItems[${j}]`,
      totals: (i, field) => `claims[${i}].claimTotal.${({ charged: 'amountProviderCharged', allowed: 'medicareApprovedAmount', paid: 'amountMedicarePaid', patientMayBeBilled: 'maxYouMayBeBilled' })[field] || field}` },
  };
}
