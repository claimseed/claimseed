// variants.js — layout variants (0.5.0). The itemized bill and both Medicare Advantage EOBs print the same data in
// several layouts: each type publishes a closed list of 12 ids in data/<type>/variants.json, each naming a column
// order, a label set (data/<type>/labels.json), a style (font, density, palette) and a continuation rule. With no
// variant a type renders exactly as before variants existed and its key stays at schema 1.3. Messages come from
// data/layout-variants.json and never repeat what the caller passed.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { makeRng } from './generate/rng.js';
import { scalarText } from './scalar-text.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const VARIANT_TYPES = Object.freeze(['itemized-bill', 'ppo-eob', 'hmo-eob']);
export const VARIANT_STRINGS = JSON.parse(fs.readFileSync(path.join(DATA, 'layout-variants.json'), 'utf-8'));
const FAMILY = Object.fromEntries(VARIANT_TYPES.map((t) => [t, {
  ...JSON.parse(fs.readFileSync(path.join(DATA, t, 'variants.json'), 'utf-8')),
  labelSets: JSON.parse(fs.readFileSync(path.join(DATA, t, 'labels.json'), 'utf-8')).sets,
}]));
export const DENSITY = Object.freeze({ compact: 0.92, regular: 1, roomy: 1.1 });
// font packages a style may pick (all bundled, see fonts/coverage.json); the layout's own fallbacks follow. The names
// are unquoted CSS family names, so the templates print them through autoescape unchanged (never `| safe`).
export const FONTS = Object.freeze({ inter: 'Inter', 'noto-sans': 'Noto Sans', 'noto-serif': 'Noto Serif' });

export class VariantError extends Error { constructor(key) { super(VARIANT_STRINGS.messages[key]); this.code = 'LAYOUT_VARIANT'; this.key = key; } }
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);   // a key that is text, never converted

/** The published ids of a type, in order (an empty list for a type that is not varied). */
export function variantIds(type) { return own(FAMILY, type) ? Object.keys(FAMILY[type].ids) : []; }

/** Check a caller's value without resolving it: null when absent, otherwise the value, or a VariantError.
 *  `all` is accepted only where `allowAll` is set (the CLI's render and batch expand it themselves). */
