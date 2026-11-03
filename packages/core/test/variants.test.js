// Layout variants (0.5.0): the closed lists, the seeded pick, the key (schema 1.4), refusals that echo nothing,
// labels that are never data, contrast, and the paginators for every id. Data level; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { generateData, listScenarios } from '../src/generate/index.js';
import { VARIANT_TYPES, VARIANT_STRINGS, variantIds, resolveVariant, checkVariantOption, STYLE_PAIRS, contrastRatio, P1_RATIOS, P1_FIXED } from '../src/variants.js';
import { paginateClaims, variantClaimLayout, CLAIM_LAYOUTS } from '../src/render-ma.js';
import { paginateForItemizedBill, paginateItemizedBillVariant, variantBillLayout, BILL_LAYOUT } from '../src/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const FAMILY = Object.fromEntries(VARIANT_TYPES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(here, `../data/${t}/variants.json`), 'utf-8'))]));
const LABELS = Object.fromEntries(VARIANT_TYPES.map((t) => [t, JSON.parse(fs.readFileSync(path.join(here, `../data/${t}/labels.json`), 'utf-8')).sets]));
const SEEDS = Array.from({ length: 20 }, (_, i) => String(i + 1));
const COLUMNS = {
  'ppo-eob': ['date', 'service', 'code', 'billed', 'approved', 'planShare', 'yourShare', 'notes'],
  'hmo-eob': ['service', 'charged', 'approved', 'paid', 'owe', 'notes'],
  'itemized-bill': ['dept', 'date', 'hcpcs', 'units', 'description', 'charge'],
};
const MONEY = { 'ppo-eob': ['billed', 'approved', 'planShare', 'yourShare'], 'hmo-eob': ['charged', 'approved', 'paid', 'owe'] };
const base = (c) => c.replace(/\(.*\)$/, '');

test('each varied type publishes 12 ids and 6 styles that cover every axis value at least twice', () => {
  for (const type of VARIANT_TYPES) {
    const fam = FAMILY[type]; const ids = Object.keys(fam.ids); const styles = Object.keys(fam.styles);
    assert.equal(ids.length, 12, type); assert.deepEqual(variantIds(type), ids);
    assert.equal(styles.length, 6, type);
    for (const id of ids) assert.match(`${type}.${id}`, /^[a-z-]+\.[a-z0-9-]+$/);
    assert.equal(new Set(ids.map((id) => id[0])).size, 1, `${type}: one id letter`);
    for (const axis of ['font', 'density', 'palette']) {
      const n = {}; for (const s of styles) n[fam.styles[s][axis]] = (n[fam.styles[s][axis]] || 0) + 1;
      assert.equal(Object.keys(n).length, 3, `${type} ${axis}: three values`);
      for (const [k, c] of Object.entries(n)) assert.ok(c >= 2, `${type} ${axis} ${k} appears ${c} times`);
    }
    const perStyle = {}; for (const id of ids) perStyle[fam.ids[id].style] = (perStyle[fam.ids[id].style] || 0) + 1;
    for (const s of styles) assert.ok(perStyle[s] >= 2, `${type} style ${s} used ${perStyle[s]} times`);
    const perBreak = {}; for (const id of ids) perBreak[fam.ids[id].breaks] = (perBreak[fam.ids[id].breaks] || 0) + 1;
    assert.deepEqual(Object.keys(perBreak).sort(), ['marker', 'repeat']); for (const c of Object.values(perBreak)) assert.ok(c >= 3, `${type} breaks`);
    const pairs = new Set(ids.map((id) => `${fam.ids[id].columns.join(',')}|${fam.ids[id].labels}`));
    assert.ok(pairs.size >= 8, `${type}: ${pairs.size} distinct (column order, label set) pairs`);
    for (const id of ids) {
      const cols = fam.ids[id].columns;
      assert.deepEqual(cols.map(base).sort(), [...COLUMNS[type]].sort(), `${type}.${id}: every column, once`);
      if (MONEY[type]) assert.deepEqual(cols.filter((c) => MONEY[type].includes(c)), MONEY[type], `${type}.${id}: money columns in the model's order`);
      if (type === 'itemized-bill') assert.equal(cols.at(-1), 'charge', `${type}.${id}: charge last`);
      else assert.ok(cols[0] === 'notes' || cols.at(-1) === 'notes', `${type}.${id}: notes first or last`);
      if (type === 'ppo-eob') { const at = cols.map((c, i) => (['date', 'service', 'code'].includes(c) ? i : -1)).filter((i) => i >= 0); assert.equal(at.at(-1) - at[0], 2, `${type}.${id}: identity columns together`); }
      assert.ok(LABELS[type][fam.ids[id].labels], `${type}.${id}: label set`);
    }
    // the first id differs from the unvaried layout in column order
    assert.notDeepEqual(fam.ids[ids[0]].columns.map(base), COLUMNS[type], `${type}: the first id is not the unvaried order`);
  }
});

