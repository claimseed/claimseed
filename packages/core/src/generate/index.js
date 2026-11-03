// index.js — generateData({ type, scenario, seed, overrides }) -> { data, groundTruth }
// A scenario file (scenarios/<type>/<slug>.json) is:
//   { type, slug, status, description, period: { start, end }, claimCount, claimShapes?, referenceSurname?,
//     deductibleMetBefore?, qmb?, year?, dateOfNotice?, mutations: [{ op, args, kind?, severity?, rule?, note? }],
//     decoys?: [{ op, args, rule, kind?, note? }], sources: [{ what, source }] }
// See packages/core/README.md for the field-by-field description.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeRng, intBetween } from './rng.js';
import { makePlace, makeBeneficiary } from './entities.js';
import { makeEncounters, CATALOG, CLAIM_SHAPE_NAMES } from './encounter.js';
import { adjudicatePartB, ANNUAL } from './rules.js';
import { fail, inCents } from './ma-mutations.js';
import { scalarText } from '../scalar-text.js';
import { applyMutations, applyDecoys, settleTotals } from './mutations.js';
import { resolveVariant, variantRecord } from '../variants.js';
import { assembleMsn } from './msn.js';
import { assembleItemizedBill } from './itemized-bill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = path.resolve(__dirname, '../../scenarios');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function listScenarios(type) {
  if (!SLUG.test(scalarText(type))) throw new Error('invalid type slug');
  const dir = path.join(SCENARIOS_DIR, type);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
export function loadScenario(type, slug) {
  if (!SLUG.test(scalarText(type)) || !SLUG.test(scalarText(slug))) throw new Error('invalid type or scenario slug');
  const p = path.join(SCENARIOS_DIR, type, `${slug}.json`);
  if (!fs.existsSync(p)) throw new Error('scenario not found');
  const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(s.sources) || s.sources.length === 0) throw new Error('scenario has no sources[] — required');
  return s;
}
// One assembler per document type. An assembler receives { rng, beneficiary, adjudicated, period, dateOfNotice, year,
// groundTruthErrors } and returns the data object its templates read; keys starting with "_" are not rendered and
// not flattened into ground-truth fields. `_groundTruth` may override the entities block (providers, identifiers, payer).
import { assemblePpoEob, assembleHmoEob } from './ma-eob.js';
const CATALOG_BY_CODE = Object.fromEntries(CATALOG.services.map((s) => [s.code, s]));
export const ASSEMBLERS = { msn: assembleMsn, 'itemized-bill': assembleItemizedBill, 'ppo-eob': assemblePpoEob, 'hmo-eob': assembleHmoEob };
export const DATA_DIR_FOR_STOCK = path.resolve(__dirname, '../../data');

// The scenario's own figures (from its file or a caller's overrides), held to what the documents can print before
// anything is drawn: a whole number of claims up to the most any check renders (16), known claim shapes, real dates in
// order within one calendar year (the year whose figures the document uses, which the reference data must cover), a
// notice date at most MAX_NOTICE_DAYS after the period, and a deductible already met in whole cents. Every date the
// generator derives (notice, appeal deadline, a shifted or repeated service) then stays within a year or so of it.
const MAX_CLAIMS = 16; const MAX_NOTICE_DAYS = 90;
const daysAfter = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const realDate = (v) => typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function checkScenario(type, sc) {
  const max = MAX_CLAIMS;
  if (!Number.isInteger(sc.claimCount) || sc.claimCount < 1 || sc.claimCount > max) throw fail('badClaimCount', { type, max });
  if (sc.claimShapes !== undefined && !(Array.isArray(sc.claimShapes) && sc.claimShapes.every((s) => s === null || s === undefined || s === '' || CLAIM_SHAPE_NAMES.includes(s)))) throw fail('badShape', { type, known: CLAIM_SHAPE_NAMES.join(', ') });
  const p = sc.period;
  if (!p || typeof p !== 'object' || !realDate(p.start) || !realDate(p.end) || p.end < p.start || p.start.slice(0, 4) !== p.end.slice(0, 4)) throw fail('badPeriod', { type });
  const year = Number(p.start.slice(0, 4));
  if (sc.year !== undefined && sc.year !== year) throw fail('yearNotPeriod', { type });   // one year's figures for the whole document
  if (!Object.prototype.hasOwnProperty.call(ANNUAL.years, String(year))) throw fail('badYear', { type });
  if (sc.dateOfNotice !== undefined && !(realDate(sc.dateOfNotice) && sc.dateOfNotice >= p.end && daysAfter(p.end, sc.dateOfNotice) <= MAX_NOTICE_DAYS)) throw fail('badNoticeDate', { type, max: MAX_NOTICE_DAYS });
  const ded = ANNUAL.years[String(year)].partB.deductible;
  if (sc.deductibleMetBefore !== undefined && !(inCents(sc.deductibleMetBefore) && sc.deductibleMetBefore >= 0 && sc.deductibleMetBefore <= ded)) throw fail('deductibleRange', { type });
}

