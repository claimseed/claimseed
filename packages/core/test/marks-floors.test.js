// The specimen marks' floors (set with the watermark's 7% opacity) on the clean PDFs: every document type, both
// commercial insurers, the provider's statement beside each EOB type, and a layout variant of each variant type.
// The band, read from the stamp's drawing operators: the full page width, at least 9 pt tall, its text at least 6 pt
// (21 CFR 201.66(d)(2): no smaller than 6-point type for printed consumer drug information), at least 4.5:1 contrast
// (WCAG 2.2 SC 1.4.3). The watermark, on every page: readable contrast on plain paper and its reach across the page and
// its printed rows (test/watermark-contrast.js). And the measure itself: a watermark drawn at 0.05 on grey paper falls
// under the floor, at the opacity the code uses it does not, and a clipped, missing or misplaced watermark fails its
// reach. Degraded copies: test/degrade.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { findChrome, launchBrowser, render, finalizePdf, degradePdf, degradationParams } from '../src/index.js';
import { drawWatermark, markHeights, WATERMARK_OPACITY } from '../src/render.js';
import { copyMarks } from '../src/degrade.js';
import { watermarkContrast, belowFloors, FLOORS } from './watermark-contrast.js';
import { bandsOf } from './helpers.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser; let dir;
before(async () => { if (!skip) { browser = await launchBrowser(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-marks-')); } });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const CASES = [['msn', 'combined-three-errors', {}], ['itemized-bill', 'duplicate-charge', {}], ['ppo-eob', 'baseline-clean', {}], ['hmo-eob', 'baseline-clean', {}],
  ['commercial-eob', 'baseline-clean', { insurer: 'a' }], ['commercial-eob', 'baseline-clean', { insurer: 'b' }],
  ['itemized-bill', 'baseline-clean', { layoutVariant: 'seeded' }], ['ppo-eob', 'baseline-clean', { layoutVariant: 'seeded' }], ['hmo-eob', 'baseline-clean', { layoutVariant: 'seeded' }]];

test('every clean document and statement: the band and the watermark on every page above their floors', { skip, timeout: 600000 }, async () => {
  for (const [type, scenario, o] of CASES) {
    const paired = ['ppo-eob', 'hmo-eob', 'commercial-eob'].includes(type) && !o.layoutVariant;
    const r = await render({ type, scenario, seed: 'marks-t', ...o, ...(paired ? { also: ['bill'] } : {}), outDir: fs.mkdtempSync(path.join(dir, 'r-')), browser });
    const name = `${type}${o.insurer ? `.${o.insurer}` : ''}${o.layoutVariant ? ' variant' : ''}`;
    for (const [what, bytes] of [[name, r.bytes], ...(paired ? [[`${name} statement`, r.bill.bytes]] : [])]) {
      const bands = await bandsOf(bytes);
      bands.forEach((b, i) => {
        const where = `${what} p${i + 1}`;
        assert.ok(b, `${where}: the band's operators`);
        assert.ok(Math.abs(b.width - b.pageWidth) < 0.01, `${where}: the band spans the page (${b.width} of ${b.pageWidth})`);
        assert.ok(b.height >= 9, `${where}: band height ${b.height}`); assert.ok(b.size >= 6, `${where}: band text ${b.size} pt`);
        assert.ok(ratio(b.fill, b.ink) >= 4.5, `${where}: band contrast ${ratio(b.fill, b.ink).toFixed(2)}`);
      });
      const marks = await markHeights(bytes);
      for (let n = 1; n <= bands.length; n++) {
        const m = await watermarkContrast(browser, bytes, n, null, marks[n - 1]);
        assert.deepEqual(belowFloors(m, { clean: true }), [], `${what} p${n}: ${JSON.stringify(m)}`);
      }
    }
  }
});

test('the watermark is drawn at the opacity the floors were set with', () => { assert.equal(WATERMARK_OPACITY, 0.07); });

test('the contrast floor is a real bar: on grey paper (luma 185) the watermark at 0.05 falls under it, at the opacity the code uses it does not', { skip, timeout: 120000 }, async () => {
  const page = async (opacity) => {
    const doc = await PDFDocument.create(); const p = doc.addPage([612, 792]);
    p.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(185 / 255, 185 / 255, 185 / 255) });
    drawWatermark(p, { ox: 0, oy: 0, width: 612, height: 792 }, opacity);
    return Buffer.from(await doc.save());
  };
  const mid = { fy: 0.5 };
  const low = await watermarkContrast(browser, await page(0.05), 1, null, mid); const now = await watermarkContrast(browser, await page(WATERMARK_OPACITY), 1, null, mid);
  assert.ok(low.tiles >= FLOORS.tiles && low.mean < FLOORS.mean, `at 0.05: ${JSON.stringify(low)}`);
  assert.deepEqual(belowFloors(now), [], `at ${WATERMARK_OPACITY}: ${JSON.stringify(now)}`);   // about 6.4% against 6.0%: deterministic, little room
});

// The reach is read from the target: a watermark painted over, missing or elsewhere reads short, on a clean page and on
// the pictures of the three degraded presets the contrast floors judge.
test('the measure reads the target: a clipped, missing or misplaced watermark fails its reach', { skip, timeout: 300000 }, async () => {
  const text = async (stamp) => {
    const d = await PDFDocument.create(); const p = d.addPage([612, 792]); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 50; i++) p.drawText(`Printed row ${i} of a statement with billing words and 123.45`, { x: 40, y: 760 - i * 14, size: 9, font: f });
    const f0 = path.join(dir, `t-${stamp}.pdf`); fs.writeFileSync(f0, await d.save()); if (stamp) await finalizePdf(f0, {}); return fs.readFileSync(f0);
  };
  const stamped = await text(true); const [mark] = await markHeights(stamped);
  assert.deepEqual(belowFloors(await watermarkContrast(browser, stamped, 1, null, mark), { clean: true }), [], 'the stamped page itself');
  const paint = async (bytes, from) => { const d = await PDFDocument.load(bytes); const p = d.getPage(0); const { width, height } = p.getSize();
    p.drawRectangle({ x: width * from, y: 11, width: width * (1 - from), height: height - 11, color: rgb(1, 1, 1) }); return Buffer.from(await d.save()); };
  const clipped = await watermarkContrast(browser, await paint(stamped, 0.4), 1, null, mark);
  assert.ok(clipped.spanX < FLOORS.spanX, `painted over right of 40%: ${JSON.stringify(clipped)}`);
  const kept = await watermarkContrast(browser, await paint(stamped, 0.28), 1, null, mark);
  assert.ok(kept.spanX < FLOORS.spanX && kept.spanY < FLOORS.spanY, `painted over right of 28%: ${JSON.stringify(kept)}`);
  const away = await watermarkContrast(browser, stamped, 1, null, { fy: mark.fy > 0.5 ? mark.fy - 0.25 : mark.fy + 0.25 });
  assert.ok(away.mean < FLOORS.mean && away.spanX < FLOORS.spanX, `a reference 200 pt away: ${JSON.stringify(away)}`);
  const none = await watermarkContrast(browser, await text(false), 1, null, mark);
  assert.ok(none.mean < FLOORS.mean && none.spanX < FLOORS.spanX && none.spanY < FLOORS.spanY, `no watermark: ${JSON.stringify(none)}`);
  // the picture of an unstamped page under each judged preset, and a photo copy painted over right of 40%
  const plain = await text(false);
  for (const preset of ['scan', 'photo', 'low-res']) {
    const params = degradationParams(preset, { type: 'msn', scenario: 'x', seed: 'n1' }); const [m] = copyMarks(preset, params, [{ fy: 0.5 }]);
    const { pdf, pictures } = await degradePdf(browser, plain, { preset, params, pageImages: false, keepPictures: true });
    const r = await watermarkContrast(browser, pdf, 1, { url: `data:${pictures[0].mimeType};base64,${pictures[0].data}`, dpi: params.dpi }, m);
    assert.ok(r.spanX < FLOORS.spanX && r.spanY < FLOORS.spanY, `${preset}, no watermark in the picture: ${JSON.stringify(r)}`);
    if (preset === 'photo') {
      const [pm] = copyMarks(preset, params, [mark]); const copy = await degradePdf(browser, stamped, { preset, params, pageImages: false });
      assert.deepEqual(belowFloors(await watermarkContrast(browser, copy.pdf, 1, null, pm)), [], 'the photo copy itself');
      const c = await watermarkContrast(browser, await paint(copy.pdf, 0.4), 1, null, pm);
      assert.ok(c.spanX < FLOORS.spanX, `photo copy painted over right of 40%: ${JSON.stringify(c)}`);
    }
  }
});