test('label sets name the same keys, and no label is ever a value the key records in fields', () => {
  for (const type of VARIANT_TYPES) {
    const sets = LABELS[type]; const keys = Object.keys(sets.base).sort();
    for (const s of ['alt-a', 'alt-b']) assert.deepEqual(Object.keys(sets[s]).sort(), keys, `${type} ${s}`);
    for (const k of keys) assert.ok(new Set([sets.base[k], sets['alt-a'][k], sets['alt-b'][k]]).size === 3, `${type} ${k}: three different wordings`);
    const texts = new Set(Object.values(sets).flatMap((x) => Object.values(x)).map((t) => t.toLowerCase()));
    for (const scenario of listScenarios(type)) for (const seed of SEEDS.slice(0, 5)) {
      const f = generateData({ type, scenario, seed }).groundTruth.documents[0].fields;
      for (const [p, v] of Object.entries(f)) if (typeof v === 'string') assert.ok(!texts.has(v.toLowerCase()), `${type}/${scenario}/${seed}: field ${p} is also a label`);
    }
  }
});

// the label length caps (spaces count), so a header fits two lines at the narrowest density
const CAPS = {
  'ppo-eob': { 'claims.title': 32, 'columns.date': 22, 'columns.service': 28, 'columns.code': 20, 'columns.billed': 28, 'columns.approved': 28, 'columns.planShare': 28, 'columns.yourShare': 28,
    'columns.notes': 12, 'claims.claimLabel': 16, 'claims.totalLabel': 20, 'claims.continuedFrom': 40, 'claims.continuesOn': 40, 'claims.notesTitle': 36, 'claims.pageContinues': 44 },
  'hmo-eob': { 'claims.title': 32, 'columns.service': 26, 'columns.charged': 24, 'columns.approved': 24, 'columns.paid': 24, 'columns.owe': 26, 'columns.notes': 10, 'claims.codeLabel': 10,
    'claims.dateLabel': 10, 'claims.claimLabel': 12, 'claims.totalLabel': 24, 'claims.continuedFrom': 24, 'claims.continuesOn': 32, 'claims.notesTitle': 24, 'claims.pageContinues': 32 },
  'itemized-bill': { 'labels.columnRevCode': 14, 'labels.columnDate': 14, 'labels.columnHcpcs': 12, 'labels.columnUnits': 8, 'labels.columnDescription': 24, 'labels.columnAmount': 14,
    'labels.subtotalLabel': 16, 'labels.totalChargesLabel': 20, 'labels.groupContinuedFrom': 24, 'labels.groupContinuesOn': 32 },
};
test('every label set names exactly the capped keys, each within its cap', () => {
  for (const type of VARIANT_TYPES) for (const [name, set] of Object.entries(LABELS[type])) {
    assert.deepEqual(Object.keys(set).sort(), Object.keys(CAPS[type]).sort(), `${type} ${name}: keys`);
    for (const [k, t] of Object.entries(set)) assert.ok(typeof t === 'string' && t.trim() === t && t.length >= 1 && t.length <= CAPS[type][k], `${type} ${name} ${k}: ${t.length} over ${CAPS[type][k]}`);
  }
});

