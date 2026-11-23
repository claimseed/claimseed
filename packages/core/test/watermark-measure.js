// This tint check is the working guard on the opacity itself: it fails below about 0.0625, while the contrast floor
// (test/watermark-contrast.js) allows a small drop on white paper. Keep both.
// Measure the specimen watermark on one page of a degraded PDF (shared by test/degrade.test.js and
// test/variants-render.test.js): compare the stamped raster with the picture before stamping and with a blank page
// stamped at the copy's placement (`mark`, from copyMarks; it shows where the watermark goes). Returns the tint the watermark adds inside its own
// shapes and elsewhere, and how the band strip looks.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { withPdfPage } from '../src/index.js';
import { finalizePdfAt } from '../src/render.js';
import { MASK_THRESHOLD } from './watermark-contrast.js';

export async function measureWatermark(browser, pdf, picture, n, label, mark) {
  if (!mark || !Number.isFinite(mark.fy)) throw new Error('measureWatermark: pass the page\'s placement (copyMarks)');
  const scale = 100 / 72;
  const [w, h] = await withPdfPage(browser, pdf, async (page, sizes) => sizes[n - 1]);
  const ref = await PDFDocument.create(); ref.addPage([w, h]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ref-')); const refPath = path.join(dir, 'ref.pdf');
  try {
    fs.writeFileSync(refPath, await ref.save()); await finalizePdfAt(refPath, { band: label }, [mark]);
    const refPng = await withPdfPage(browser, fs.readFileSync(refPath), async (page) => { await page.evaluate((s) => window.claimseedCanvas(1, s), scale); return page.evaluate(() => window.claimseedLast.toDataURL('image/png')); });
    return await withPdfPage(browser, pdf, async (page) => {
      await page.evaluate((a, s) => window.claimseedCanvas(a, s), n, scale);
      return page.evaluate(async (refUrl, picUrl, bandPt, s, threshold) => {
        const A = window.claimseedLast; const W = A.width, H = A.height;
        const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
        const pixels = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
        const a = A.getContext('2d').getImageData(0, 0, W, H).data; const r = pixels(await load(refUrl)); const p = pixels(await load(picUrl));
        const bandTop = H - Math.round(bandPt * s);
        let inSum = 0, inN = 0, outSum = 0, outN = 0, bg = 0, dark = 0, bandN = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (y > bandTop + 1 && y < H - 1) { bandN++; if (Math.abs(a[i] - 251) + Math.abs(a[i + 1] - 243) + Math.abs(a[i + 2] - 234) < 30) bg++; if (a[i] + a[i + 1] + a[i + 2] < 420) dark++; continue; }
          if (y >= bandTop - 2) continue;
          const tint = (a[i] - p[i]) - (a[i + 2] - p[i + 2]);
          if (r[i] - r[i + 2] > threshold) { inSum += tint; inN++; } else if ((x + y) % 7 === 0) { outSum += tint; outN++; }
        }
        return { tintIn: inSum / inN, tintOut: outSum / outN, maskPixels: inN, bandBackground: bg / bandN, bandDark: dark };
      }, refPng, `data:${picture.mimeType};base64,${picture.data}`, 11, scale, MASK_THRESHOLD);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
