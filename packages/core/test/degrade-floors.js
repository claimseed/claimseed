// The band and the watermark drawn on top of every page of every degraded preset of a layout, above their floors on
// the page and its image, and the markers on every file (test/degrade-floors-*.test.js, a part of the layouts each).
// The watermark is measured where the copy's own is (copyMarks of the clean PDF's placement).
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import { PDFDocument } from 'pdf-lib';
import { render, degradePdf, degradationParams, DEGRADE_PRESETS, withPdfPage, BAND_TEXT, SPECIMEN_SUBJECT } from '../src/index.js';
import { markHeights, finalizePdfAt } from '../src/render.js';
import { copyMarks } from '../src/degrade.js';
import { readMarkers } from './markers-read.js';
import { measureWatermark } from './watermark-measure.js';
import { watermarkContrast, belowFloors, MASK_THRESHOLD } from './watermark-contrast.js';
import { pdfWords } from '../scripts/lib/provenance.js';

// On one fax page image, threshold it again at the preset's own threshold (as a fax reader would) and compare the black
// share inside the watermark's letters with the ring around them (the letters grown by 6 pixels, minus the letters,
// above the band). The letters come from a blank page stamped at the copy's placement (`mark`), drawn at the image's
// resolution.
export async function faxPattern(browser, pdf, image, n, label, params, mark) {
  const [w, h] = await withPdfPage(browser, pdf, async (page, sizes) => sizes[n - 1]);
  const ref = await PDFDocument.create(); ref.addPage([w, h]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fax-')); const refPath = path.join(dir, 'ref.pdf');
  fs.writeFileSync(refPath, await ref.save()); await finalizePdfAt(refPath, { band: label }, [mark]);
  return withPdfPage(browser, fs.readFileSync(refPath), async (page) => {
    await page.evaluate((s) => window.claimseedCanvas(1, s), params.dpi / 72);
    return page.evaluate(async (imgUrl, threshold, bandPt, s, maskThreshold) => {
      const R = window.claimseedLast; const W = R.width, H = R.height; const r = R.getContext('2d').getImageData(0, 0, W, H).data;
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imgUrl; });
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
      const a = g.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H); for (let k = 0; k < W * H; k++) mask[k] = r[k * 4] - r[k * 4 + 2] > maskThreshold ? 1 : 0;
      // grow the mask by 6 pixels (a 13 x 13 square), rows then columns
      const grow = (m) => { const o = new Uint8Array(W * H); const t = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = Math.max(0, x - 6); k <= Math.min(W - 1, x + 6) && !v; k++) v = m[y * W + k]; t[y * W + x] = v; }
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { let v = 0; for (let k = Math.max(0, y - 6); k <= Math.min(H - 1, y + 6) && !v; k++) v = t[k * W + x]; o[y * W + x] = v; }
        return o; };
      const big = grow(mask); const bandTop = H - Math.round(bandPt * s) - 2;
      let inB = 0, inN = 0, ringB = 0, ringN = 0;
      for (let y = 0; y < bandTop; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x; const i = k * 4; const black = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2] < threshold * 255;
        if (mask[k]) { inN++; if (black) inB++; } else if (big[k]) { ringN++; if (black) ringB++; }
      }
      return { inside: inB / inN, ring: ringB / ringN, maskPixels: inN };
    }, `data:${image.mimeType};base64,${image.data.toString('base64')}`, params.threshold, 11, params.dpi / 72, MASK_THRESHOLD);
  });
}