test('seeded picks the same id every time, from its own stream, and seeds 1-20 give at least 8 distinct layouts', () => {
  for (const type of VARIANT_TYPES) {
    const picks = SEEDS.map((seed) => resolveVariant(type, 'seeded', seed));
    assert.deepEqual(SEEDS.map((seed) => resolveVariant(type, 'seeded', seed).id), picks.map((p) => p.id), `${type}: deterministic`);
    const distinct = new Set(picks.map((p) => `${p.columns.join(',')}|${p.labels}`)).size;
    console.log(`  ${type}: seeds 1-20 with seeded give ${distinct} distinct column orders or label sets`);
    assert.ok(distinct >= 8, `${type}: ${distinct}`);
    // the pick moves nothing else: the document's data equals the unvaried one
    const a = generateData({ type, scenario: 'baseline-clean', seed: '4' }); const b = generateData({ type, scenario: 'baseline-clean', seed: '4', layoutVariant: 'seeded' });
    const strip = (d) => { const x = { ...d }; delete x._variant; return JSON.stringify(x); };
    assert.equal(strip(b.data), strip(a.data), `${type}: data unchanged`);
  }
});

test('a varied key equals the unvaried key except the layout record and schema version, for every id', () => {
  for (const type of VARIANT_TYPES) for (const scenario of listScenarios(type)) for (const seed of ['1', '2']) {
    const plain = generateData({ type, scenario, seed }).groundTruth;
    assert.equal(plain.schemaVersion, '1.3'); assert.equal(plain.documents[0].layout, type); assert.equal('layoutVariant' in plain.documents[0], false);
    for (const id of variantIds(type)) {
      const g = generateData({ type, scenario, seed, layoutVariant: id }).groundTruth;
      assert.ok(validate(g), `${type}.${id}: ${JSON.stringify(validate.errors?.slice(0, 2))}`);
      assert.equal(g.schemaVersion, '1.4'); assert.equal(g.documents[0].layout, `${type}.${id}`);
      assert.deepEqual(g.documents[0].layoutVariant, { id, ...FAMILY[type].ids[id] });
      const x = JSON.parse(JSON.stringify(g)); x.schemaVersion = '1.3'; x.documents[0].layout = type; delete x.documents[0].layoutVariant;
      assert.deepEqual(x, plain, `${type}/${scenario}/${seed}.${id}: nothing else differs`);
    }
  }
});

test('schema 1.4: the 1.3 requirements hold, a varied document is required, and only 1.4 may carry one', () => {
  const g = generateData({ type: 'ppo-eob', scenario: 'baseline-clean', seed: '1', layoutVariant: 'p03' }).groundTruth;
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(g)); mut(x); return validate(x); };
  assert.equal(validate(g), true);
  assert.equal(bad((x) => { delete x.claims; }), false, 'a 1.4 key without claims');
  assert.equal(bad((x) => { delete x.deductibleMetBefore; }), false, 'a 1.4 key without deductibleMetBefore');
  assert.equal(bad((x) => { delete x.documents[0].layoutVariant; }), false, 'a 1.4 key with no varied document');
  assert.equal(bad((x) => { x.documents[0].layout = 'ppo-eob'; }), false, 'a varied document named like an unvaried one');
  assert.equal(bad((x) => { x.documents[0].layoutVariant.extra = 1; }), false, 'an unknown property in layoutVariant');
  assert.equal(bad((x) => { x.documents[0].layoutVariant.breaks = 'sideways'; }), false, 'an unknown continuation rule');
  assert.equal(bad((x) => { x.schemaVersion = '1.3'; }), false, 'a 1.3 key with a varied document');
  assert.equal(bad((x) => { x.schemaVersion = '1.2'; }), false, 'a 1.2 key with a varied document');
  const plain = generateData({ type: 'ppo-eob', scenario: 'baseline-clean', seed: '1' }).groundTruth;
  assert.equal(validate(plain), true);
  const mcp = fs.readFileSync(path.join(here, '../../mcp/resources/ground-truth.schema.json'), 'utf-8');
  assert.equal(mcp, fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'), 'both schema copies identical');
});

