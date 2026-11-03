// check835.js — claimseed's own reader and checker for the 835 files it writes (remittance.js): the envelope, the
// balancing rules, the duplicate check, the specimen markers, the free-text allow-list and the synthetic
// identifiers. It reads only claimseed's delimiters (* ^ > ~) and returns findings; the tests treat it as the source
// of truth and an independent open-source parser as a second reader.
import { SPECIMEN_STRINGS } from './remittance.js';

const cents = (v) => Math.round(Number(v) * 100);
// The text of an 835 as given: a string, or bytes read as UTF-8. Anything else is no text at all: it is never
// converted, so no method of the caller's value runs, and an empty file gives its findings.
function asText(v) {
  if (typeof v === 'string') return v;
  try { return ArrayBuffer.isView(v) ? new TextDecoder().decode(v) : ''; } catch { return ''; }
}
export function parse835(text) {
  const segs = asText(text).split('~').map((s) => s.replace(/^[\r\n]+/, '')).filter((s) => s.length);
  return segs.map((s) => s.split('*'));
}
// a terminator with no segment before it, which parse835 drops (the writer never writes one)
const emptySegment = (text) => asText(text).split('~').slice(0, -1).some((p) => !p.replace(/^[\r\n]+/, '').length);

// The amounts, codes and dates the balancing below reads, by segment and element: an empty or free-text value there
// would count as zero (or match nothing), so it is a finding of its own ('element'), whatever the arithmetic gives.
// an amount as X12 writes it: no leading zero, no negative zero, at most two decimals
const AMOUNT = /^(?!-0(\.0{1,2})?$)-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/; const DATE8 = /^[0-9]{8}$/;
const READ = { BPR: { 1: /^[IH]$/, 2: AMOUNT, 4: /^(CHK|NON)$/ }, CLP: { 3: AMOUNT, 4: AMOUNT, 5: AMOUNT },
  SVC: { 1: /^HC>[0-9A-Z]{5}$/, 2: AMOUNT, 3: AMOUNT }, AMT: { 1: /^B6$/, 2: AMOUNT }, DTM472: { 2: DATE8 } };
// the segments a transaction holds, by where they stand: its header; a claim before its first service (the patient,
// the claim's own adjustments); a service (its date, adjustments and allowed amount, or the next service or claim)
const TX_HEADER = new Set(['BPR', 'TRN', 'DTM', 'N1', 'N3', 'N4', 'PER', 'REF', 'LX']);
const IN_CLAIM = new Set(['CLP', 'NM1', 'CAS', 'SVC']);
const IN_SERVICE = new Set(['CLP', 'SVC', 'DTM', 'CAS', 'AMT']);
const CAS_GROUP = /^(CO|OA|PR)$/; const CAS_REASON = /^[0-9A-Z]{1,5}$/;
// a CAS: its group, then one to six adjustments of reason and amount (a quantity, when written, is empty)
function casProblems(s) {
  const out = []; if (!CAS_GROUP.test(s[1] ?? '')) out.push('CAS01');
  const n = Math.max(1, Math.ceil((s.length - 2) / 3));
  for (let k = 0; k < n; k++) { const i = 2 + 3 * k; if (!CAS_REASON.test(s[i] ?? '')) out.push(`CAS${String(i).padStart(2, '0')}`); if (!AMOUNT.test(s[i + 1] ?? '')) out.push(`CAS${String(i + 1).padStart(2, '0')}`); }
  return out;
}
const readProblems = (s, key) => Object.entries(READ[key]).filter(([i, re]) => !re.test(s[i] ?? '')).map(([i]) => `${key.slice(0, 3)}${String(i).padStart(2, '0')}`);

