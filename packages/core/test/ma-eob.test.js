// Medicare Advantage EOB layouts (ppo-eob, hmo-eob): figures reconcile, the rendered pages say what the data says,
// a clean statement never talks about denials, page numbering matches the finished PDF, and the claim paginator
// keeps its promises (no orphaned claim header, no claim total alone on a page, honest "continued" labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findChrome } from '../src/browser.js';
import { watermarkRectsPerPage } from './helpers.js';
import { generateData } from '../src/generate/index.js';
import { paginateClaims, CLAIM_LAYOUTS } from '../src/render-ma.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const SEEDS = ['ma-r1', 'ma-r2', 'ma-r3'];
const near = (a, b) => Math.abs(a - b) < 0.005;
const money = (n) => '$' + Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// The four amounts of a summary block, named per layout: billed, approved, plan paid, member share.
const KEYS = {
  'ppo-eob': ['providerBilled', 'planApproved', 'planShare', 'yourShare'],
  'hmo-eob': ['providersCharged', 'planApproved', 'amountPlanPaid', 'maxYouMayBeBilled'],
};

function checkReconciles(type, data) {
  const [billed, approved, paid, member] = KEYS[type];
  const fsum = data.financialSummary;
  for (const blk of [fsum.monthly, fsum.ytd]) {
    assert.ok(blk[billed] + 0.005 >= blk[approved], `${type} ${blk.label}: billed ${blk[billed]} < approved ${blk[approved]}`);
    assert.ok(near(blk[approved], blk[paid] + blk[member]), `${type} ${blk.label}: approved ${blk[approved]} != plan ${blk[paid]} + member ${blk[member]}`);
    for (const k of KEYS[type]) assert.ok(blk[k] >= 0, `${type} ${blk.label}: negative ${k}`);
  }
  for (const k of KEYS[type]) assert.ok(fsum.ytd[k] + 0.005 >= fsum.monthly[k], `${type}: year-to-date ${k} below this month`);
  // the month is the sum of its claims, and each claim is the sum of its lines
  for (const k of KEYS[type]) {
    assert.ok(near(fsum.monthly[k], data.claims.reduce((s, c) => s + c.claimTotal[k], 0)), `${type}: monthly ${k} != sum of claims`);
    for (const c of data.claims) assert.ok(near(c.claimTotal[k], c.lineItems.reduce((s, l) => s + l[k], 0)), `${type} ${c.claimNumber}: total ${k} != sum of lines`);
  }
  assert.ok(fsum.oopUsed <= fsum.oopMax, `${type}: oopUsed ${fsum.oopUsed} > oopMax ${fsum.oopMax}`);
  assert.ok(near(fsum.ytd[member], fsum.oopUsed), `${type}: year-to-date member share ${fsum.ytd[member]} != out-of-pocket used ${fsum.oopUsed}`);
  if (type === 'ppo-eob') assert.ok(fsum.deductibleMet <= fsum.deductible, 'ppo-eob: deductibleMet > deductible');
}

test('MA EOB summary figures reconcile for several seeds', () => {
  for (const type of Object.keys(KEYS)) for (const seed of [...SEEDS, 'ma-r4', 'ma-r5', 'ma-r6']) {
    checkReconciles(type, generateData({ type, scenario: 'baseline-clean', seed }).data);
  }
});

// ---------- paginator ----------
function fakeClaims(shape) {
  return shape.map((n, ci) => ({ claimNumber: `CSTEST${ci}`, lineItems: Array.from({ length: n }, (_, li) => ({ description: li % 3 ? 'Short service' : 'Return visit with your doctor, low complexity', notes: [li % 2 ? 'A1' : 'B1'] })) }));
}
for (const type of Object.keys(CLAIM_LAYOUTS)) {
  test(`${type} paginator: headers and totals never orphaned, continued labels honest`, () => {
    const notes = [{ id: 'A1', text: 'a' }, { id: 'B1', text: 'b' }];
    for (const shape of [[1], [5, 5, 5, 5, 5, 5], [1, 1, 1, 1, 1, 1], [2, 5, 1, 4, 3, 5], [12], [3, 30, 2], [5, 4, 5, 4, 5, 4, 5, 4]]) {
      const claims = fakeClaims(shape);
      const pages = paginateClaims(claims, notes, CLAIM_LAYOUTS[type]);
      const seen = claims.map(() => 0);
      pages.forEach((p, pi) => {
        assert.ok(p.blocks.length > 0, `page ${pi} empty`);
        for (const [bi, b] of p.blocks.entries()) {
          assert.ok(b.lines.length >= 1, `shape ${shape}: page ${pi} block ${bi} has a header and no lines`);
          // continuedFromPrev only on the first block of a page, and only if the same claim ended the previous page
          if (b.continuedFromPrev) {
            assert.equal(bi, 0, 'continued block not first on its page');
            const prev = pages[pi - 1].blocks.at(-1);
            assert.equal(prev.claimIndex, b.claimIndex); assert.ok(prev.continuesNext);
          } else assert.equal(seen[b.claimIndex], 0, 'a claim restarted without a continued label');
          if (b.continuesNext) { assert.equal(bi, p.blocks.length - 1); assert.ok(pages[pi + 1].blocks[0].continuedFromPrev); assert.ok(!b.showTotals); }
          if (b.showTotals) assert.equal(seen[b.claimIndex] + b.lines.length, claims[b.claimIndex].lineItems.length, 'totals shown before the last line');
          seen[b.claimIndex] += b.lines.length;
        }
        // every note used on the page is listed on the page, and none that is not used
        const used = new Set(p.blocks.flatMap((b) => b.lines.flatMap((l) => l.notes)));
        assert.deepEqual(p.notes.map((n) => n.id).sort(), [...used].sort());
      });
      assert.deepEqual(seen, shape, 'every line placed exactly once');
      assert.equal(pages.flatMap((p) => p.blocks).filter((b) => b.showTotals).length, claims.length, 'one totals row per claim');
    }
  });
}

