// Layout variants, rendered: one document per variant id (36), each a stress-shaped document with planted errors, so
// one render checks the markers, the planned page count, the continuation marking and that every error prints its
// recorded value where its variant puts the column. For each type, the first id of each palette is also degraded
// (low-res) and the watermark measured on its claims or charges page. Every operation on every id, a second render
// per id and the other presets are left out of this suite to keep its run time down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { generateData, RENDERERS, launchBrowser, findChrome, SPECIMEN_SUBJECT, degradePdf, degradationParams } from '../src/index.js';
import { measureWatermark } from './watermark-measure.js';
import { VARIANT_TYPES, variantIds, resolveVariant, variantStock } from '../src/variants.js';
import { paginateClaims, variantClaimLayout } from '../src/render-ma.js';
import { paginateItemizedBillVariant, variantBillLayout } from '../src/render.js';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const money = (n) => '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const short = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; };
// the stress shapes: enough lines that a claim or a department group runs onto the next page, with errors planted
const SHAPE = {
  'ppo-eob': { claimCount: 6, claimShapes: ['OPH', 'FP', 'RAD', 'LAB', 'LAB', 'LAB'], mutations: [
    { op: 'ma-duplicate-line', args: { claim: 0, line: 0 } }, { op: 'ma-cost-share-on-exempt-line', args: { claim: 1, line: 0 } }, { op: 'ma-break-claim-total', args: { claim: 2, field: 'patientMayBeBilled', by: 15 } }] },
  'hmo-eob': { claimCount: 6, claimShapes: ['PT', 'LAB', 'RAD', 'LAB', 'LAB', 'LAB'], mutations: [
    { op: 'ma-duplicate-line', args: { claim: 0, line: 0 } }, { op: 'ma-cost-share-on-exempt-line', args: { claim: 1, line: 0 } }, { op: 'ma-break-claim-total', args: { claim: 2, field: 'paid', by: 12 } }] },
  'itemized-bill': { claimCount: 6, claimShapes: ['LAB', 'IM', 'LAB', 'CARD', 'LAB', 'IM'], mutations: [
    { op: 'duplicate-line', args: { claim: 0, line: 0 } }, { op: 'break-claim-total', args: { claim: 1, field: 'amountProviderCharged', by: 25 }, kind: 'subtotals-mismatch', rule: 'internal consistency' }] },
};
const pages = (pdf) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
const pageText = (pdf, p) => execFileSync('pdftotext', ['-layout', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' });

// words whose box reaches into the band (the bottom 11 pt) must be the band's own words
function bandIntruders(pdf, bandWords) {
  const xml = execFileSync('pdftotext', ['-bbox-layout', pdf, '-'], { encoding: 'utf-8' });
  const out = [];
  for (const pg of xml.split('<page ').slice(1)) {
    const H = Number(/height="([\d.]+)"/.exec(pg)[1]);
    for (const m of pg.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
      const [y0, y1, w] = [Number(m[1]), Number(m[2]), m[3]];
      if (y1 > H - 11 && !bandWords.has(w)) out.push(w);
    }
  }
  return out;
}

// The stress shape of one id: the planted errors' claims first, then lab claims until the variant's own paginator carries
// a claim or a department group over to the next page (found at data level, so every id renders one continuation).
function continues(type, data, v) {
  if (type === 'itemized-bill') return paginateItemizedBillVariant(data, variantBillLayout(v)).slice(1).some((p) => p.blocks[0].type === 'continued-marker' || p.blocks[0].continued);
  return paginateClaims(data.claims, data.notes || [], variantClaimLayout(type, v)).flatMap((p) => p.blocks).some((b) => b.continuedFromPrev);
}
function stressFor(type, id, v) {
  const sh = SHAPE[type];
  // the EOBs keep six claims (their cover lists every claim and holds no more); the bill takes more department groups
  for (let k = 1; k <= 9; k++) for (let n = sh.claimCount; n <= (type === 'itemized-bill' ? 16 : sh.claimCount); n++) {
    const overrides = { ...sh, claimCount: n, claimShapes: [...sh.claimShapes, ...Array(n - sh.claimShapes.length).fill('LAB')] };
    const seed = `var-${k}`; const g = generateData({ type, scenario: 'baseline-clean', seed, overrides, layoutVariant: id });
    if (continues(type, g.data, v)) return { ...g, seed };
  }
  return null;
}
// The amounts a printed row holds, left to right
const amounts = (line) => line.match(/\$[\d,]+\.\d{2}/g) || [];
// what each money column of a line or a claim's totals prints, in the columns' order (the model's, on every variant)
const LINE_MONEY = { 'ppo-eob': ['providerBilled', 'planApproved', 'planShare', 'yourShare'], 'hmo-eob': ['providersCharged', 'planApproved', 'amountPlanPaid', 'maxYouMayBeBilled'] };

test('every layout variant id renders with its markers, its planned pages, its continuation marks and its errors in place', { skip, timeout: 1200000 }, async () => {
  const browser = await launchBrowser(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-var-'));
  const quiet = console.log; console.log = () => {};
  let continued = 0; const degraded = new Set();
  try {
    for (const type of VARIANT_TYPES) {
      const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
      for (const id of variantIds(type)) {
        const where = `${type}.${id}`; const v = resolveVariant(type, id, 'var-1'); const s = variantStock(type, stock, v);
        const shaped = stressFor(type, id, v); assert.ok(shaped, `${where}: no stress shape (seeds var-1 to var-9; the bill up to 16 claims) continues on this variant`);
        const { data, groundTruth: gt, seed } = shaped;
        const band = `${where} / stress / seed ${seed}`;
        const pdf = await RENDERERS[type](data, stock, fs.mkdtempSync(path.join(tmp, 'w')), { title: `claimseed specimen - ${where}`, band, browser });
        // markers: metadata, the band on every page naming the variant, nothing else inside the band
        const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' });
        assert.ok(info.includes(SPECIMEN_SUBJECT.slice(0, 40)), `${where}: subject`); assert.match(info, /Producer:\s+claimseed/); assert.ok(info.includes(where), `${where}: title`);
        const n = pages(pdf); assert.equal(n, data.metadata.pageCount, `${where}: planned pages`);
        const ps = { inter: 'Inter-', 'noto-sans': 'NotoSans-', 'noto-serif': 'NotoSerif-' }[v.styleDef.font];
        assert.ok(execFileSync('pdffonts', [pdf], { encoding: 'utf-8' }).includes(`+${ps}`), `${where}: the style's font is embedded`);
        const texts = Array.from({ length: n }, (_, i) => pageText(pdf, i + 1));
        for (const [i, t] of texts.entries()) { assert.match(t, /SYNTHETIC SPECIMEN/, `${where} p${i + 1}: band`); assert.ok(t.includes(where), `${where} p${i + 1}: the band names the variant`); }
        const bandWords = new Set(`SYNTHETIC SPECIMEN - generated by claimseed for software testing - not a real document - ${band}`.split(/\s+/));
        assert.deepEqual(bandIntruders(pdf, bandWords), [], `${where}: words inside the band`);
        const all = texts.join('\n'); const lines = all.split('\n');
        // continuation: the paginator's plan, and the page shows the variant's marking
        if (type === 'itemized-bill') {
          const plan = paginateItemizedBillVariant(data, variantBillLayout(v));
          const carry = plan.slice(1).filter((p) => p.blocks[0].type === 'continued-marker' || p.blocks[0].continued);
          assert.ok(carry.length >= 1, `${where}: a group carried over`); continued++;
          assert.ok(all.includes(s.labels.groupContinuesOn), `${where}: continues line`); assert.ok(all.includes(s.labels.groupContinuedFrom), `${where}: continued mark`);
          // a carried group repeats its header (repeat) or prints the marker alone (marker) at the top of the next page
          for (const pg of carry) {
            const top = texts[pg.pageNumber - 1].split('\n'); const g = data.revenueCodeGroups.find((x) => pg.blocks[0].type === 'group-header' ? x.revCode === pg.blocks[0].revCode : true);
            const headerAgain = top.some((l) => l.includes(`${g.revCode}`) && l.includes(s.labels.groupContinuedFrom));
            assert.equal(headerAgain, v.breaks === 'repeat', `${where} p${pg.pageNumber}: the group header ${v.breaks === 'repeat' ? 'repeated' : 'not repeated'}`);
          }
        } else {
          const plan = paginateClaims(data.claims, data.notes || [], variantClaimLayout(type, v));
          const cont = plan.flatMap((p) => p.blocks).filter((b) => b.continuedFromPrev);
          assert.ok(cont.length >= 1, `${where}: a claim carried over`);
          {
            continued++;
            const mark = type === 'ppo-eob' ? `(${s.claims.continuedFrom})` : s.claims.continuedFrom;
            assert.ok(all.includes(mark), `${where}: continued mark`);
            const heads = (b) => lines.filter((l) => l.includes(b.claim.claimNumber) && !/\$\d/.test(l)).length;
            for (const b of cont) assert.ok(v.breaks === 'repeat' ? heads(b) >= 2 : heads(b) >= 1, `${where}: claim header ${v.breaks}`);
          }
        }
        // the watermark on a degraded copy, once per palette of the type, on the first claims or charges page
        if (!degraded.has(`${type}/${v.styleDef.palette}`)) {
          degraded.add(`${type}/${v.styleDef.palette}`);
          const params = degradationParams('low-res', { type, scenario: 'baseline-clean', seed });
          const { pdf: low, pictures } = await degradePdf(browser, fs.readFileSync(pdf), { preset: 'low-res', params, label: band, keepPictures: true });
          const m = await measureWatermark(browser, low, pictures[1], 2, `${band} / low-res`);
          assert.ok(m.maskPixels > 500 && m.tintIn > 8 && Math.abs(m.tintOut) < 3, `${where} (${v.styleDef.palette}): watermark ${JSON.stringify(m)}`);
          assert.ok(m.bandBackground > 0.6 && m.bandDark > 40, `${where}: band ${JSON.stringify(m)}`);
        }
        // every line and totals row, read as printed: its amounts are the data's, one per money column, in the columns'
        // order; a row that loses a cell, or prints two columns' cells swapped, fails here
        if (type === 'itemized-bill') {
          for (const g of data.revenueCodeGroups) for (const it of g.lineItems) {
            const rows = lines.filter((x) => x.includes(it.date) && x.includes(it.hcpcs) && x.includes(g.revCode) && amounts(x).length);
            assert.ok(rows.length >= 1 && rows.every((x) => amounts(x).length === 1), `${where}: the row of ${it.hcpcs} on ${it.date} (one amount, its department code)`);
            assert.ok(rows.some((x) => amounts(x)[0] === money(it.amount)), `${where}: ${it.hcpcs} prints its charge`);
          }
        } else {
          for (const c of data.claims) {
            for (const l of c.lineItems) {
              const code = type === 'ppo-eob' ? l.cptCode : l.billingCode;
              let rows;
              if (type === 'ppo-eob') rows = lines.filter((x) => x.includes(l.dateOfService) && x.includes(code) && amounts(x).length);
              else rows = lines.map((x, i) => (x.includes(`${s.claims.codeLabel} ${code}`) && x.includes(`${s.claims.dateLabel} ${l.dateOfService}`) ? i : -1)).filter((i) => i >= 0)
                .map((i) => { let k = i; while (k >= 0 && !amounts(lines[k]).length) k--; return lines[k]; });
              assert.ok(rows.length >= 1 && rows.every((x) => amounts(x).length === 4), `${where}: a ${code} row with an amount under each of the four money columns`);
              assert.ok(rows.some((x) => JSON.stringify(amounts(x)) === JSON.stringify(LINE_MONEY[type].map((f) => money(l[f])))), `${where}: ${code} prints its amounts in the columns' order`);
            }
            const tl = type === 'ppo-eob' ? lines.filter((x) => x.includes(`${s.claims.totalLabel}, ${c.claimNumber}`)) : null;
            if (tl) { assert.equal(tl.length, 1, `${where}: one totals row for ${c.claimNumber}`); assert.deepEqual(amounts(tl[0]), LINE_MONEY[type].map((f) => money(c.claimTotal[f])), `${where}: ${c.claimNumber} totals in the columns' order`); }
          }
          if (type === 'hmo-eob') {
            const tot = lines.filter((x) => x.includes(s.claims.totalLabel) && amounts(x).length);
            assert.deepEqual(tot.map(amounts), data.claims.map((c) => LINE_MONEY[type].map((f) => money(c.claimTotal[f]))), `${where}: every claim's totals row, in the columns' order`);
          }
        }
        // errors: each prints its recorded value where the variant puts it
        for (const e of gt.errors) {
          if (e.kind === 'duplicate-charge') {
            const l = gt.claims[Number(/^claims\[(\d+)\]/.exec(e.lineRef)[1])].lines[Number(/lines\[(\d+)\]/.exec(e.lineRef)[1])];
            const d = type === 'itemized-bill' ? data.revenueCodeGroups.flatMap((g) => g.lineItems).find((x) => x.hcpcs === l.code).date : short(l.dateOfService);
            const twice = type === 'hmo-eob' ? lines.filter((x) => x.includes(`${s.claims.codeLabel} ${l.code}`) && x.includes(`${s.claims.dateLabel} ${d}`)).length
              : lines.filter((x) => x.includes(d) && x.includes(l.code)).length;
            assert.equal(twice, 2, `${where}: the duplicate prints twice`);
          } else if (e.kind === 'math-error' || e.kind === 'subtotals-mismatch') {
            assert.ok(lines.some((x) => x.includes(money(e.actual))), `${where}: the shifted total ${money(e.actual)} prints`);
          } else {
            assert.ok(lines.some((x) => x.includes(money(e.actual))), `${where}: ${e.kind} prints ${money(e.actual)}`);
          }
        }
      }
    }
  } finally { console.log = quiet; await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(continued, 36, 'every id carries a claim or a group over');
  assert.equal(degraded.size, 9, 'every palette of every type degraded once');
});

// Contrast as printed: for the first id of each palette of each type, every text node of every page part is read in the
// browser with its computed colour and the colour of the nearest painted background behind it. A pair that also prints
// on the 0.4.0 palette (p1) is unchanged by the variant; every other pair a new palette prints must reach 3:1 and be one
// of the pairs src/variants.js lists (STYLE_PAIRS), so the list cannot miss a pair a template prints.
test('every text colour a new palette prints reaches 3:1 on its background, and is listed', { skip, timeout: 600000 }, async () => {
  const { printHooks } = await import('../src/browser.js');
  const { STYLE_PAIRS, contrastRatio } = await import('../src/variants.js');
  const browser = await launchBrowser(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-contrast-'));
  const quiet = console.log; console.log = () => {};
  const problems = [];
  const hex = (rgb) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb); return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('').toUpperCase(); };
  try {
    for (const type of VARIANT_TYPES) {
      const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
      const printed = {};
      for (const pal of ['p1', 'p2', 'p3']) {
        const id = variantIds(type).find((x) => resolveVariant(type, x, '1').styleDef.palette === pal);
        const parts = []; printHooks.capture = (h) => parts.push(h);
        try { await RENDERERS[type](generateData({ type, scenario: 'baseline-clean', seed: '1', layoutVariant: id }).data, stock, tmp, { title: 't', band: 'b' }); } finally { printHooks.capture = null; }
        const pairs = new Set();
        for (const html of parts) {
          const page = await browser.newPage();
          try {
            await page.setContent(html, { waitUntil: 'load' });
            for (const [fg, bg] of await page.evaluate(() => {
              const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              for (let n = w.nextNode(); n; n = w.nextNode()) {
                if (!n.textContent.trim()) continue; const el = n.parentElement; const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
                let b = el; let bg = 'rgb(255, 255, 255)';
                while (b) { const c = getComputedStyle(b).backgroundColor; if (!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c)) { bg = c; break; } b = b.parentElement; }
                out.push([cs.color, bg]);
              }
              return out;
            })) pairs.add(`${hex(fg)} on ${hex(bg)}`);
          } finally { await page.close(); }
        }
        printed[pal] = { id, pairs };
      }
      const fam = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/variants.json`), 'utf-8'));
      for (const pal of ['p2', 'p3']) {
        const colors = { ...stock.colors, ...fam.palettes[pal] }; const col = (k) => (k.startsWith('#') ? k : colors[k]).toUpperCase();
        const listed = new Set(STYLE_PAIRS[type].map(([f, b]) => `${col(f)} on ${col(b)}`));
        for (const pair of printed[pal].pairs) {
          if (printed.p1.pairs.has(pair)) continue;   // also printed by today's palette: not the variant's
          const [f, b] = pair.split(' on ');
          if (contrastRatio(f, b) < 3) problems.push(`${type}.${printed[pal].id} (${pal}): ${pair} is ${contrastRatio(f, b).toFixed(2)}:1`);
          if (!listed.has(pair)) problems.push(`${type}.${printed[pal].id} (${pal}): ${pair} prints but no STYLE_PAIRS entry gives it`);
        }
      }
    }
  } finally { console.log = quiet; await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.deepEqual(problems, [], 'printed colour pairs');
});