// Envelope and balancing. Returns { findings: [{ check, ref }], transactions } where ref names the element or
// service line (<ST02>:CLP<n>:CLP0x or <ST02>:CLP<n>:SVC<n>), a claim's own adjustments (<ST02>:CLP<n>:CAS), or the
// envelope segment. A planted wrong total gives one finding at its element; a line out of balance also shows in the
// claim total it feeds, since the file alone cannot tell which of the two is wrong. An amount, code or date the
// balancing reads that is empty or not in its form is an 'element' finding at that element (<ST02>:BPR0x,
// <ST02>:CLP<n>:CLP0x, <ST02>:CLP<n>:CAS0x, <ST02>:CLP<n>:SVC<n>:<segment and element>). Any input, empty or cut
// short, gives findings rather than an exception.
export function check835(text) {
  const findings = []; const add = (check, ref) => findings.push({ check, ref });
  const raw = asText(text);
  if (!raw.startsWith('ISA') || raw.indexOf('~') !== 105) add('envelope', 'ISA: not 106 characters');
  // an empty or truncated file: no ISA, no IEA, or nothing between them, gives envelope findings and stops here
  const S = parse835(raw); const isa = S[0] || []; const iea = S[S.length - 1] || [];
  if (S.length < 4 || isa[0] !== 'ISA' || iea[0] !== 'IEA') { add('envelope', 'ISA/IEA'); return { findings, transactions: [] }; }
  if (!/~[\r\n]*$/.test(raw)) add('envelope', 'ISA/IEA');   // the IEA is terminated too; only line breaks follow it
  if (emptySegment(raw)) add('envelope', 'ISA/IEA');
  if (isa[15] !== 'T') add('envelope', 'ISA15 is not T');
  if (!/^[0-9]{9}$/.test(isa[13]) || /^0+$/.test(isa[13]) || iea[2] !== isa[13]) add('envelope', 'ISA13/IEA02');
  const gs = S[1]; const ge = S[S.length - 2];
  // counts and control numbers are digits only (a number written another way, ' 12' or '1.2e1', is not read as one)
  const COUNT = /^[1-9][0-9]{0,8}$/;
  if (gs[0] !== 'GS' || ge[0] !== 'GE' || !COUNT.test(gs[6] ?? '') || ge[2] !== gs[6] || gs[8] !== '005010X221A1') add('envelope', 'GS/GE');
  if (iea[1] !== '1') add('envelope', 'IEA01');
  const txs = []; let cur = null;
  for (let k = 2; k < S.length - 2; k++) {
    const s = S[k];
    if (s[0] === 'ST') {
      if (cur) add('envelope', `${cur.st02}:SE`);   // a transaction opened before the last one was closed
      cur = { st02: s[2], start: k, segs: [] }; txs.push(cur); if (s.length !== 3 || s[1] !== '835') add('envelope', `${s[2]}:ST`);
    }
    if (!cur) { add('envelope', `segment ${k} outside a transaction`); continue; }
    cur.segs.push(s);
    if (s[0] === 'SE') { if (s[2] !== cur.st02 || !COUNT.test(s[1] ?? '') || Number(s[1]) !== cur.segs.length) add('envelope', `${cur.st02}:SE`); cur = null; }
  }
  if (cur) add('envelope', `${cur.st02}:SE`);   // the last transaction has no SE before the GE
  if (!COUNT.test(ge[1] ?? '') || Number(ge[1]) !== txs.length) add('envelope', 'GE01');
  const transactions = [];
  for (const tx of txs) {
    const bpr = tx.segs.find((s) => s[0] === 'BPR') || [];
    for (const e of readProblems(bpr, 'BPR')) add('element', `${tx.st02}:${e}`);
    if (!/^[0-9]{4,9}$/.test(tx.st02) || /^0+$/.test(tx.st02)) add('envelope', `${tx.st02}:ST02`);
    if (bpr.slice(5, 16).some((v) => v)) add('payment', `${tx.st02}:BPR05-BPR15 not empty`);
    if (!((bpr[1] === 'I' && bpr[4] === 'CHK' && cents(bpr[2]) > 0) || (bpr[1] === 'H' && bpr[4] === 'NON' && cents(bpr[2]) === 0))) add('payment', `${tx.st02}:BPR`);
    if (!tx.segs.some((s) => s[0] === 'TRN')) add('payment', `${tx.st02}:TRN`);
    // claims and their service lines
    const claims = []; let claim = null; let svc = null;
    tx.segs.forEach((s, k) => {
      // where each segment may stand: the header before the first claim, then claims; a segment anywhere else (or one
      // the writer never writes) would be read as nothing, so it is a finding of its own
      const where = `${tx.st02}:segment ${k + 1}`;
      if (s[0] === 'ST' || s[0] === 'SE') return;
      if (!claim) { if (s[0] !== 'CLP' && !TX_HEADER.has(s[0])) add('envelope', where); }
      else if (!(svc ? IN_SERVICE : IN_CLAIM).has(s[0])) add('envelope', where);
      if (s[0] === 'CLP') { claim = { n: claims.length + 1, clp: s, svcs: [], cas: [] }; claims.push(claim); svc = null; }
      else if (s[0] === 'SVC' && claim) { svc = { n: claim.svcs.length + 1, svc: s, cas: [], dates: [], read: [] }; claim.svcs.push(svc); }
      else if (s[0] === 'CAS' && claim) (svc ? svc.cas : claim.cas).push(s);
      else if (s[0] === 'DTM' && svc) svc.dates.push(s);
      else if (s[0] === 'AMT' && svc) svc.read.push(...readProblems(s, 'AMT'));
    });
    if (!claims.length) add('envelope', `${tx.st02}:CLP`);   // a transaction pays or denies at least one claim
    // each service has one date of service (DTM*472) and no other date: the date selects the services the duplicate
    // check compares, so a missing date or another qualifier is a finding of its own rather than a service skipped
    for (const c of claims) for (const v of c.svcs) {
      const own = v.dates.filter((s) => s[1] === '472');
      if (own.length !== 1 || own.length !== v.dates.length) v.read.push('DTM01');
      for (const s of own) v.read.push(...readProblems(s, 'DTM472'));
      v.date = own.length === 1 && DATE8.test(own[0][2] ?? '') ? own[0][2] : null;
    }
    const casTotal = (list, group = null) => list.reduce((t, s) => { if (group && s[1] !== group) return t; for (let i = 2; i < s.length; i += 3) if (s[i]) t += cents(s[i + 1]); return t; }, 0);
    let paidSum = 0;
    for (const c of claims) {
      const ref = `${tx.st02}:CLP${c.n}`;
      for (const e of readProblems(c.clp, 'CLP')) add('element', `${ref}:${e}`);
      for (const s of c.cas) for (const e of casProblems(s)) add('element', `${ref}:${e}`);
      for (const v of c.svcs) for (const e of [...readProblems(v.svc, 'SVC'), ...v.cas.flatMap(casProblems), ...v.read]) add('element', `${ref}:SVC${v.n}:${e}`);
      const svcAdj = c.svcs.reduce((t, v) => t + casTotal(v.cas), 0);
      for (const v of c.svcs) if (cents(v.svc[2]) - casTotal(v.cas) !== cents(v.svc[3])) add('service-balance', `${ref}:SVC${v.n}`);
      const chargedSum = c.svcs.reduce((t, v) => t + cents(v.svc[2]), 0); const linePaid = c.svcs.reduce((t, v) => t + cents(v.svc[3]), 0);
      // a wrong total is reported at its own element only: the charged total against the lines' charges, the paid
      // total against the lines' payments. With both right and every line balanced, the claim's own adjustments
      // must close the equation.
      const chargedOk = cents(c.clp[3]) === chargedSum; const paidOk = cents(c.clp[4]) === linePaid;
      const linesOk = c.svcs.every((v) => cents(v.svc[2]) - casTotal(v.cas) === cents(v.svc[3]));
      if (!chargedOk) add('claim-balance', `${ref}:CLP03`);
      if (!paidOk) add('claim-balance', `${ref}:CLP04`);
      if (chargedOk && paidOk && linesOk && cents(c.clp[3]) - svcAdj - casTotal(c.cas) !== cents(c.clp[4])) add('claim-balance', `${ref}:CAS`);
      const pr = c.svcs.reduce((t, v) => t + casTotal(v.cas, 'PR'), 0) + casTotal(c.cas, 'PR');
      if (cents(c.clp[5]) !== pr) add('patient-responsibility', `${ref}:CLP05`);
      // the same service on the same date at the same charge, adjudicated twice (paid, or applied to the deductible)
      c.svcs.forEach((v, i) => { if (v.date && c.svcs.slice(0, i).some((u) => u.svc[1] === v.svc[1] && u.date === v.date && cents(u.svc[2]) === cents(v.svc[2]))) add('duplicate-service', `${ref}:SVC${v.n}`); });
      paidSum += cents(c.clp[4]);
    }
    if (cents(bpr[2]) !== paidSum) add('transaction-balance', `${tx.st02}:BPR02`);
    transactions.push({ st02: tx.st02, claims: claims.length, handling: bpr[1], method: bpr[4], payment: cents(bpr[2]) });
  }
  return { findings, transactions };
}