export function checkVariantOption(type, value, { allowAll = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new VariantError('variantUnknown');
  if (value === '') throw new VariantError('variantEmpty');
  if (!own(FAMILY, type)) throw new VariantError('variantMsn');
  if (value === 'all') { if (allowAll) return value; throw new VariantError('variantAllHere'); }
  if (value === 'seeded') return value;
  if (value.length > 64 || !own(FAMILY[type].ids, value)) throw new VariantError('variantUnknown');
  return value;
}

/** Resolve a type's variant for a seed: null for none, else { id, layout, columns, labels, style, breaks, labelSet,
 *  styleDef, palette }. `seeded` draws from a stream of its own (the seed and "layout-variant", the same for every
 *  type and scenario), so no other draw of the document moves. */
export function resolveVariant(type, value, seed) {
  const v = checkVariantOption(type, value);
  if (v === null) return null;
  const fam = FAMILY[type];
  const ids = Object.keys(fam.ids);
  if (v === 'seeded' && scalarText(seed) === '') throw new Error('invalid seed');   // never converted
  const id = v === 'seeded' ? ids[Math.floor(makeRng(`${scalarText(seed)}|layout-variant`)() * ids.length)] : v;
  const def = fam.ids[id]; const styleDef = fam.styles[def.style];
  return Object.freeze({
    id, layout: `${type}.${id}`, columns: [...def.columns], labels: def.labels, style: def.style, breaks: def.breaks,
    labelSet: { ...fam.labelSets[def.labels] }, styleDef: { ...styleDef, scale: DENSITY[styleDef.density], fontFamily: FONTS[styleDef.font] },
    palette: styleDef.palette === 'p1' ? null : { ...fam.palettes[styleDef.palette] },
  });
}

/** The key's record of a variant (documents[].layoutVariant). */
export const variantRecord = (v) => ({ id: v.id, columns: [...v.columns], labels: v.labels, style: v.style, breaks: v.breaks });

/** The stock with a variant's palette and label set applied (a copy; the stock file is untouched). Label keys are the
 *  label sets': on the EOBs `columns.*` sits under `claims`, every other key is a dotted path into the stock. */
export function variantStock(type, stock, v) {
  const s = JSON.parse(JSON.stringify(stock));
  if (v.palette) s.colors = { ...s.colors, ...v.palette };
  for (const [key, text] of Object.entries(v.labelSet)) {
    const p = (type !== 'itemized-bill' && key.startsWith('columns.') ? `claims.${key}` : key).split('.');
    let o = s; for (const k of p.slice(0, -1)) o = (o[k] ||= {});
    o[p.at(-1)] = text;
  }
  return s;
}

// What the variant templates read (templates/<type>/pages-*-v.html): the column order with each column's CSS class,
// header class and label key, the totals row's cells, the density scale and the font.
const VIEW = {
  'ppo-eob': {
    colClass: { date: 'date', service: 'svc', code: 'code', billed: 'amt', approved: 'amt', planShare: 'amt', yourShare: 'amt', notes: 'notes' },
    thClass: { date: '', service: '', code: '', billed: 'num', approved: 'num', planShare: 'num', yourShare: 'num yours', notes: 'ctr' },
  },
  'hmo-eob': {
    colClass: { 'service(code,date)': 'svc', 'service(date,code)': 'svc', charged: 'amt', approved: 'amt', paid: 'amt', owe: 'owe', notes: 'notes' },
    thClass: { 'service(code,date)': 'svc', 'service(date,code)': 'svc', charged: '', approved: '', paid: '', owe: 'owe', notes: 'ctr' },
    labelKey: { 'service(code,date)': 'service', 'service(date,code)': 'service', charged: 'charged', approved: 'approved', paid: 'paid', owe: 'owe', notes: 'notes' },
  },
  'itemized-bill': {
    colClass: { dept: 'col-revcode', date: 'col-date', hcpcs: 'col-hcpcs', units: 'col-units', description: 'col-description', charge: 'col-amount' },
    labelKey: { dept: 'columnRevCode', date: 'columnDate', hcpcs: 'columnHcpcs', units: 'columnUnits', description: 'columnDescription', charge: 'columnAmount' },
  },
};
const IDENTITY = new Set(['date', 'service', 'code']);
export function templateVariant(type, v) {
  const view = VIEW[type];
  const totalCells = [];
  for (const c of v.columns) { if (IDENTITY.has(c)) { if (!totalCells.includes('label')) totalCells.push('label'); } else totalCells.push(c === 'notes' ? 'blank' : c); }
  return { columns: v.columns, breaks: v.breaks, scale: v.styleDef.scale, fontFamily: v.styleDef.fontFamily,
    colClass: view.colClass, thClass: view.thClass || {}, labelKey: view.labelKey || {}, totalCells };
}
// characters per line relative to Inter at the same size (conservative: a wider face wraps sooner)
export const FONT_WIDTH = Object.freeze({ inter: 1, 'noto-sans': 0.95, 'noto-serif': 0.92 });

// Text and background colour pairs each layout prints, by palette key (a literal colour where the template fixes one).
// A new palette (p2, p3) reaches at least 3:1 on every pair; today's palette (p1) is recorded with its measured ratios,
// unchanged. The bill's footer grey is fixed in its template; a new palette names its own.
// test/variants-render.test.js reads every text colour a variant prints in the browser and fails on a pair not listed
// here. On a varied bill the header's specimen badge has a light ground (#FBF1E6), since every header colour of the
// palettes, today's included, leaves its text below 3:1.
export const STYLE_PAIRS = Object.freeze({
  'ppo-eob': [['text', '#FFFFFF'], ['ink', '#FFFFFF'], ['muted', '#FFFFFF'], ['tableHeaderText', 'tableHeaderBg'], ['#FFFFFF', 'accent'], ['accent', '#FFFFFF'], ['text', 'accentSoft'], ['text', 'zebra'], ['ink', 'inkSoft'],
    ['#FFFFFF', 'ink'], ['muted', 'accentSoft'], ['text', 'inkSoft']],
  'hmo-eob': [['text', '#FFFFFF'], ['ink', '#FFFFFF'], ['muted', '#FFFFFF'], ['tableHeaderText', 'tableHeaderBg'], ['#FFFFFF', 'ink'], ['text', 'inkSoft'], ['text', 'sand'], ['text', 'sandDeep'],
    ['muted', 'sand'], ['ink', 'sand'], ['muted', 'inkSoft'], ['ink', 'inkSoft']],
  'itemized-bill': [['text', '#FFFFFF'], ['headerText', 'headerBg'], ['columnHeaderText', 'columnHeaderBg'], ['grandTotalText', 'grandTotalBg'], ['summaryHeaderText', 'summaryHeaderBg'], ['headerBg', 'groupHeaderBg'], ['text', 'zebraStripeBg'], ['text', 'noticeBg'], ['text', 'infoBg'], ['footerText', '#FFFFFF'],
    ['headerBg', '#FFFFFF'], ['headerBg', 'infoBg'], ['#333333', 'noticeBg'], ['#333333', 'infoBg'], ['#B8531E', '#FBF1E6']],
});
export const P1_FIXED = Object.freeze({ 'itemized-bill': { footerText: '#999999' } });
export const P1_RATIOS = Object.freeze({
  'ppo-eob': { 'text on #FFFFFF': 15.9, 'ink on #FFFFFF': 11.26, 'muted on #FFFFFF': 6.12, 'tableHeaderText on tableHeaderBg': 11.26, '#FFFFFF on accent': 3.72, 'accent on #FFFFFF': 3.72, 'text on accentSoft': 14.05, 'text on zebra': 14.71, 'ink on inkSoft': 9.35,
    '#FFFFFF on ink': 11.26, 'muted on accentSoft': 5.41, 'text on inkSoft': 13.2 },
  'hmo-eob': { 'text on #FFFFFF': 17.04, 'ink on #FFFFFF': 10.66, 'muted on #FFFFFF': 7.29, 'tableHeaderText on tableHeaderBg': 13.78, '#FFFFFF on ink': 10.66, 'text on inkSoft': 14.67, 'text on sand': 13.78, 'text on sandDeep': 8.71,
    'muted on sand': 5.89, 'ink on sand': 8.62, 'muted on inkSoft': 6.27, 'ink on inkSoft': 9.17 },
  'itemized-bill': { 'text on #FFFFFF': 21, 'headerText on headerBg': 11.63, 'columnHeaderText on columnHeaderBg': 11.63, 'grandTotalText on grandTotalBg': 11.63, 'summaryHeaderText on summaryHeaderBg': 11.63, 'headerBg on groupHeaderBg': 10.52, 'text on zebraStripeBg': 19.92, 'text on noticeBg': 19.77, 'text on infoBg': 18.33, 'footerText on #FFFFFF': 2.85,
    'headerBg on #FFFFFF': 11.63, 'headerBg on infoBg': 10.15, '#333333 on noticeBg': 11.89, '#333333 on infoBg': 11.03, '#B8531E on #FBF1E6': 4.38 },
});
// WCAG 2.x contrast ratio of two #RRGGBB colours
export function contrastRatio(a, b) {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05);
}