test('every refusal of a layout variant stops before anything is made and repeats nothing the caller passed', () => {
  const M = VARIANT_STRINGS.messages; const sec = 'zz-secret-7731';
  const refuse = (type, value, key, opts) => assert.throws(() => (opts ? checkVariantOption(type, value, opts) : generateData({ type, scenario: 'baseline-clean', seed: '1', layoutVariant: value })),
    (e) => { assert.equal(e.message, M[key]); assert.ok(!String(e.message).includes(sec)); return true; });
  for (const type of VARIANT_TYPES) {
    refuse(type, `${sec}`, 'variantUnknown'); refuse(type, '', 'variantEmpty'); refuse(type, 'x'.repeat(65), 'variantUnknown');
    for (const p of ['../p01', 'p01/..', 'p0\u0000', '..\\p01', `${sec}/x`]) refuse(type, p, 'variantUnknown');
    refuse(type, 'all', 'variantAllHere'); refuse(type, 42, 'variantUnknown'); refuse(type, {}, 'variantUnknown');
    for (const other of VARIANT_TYPES.filter((t) => t !== type)) refuse(type, variantIds(other)[0], 'variantUnknown');
    assert.equal(checkVariantOption(type, 'all', { allowAll: true }), 'all');
  }
  for (const v of ['p01', 'seeded', 'all']) refuse('msn', v, 'variantMsn');
  for (const k of Object.keys(M)) assert.ok(typeof M[k] === 'string' && M[k].length <= 110 && !/\.$/.test(M[k]), k);
});

test('colour pairs: the new palettes reach 3:1, and the 0.4.0 palettes keep their recorded ratios', () => {
  for (const type of VARIANT_TYPES) {
    const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
    const col = (pal, k) => (k.startsWith('#') ? k : pal[k]);
    assert.ok(STYLE_PAIRS[type].length >= 4, `${type}: pairs listed`);
    for (const p of ['p2', 'p3']) {
      const pal = { ...stock.colors, ...FAMILY[type].palettes[p] };
      for (const [fg, bg] of STYLE_PAIRS[type]) assert.ok(contrastRatio(col(pal, fg), col(pal, bg)) >= 3, `${type} ${p}: ${fg} on ${bg} is ${contrastRatio(col(pal, fg), col(pal, bg)).toFixed(2)}`);
      for (const [k, v] of Object.entries(FAMILY[type].palettes[p])) if (/Bg$|^zebra|Soft$|^sand$|^infoBg$|^noticeBg$|^groupHeaderBg$/.test(k) && contrastRatio(v, '#FFFFFF') < 1.6) {
        const [r, , b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); assert.ok(b >= r, `${type} ${p}: tint ${k} ${v} is neutral or cool`);
      }
    }
    const p1pal = { ...stock.colors, ...(P1_FIXED[type] || {}) };
    const p1 = Object.fromEntries(STYLE_PAIRS[type].map(([fg, bg]) => [`${fg} on ${bg}`, Math.round(contrastRatio(col(p1pal, fg), col(p1pal, bg)) * 100) / 100]));
    assert.deepEqual(p1, P1_RATIOS[type], `${type}: today's palette, as recorded`);
  }
});

// stress shapes: many lines, long descriptions, notes on every line, a claim or group that must continue
const stressClaims = (n, lines, long) => Array.from({ length: n }, (_, ci) => ({ claimNumber: `C${ci}`, lineItems: Array.from({ length: lines }, (_, li) => ({
  description: long ? 'Very long service description that wraps over several lines in the narrowest column of the table '.repeat(1 + (li % 2)) : `Service ${li}`, notes: [`N${(ci + li) % 4}`] })) }));
const stressNotes = [0, 1, 2, 3].map((i) => ({ id: `N${i}`, text: 'x' }));
test('the claim paginator places every line once, never strands a header or a total, for every MA id and stress shape', () => {
  for (const type of ['ppo-eob', 'hmo-eob']) for (const id of variantIds(type)) {
    const v = resolveVariant(type, id, '1'); const cfg = variantClaimLayout(type, v);
    for (const [n, lines, long] of [[1, 1, false], [3, 12, false], [2, 30, true], [6, 9, true], [1, 60, false]]) {
      const claims = stressClaims(n, lines, long); const pages = paginateClaims(claims, stressNotes, cfg);
      const placed = pages.flatMap((p) => p.blocks.flatMap((b) => b.lines.map((l) => l)));
      assert.equal(placed.length, n * lines, `${type}.${id} ${n}x${lines}`);
      for (const p of pages) for (const b of p.blocks) assert.ok(b.lines.length >= 1, `${type}.${id}: an empty block`);
      for (const c of claims) { const bs = pages.flatMap((p) => p.blocks).filter((b) => b.claim === c); assert.equal(bs.filter((b) => b.showTotals).length, 1); assert.ok(bs.at(-1).showTotals); }
    }
    assert.ok(cfg.claimHeaderCost > 0 && cfg.lineCost({ description: 'x' }) > 0);
  }
  // the unvaried settings are untouched
  assert.equal(CLAIM_LAYOUTS['ppo-eob'].continuedHeaderCost, undefined); assert.equal(CLAIM_LAYOUTS['hmo-eob'].continuedHeaderCost, undefined);
});

