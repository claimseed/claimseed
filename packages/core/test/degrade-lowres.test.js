// The low-resolution copy's page images (degrade.js, LOW_RES_MIN_DPI): measured at their own resolution, they keep
// enough plain paper around the watermark's letters for the marks' floors at every resolution the preset draws.
// The tile count is not monotone in the resolution (it depends on how the measure's 16 px tiles fall on the letters'
// cells), so a notice's last page, among the hardest pages for the measure, is measured at the five resolutions from
// 75 to 90 dpi where it keeps the fewest tiles, at the worst JPEG quality.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { findChrome, launchBrowser, render, renderDegraded, degradePdf, degradationParams } from '../src/index.js';
import { markHeights } from '../src/render.js';
import { copyMarks, LOW_RES_MIN_DPI } from '../src/degrade.js';
import { watermarkContrast, belowFloors } from './watermark-contrast.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });
const imageOf = (im, dpi) => ({ url: `data:${im.mimeType};base64,${im.data.toString('base64')}`, dpi });

test('the low-res settings: 75 to 90 dpi, the quality drawn as before', () => {
  assert.equal(LOW_RES_MIN_DPI, 75);
  for (let i = 0; i < 1000; i++) {
    const p = degradationParams('low-res', { type: 'msn', scenario: 'baseline-clean', seed: `lr-${i}` });
    assert.ok(Number.isInteger(p.dpi) && p.dpi >= 75 && p.dpi <= 90, `seed lr-${i}: ${p.dpi} dpi`);
    assert.ok(p.quality >= 0.35 && p.quality <= 0.55, `seed lr-${i}: quality ${p.quality}`);
  }
  // the quality and the copy's own seed come from draws the resolution's range does not move (fixed values)
  const before = { 'q-1': [1671444404, 0.43], 'q-2': [426056593, 0.36], 'q-3': [2131387285, 0.55], 'q-4': [1998446817, 0.43], 'q-5': [1785039292, 0.53] };
  for (const [seed, [s, q]] of Object.entries(before)) {
    const p = degradationParams('low-res', { type: 'msn', scenario: 'baseline-clean', seed });
    assert.deepEqual([p.seed, p.quality], [s, q], seed);
  }
});

test('a low-res copy from the standard set: every page and page image meets the degraded floors', { skip, timeout: 300000 }, async () => {
  // the standard set's doc-3499a75a65153594 (its salt is public in the keys zip), a notice whose last page is among the
  // hardest for the measure
  const o = { type: 'msn', scenario: 'service-date-after-notice', seed: 'set-20', blind: { salt: '756285ac56bc1e289b3f57115544ab07' }, browser };
  const clean = await render(o);
  const d = await renderDegraded({ ...o, preset: 'low-res', pageImages: true });
  const params = d.groundTruth.documents[0].degradationParams;
  assert.ok(params.dpi >= 75, `${params.dpi} dpi`);
  const marks = copyMarks('low-res', params, await markHeights(clean.bytes));
  assert.equal(d.images.length, marks.length);
  for (const im of d.images) {
    const page = await watermarkContrast(browser, d.bytes, im.page, null, marks[im.page - 1]);
    const image = await watermarkContrast(browser, d.bytes, im.page, imageOf(im, params.dpi), marks[im.page - 1]);
    assert.deepEqual(belowFloors(page), [], `p${im.page}`);
    assert.deepEqual(belowFloors(image), [], `p${im.page} image: ${image.tiles} tiles`);
  }
});

// the hardest page image found and the resolutions where it keeps the fewest tiles (81, 75, 80, 79 and 85 dpi), the page
// degraded on its own: a low-res copy draws no settings per page, so a page degrades the same alone as inside its document
const HARD = [['msn', 'baseline-clean', 'lr-1', 6]]; const WORST_DPI = [75, 79, 80, 81, 85];
async function onePage(bytes, n) {
  const src = await PDFDocument.load(bytes, { updateMetadata: false }); const one = await PDFDocument.create({ updateMetadata: false });
  const [pg] = await one.copyPages(src, [n - 1]); one.addPage(pg); return Buffer.from(await one.save());
}
test('the hardest page image at its worst resolutions from 75 to 90 dpi, at the worst quality', { skip, timeout: 600000 }, async () => {
  for (const [type, scenario, seed, n] of HARD) {
    const r = await render({ type, scenario, seed, browser });
    const page = await onePage(r.bytes, n); const heights = await markHeights(page);
    for (const dpi of WORST_DPI) {
      const params = { seed: 1, dpi, quality: 0.35 };
      const deg = await degradePdf(browser, page, { preset: 'low-res', params, pageImages: true });
      const m = await watermarkContrast(browser, deg.pdf, 1, imageOf(deg.images[0], dpi), copyMarks('low-res', params, heights)[0]);
      assert.deepEqual(belowFloors(m), [], `${type} ${scenario} ${seed} p${n} at ${dpi} dpi: ${m.tiles} tiles`);
    }
    if (n === 6 && scenario === 'baseline-clean') {
      // the page alone and the same page inside its document give the same image
      const params = { seed: 1, dpi: 81, quality: 0.35 };
      const whole = await degradePdf(browser, r.bytes, { preset: 'low-res', params, pageImages: true });
      const alone = await degradePdf(browser, page, { preset: 'low-res', params, pageImages: true });
      const marks = copyMarks('low-res', params, await markHeights(r.bytes));
      const a = await watermarkContrast(browser, whole.pdf, n, imageOf(whole.images[n - 1], 81), marks[n - 1]);
      const b = await watermarkContrast(browser, alone.pdf, 1, imageOf(alone.images[0], 81), copyMarks('low-res', params, heights)[0]);
      assert.equal(a.tiles, b.tiles, 'alone and in its document');
    }
  }
});