// The file the writer produces, exactly: these segments only, each with this many elements, the fixed values it
// always writes, the elements it never leaves empty, and the order of a transaction's segments.
const ELEMENTS = { ISA: 16, GS: 8, ST: 2, BPR: 16, TRN: 3, DTM: 2, N1: 4, N3: 1, N4: 3, PER: 4, REF: 2, LX: 1, CLP: 7, NM1: 9, SVC: 5, AMT: 2, SE: 2, GE: 2, IEA: 2 };
const FIXED = {
  ISA: { 1: '00', 2: ' '.repeat(10), 3: '00', 4: ' '.repeat(10), 5: 'ZZ', 7: 'ZZ', 10: '1200', 11: '^', 12: '00501', 14: '0', 16: '>' },
  GS: { 1: 'HP', 5: '1200', 7: 'X', 8: '005010X221A1' }, ST: { 1: '835' }, TRN: { 1: '1' }, LX: { 1: '1' }, REF: { 1: 'TJ' },
  PER: { 1: 'BL', 3: 'TE' }, NM1: { 1: 'QC', 2: '1', 6: '', 7: '', 8: 'MI' }, AMT: { 1: 'B6' },
};
const REQUIRED = { ISA: [6, 8, 9, 13, 15], GS: [2, 3, 4, 6], ST: [2], BPR: [1, 2, 3, 4, 16], TRN: [2, 3], DTM: [1, 2], N1: [1, 2, 3, 4], N3: [1], N4: [1, 2, 3],
  PER: [2, 4], REF: [2], CLP: [1, 2, 3, 4, 5, 6, 7], NM1: [3, 4, 9], SVC: [1, 2, 3, 5], AMT: [2], SE: [1, 2], GE: [1, 2], IEA: [1, 2] };