export function generateData({ type, scenario, seed = 'claimseed', overrides = {}, layoutVariant = null }) {
  // the type and scenario are slugs and the seed is text or a number (written out); any other value is refused before
  // it is converted or used to look anything up
  if (!SLUG.test(scalarText(type)) || !SLUG.test(scalarText(scenario))) throw new Error('invalid type or scenario slug');
  if (scalarText(seed) === '') throw new Error('invalid seed');
  // a layout variant is checked first and drawn from a stream of its own: it moves no draw of the document
  const variant = resolveVariant(type, layoutVariant, seed);
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('invalid overrides');
  const sc = { ...loadScenario(type, scenario), ...overrides };
  checkScenario(type, sc);
  const rng = makeRng(seed, type, scenario);
  const place = makePlace(rng);
  const beneficiary = makeBeneficiary(rng, place, { referenceSurname: !!sc.referenceSurname });
  if (sc.qmb) beneficiary.qmb = true;
  const year = sc.year || Number(sc.period.start.slice(0, 4));
  const claims = makeEncounters(rng, place, { claimCount: sc.claimCount, claimShapes: sc.claimShapes, periodStart: sc.period.start, periodEnd: sc.period.end });
  const adjudicated = adjudicatePartB(claims, { year, deductibleMetBefore: sc.deductibleMetBefore ?? 0, rng });
  const assemble = ASSEMBLERS[type]; if (!assemble) throw new Error('no assembler for type');
  // The Medicare Advantage layouts (assemble.maOps) re-adjudicate the claims under the plan, so they run their own
  // operations on the plan's figures (ma-mutations.js); every other layout gets the Part B operations here.
  let errors = []; let decoys = [];
  if (!assemble.maOps) {
    const ctx = { type, claims: adjudicated.claims, params: adjudicated.params, period: sc.period, deductibleMetBefore: sc.deductibleMetBefore ?? 0 };
    const planted = applyMutations(ctx, sc.mutations || []); const placed = applyDecoys(ctx, sc.decoys || [], planted);
    settleTotals(ctx);   // a shifted claim total, on the lines as every operation left them
    errors = planted.map((e) => ({ documentId: `${type}-1`, ...e }));
    decoys = placed.map((d) => ({ id: d.id, kind: d.kind, documentId: `${type}-1`, ...d }));
  }
  const dateOfNotice = sc.dateOfNotice || (() => { const d = new Date(sc.period.end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + intBetween(rng, 5, 12)); return d.toISOString().slice(0, 10); })();
  const stockPath = path.join(DATA_DIR_FOR_STOCK, type, 'stock-content.json');
  const stock = fs.existsSync(stockPath) ? JSON.parse(fs.readFileSync(stockPath, 'utf-8')) : {};
  const data = assemble({ rng, beneficiary, adjudicated, period: sc.period, dateOfNotice, year, groundTruthErrors: errors, stock, catalogByCode: CATALOG_BY_CODE,
    ...(assemble.maOps ? { mutations: sc.mutations || [], decoys: sc.decoys || [], maState: { maPriorOop: sc.maPriorOop, maDeductibleMetBefore: sc.maDeductibleMetBefore } } : {}) });
  if (assemble.maOps) {
    errors = data._groundTruthErrors.map((e) => ({ documentId: `${type}-1`, ...e }));
    decoys = data._groundTruthDecoys.map((d) => ({ id: d.id, kind: d.kind, documentId: `${type}-1`, ...d }));
  }
  data.scenario = scenario; data._dateOfNotice = dateOfNotice;
  if (variant) Object.defineProperty(data, '_variant', { value: variant, enumerable: false });   // for the renderer; never in fields or JSON   // not printed: the date an 835 written beside it carries
  const gtOverrides = data._groundTruth || {};
  // Every error carries two references: `lineRef` into the adjudication model (groundTruth.claims — the same
  // shape for every document type) and `fieldRef`, the corresponding path into documents[0].fields for this layout.
  const fieldPaths = data._fieldPaths || DEFAULT_FIELD_PATHS;
  for (const e of errors) { e.fieldRef = fieldRefFor(e.lineRef, fieldPaths); if (e.relatedLineRef) e.relatedFieldRef = fieldRefFor(e.relatedLineRef, fieldPaths); }
  for (const d of decoys) d.fieldRef = fieldRefFor(d.lineRef, fieldPaths);
  const groundTruth = {
    schemaVersion: '1.3', seed: String(seed), scenario: `${type}.${scenario}`,
    // pages and sha256 are null from `generate`; the CLI's render step fills them from the finished PDF.
    documents: [{ id: `${type}-1`, type, layout: type, pages: null, format: 'pdf', degradation: null, degradationParams: null, sha256: null,
      fields: flattenFields(data), entities: {
        patient: { name: beneficiary.name, address: beneficiary.addressLines.join(', ') },
        providers: gtOverrides.providers || adjudicated.claims.map((c) => ({ name: c.provider.name, npi: c.provider.npi, specialty: c.provider.specialty, address: c.provider.addressLines.join(', '), participating: true })),
        payer: gtOverrides.payer || { name: 'Medicare', planType: 'Original Medicare Part B' },
        identifiers: gtOverrides.identifiers || { mbi: beneficiary.mbi, ...Object.fromEntries((data.claims || []).map((c, i) => [`claimNumber[${i}]`, c.claimNumber])) },
      } }],
    claims: gtOverrides.claims || adjudicated.claims.map((c, i) => ({ claimNumber: data.claims?.[i]?.claimNumber ?? null, provider: c.provider.name, dateOfService: c.dateOfService,
      // the patient's share in its parts (Part B has no copay; a denied line the patient may be billed for is non-covered)
      lines: c.lines.map((l) => ({ code: l.code, units: l.units, dateOfService: l.dateOfService, charged: l.charged, allowed: l.allowed, approved: !!l.approved, paid: l.paid ?? null, toDeductible: l.toDeductible ?? null,
        coinsurance: l.coinsurance ?? null, copay: 0, nonCovered: l.approved ? 0 : (l.patientMayBeBilled ?? 0), patientMayBeBilled: l.patientMayBeBilled ?? null })),
      totals: c.totals })),
    // the deductible already met before this document's claims, so the lines' deductible adds up to the printed amount
    deductibleMetBefore: gtOverrides.deductibleMetBefore ?? (sc.deductibleMetBefore ?? 0),
    errors, decoys, documentGaps: [], adversarial: false,
    sources: [...(sc.sources || []), ...CATALOG.sources],
    pricing: { status: CATALOG.priceSource, year: CATALOG.year },
  };
  // a varied document: schema 1.4, the variant's layout name and its record; nothing else in the key changes
  if (variant) { groundTruth.schemaVersion = '1.4'; Object.assign(groundTruth.documents[0], { layout: variant.layout, layoutVariant: variantRecord(variant) }); }
  return { data, groundTruth };
}
// Internal keys that are not printed and so never appear in fields.
const INTERNAL_TOP_LEVEL = new Set(['carrier', 'scenario', 'hasDenial']);
const DEFAULT_FIELD_PATHS = { line: (i, j) => `claims[${i}].lineItems[${j}]`, totals: (i, field) => `claims[${i}].claimTotal.${field}` };
function fieldRefFor(lineRef, fp) {
  if (!lineRef) return null;
  let m = /^claims\[(\d+)\]\.lines\[(\d+)\]$/.exec(lineRef); if (m) return fp.line(Number(m[1]), Number(m[2]));
  m = /^claims\[(\d+)\]\.totals\.(\w+)$/.exec(lineRef); if (m) return fp.totals(Number(m[1]), m[2]);
  return null;
}
function flattenFields(data, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_') || (!prefix && INTERNAL_TOP_LEVEL.has(k))) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' && x !== null ? flattenFields(x, `${key}[${i}]`, out) : (out[`${key}[${i}]`] = x)));
    else if (v && typeof v === 'object') flattenFields(v, key, out);
    else out[key] = v;
  }
  return out;
}
