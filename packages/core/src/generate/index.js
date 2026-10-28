// index.js — generateData({ type, scenario, seed, overrides }) -> { data, groundTruth }
// A scenario file (scenarios/<type>/<slug>.json) is:
//   { type, slug, status, description, period: { start, end }, claimCount, claimShapes?, referenceSurname?,
//     deductibleMetBefore?, qmb?, year?, dateOfNotice?, mutations: [{ op, args, kind?, severity?, rule?, note? }], sources: [{ what, source }] }
// See packages/core/README.md for the field-by-field description.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeRng, intBetween } from './rng.js';
import { makePlace, makeBeneficiary } from './entities.js';
import { makeEncounters, CATALOG } from './encounter.js';
import { adjudicatePartB } from './rules.js';
import { applyMutations } from './mutations.js';
import { assembleMsn } from './msn.js';
import { assembleItemizedBill } from './itemized-bill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIOS_DIR = path.resolve(__dirname, '../../scenarios');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function listScenarios(type) {
  if (!SLUG.test(String(type))) throw new Error(`invalid type slug: ${type}`);
  const dir = path.join(SCENARIOS_DIR, type);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
export function loadScenario(type, slug) {
  if (!SLUG.test(String(type)) || !SLUG.test(String(slug))) throw new Error(`invalid type/scenario slug: ${type}/${slug}`);
  const p = path.join(SCENARIOS_DIR, type, `${slug}.json`);
  if (!fs.existsSync(p)) throw new Error(`scenario not found: ${type}/${slug}`);
  const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!Array.isArray(s.sources) || s.sources.length === 0) throw new Error(`scenario ${type}/${slug} has no sources[] — required`);
  return s;
}
// One assembler per document type. An assembler receives { rng, beneficiary, adjudicated, period, dateOfNotice, year,
// groundTruthErrors } and returns the data object its templates read; keys starting with "_" are not rendered and
// not flattened into ground-truth fields. `_groundTruth` may override the entities block (providers, identifiers, payer).
import { assemblePpoEob, assembleHmoEob } from './ma-eob.js';
const CATALOG_BY_CODE = Object.fromEntries(CATALOG.services.map((s) => [s.code, s]));
export const ASSEMBLERS = { msn: assembleMsn, 'itemized-bill': assembleItemizedBill, 'ppo-eob': assemblePpoEob, 'hmo-eob': assembleHmoEob };
export const DATA_DIR_FOR_STOCK = path.resolve(__dirname, '../../data');

export function generateData({ type, scenario, seed = 'claimseed', overrides = {} }) {
  const sc = { ...loadScenario(type, scenario), ...overrides };
  const rng = makeRng(seed, type, scenario);
  const place = makePlace(rng);
  const beneficiary = makeBeneficiary(rng, place, { referenceSurname: !!sc.referenceSurname });
  if (sc.qmb) beneficiary.qmb = true;
  const year = sc.year || Number(sc.period.start.slice(0, 4));
  const claims = makeEncounters(rng, place, { claimCount: sc.claimCount, claimShapes: sc.claimShapes, periodStart: sc.period.start, periodEnd: sc.period.end });
  const adjudicated = adjudicatePartB(claims, { year, deductibleMetBefore: sc.deductibleMetBefore ?? 0, rng });
  const ctx = { claims: adjudicated.claims, params: adjudicated.params };
  const errors = applyMutations(ctx, sc.mutations || []).map((e) => ({ documentId: `${type}-1`, ...e }));
  const dateOfNotice = sc.dateOfNotice || (() => { const d = new Date(sc.period.end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + intBetween(rng, 5, 12)); return d.toISOString().slice(0, 10); })();
  const assemble = ASSEMBLERS[type]; if (!assemble) throw new Error(`no assembler for type ${type}`);
  const stockPath = path.join(DATA_DIR_FOR_STOCK, type, 'stock-content.json');
  const stock = fs.existsSync(stockPath) ? JSON.parse(fs.readFileSync(stockPath, 'utf-8')) : {};
  const data = assemble({ rng, beneficiary, adjudicated, period: sc.period, dateOfNotice, year, groundTruthErrors: errors, stock, catalogByCode: CATALOG_BY_CODE });
  data.scenario = scenario;
  const gtOverrides = data._groundTruth || {};
  // Every error carries two references: `lineRef` into the adjudication model (groundTruth.claims — the same
  // shape for every document type) and `fieldRef`, the corresponding path into documents[0].fields for this layout.
  const fieldPaths = data._fieldPaths || DEFAULT_FIELD_PATHS;
  for (const e of errors) e.fieldRef = fieldRefFor(e.lineRef, fieldPaths);
  const groundTruth = {
    schemaVersion: '1.0', seed: String(seed), scenario: `${type}.${scenario}`,
    // pages and sha256 are null from `generate`; the CLI's render step fills them from the finished PDF.
    documents: [{ id: `${type}-1`, type, layout: type, pages: null, format: 'pdf', degradation: null, sha256: null,
      fields: flattenFields(data), entities: {
        patient: { name: beneficiary.name, address: beneficiary.addressLines.join(', ') },
        providers: gtOverrides.providers || adjudicated.claims.map((c) => ({ name: c.provider.name, npi: c.provider.npi, specialty: c.provider.specialty, address: c.provider.addressLines.join(', '), participating: true })),
        payer: gtOverrides.payer || { name: 'Medicare', planType: 'Original Medicare Part B' },
        identifiers: gtOverrides.identifiers || { mbi: beneficiary.mbi, ...Object.fromEntries((data.claims || []).map((c, i) => [`claimNumber[${i}]`, c.claimNumber])) },
      } }],
    claims: gtOverrides.claims || adjudicated.claims.map((c, i) => ({ claimNumber: data.claims?.[i]?.claimNumber ?? null, provider: c.provider.name, dateOfService: c.dateOfService,
      lines: c.lines.map((l) => ({ code: l.code, units: l.units, dateOfService: l.dateOfService, charged: l.charged, allowed: l.allowed, approved: !!l.approved, paid: l.paid ?? null, toDeductible: l.toDeductible ?? null, patientMayBeBilled: l.patientMayBeBilled ?? null })),
      totals: c.totals })),
    errors, documentGaps: [], adversarial: false,
    sources: [...(sc.sources || []), ...CATALOG.sources],
    pricing: { status: CATALOG.priceSource, year: CATALOG.year },
  };
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