const token = (s) => (s[0] === 'DTM' || s[0] === 'N1' ? s[0] + s[1] : s[0]);
const TRANSACTION = /^ST BPR TRN DTM405 N1PR N3 N4 PER N1PE REF LX (CLP NM1 (SVC DTM472 (CAS ){0,2}AMT )+)+SE$/;
function shapeProblems(S, str) {
  const problems = [];
  for (const s of S) {
    if (s[0] === 'CAS') {
      // a group code, then up to six adjustments of reason, amount and an empty quantity (the last one's dropped)
      const n = s.length - 1;
      if (n < 3 || n > 18 || n % 3) { problems.push('CAS has an unexpected number of elements'); continue; }
      if (!s[1]) problems.push('CAS01 is empty');
      for (let i = 2; i <= n; i += 3) for (const k of [i, i + 1]) if (!s[k]) problems.push(`CAS${String(k).padStart(2, '0')} is empty`);
      continue;
    }
    if (!(s[0] in ELEMENTS)) { problems.push('file holds a segment the writer never writes'); continue; }
    if (s.length - 1 !== ELEMENTS[s[0]]) { problems.push(`${s[0]} has an unexpected number of elements`); continue; }
    for (const [i, v] of Object.entries(FIXED[s[0]] || {})) if (s[i] !== v) problems.push(`${s[0]}${String(i).padStart(2, '0')} does not hold its fixed value`);
    for (const i of REQUIRED[s[0]] || []) if (!s[i] || !s[i].trim()) problems.push(`${s[0]}${String(i).padStart(2, '0')} is empty`);
  }
  for (const s of S.filter((x) => x[0] === 'N1')) if (s[3] !== (s[1] === 'PR' ? 'XV' : 'XX') || !['PR', 'PE'].includes(s[1])) problems.push('N103 does not hold its fixed value');
  for (const s of S.filter((x) => x[0] === 'N3')) if (s[1] !== str.payerAddress.line1) problems.push('address not on the allow-list');
  for (const s of S.filter((x) => x[0] === 'N4')) {
    if (s[1] !== str.payerAddress.city) problems.push('city not on the allow-list');
    if (s[2] !== str.payerAddress.state) problems.push('N402 does not hold its fixed value');
    if (s[3] !== str.payerAddress.zip) problems.push('N403 does not hold its fixed value');
  }
  // the interchange: one ISA and GS, then transactions, then GE and IEA; each transaction in the writer's order
  const ids = S.map((s) => s[0]);
  if (ids[0] !== 'ISA' || ids[1] !== 'GS' || ids[ids.length - 2] !== 'GE' || ids[ids.length - 1] !== 'IEA' || ids.filter((x) => x === 'ISA' || x === 'GS' || x === 'GE' || x === 'IEA').length !== 4) problems.push("a transaction's segments are missing, extra or out of order");
  let cur = null;
  for (const s of S.slice(2, -2)) {
    if (s[0] === 'ST') { if (cur) problems.push("a transaction's segments are missing, extra or out of order"); cur = []; }
    if (!cur) { problems.push("a transaction's segments are missing, extra or out of order"); continue; }
    cur.push(token(s));
    if (s[0] === 'SE') { if (!TRANSACTION.test(cur.join(' '))) problems.push("a transaction's segments are missing, extra or out of order"); cur = null; }
  }
  if (cur) problems.push("a transaction's segments are missing, extra or out of order");
  return problems;
}