export async function degradedFloors(browser, layouts) {
  const measure = (pdf, picture, n, label, mark) => measureWatermark(browser, pdf, picture, n, label, mark);
  for (const [type, scenario, o] of layouts) {
    const clean = await render({ type, scenario, seed: 'deg-t', ...o, browser });
    const heights = await markHeights(clean.bytes);
    for (const preset of DEGRADE_PRESETS) {
      const params = degradationParams(preset, { type, scenario, seed: 'deg-t' }); const label = `${type} / ${scenario} / seed deg-t`;
      const { pdf, images, pictures } = await degradePdf(browser, clean.bytes, { preset, params, label, keepPictures: true });
      const what = `${type}${o.insurer ? ` ${o.insurer}` : ''} ${preset}`; const marks = copyMarks(preset, params, heights);
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      assert.equal(doc.getPageCount(), clean.groundTruth.documents[0].pages, `${what}: page count`);
      assert.equal(doc.getSubject(), SPECIMEN_SUBJECT, `${what}: PDF metadata`); assert.equal(doc.getProducer(), 'claimseed');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deg-')); fs.writeFileSync(path.join(dir, 'd.pdf'), pdf);
      // a second, independent reader of the metadata (Poppler); it must be installed, so its absence fails the test
      const info = spawnSync('pdfinfo', [path.join(dir, 'd.pdf')], { encoding: 'utf-8' });
      assert.equal(info.status, 0, `${what}: pdfinfo did not run (${info.error?.code || info.stderr})`);
      assert.equal((info.stdout.split('\n').find((l) => l.startsWith('Subject:')) || '').replace(/^Subject:\s+/, ''), SPECIMEN_SUBJECT, `${what}: pdfinfo Subject`);
      const words = pdfWords(path.join(dir, 'd.pdf'));
      assert.ok(words.every((ws) => ws.map((w) => w.t).join(' ').includes('SYNTHETIC SPECIMEN')), `${what}: a page without the band text`);
      assert.equal(images.length, doc.getPageCount());
      for (const i of images) {
        assert.equal(i.mimeType, preset === 'fax' ? 'image/png' : 'image/jpeg');
        const m = readMarkers(i.mimeType, i.data.toString('base64'));
        assert.equal(m.description, BAND_TEXT, `${what} page ${i.page}: image without its marker`); assert.ok(String(m.label ?? m.comment).includes(`${type} / ${scenario} / seed deg-t / ${preset}`), `${what}: image label`);
      }
      // on every page: the tint and band, the fax pattern, and the floors
      for (let n = 1; n <= doc.getPageCount(); n++) {
        const m = await measure(pdf, pictures[n - 1], n, `${label} / ${preset}`, marks[n - 1]);
        assert.ok(m.maskPixels > 500, `${what} p${n}: watermark mask ${m.maskPixels}`);
        assert.ok(m.tintIn > 8, `${what} p${n}: the watermark adds ${m.tintIn.toFixed(1)} of tint inside its shapes`);
        assert.ok(Math.abs(m.tintOut) < 3, `${what} p${n}: ${m.tintOut.toFixed(1)} of tint outside them`);
        assert.ok(m.bandBackground > 0.6 && m.bandDark > 40, `${what} p${n}: band ${JSON.stringify(m)}`);
        // the floors: readable contrast on plain paper and reach, on the PDF page and on the page image delivered beside it
        if (preset !== 'fax') {
          const im = images[n - 1];
          for (const [where, r] of [['page', await watermarkContrast(browser, pdf, n, null, marks[n - 1])], ['image', await watermarkContrast(browser, pdf, n, { url: `data:${im.mimeType};base64,${im.data.toString('base64')}`, dpi: params.dpi }, marks[n - 1])]]) {
            assert.deepEqual(belowFloors(r), [], `${what} p${n} ${where}: ${JSON.stringify(r)}`);
          }
        }
        if (preset === 'fax') {
          const f = await faxPattern(browser, pdf, images[n - 1], n, `${label} / ${preset}`, params, marks[n - 1]);
          assert.ok(f.maskPixels > 500 && f.inside - f.ring >= 0.3, `${what} p${n}: after thresholding the watermark is ${f.inside.toFixed(2)} black inside its letters, ${f.ring.toFixed(2)} beside them`);
        }
      }
    }
  }
}
