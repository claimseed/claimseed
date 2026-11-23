// The watermark's contrast and reach on one page, by one measure for a clean PDF, a degraded PDF and a delivered page
// image (the floors in test/marks-floors.test.js and test/degrade.test.js). The letters' mask comes from a blank page
// of the same size with the watermark drawn where the page's own is (`mark`: the page's placement, from markHeights of
// the clean PDF, through copyMarks for a degraded copy), so no picture from before stamping is needed. The page is cut
// into 16 px tiles; a tile counts when 20-80% of it is letter and its other pixels are plain light paper (median
// relative luminance above 0.35, p80 - p20 under 0.08: no print, no dark surround). Per tile, Weber contrast in WCAG
// relative luminance: (paper - letter) / paper, from the medians.
// The reach is read from the target: the letters' extent is cut into four bins across and four down by their share of
// the letters, and a bin counts only where the target shows the watermark (half of its tiles on light paper at the
// weakest-tenth floor's contrast). spanX and spanY are the counted bins' share of the page, and rowsCrossed counts a
// printed row only inside a counted bin down; so a watermark clipped or missing anywhere on the page reads short.
// A degraded copy carries the watermark twice: once inside its picture (degraded with the page) and once stamped on
// top. On the scan and low-res presets the two nearly coincide, so those copies read higher than a clean page; on the
// photo preset they do not, which makes it the weakest.
import fs from 'fs'; import os from 'os'; import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { withPdfPage } from '../src/index.js';
import { WATERMARK_COLOR, WATERMARK_OPACITY, finalizePdfAt } from '../src/render.js';

// a reference pixel is a letter when its red exceeds its blue by 40% of what a full letter adds on white
export const MASK_THRESHOLD = 0.4 * (WATERMARK_COLOR.red - WATERMARK_COLOR.blue) * 255 * WATERMARK_OPACITY;
const BAND_PT = 11;
// a tile on light paper shows the watermark at the weakest-tenth floor's contrast; a bin shows it when half its tiles do
const DETECT = 0.025; const SHOW = 0.5; const BINS = 4;

const ANALYSE = `(async (refUrl, tgtUrl, W, H, bandPx, threshold, detect, show, BINS) => {
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const px = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
  const r = px(await load(refUrl)); const a = tgtUrl ? px(await load(tgtUrl)) : window.claimseedLast.getContext('2d').getImageData(0, 0, W, H).data;
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  const top = H - bandPx - 2; const mask = new Uint8Array(W * H); let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < top; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (r[i] - r[i + 2] > threshold) { mask[y * W + x] = 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
  const q = (v, f) => v[Math.min(v.length - 1, Math.floor(v.length * f))];
  const webers = []; const T = 16;
  // four bins across and four down, each holding a quarter of the reference letters' pixels; a bin shows the watermark
  // when at least half of its tiles on light paper reach the detection contrast
  const colN = new Array(W).fill(0), rowN = new Array(H).fill(0); let total = 0;
  for (let y = 0; y < top; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { colN[x]++; rowN[y]++; total++; }
  const edges = (n) => { const e = [0]; let acc = 0, k = 1; for (let i = 0; i < n.length && k < BINS; i++) { acc += n[i]; while (k < BINS && acc >= (total * k) / BINS) { e.push(i + 1); k++; } } while (e.length < BINS) e.push(n.length); e[0] = n.findIndex((v) => v > 0); e.push(n.length - [...n].reverse().findIndex((v) => v > 0)); return e; };   // from the letters' first row or column to their last
  const ex = edges(colN), ey = edges(rowN);
  const bin = (v, e) => { let b = 0; while (b < BINS - 1 && v >= e[b + 1]) b++; return b; };
  const candX = new Array(BINS).fill(0), detX = new Array(BINS).fill(0), candY = new Array(BINS).fill(0), detY = new Array(BINS).fill(0);
  for (let ty = 0; ty + T <= top; ty += T) for (let tx = 0; tx + T <= W; tx += T) {
    const inL = [], outL = [];
    for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) { const k = y * W + x; (mask[k] ? inL : outL).push(L(a, k * 4)); }
    const share = inL.length / (T * T); if (share < 0.2 || share > 0.8) continue;
    inL.sort((x, y) => x - y); outL.sort((x, y) => x - y);
    const paper = q(outL, 0.5); if (!(paper > 0.35)) continue; const plain = q(outL, 0.8) - q(outL, 0.2) < 0.08;
    const w = (paper - q(inL, 0.5)) / paper; const bx = bin(tx + T / 2, ex), by = bin(ty + T / 2, ey);
    candX[bx]++; candY[by]++; if (w >= detect) { detX[bx]++; detY[by]++; }
    if (plain) webers.push(w);
  }
  const rate = (cand, det) => cand.map((c, i) => (c > 0 ? det[i] / c : 0)); const rateX = rate(candX, detX), rateY = rate(candY, detY);
  const shows = (r) => r.map((v) => v >= show);
  const showX = shows(rateX), showY = shows(rateY);
  const width = (sh, e, n) => sh.reduce((t, v, b) => t + (v ? e[b + 1] - e[b] : 0), 0) / n;
  let inked = 0, crossed = 0;
  for (let y = 0; y < top; y++) { let ink = false, mk = false; for (let x = 0; x < W; x++) { const k = y * W + x; if (L(a, k * 4) < 0.3) ink = true; if (mask[k]) mk = true; } if (ink) { inked++; if (mk && showY[bin(y, ey)]) crossed++; } }
  webers.sort((x, y) => x - y);
  const maskX = maxX >= minX ? (maxX - minX) / W : 0, maskY = maxY >= minY ? (maxY - minY) / H : 0;
  return { mean: webers.length ? webers.reduce((s, v) => s + v, 0) / webers.length : 0, p10: webers.length ? q(webers, 0.1) : 0, tiles: webers.length,
    spanX: Math.min(maskX, width(showX, ex, W)), spanY: Math.min(maskY, width(showY, ey, H)), rowsCrossed: inked ? crossed / inked : 0, maskX, maskY, rateX, rateY, candX, candY };
})`;