// Markers, the free-text allow-list and the identifier rules. `names` is the allowed free text besides the specimen
// strings: the payee and patient names the document prints. Returns a list of problems (empty when the file passes).
export function checkSpecimen835(text, options) {
  // the allowed names: strings in an array, read once; any other value allows none (and never throws)
  let names = []; try { const n = options?.names; if (Array.isArray(n)) names = n.filter((x) => typeof x === 'string'); } catch { names = []; }
  const S = parse835(text); const str = SPECIMEN_STRINGS; const problems = shapeProblems(S, str);
  if (!/~[\r\n]*$/.test(asText(text))) problems.push('file ends without a segment terminator');
  if (emptySegment(text)) problems.push("a transaction's segments are missing, extra or out of order");
  const get = (id, q) => S.filter((s) => s[0] === id && (q === undefined || s[1] === q));
  if (S[0]?.[15] !== 'T') problems.push('ISA15 is not T');
  if (S[0]?.[6]?.trim() !== str.interchangeSenderId || S[0]?.[8]?.trim() !== str.interchangeReceiverId) problems.push('ISA sender or receiver is not the specimen ID');
  if (S[1]?.[2] !== str.interchangeSenderId || S[1]?.[3] !== str.interchangeReceiverId) problems.push('GS sender or receiver is not the specimen ID');
  if (!get('PER', 'BL').every((s) => s[2] === str.technicalContactName && s[3] === 'TE' && s[4] === str.technicalContactPhone) || !get('PER', 'BL').length) problems.push('technical contact is not the specimen contact');
  const payerNames = new Set(Object.values(str.payerNames));
  for (const s of get('N1', 'PR')) { if (!payerNames.has(s[2])) problems.push('payer name is not a specimen name'); if (!/^CS[A-Z0-9]+$/.test(s[4] || '')) problems.push('payer ID is not a sentinel'); }
  for (const s of get('N1', 'PE')) if (!/^9[0-9]{9}$/.test(s[4] || '') || !luhnNpi(s[4])) problems.push('payee NPI is not a synthetic NPI');
  for (const s of get('REF', 'TJ')) if (!/^00[0-9]{7}$/.test(s[2] || '')) problems.push('payee tax ID is not 00-prefixed');
  for (const s of get('TRN')) { if (!/^CS[A-Z0-9]+$/.test(s[2] || '')) problems.push('check number is not a sentinel'); if (!/^100[0-9]{7}$/.test(s[3] || '')) problems.push('payer tax ID is not 00-prefixed'); }
  for (const s of get('CLP')) {
    if (!/^CS[0-9]{10}$/.test(s[1] || '')) problems.push('patient control number is not a sentinel');
    if (!(/^99[0-9]{11}$/.test(s[7] || '') || /^CS[0-9]{10}$/.test(s[7] || ''))) problems.push('payer claim number is not a sentinel');
  }
  for (const s of get('NM1', 'QC')) {
    const id = s[9] || '';
    // a Medicare number with a letter Medicare never uses (S L O I B Z), or a sentinel member ID
    if (!(/^[0-9A-Z]{11}$/.test(id) && /[SLOIBZ]/.test(id.slice(1)) || /^SPEC[0-9]{8}$/.test(id))) problems.push('patient ID is neither an impossible Medicare number nor a sentinel member ID');
  }
  // free text only where allowed
  const allowed = new Set([...payerNames, str.technicalContactName, str.payerAddress.line1, str.payerAddress.city, ...names]);
  // the coded segments, element by element: amounts, dates, codes and the sentinel identifiers only
  const AMT = AMOUNT; const DATE = /^[0-9]{8}$/;
  const CODED = {
    BPR: [/^[IH]$/, AMT, /^C$/, /^(CHK|NON)$/, ...Array(11).fill(/^$/), DATE],
    CLP: [/^CS[0-9]{10}$/, /^[14]$/, AMT, AMT, AMT, /^(MB|16)$/, /^(99[0-9]{11}|CS[0-9]{10})$/],
    SVC: [/^HC>[0-9A-Z]{5}$/, AMT, AMT, /^$/, /^[1-9][0-9]*$/],
    CAS: [/^(CO|OA|PR)$/, ...Array(6).fill(null).flatMap(() => [/^(1|2|3|18|45|50)$/, AMT, /^$/])],
    AMT: [/^B6$/, AMT],
    DTM: [/^(405|472)$/, DATE],
  };
  // the envelope's dates and control numbers: digits only (the elements the other rules leave open)
  const DIGITS = (n, m) => new RegExp(`^[0-9]{${n},${m}}$`); const CONTROL = /^[1-9][0-9]{0,8}$/;
  const ENVELOPE = { ISA: { 9: DIGITS(6, 6), 13: DIGITS(9, 9) }, GS: { 4: DATE, 6: CONTROL }, ST: { 2: DIGITS(4, 9) },
    SE: { 1: CONTROL, 2: DIGITS(4, 9) }, GE: { 1: CONTROL, 2: CONTROL }, IEA: { 1: CONTROL, 2: DIGITS(9, 9) } };
  for (const s of S) for (const [i, re] of Object.entries(ENVELOPE[s[0]] || {})) if (s[i] !== undefined && !re.test(s[i])) problems.push(`${s[0]}${String(i).padStart(2, '0')} holds free text or an unexpected value`);
  // an empty value is held to its element's pattern too, unless the shape rules already report that element empty
  const emptyReported = (s, i) => (REQUIRED[s[0]] || []).includes(i) || (FIXED[s[0]] || {})[i] !== undefined || (s[0] === 'CAS' && (i === 1 || i % 3 !== 1));
  for (const s of S) {
    if (CODED[s[0]]) { s.slice(1).forEach((v, k) => { const i = k + 1; const re = CODED[s[0]][k]; if (!v && emptyReported(s, i)) return; if (!re || !re.test(v)) problems.push(`${s[0]}${String(i).padStart(2, '0')} holds free text or an unexpected value`); }); continue; }
    if (s[0] === 'N1') { if (!allowed.has(s[2])) problems.push(`${s[1]} name not on the allow-list`); }
    else if (s[0] === 'NM1') { if (![s[3], s[4]].every((v) => allowed.has(v)) || (s[5] && !allowed.has(s[5]))) problems.push('patient name not on the allow-list'); }
  }
  return problems;
}
// Luhn with the NPI's 80840 prefix
export function luhnNpi(npi) {
  if (typeof npi !== 'string' || !/^[0-9]{10}$/.test(npi)) return false;
  const d = `80840${npi.slice(0, 9)}`.split('').map(Number); let sum = 0;
  for (let i = d.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) { let v = d[i]; if (dbl) { v *= 2; if (v > 9) v -= 9; } sum += v; }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}
