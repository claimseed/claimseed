// commercial-checker.js — a reader of the commercial EOB's printed fields alone (printedFields, the answer key's
// fields) that finds the six planted kinds by the rules a careful reviewer applies, with public lists only: the
// preventive visit, vaccine and vaccine administration codes, the specialties consent never waives and the No
// Surprises facility types, each as the page prints them. The decidability test runs it over every commercial
// scenario: it must find every planted error, no decoy, and nothing on a clean EOB.
import { SERVICES, NOT_WAIVABLE, NSA_FACILITIES } from '../../src/generate/commercial/adjudicate.js';
import { WELL_VISITS } from '../../src/generate/commercial-operations.js';

const PAGE_PREVENTIVE = new Set([...WELL_VISITS, 'vaccine-admin-adult', 'vaccine-admin-child', 'flu-vaccine'].map((id) => SERVICES[id].code));
const c = (x) => Math.round(x * 100);

/** printed: printedFields(data, text); text: the stock content. Returns [{ kind, fieldRef }] (fieldRef null: the document). */
export function checkCommercialPage(printed, text) {
  const out = []; const S = text.claim;
  const notWaivable = new Set([...NOT_WAIVABLE].map((s) => text.specialties[s]).filter(Boolean));
  const nsaPlaces = [...NSA_FACILITIES].map((t) => text.facilityTypes[t]).filter(Boolean);
  const ambulance = text.specialties.ambulance;
  const denialStart = (l) => `${l.code}: ${text.denial.reasonLabel}:`;
  let denied = false;
  printed.claims.forEach((claim, i) => {
    const inNet = claim.network === S.inNetwork; const emergency = claim.emergency === S.yes;
    const consentNote = claim.notes.includes(text.lineNotes.consent);
    const atNsaPlace = typeof claim.place === 'string' && claim.place.endsWith(`, ${S.inNetwork}`) && nsaPlaces.some((t) => claim.place.includes(`, ${t}, `));
    // the denial notes, in line order
    const denialNotes = claim.notes.map((n, k) => ({ n, k })).filter(({ n }) => claim.lineItems.some((l) => n.startsWith(denialStart(l))));
    let nextDenialNote = 0;
    claim.lineItems.forEach((l, j) => {
      const at = `claims[${i}].lineItems[${j}]`; const share = c(l.deductible) + c(l.copay) + c(l.coinsurance);
      const isDenied = ['PI', 'PO', 'VL'].includes(l.remark);
      if (isDenied) {
        denied = true;
        const note = denialNotes[nextDenialNote++];
        if (!note || !note.n.includes(`${text.denial.provisionLabel}:`)) out.push({ kind: 'missing-required-section', fieldRef: note ? `claims[${i}].notes[${note.k}]` : at });
        if (emergency && (l.remark === 'PI' || l.remark === 'PO')) out.push({ kind: 'emergency-authorization-denial', fieldRef: at });
        return;
      }
      // 1: in network, a covered line's member amount is its cost sharing (a not-covered amount comes only with a denial,
      // which returned above)
      if (inNet && c(l.youMayOwe) > share) out.push({ kind: 'in-network-balance-bill', fieldRef: at });
      // 3: a preventive visit, vaccine or administration in network costs nothing
      if (inNet && PAGE_PREVENTIVE.has(l.code) && share > 0) out.push({ kind: 'preventive-cost-sharing', fieldRef: at });
      // 2: out of network and protected by what the page shows (ground ambulance is outside the Act)
      if (!inNet && claim.specialty !== ambulance) {
        const waivable = !notWaivable.has(claim.specialty);
        const isProtected = emergency || (atNsaPlace && !(consentNote && waivable));
        if (isProtected && (l.remark !== 'NS' || c(l.youMayOwe) > share)) out.push({ kind: 'surprise-balance-bill', fieldRef: at });
      }
    });
  });
  printed.accumulators.forEach((r, k) => { if (c(r.yearToDate) !== c(r.before) + c(r.thisStatement)) out.push({ kind: 'math-error', fieldRef: `accumulators[${k}]` }); });
  if (denied && !printed.sections.appeal) out.push({ kind: 'missing-required-section', fieldRef: null });
  return out;
}
