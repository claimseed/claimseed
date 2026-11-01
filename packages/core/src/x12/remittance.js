// remittance.js — an X12 005010X221A1 835 (health care claim payment/advice) written from the same claims as a
// Medicare Summary Notice or a Medicare Advantage EOB, as a synthetic test specimen.
//
// What the file is: remittance information only (BPR01 I) for a fictional check (BPR04 CHK), with no bank routing or
// account numbers (BPR05-BPR15 empty); a transaction whose claims pay nothing uses BPR01 H, BPR04 NON and a $0 total.
// One interchange and one functional group per file, one transaction per payee (provider NPI). Every file is marked:
// ISA15 is T (test), and the sender and receiver IDs, the payer's name and address and the technical contact come
// from data/x12/specimen-strings.json, all of which say specimen or test. Code values only: claim adjustment group
// codes CO, OA and PR with reason codes 1 (deductible), 2 (coinsurance), 3 (copay), 45 (charge above the approved
// amount) and 50 (not medically necessary); no code descriptions, no remark codes, no sequestration adjustment, no
// provider-level adjustments.
//
// The values are the document's own: charged, approved, paid and the patient's share per line and per claim, as the
// PDF prints them and as the answer key's claims block records them, so a planted error shows in the 835 where the
// PDF shows it (a wrong patient total is a CLP05 that differs from the claim's PR adjustments; a wrong charged or
// paid total fails the claim balance; a duplicate is a repeated paid service line). Values the PDF does not carry
// (control numbers, check and patient control numbers, payer ID, tax IDs) come from a stream of their own, so the
// document itself never changes.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { makeRng } from '../generate/rng.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPECIMEN_STRINGS = JSON.parse(fs.readFileSync(path.join(here, '../../data/x12/specimen-strings.json'), 'utf-8'));
export const REMITTANCE_TYPES = ['msn', 'ppo-eob', 'hmo-eob'];
const CLAIM_FILING = { msn: 'MB', 'ppo-eob': '16', 'hmo-eob': '16' };
export const DELIMITERS = { element: '*', repetition: '^', component: '>', segment: '~' };
const FORBIDDEN = /[*^>~]/;