// ---------- rendered output ----------
function render(dir, type, scenario, seed) {
  execFileSync(process.execPath, [CLI, 'render', type, scenario, '--seed', seed, '--out', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
  const base = path.join(dir, `${type}_${scenario}_${seed}`);
  return { pdf: base + '.pdf', gt: JSON.parse(fs.readFileSync(base + '.ground-truth.json', 'utf-8')) };
}
const rawText = (pdf, p) => execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' });
const pageText = (pdf, p) => execFileSync('pdftotext', ['-layout', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' });

for (const type of Object.keys(KEYS)) {
  test(`${type}/baseline-clean renders for ${SEEDS.length} seeds: page numbering, figures, specimen marks, no denial wording`, { skip }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ma-'));
    try {
      for (const seed of SEEDS) {
        const { pdf, gt } = render(dir, type, 'baseline-clean', seed);
        const { data } = generateData({ type, scenario: 'baseline-clean', seed });
        assert.equal(data.hasDenial, false);
        const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
        assert.equal(gt.documents[0].pages, pages, `${type}@${seed}: ground truth page count`);
        assert.equal(gt.documents[0].fields['metadata.pageCount'], pages);
        const texts = Array.from({ length: pages }, (_, i) => pageText(pdf, i + 1));
        const rects = await watermarkRectsPerPage(pdf);
        texts.forEach((t, i) => {
          const marks = [...t.matchAll(/Page\s+(\d+)\s+of\s+(\d+)/g)];
          assert.ok(marks.length >= 1, `${type}@${seed}: page ${i + 1} has no page number`);
          for (const m of marks) assert.deepEqual([Number(m[1]), Number(m[2])], [i + 1, pages], `${type}@${seed}: page ${i + 1} prints "${m[0]}"`);
          // band (text) + watermark (shapes) + the header SPECIMEN badge
          const squashed = rawText(pdf, i + 1).replace(/\s+/g, '');
          assert.ok(squashed.includes('SYNTHETICSPECIMEN'), `${type}@${seed}: page ${i + 1} lacks the band`);
          assert.ok(squashed.replace(/SYNTHETICSPECIMEN/g, '').replace(new RegExp(data.metadata.memberName.replace(/\s+/g, ''), 'g'), '').includes('SPECIMEN'), `${type}@${seed}: page ${i + 1} lacks the SPECIMEN badge`);
          assert.ok(rects[i] >= 100, `${type}@${seed}: page ${i + 1} lacks the watermark`);
        });
        const all = texts.join('\n');
        assert.ok(!/denied|denial/i.test(all), `${type}@${seed}: clean statement mentions a denial`);
        assert.match(texts[0], /Synthetic test document\s+.\s+not issued by any health plan/);
        assert.match(all, /THIS IS NOT A BILL/i);
        // every claim number and claim total reached the page (catches clipped overflow)
        for (const c of data.claims) {
          assert.ok(all.includes(c.claimNumber), `${type}@${seed}: claim ${c.claimNumber} missing`);
          for (const l of c.lineItems) assert.ok(all.includes(l.cptCode || l.billingCode), `${type}@${seed}: line ${l.cptCode || l.billingCode} missing`);
        }
        for (const k of KEYS[type]) {
          assert.ok(texts[0].includes(money(data.financialSummary.monthly[k])), `${type}@${seed}: cover lacks monthly ${k}`);
          assert.ok(texts[0].includes(money(data.financialSummary.ytd[k])), `${type}@${seed}: cover lacks year-to-date ${k}`);
        }
        assert.ok(texts[0].includes(money(data.financialSummary.oopMax)) && texts[0].includes(money(data.financialSummary.oopUsed)), `${type}@${seed}: out-of-pocket progress missing`);
        assert.ok(all.includes('1-800-MEDICARE') && all.includes(data.metadata.issuer.phone), `${type}@${seed}: contact lines missing`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
