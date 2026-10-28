// rules.js — Original Medicare Part B adjudication for a participating provider.
// Billed charge = allowed × a provider markup (providers bill above the fee schedule; Medicare pays on
// the allowed amount). Deductible applies to MPFS services, not to CLFS lab tests or $0 preventive services.
// Sources: SSA §1833(a)(1), (b); CMS annual parameters file.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ANNUAL = JSON.parse(fs.readFileSync(path.join(__dirname, '../../reference-data/cms-annual-parameters.json'), 'utf-8'));
const r2 = (x) => Math.round(x * 100) / 100;

export function adjudicatePartB(claims, { year, deductibleMetBefore = 0, markup = (rng) => 1.6 + rng() * 1.4, rng }) {
  const params = ANNUAL.years[String(year)];
  if (!params) throw new Error(`no CMS parameters for ${year}`);
  let deductibleRemaining = r2(Math.max(0, params.partB.deductible - deductibleMetBefore));
  const out = [];
  for (const claim of claims) {
    const lines = claim.lines.map((ln) => {
      const allowed = r2(ln.allowedEach * ln.units);
      const charged = r2(allowed * markup(rng));
      let toDeductible = 0, coinsurance = 0, paid = 0;
      if (ln.preventiveNoCostShare) { paid = allowed; }
      else if (ln.labNoCostShare) { paid = allowed; }
      else {
        toDeductible = r2(Math.min(deductibleRemaining, allowed));
        deductibleRemaining = r2(deductibleRemaining - toDeductible);
        coinsurance = r2((allowed - toDeductible) * params.partB.coinsuranceRate);
        paid = r2(allowed - toDeductible - coinsurance);
      }
      return { ...ln, charged, allowed, toDeductible, coinsurance, paid, patientMayBeBilled: r2(toDeductible + coinsurance), approved: true };
    });
    out.push({ ...claim, lines, totals: sum(lines) });
  }
  return { claims: out, deductibleMet: r2(params.partB.deductible - deductibleRemaining), deductibleMetBefore: r2(deductibleMetBefore), params };
}
/** Claim totals. `providerBilled` is what the provider's own paperwork asks the patient for: equal to
 *  patientMayBeBilled unless a mutation (bill-above-approved) set `providerBilledPatient` on a line. */
export function sum(lines) {
  const t = { charged: 0, allowed: 0, paid: 0, toDeductible: 0, coinsurance: 0, patientMayBeBilled: 0, providerBilled: 0 };
  for (const l of lines) {
    t.charged += l.charged; t.allowed += l.allowed; t.paid += l.paid; t.toDeductible += l.toDeductible; t.coinsurance += l.coinsurance;
    t.patientMayBeBilled += l.patientMayBeBilled; t.providerBilled += l.providerBilledPatient ?? l.patientMayBeBilled;
  }
  for (const k in t) t[k] = r2(t[k]);
  return t;
}