const cents = (v) => Math.round(Number(v) * 100);
// an amount in X12's decimal form, from integer cents: no trailing zeros, no decimal point for whole dollars
export function amount(c) {
  const neg = c < 0; const a = Math.abs(c); const whole = Math.floor(a / 100); const frac = a % 100;
  const s = frac === 0 ? String(whole) : frac % 10 === 0 ? `${whole}.${frac / 10}` : `${whole}.${String(frac).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
const digits = (rng, n) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
const nonZero = (rng, n) => { let s; do s = digits(rng, n); while (/^0+$/.test(s)); return s; };
const ymd = (iso) => iso.replace(/-/g, '');
const clean = (s) => { const v = String(s).toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim(); if (FORBIDDEN.test(v)) throw new Error('remittance: a value holds an X12 delimiter'); return v; };

// Split a printed person name ("Geraldine I. Carrasco") into last, first and middle.
function personName(name) {
  const t = clean(name).split(' ');
  return { last: t[t.length - 1], first: t[0], middle: t.length > 2 ? t.slice(1, -1).join(' ') : '' };
}

// Build the 835 for a generated document. `generated` is generateData()'s result; returns { text, document, x12Refs }:
// the file, its answer-key entry (documents[1]) and, per error index, where the error sits in the file (or null).
export function buildRemittance({ type, scenario, seed, generated }) {
  if (!REMITTANCE_TYPES.includes(type)) throw new Error(`remittance: no 835 for ${type}; types: ${REMITTANCE_TYPES.join(', ')}`);
  const { data, groundTruth: gt } = generated;
  const rng = makeRng(seed, type, scenario, '835');
  const S = SPECIMEN_STRINGS; const sep = DELIMITERS.element; const end = DELIMITERS.segment;
  const date = data._dateOfNotice; if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('remittance: the document has no notice date');
  const doc = gt.documents[0]; const providers = doc.entities.providers; const ids = doc.entities.identifiers;
  const patient = personName(doc.entities.patient.name); const patientId = ids.mbi || ids.memberId;
  // control numbers and identifiers of the file, from the file's own stream
  const isa13 = nonZero(rng, 9); const gs06 = String(1 + Math.floor(rng() * 999999));
  const payer = { id: `CS${digits(rng, 5)}`, taxId: `00${digits(rng, 7)}`, name: clean(S.payerNames[type]) };
  // group the claims by payee NPI, in the document's order
  const groups = []; const byNpi = new Map();
  gt.claims.forEach((claim, i) => {
    const p = providers[i]; if (!p) throw new Error(`remittance: claims[${i}] has no provider`);
    if (!byNpi.has(p.npi)) { const g = { provider: p, claims: [] }; byNpi.set(p.npi, g); groups.push(g); }
    byNpi.get(p.npi).claims.push(i);
  });
  const segments = []; const seg = (...els) => { const s = els.join(sep).replace(/\*+$/, ''); segments.push(s); return s; };
  const where = {}; const transactions = [];
  seg('ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', S.interchangeSenderId.padEnd(15), 'ZZ', S.interchangeReceiverId.padEnd(15),
    ymd(date).slice(2), '1200', DELIMITERS.repetition, '00501', isa13, '0', 'T', DELIMITERS.component);
  seg('GS', 'HP', S.interchangeSenderId, S.interchangeReceiverId, ymd(date), '1200', gs06, 'X', '005010X221A1');
  groups.forEach((g, t) => {
    const st02 = String(t + 1).padStart(4, '0'); const start = segments.length;
    const paid = g.claims.reduce((s, i) => s + cents(gt.claims[i].totals.paid), 0);
    const handling = paid > 0 ? 'I' : 'H'; const method = paid > 0 ? 'CHK' : 'NON';
    const trace = `CS${digits(rng, 8)}`; const payeeTaxId = `00${digits(rng, 7)}`;
    seg('ST', '835', st02);   // the 835 has no ST03
    // BPR05 to BPR15 empty: a check, or no payment at all, carries no bank routing or account numbers
    seg('BPR', handling, amount(paid), 'C', method, '', '', '', '', '', '', '', '', '', '', '', ymd(date));
    seg('TRN', '1', trace, `1${payer.taxId}`);
    seg('DTM', '405', ymd(date));
    seg('N1', 'PR', payer.name, 'XV', payer.id);
    seg('N3', clean(S.payerAddress.line1));
    seg('N4', clean(S.payerAddress.city), S.payerAddress.state, S.payerAddress.zip);
    seg('PER', 'BL', clean(S.technicalContactName), 'TE', S.technicalContactPhone);
    seg('N1', 'PE', clean(g.provider.name), 'XX', g.provider.npi);
    seg('REF', 'TJ', payeeTaxId);
    seg('LX', '1');
    g.claims.forEach((i, k) => {
      const c = gt.claims[i]; const clp = `${st02}:CLP${k + 1}`;
      where[`claims[${i}]`] = clp;
      // claim amounts as the document prints them (a planted totals error stays where the PDF has it)
      // claim status: processed as primary, or denied when every line is
      seg('CLP', `CS${digits(rng, 10)}`, c.lines.every((l) => !l.approved) ? '4' : '1', amount(cents(c.totals.charged)), amount(cents(c.totals.paid)), amount(cents(c.totals.patientMayBeBilled)),
        CLAIM_FILING[type], c.claimNumber);
      seg('NM1', 'QC', '1', patient.last, patient.first, patient.middle, '', '', 'MI', patientId);
      c.lines.forEach((l, j) => {
        where[`claims[${i}].lines[${j}]`] = `${clp}:SVC${j + 1}`;
        const charged = cents(l.charged), allowed = cents(l.allowed), linePaid = cents(l.paid ?? 0);
        seg('SVC', `HC${DELIMITERS.component}${l.code}`, amount(charged), amount(linePaid), '', String(l.units));
        seg('DTM', '472', ymd(l.dateOfService));
        if (!l.approved) {
          // denied as not medically necessary: the patient's liability when the notice says they may be billed
          seg('CAS', cents(l.nonCovered) > 0 ? 'PR' : 'CO', '50', amount(charged));
        } else {
          if (charged > allowed) seg('CAS', 'CO', '45', amount(charged - allowed));
          const pr = [['1', l.toDeductible], ['2', l.coinsurance], ['3', l.copay]].filter(([, v]) => cents(v) > 0);
          if (pr.length) seg('CAS', 'PR', ...pr.flatMap(([code, v]) => [code, amount(cents(v)), '']));
        }
        seg('AMT', 'B6', amount(allowed));
      });
    });
    seg('SE', String(segments.length - start + 1), st02);
    transactions.push({ controlNumber: st02, payeeNpi: g.provider.npi, payeeTaxId, traceNumber: trace, paymentAmount: paid / 100, handlingCode: handling, paymentMethod: method });
  });
  seg('GE', String(groups.length), gs06);
  seg('IEA', '1', isa13);
  // a CAS triplet's empty quantity is dropped only at the end of a segment; inside it the separators stay
  const text = segments.map((s) => s + end).join('\n') + '\n';
  // where each error sits: a claim total names its CLP element, a line names its service line
  const TOTAL_ELEMENT = { charged: 'CLP03', paid: 'CLP04', patientMayBeBilled: 'CLP05' };
  const x12Refs = gt.errors.map((e) => {
    const m = /^(claims\[\d+\])\.totals\.(\w+)$/.exec(e.lineRef || '');
    if (m) return TOTAL_ELEMENT[m[2]] && where[m[1]] ? `${where[m[1]]}:${TOTAL_ELEMENT[m[2]]}` : null;
    return where[e.lineRef] || null;
  });
  const document = { id: 'remittance-1', type: 'x12-835', layout: 'x12-835', pages: null, format: 'x12', degradation: null, degradationParams: null,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), fields: {}, entities: { identifiers: { isa13 } }, transactions, payer };
  return { text, document, x12Refs };
}

// The 835 of a document and the document's answer key with the 835 added: documents[1] and, on each error the 835
// carries, x12Ref. `generated` may be passed when the caller already has generateData's result.
export async function remittanceFor({ type, scenario, seed = 'claimseed', generated = null }) {
  const g = generated || (await import('../generate/index.js')).generateData({ type, scenario, seed });
  const { text, document, x12Refs } = buildRemittance({ type, scenario, seed, generated: g });
  const groundTruth = JSON.parse(JSON.stringify(g.groundTruth));
  groundTruth.documents.push(document);
  groundTruth.errors.forEach((e, i) => { e.x12Ref = x12Refs[i]; });
  return { text, groundTruth };
}