test('the bill paginator: bare equals the unvaried one; repeat and marker mark every group carried over, for every id', () => {
  for (const scenario of listScenarios('itemized-bill')) for (const seed of SEEDS) {
    const d = generateData({ type: 'itemized-bill', scenario, seed }).data;
    assert.deepEqual(paginateItemizedBillVariant(d, BILL_LAYOUT), paginateForItemizedBill(d), `${scenario}/${seed}`);
  }
  const big = { revenueCodeGroups: Array.from({ length: 5 }, (_, g) => ({ revCode: `0${g}00`, description: `Group ${g}`, subtotal: 1,
    lineItems: Array.from({ length: 18 + g * 7 }, (_, i) => ({ date: '2026-01-01', hcpcs: '99213', units: 1, description: i % 3 ? 'Short line' : 'A much longer description that wraps in the description column of the bill', amount: 1 })) })), grandTotal: 5 };
  for (const id of variantIds('itemized-bill')) {
    const v = resolveVariant('itemized-bill', id, '1'); const pages = paginateItemizedBillVariant(big, variantBillLayout(v));
    const blocks = pages.flatMap((p) => p.blocks.map((b) => ({ ...b, page: p.pageNumber })));
    assert.equal(blocks.filter((b) => b.type === 'line-item').length, big.revenueCodeGroups.reduce((t, g) => t + g.lineItems.length, 0), id);
    // a page opens a new group, the grand total alone, or a group carried over
    const carried = pages.slice(1).filter((p) => p.blocks[0].type !== 'grand-total' && (p.blocks[0].type !== 'group-header' || p.blocks[0].continued));
    assert.ok(carried.length >= 1, `${id}: the stress shape carries a group over`);
    for (const p of pages.slice(1)) if (!carried.includes(p)) assert.equal(pages[pages.indexOf(p) - 1].blocks.at(-1).type, 'subtotal', `${id}: a page that carries nothing follows a finished group`);
    for (const p of carried) {
      const prev = pages[pages.indexOf(p) - 1];
      assert.equal(prev.blocks.at(-1).type, 'continues-marker', `${id}: the page a group leaves says so`);
      if (v.breaks === 'repeat') assert.ok(p.blocks[0].type === 'group-header' && p.blocks[0].continued, `${id}: header repeated`);
      else assert.equal(p.blocks[0].type, 'continued-marker', `${id}: marker`);
    }
    assert.equal(blocks.at(-1).type, 'grand-total');
    // every line prints its own department code (the unvaried bill leaves the column blank)
    let group = null;
    for (const b of blocks) { if (b.type === 'group-header') group = b.revCode; if (b.type === 'line-item') assert.equal(b.revCode, group, `${id}: a line's department code`); }
  }
});

