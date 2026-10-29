// verify.js — score what an extractor or bill auditor reported for one document against that document's answer key.
// The report uses the answer key's own vocabulary (schemas/extractor-output.schema.json): field paths from
// documents[0].fields, and errors as { kind, fieldRef or lineRef }. The result names only the answer key's paths,
// kinds and decoy ids, never text the caller sent, so it is safe to hand back to an agent.
import { generateData } from './generate/index.js';

export const LIMITS = Object.freeze({ fields: 5000, errors: 1000, pathLength: 200, valueLength: 1000, kindLength: 64, listed: 500 });
// Known only once a PDF exists (the page count), so not scored when the key is rebuilt from a seed.
const UNSCORED = new Set(['metadata.pageCount']);

const fail = (msg) => { const e = new Error(`extractor output: ${msg}`); e.code = 'EXTRACTOR_OUTPUT'; throw e; };
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// Refuse anything outside the documented shape or the limits. Messages name positions, never the caller's text.
export function checkOutput(output) {
  if (!isPlain(output)) fail('must be a JSON object');
  for (const k of Object.keys(output)) if (k !== 'fields' && k !== 'errors') fail('only "fields" and "errors" are allowed at the top level');
  if (output.fields !== undefined) {
    if (!isPlain(output.fields)) fail('"fields" must be an object of path -> value');
    const entries = Object.entries(output.fields);
    if (entries.length > LIMITS.fields) fail(`"fields" holds ${entries.length} entries; the limit is ${LIMITS.fields}`);
    entries.forEach(([k, v], i) => {
      if (k.length > LIMITS.pathLength) fail(`field ${i + 1}: path longer than ${LIMITS.pathLength} characters`);
      if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) fail(`field ${i + 1}: value must be a string, number, boolean or null`);
      if (typeof v === 'string' && v.length > LIMITS.valueLength) fail(`field ${i + 1}: value longer than ${LIMITS.valueLength} characters`);
      if (typeof v === 'number' && !Number.isFinite(v)) fail(`field ${i + 1}: value is not a finite number`);
    });
  }
  if (output.errors !== undefined) {
    if (!Array.isArray(output.errors)) fail('"errors" must be an array');
    if (output.errors.length > LIMITS.errors) fail(`"errors" holds ${output.errors.length} items; the limit is ${LIMITS.errors}`);
    output.errors.forEach((e, i) => {
      if (!isPlain(e)) fail(`error ${i + 1}: must be an object`);
      for (const k of Object.keys(e)) if (!['kind', 'fieldRef', 'lineRef'].includes(k)) fail(`error ${i + 1}: only kind, fieldRef and lineRef are allowed`);
      if (typeof e.kind !== 'string' || !e.kind || e.kind.length > LIMITS.kindLength) fail(`error ${i + 1}: kind must be a string of 1 to ${LIMITS.kindLength} characters`);
      for (const k of ['fieldRef', 'lineRef']) if (e[k] != null && (typeof e[k] !== 'string' || e[k].length > LIMITS.pathLength)) fail(`error ${i + 1}: ${k} must be a string of at most ${LIMITS.pathLength} characters, or null`);
    });
  }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
// A date written the ways documents print them, as YYYY-MM-DD; null when it is not a date.
export function normDate(s) {
  s = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s); if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) { const i = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase()) && m[1].length >= 3); if (i >= 0) return `${m[3]}-${pad(i + 1)}-${pad(m[2])}`; }
  return null;
}
// A number written as printed: "$1,234.50", "(12.00)" for a negative, "12.5"; null when it is not a number.
export function normNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim(); let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return (neg ? -1 : 1) * Number(s);
}
const normText = (v) => String(v).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const empty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
// Does a reported value match the answer key's value? Dates match in any supported form on either side.
export function sameValue(expected, got) {
  if (expected === null) return empty(got);
  if (empty(got)) return false;
  if (typeof expected === 'number') { const n = normNumber(got); return n !== null && Math.round(n * 100) === Math.round(expected * 100); }
  if (typeof expected === 'boolean') { const t = normText(got); return expected ? ['true', 'yes', 'y'].includes(t) : ['false', 'no', 'n'].includes(t); }
  const date = typeof expected === 'string' ? normDate(expected) : null;   // a date as the key prints it, in any supported form
  if (date) return normDate(got) === date;
  return normText(got) === normText(expected);
}

const locs = (x) => [x.fieldRef, x.lineRef, x.relatedFieldRef, x.relatedLineRef].filter((r) => typeof r === 'string' && r);
// A reported location matches when it names the same line or total, or a field inside it.
function sameLocation(keyItem, reported) {
  const want = locs(keyItem); const got = [reported.fieldRef, reported.lineRef].filter((r) => typeof r === 'string' && r);
  if (!want.length) return got.length === 0;
  return got.some((g) => want.some((w) => g === w || g.startsWith(`${w}.`)));
}
const rate = (n, d) => (d ? Math.round((n / d) * 10000) / 10000 : null);
const listed = (a) => a.slice(0, LIMITS.listed);