/** Page n of a PDF (bytes), drawn at 100/72 px per pt, or with `image` ({ url, dpi }) the page image drawn from it at
 *  the preset's resolution (degrade.js: its long side at dpi). */
export async function watermarkContrast(browser, pdf, n, image, mark) {
  if (!mark || !Number.isFinite(mark.fy)) throw new Error('watermarkContrast: pass the page\'s placement (markHeights, copyMarks)');
  const [w, h] = await withPdfPage(browser, pdf, async (page, sizes) => sizes[n - 1]);
  const ref = await PDFDocument.create(); ref.addPage([w, h]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-contrast-')); const refPath = path.join(dir, 'ref.pdf');
  try {
    fs.writeFileSync(refPath, await ref.save()); await finalizePdfAt(refPath, { band: 'ref' }, [mark]);
    const scale = image ? Math.round((Math.max(w, h) * image.dpi) / 72) / Math.max(w, h) : 100 / 72;
    const W = Math.round(w * scale), H = Math.round(h * scale);
    const refPng = await withPdfPage(browser, fs.readFileSync(refPath), async (page) => { await page.evaluate((s) => window.claimseedCanvas(1, s), scale); return page.evaluate(() => window.claimseedLast.toDataURL('image/png')); });
    return await withPdfPage(browser, pdf, async (page) => {
      if (!image) await page.evaluate((a, s) => window.claimseedCanvas(a, s), n, scale);
      return page.evaluate(`${ANALYSE}(${JSON.stringify(refPng)}, ${image ? JSON.stringify(image.url) : 'null'}, ${W}, ${H}, ${Math.round(BAND_PT * scale)}, ${MASK_THRESHOLD}, ${DETECT}, ${SHOW}, ${BINS})`);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The floors: mean contrast on plain paper, enough tiles to judge, and the letters' reach
// across the page; on a clean page also the weakest tenth of the tiles and the printed rows crossed.
// The weakest tenth is judged where the page carries one watermark (clean PDFs). A degraded copy carries two, the
// picture's own and the stamped one, a few points apart; the local contrast between them is not a measure of
// readability. On a degraded copy the stamped mark's contrast is fixed by the opacity and the paper, which the mean
// floor and the plain-paper filter hold.
export const FLOORS = { mean: 0.06, p10: 0.025, tiles: 20, spanX: 0.70, spanY: 0.35, rowsCrossed: 0.15 };
export function belowFloors(m, { clean = false } = {}) {
  const out = [];
  if (!(m.tiles >= FLOORS.tiles)) out.push(`${m.tiles} plain-paper tiles`);
  if (!(m.mean >= FLOORS.mean)) out.push(`mean contrast ${(m.mean * 100).toFixed(1)}%`);
  if (clean && !(m.p10 >= FLOORS.p10)) out.push(`10th percentile ${(m.p10 * 100).toFixed(1)}%`);
  if (!(m.spanX >= FLOORS.spanX)) out.push(`width ${(m.spanX * 100).toFixed(0)}%`);
  if (!(m.spanY >= FLOORS.spanY)) out.push(`height ${(m.spanY * 100).toFixed(0)}%`);
  if (clean && !(m.rowsCrossed >= FLOORS.rowsCrossed)) out.push(`printed rows crossed ${(m.rowsCrossed * 100).toFixed(0)}%`);
  return out;
}