// The variant's style reaches the page: captured HTML (no browser) names the style's font in a declaration the browser
// can read (nothing escaped inside a style block), and every colour of a new palette prints somewhere in the document.
test('every id prints its font, a readable style block and every colour of its palette', async () => {
  const { RENDERERS } = await import('../src/index.js'); const { printHooks } = await import('../src/browser.js');
  const os = await import('os'); const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vstyle-'));
  const quiet = console.log; console.log = () => {};
  try {
    for (const type of VARIANT_TYPES) {
      const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
      for (const id of variantIds(type)) {
        const v = resolveVariant(type, id, '1'); const parts = [];
        printHooks.capture = (html) => parts.push(html);
        try { await RENDERERS[type](generateData({ type, scenario: 'baseline-clean', seed: '1', layoutVariant: id }).data, stock, work, { title: 't', band: 'b' }); } finally { printHooks.capture = null; }
        const all = parts.join('\n');
        assert.ok(all.includes(`font-family: ${v.styleDef.fontFamily}, 'Noto Sans', sans-serif;`), `${type}.${id}: the style's font`);
        for (const m of all.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) assert.ok(!/&#39;|&quot;|&amp;|&lt;/.test(m[1]), `${type}.${id}: an escaped character in a style block`);
        if (v.palette) for (const [k, c] of Object.entries(v.palette)) assert.ok(all.toUpperCase().includes(c.toUpperCase()), `${type}.${id}: palette ${k} ${c} never prints`);
      }
    }
  } finally { console.log = quiet; fs.rmSync(work, { recursive: true, force: true }); }
});

// Every cell under its own header, on every id: the captured HTML of each variant (no browser) is read as tables and
// compared, row by row, with the unvaried document of the same data, whose column order is today's. A header cell names
// the variant's label for its column; a line's cell holds what the unvaried layout prints in that column (the HMO's
// service cell with its sub-line in the variant's order, the bill's department cell with the line's group code); a
// totals row puts each amount under its column and the label over the identity columns.
const UNVARIED = { 'ppo-eob': COLUMNS['ppo-eob'], 'hmo-eob': ['service(code,date)', 'charged', 'approved', 'paid', 'owe', 'notes'], 'itemized-bill': COLUMNS['itemized-bill'] };
const TABLE = { 'ppo-eob': 'cv-lines', 'hmo-eob': 'ts-lines', 'itemized-bill': 'charges-table' };
const BILL_LABEL = { dept: 'columnRevCode', date: 'columnDate', hcpcs: 'columnHcpcs', units: 'columnUnits', description: 'columnDescription', charge: 'columnAmount' };
const labelOf = (type, set, c) => (type === 'itemized-bill' ? set[`labels.${BILL_LABEL[c]}`] : set[`columns.${base(c)}`]);
const cellText = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&raquo;/g, '»').replace(/\s+/g, ' ').trim();
function rowsOf(html, cls) {
  const rows = [];
  for (const t of html.matchAll(new RegExp(`<table class="${cls}"[^>]*>([\\s\\S]*?)</table>`, 'g')))
    for (const r of t[1].matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[2].matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t[dh]>/g)].map((c) => ({ th: c[1] === 'h', span: Number((/colspan="(\d+)"/.exec(c[2]) || [])[1] || 1), text: cellText(c[3]) }));
      rows.push({ cls: (/class="([^"]*)"/.exec(r[1]) || [])[1] || '', cells, spread: cells.flatMap((c) => Array(c.span).fill(c.text)) });
    }
  return rows;
}
const kind = (type, r) => {
  if (r.cells.length && r.cells.every((c) => c.th) || r.cls === 'col-header-row') return 'header';
  if (type === 'itemized-bill') return r.cls.startsWith('line-item-row') ? 'line' : r.cls;
  return r.cls === 'total' ? 'total' : 'line';
};
test('every id puts each cell under its own header, as the unvaried layout prints that column, in every scenario', async () => {
  const { RENDERERS } = await import('../src/index.js'); const { printHooks } = await import('../src/browser.js');
  const os = await import('os'); const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vcells-'));
  const capture = async (type, stock, data) => { const parts = []; printHooks.capture = (h) => parts.push(h); try { await RENDERERS[type](data, stock, work, { title: 't', band: 'b' }); } finally { printHooks.capture = null; } return parts.join('\n'); };
  const quiet = console.log; console.log = () => {}; let compared = 0;
  try {
    for (const type of VARIANT_TYPES) {
      const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
      const baseSet = LABELS[type].base; const U = UNVARIED[type];
      for (const scenario of listScenarios(type)) {
        const plain = rowsOf(await capture(type, stock, generateData({ type, scenario, seed: '1' }).data), TABLE[type]);
        const pLines = plain.filter((r) => kind(type, r) === 'line'); const pTotals = plain.filter((r) => kind(type, r) === 'total');
        for (const id of variantIds(type)) {
          const v = resolveVariant(type, id, '1'); const set = LABELS[type][v.labels]; const where = `${type}.${id}/${scenario}`;
          let rows = rowsOf(await capture(type, stock, generateData({ type, scenario, seed: '1', layoutVariant: id }).data), TABLE[type]);
          // the bill's continuation rows (a repeated group header, the markers) have no unvaried twin
          if (type === 'itemized-bill') rows = rows.filter((r) => !r.cls.startsWith('group-marker-row') && !(r.cls === 'group-header-row' && r.cells[0].text.endsWith(` ${set['labels.groupContinuedFrom']}`)));
          for (const r of rows.filter((x) => kind(type, x) === 'header')) {
            assert.deepEqual(r.cells.map((c) => c.text), v.columns.map((c) => labelOf(type, set, c)), `${where}: header`);
            if (v.labels === 'base') assert.deepEqual(r.cells.map((c) => c.text), v.columns.map((c) => plain.find((x) => kind(type, x) === 'header').cells[U.indexOf(c === 'service(date,code)' ? 'service(code,date)' : c)].text), `${where}: header as unvaried`);
          }
          const lines = rows.filter((x) => kind(type, x) === 'line'); assert.equal(lines.length, pLines.length, `${where}: line rows`);
          let group = null; const groups = rows.filter((x) => x.cls === 'group-header-row');
          for (const r of rows) {
            if (r.cls === 'group-header-row') group = r.cells[0].text.split(' ')[0];
            if (kind(type, r) !== 'line') continue;
            const p = pLines[lines.indexOf(r)]; const map = Object.fromEntries(U.map((c, i) => [c, p.cells[i].text]));
            assert.equal(r.cells.length, v.columns.length, `${where}: cells in a line row`);
            v.columns.forEach((c, k) => {
              let want = map[c];
              if (type === 'hmo-eob' && c.startsWith('service(')) {
                const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const m = new RegExp(`^(.*) ${esc(baseSet['claims.codeLabel'])} (\\S+) \\| ${esc(baseSet['claims.dateLabel'])} (\\S+)$`).exec(map['service(code,date)']);
                assert.ok(m, `${where}: unvaried service cell`);
                const [code, date] = [`${set['claims.codeLabel']} ${m[2]}`, `${set['claims.dateLabel']} ${m[3]}`];
                want = `${m[1]} ${c === 'service(code,date)' ? `${code} | ${date}` : `${date} | ${code}`}`;
              }
              if (type === 'itemized-bill' && c === 'dept') { assert.equal(map.dept, '', 'the unvaried bill leaves the department cell blank'); want = group; }
              assert.equal(r.cells[k].text, want, `${where}: line cell ${k} (${c})`);
            });
          }
          if (type === 'itemized-bill') {
            assert.deepEqual(groups.map((g) => g.cells[0].text), plain.filter((x) => x.cls === 'group-header-row').map((g) => g.cells[0].text), `${where}: group headers`);
            for (const [cls, key] of [['subtotal-row', 'labels.subtotalLabel'], ['grand-total-row', 'labels.totalChargesLabel']]) {
              const mine = rows.filter((x) => x.cls === cls); const theirs = plain.filter((x) => x.cls === cls);
              assert.deepEqual(mine.map((x) => x.spread), theirs.map((x) => [...Array(5).fill(set[key]), x.spread[5]]), `${where}: ${cls}`);
            }
          } else {
            const totals = rows.filter((x) => kind(type, x) === 'total'); assert.equal(totals.length, pTotals.length, `${where}: totals rows`);
            totals.forEach((r, i) => {
              const p = Object.fromEntries(U.map((c, k) => [c, pTotals[i].spread[k]]));
              assert.equal(r.spread.length, v.columns.length, `${where}: a totals row spans the table`);
              v.columns.forEach((c, k) => {
                const ident = ['date', 'service', 'code'].includes(c) || c.startsWith('service(');
                const want = !ident ? p[c] : type === 'ppo-eob' ? p.date.replace(baseSet['claims.totalLabel'], set['claims.totalLabel']) : set['claims.totalLabel'];
                assert.equal(r.spread[k], want, `${where}: totals cell ${k} (${c})`);
              });
            });
          }
          compared++;
        }
      }
    }
  } finally { console.log = quiet; fs.rmSync(work, { recursive: true, force: true }); }
  assert.ok(compared >= 36 * 5, `${compared} documents compared`);
});