// An answer key needs documents[0].fields (each value a string, finite number, boolean or null) and errors (each with a
// kind in the taxonomy's form: lower-case letters, digits and hyphens), and decoys, when present, as a list with ids;
// references are strings. Anything else is refused with code ANSWER_KEY, naming positions only, rather than failing
// or miscounting somewhere inside the scoring.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const refsOk = (x) => ['fieldRef', 'lineRef', 'relatedFieldRef', 'relatedLineRef'].every((r) => x[r] === undefined || x[r] === null || typeof x[r] === 'string');
export function checkAnswerKey(k) {
  const bad = (msg) => { throw Object.assign(new Error(`answer key: ${msg}`), { code: 'ANSWER_KEY' }); };
  if (!(isPlain(k) && Array.isArray(k.documents) && isPlain(k.documents[0]) && isPlain(k.documents[0].fields)
    && Array.isArray(k.errors) && (k.decoys === undefined || Array.isArray(k.decoys)))) bad('not a claimseed answer key (it needs documents[0].fields and errors)');
  Object.values(k.documents[0].fields).forEach((v, i) => { if (!isScalar(v)) bad(`field ${i + 1}: value must be a string, finite number, boolean or null`); });
  k.errors.forEach((e, i) => { if (!isPlain(e) || typeof e.kind !== 'string' || !NAME.test(e.kind) || !refsOk(e)) bad(`error ${i + 1}: needs a kind of lower-case letters, digits and hyphens, and string references`); });
  (k.decoys || []).forEach((d, i) => { if (!isPlain(d) || typeof d.id !== 'string' || !NAME.test(d.id) || !refsOk(d)) bad(`decoy ${i + 1}: needs an id of lower-case letters, digits and hyphens, and string references`); });
}

// Score `output` (already checked) against an answer key (a ground-truth object).
export function scoreExtraction(answerKey, output) {
  checkAnswerKey(answerKey);
  checkOutput(output);
  const doc = answerKey.documents[0];
  const result = { answerKey: { scenario: answerKey.scenario, seed: answerKey.seed, schemaVersion: answerKey.schemaVersion }, fields: null, errors: null };
  if (output.fields !== undefined) {
    const key = doc.fields; const got = output.fields;
    const scored = Object.keys(key).filter((k) => !UNSCORED.has(k) && key[k] !== null).sort();
    const correct = []; const wrong = []; const missing = [];
    for (const k of scored) {
      if (!Object.hasOwn(got, k) || empty(got[k])) missing.push(k);
      else if (sameValue(key[k], got[k])) correct.push(k);
      else wrong.push(k);
    }
    const unknown = Object.keys(got).filter((k) => !Object.hasOwn(key, k)).length;   // own keys only: "constructor" is no answer-key path
    const unexpected = Object.keys(key).filter((k) => !UNSCORED.has(k) && key[k] === null && Object.hasOwn(got, k) && !empty(got[k])).sort();
    result.fields = { expected: scored.length, correct: correct.length, wrong: wrong.length, missing: missing.length, accuracy: rate(correct.length, scored.length),
      wrongPaths: listed(wrong), missingPaths: listed(missing), unexpectedPaths: listed(unexpected), unknownPaths: unknown };
  }
  if (output.errors !== undefined) {
    const expected = answerKey.errors || []; const decoys = answerKey.decoys || [];
    const matched = new Set(); const decoysHit = new Set(); let falseAlarms = 0; let repeats = 0;
    for (const r of output.errors) {
      const kind = r.kind.trim().toLowerCase();
      const i = expected.findIndex((e, j) => !matched.has(j) && e.kind === kind && sameLocation(e, r));
      if (i >= 0) { matched.add(i); continue; }
      // the same error reported again (both lines of a duplicate pair, say): neither found twice nor a false alarm
      if (expected.some((e, j) => matched.has(j) && e.kind === kind && sameLocation(e, r))) { repeats++; continue; }
      falseAlarms++;
      const d = decoys.find((x) => sameLocation(x, r) && locs(x).length);
      if (d) decoysHit.add(d.id);
    }
    // counted in a Map and returned as own properties: a kind never reaches an object's prototype
    const kinds = new Map();
    expected.forEach((e, j) => { const b = kinds.get(e.kind) ?? { expected: 0, found: 0 }; b.expected++; if (matched.has(j)) b.found++; kinds.set(e.kind, b); });
    const byKind = Object.fromEntries(kinds);
    const ref = (e) => e.fieldRef || e.lineRef || '(document)';
    result.errors = { expected: expected.length, flagged: output.errors.length, found: matched.size, missed: expected.length - matched.size, falseAlarms, repeats,
      decoysFlagged: [...decoysHit].sort(), recall: rate(matched.size, expected.length), precision: rate(matched.size, output.errors.length - repeats),
      foundRefs: listed(expected.filter((_, j) => matched.has(j)).map((e) => `${e.kind}@${ref(e)}`)),
      missedRefs: listed(expected.filter((_, j) => !matched.has(j)).map((e) => `${e.kind}@${ref(e)}`)), byKind };
  }
  return result;
}

// Rebuild the answer key from the seed with this version of claimseed, then score. A key rebuilt by a different
// version may differ: score against the saved answer-key file when the documents came from another version.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function verifyFromSeed({ type, scenario, seed = 'claimseed', output }) {
  if (!SLUG.test(String(type)) || !SLUG.test(String(scenario)) || !SEED.test(String(seed))) throw new Error('verify: invalid type, scenario or seed');
  checkOutput(output);
  const { groundTruth } = generateData({ type, scenario, seed });
  return scoreExtraction(groundTruth, output);
}
