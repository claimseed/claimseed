// itemized-bill.js — assemble the data object the `itemized-bill` layout renders (templates/itemized-bill/*.html,
// paginated by paginateForItemizedBill in render.js) from the same synthetic beneficiary + adjudicated claims the
// MSN is built from. This is the PROVIDER's side of the same month: one fictional hospital outpatient department
// bills every claim as a department ("revenue code") group, shows what Medicare approved and paid, and asks the
// patient for the balance. Field names below are the contract the templates and paginator read.
//
// Data contract (read by templates/itemized-bill/* and paginateForItemizedBill):
//   metadata: { hospitalName, hospitalAddress, hospitalCityStateZip, hospitalPhone, billingPhone, taxId, websiteUrl,
//               financialAssistanceUrl, statementDate, accountNumber, claimNumber?, patientName, admissionDate,
//               dischargeDate, lengthOfStay, attendingPhysician, admittingDiagnosis, admissionType?, insurance,
//               medicareNumber, medigap, secondaryCoverage?, serviceDateRange, titleOverride?, pageCount }
//   revenueCodeGroups: [{ revCode, description, subtotal, lineItems: [{ hcpcs, description, date, amount, units }] }]
//   grandTotal
//   insuranceSummary: { totalCharges, medicareApproved, medicarePaid, deductibleApplied, deductibleNote?, coinsurance, balanceDue }
//   paymentOptions: { online, phone, mail: { payableTo, address, cityStateZip }, referenceAccount }
//   agingSummary: { current, days30, days60, days90plus, total }
//   observationNotice: { show, ... }    financialAssistance: { show, text }
import { accountNumber, digits, phone555, syntheticNpi } from './identifiers.js';
import { intBetween, pickOne } from './rng.js';
import { FACILITY_PARTS, STREET_NAMES } from './lexicon.js';
import { providerName } from './entities.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function longDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; }
function shortDate(iso) { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const r2 = (x) => Math.round(x * 100) / 100;

// Department grouping by the specialty of the claim. Revenue-code CATEGORIES (first three digits) are the public
// UB-04 groupings a hospital statement is organized by (CMS Claims Processing Manual ch. 25 §75.4 refers to
// laboratory as 0300–0319); the descriptions are claimseed's own plain language.
const DEPARTMENTS = {
  LAB: { revCode: '0300', description: 'Laboratory' },
  RAD: { revCode: '0320', description: 'Radiology – Diagnostic Imaging' },
  PT: { revCode: '0420', description: 'Physical Therapy' },
  CARD: { revCode: '0730', description: 'Cardiology – Electrocardiogram and Clinic' },
  FP: { revCode: '0771', description: 'Preventive Care Services' },
  IM: { revCode: '0510', description: 'Clinic – Internal Medicine' },
  DERM: { revCode: '0510', description: 'Clinic – Dermatology' },
  OPH: { revCode: '0510', description: 'Clinic – Ophthalmology' },
};
function department(code) { return DEPARTMENTS[code] || { revCode: '0510', description: 'Clinic' }; }

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

export function assembleItemizedBill({ rng, beneficiary, adjudicated, period, dateOfNotice, year, groundTruthErrors }) {
  const place = beneficiary.place;
  // The fictional facility. The ".example" top-level domain is reserved for documentation (RFC 2606) and can never
  // resolve; the tax ID prefix 00 is not issued by the IRS, so a specimen EIN is recognizable on sight.
  const hospitalName = `${pickOne(rng, FACILITY_PARTS.prefix)} ${pickOne(rng, ['Medical Center', 'Community Hospital'])}`;
  const domain = `www.${slugify(hospitalName)}.example`;
  const hospital = {
    name: hospitalName, npi: syntheticNpi(rng),
    street: `${intBetween(rng, 100, 9899)} ${pickOne(rng, STREET_NAMES)}`,
    cityStateZip: `${place.city}, ${place.state} ${place.zip}`,
    phone: phone555(rng, place.areaCode), billingPhone: phone555(rng, place.areaCode),
    taxId: `00-${digits(rng, 7)}`,
  };
  const attending = providerName(rng);
  const acct = accountNumber(rng);
  const statementDate = addDays(dateOfNotice, intBetween(rng, 10, 20));

  const claims = adjudicated.claims;
  const revenueCodeGroups = claims.map((c) => {
    const dept = department(c.provider.specialtyCode);
    return {
      revCode: dept.revCode, description: dept.description,
      lineItems: c.lines.map((l) => ({
        date: shortDate(l.dateOfService), hcpcs: l.code, units: l.units,
        description: l.lay + (l.approved ? '' : ' (not covered by Medicare)'),
        amount: l.charged,
      })),
      subtotal: c.totals.charged, // from claim totals, so break-claim-total on `charged` makes a subtotal disagree with its lines
    };
  });
  const lineChargeSum = r2(claims.reduce((s, c) => s + c.lines.reduce((t, l) => t + l.charged, 0), 0));
  const totals = claims.reduce((t, c) => {
    for (const k of ['allowed', 'paid', 'toDeductible', 'coinsurance', 'patientMayBeBilled', 'providerBilled']) t[k] = r2((t[k] || 0) + c.totals[k]);
    return t;
  }, {});
  const deniedCharges = r2(claims.reduce((s, c) => s + c.lines.filter((l) => !l.approved).reduce((t, l) => t + l.charged, 0), 0));

  const dates = claims.map((c) => c.dateOfService).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const insuranceSummary = {
    totalCharges: lineChargeSum,
    medicareApproved: totals.allowed,
    medicarePaid: totals.paid,
    deductibleApplied: totals.toDeductible,
    deductibleNote: deniedCharges > 0
      ? `Balance due includes $${deniedCharges.toFixed(2)} for services Medicare did not cover`
      : (totals.toDeductible > 0 ? `Part B deductible for ${year} is $${adjudicated.params.partB.deductible.toFixed(2)}` : null),
    coinsurance: totals.coinsurance,
    balanceDue: totals.providerBilled,
  };

  return {
    carrier: 'itemized-bill', scenario: null,
    metadata: {
      hospitalName: hospital.name, hospitalAddress: hospital.street, hospitalCityStateZip: hospital.cityStateZip,
      hospitalPhone: hospital.phone, billingPhone: hospital.billingPhone, taxId: hospital.taxId,
      websiteUrl: domain, financialAssistanceUrl: `${domain}/financial-assistance`,
      statementDate: longDate(statementDate), accountNumber: acct,
      claimNumber: null,
      patientName: beneficiary.name,
      admissionDate: shortDate(first), dischargeDate: shortDate(last), lengthOfStay: 'outpatient, no overnight stay',
      attendingPhysician: attending,
      admittingDiagnosis: 'Not printed on itemized statements; available on request',
      admissionType: 'Outpatient',
      insurance: 'Medicare Part B (Original Medicare)', medicareNumber: beneficiary.mbi, medigap: 'None on file',
      serviceDateRange: first === last ? `Services on ${longDate(first)}` : `Services from ${longDate(first)} through ${longDate(last)}`,
    },
    revenueCodeGroups,
    grandTotal: lineChargeSum,
    insuranceSummary,
    paymentOptions: {
      online: `${domain}/pay — have your account number ready.`,
      phone: `${hospital.billingPhone}, Monday through Friday, 8 a.m. to 5 p.m.`,
      // the remittance address uses the impossible-street lexicon like every other generated address (never a real-looking P.O. Box)
      mail: { payableTo: hospital.name, address: `Billing Office, ${intBetween(rng, 100, 9899)} ${pickOne(rng, STREET_NAMES)}`, cityStateZip: hospital.cityStateZip },
      referenceAccount: acct,
    },
    agingSummary: { current: totals.providerBilled, days30: 0, days60: 0, days90plus: 0, total: totals.providerBilled },
    observationNotice: { show: false },
    financialAssistance: { show: true, text: 'If you cannot pay this balance, you may qualify for a discount or an interest-free payment plan under our financial assistance policy.' },
    _groundTruthErrors: groundTruthErrors,
    _fieldPaths: { line: (i, j) => `revenueCodeGroups[${i}].lineItems[${j}]`,
      totals: (i, field) => (field === 'charged' ? `revenueCodeGroups[${i}].subtotal` : `insuranceSummary.${({ allowed: 'medicareApproved', paid: 'medicarePaid', toDeductible: 'deductibleApplied', coinsurance: 'coinsurance', patientMayBeBilled: 'balanceDue', providerBilled: 'balanceDue' })[field] || field}`) },
    _groundTruth: {
      providers: [{ name: hospital.name, npi: hospital.npi, specialty: 'Hospital outpatient department', address: `${hospital.street}, ${hospital.cityStateZip}`, participating: true }],
      identifiers: { mbi: beneficiary.mbi, accountNumber: acct },
      payer: { name: 'Medicare', planType: 'Original Medicare Part B' },
    },
  };
}
