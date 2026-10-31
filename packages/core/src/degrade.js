// degrade.js — scanned-looking copies of a rendered specimen: a flatbed scan, a fax, a phone photo, or a
// low-resolution copy. Each page of the stamped PDF is drawn at the recipe's resolution and degraded (pdf-raster.js),
// the pictures are put back together as an image-only PDF, and that PDF is stamped again like every other claimseed
// PDF (finalizePdf: the specimen band and the watermark drawn on top of the degraded pixels, and the specimen
// metadata), so the markers never go through the degradation. Page images are then drawn from that stamped PDF and
// carry the file markers (image-markers.js). The settings come from the seed: the same type, scenario, seed and
// preset always give the same settings, recorded in the answer key as degradationParams.
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { makeRng } from './generate/rng.js';
import { finalizePdf, watermarkCells } from './render.js';
import { withPdfPage, degradePage, drawPage } from './pdf-raster.js';
import { markImage } from './image-markers.js';

export const PRESETS = ['scan', 'fax', 'photo', 'low-res'];
const r2 = (v) => Math.round(v * 100) / 100; const r3 = (v) => Math.round(v * 1000) / 1000;
const between = (rng, lo, hi) => lo + rng() * (hi - lo);

// The seeded settings of one preset for one document. Every number is rounded, so the answer key states exactly
// what was applied.
export function degradationParams(preset, { type, scenario, seed }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no preset ${preset}; presets: ${PRESETS.join(', ')}`);
  const rng = makeRng(seed, type, scenario, 'degrade', preset);
  const base = { seed: Math.floor(rng() * 2 ** 31) };
  if (preset === 'scan') {
    const tone = Math.round(between(rng, 238, 250));
    return { ...base, dpi: 200, rotate: r2(between(rng, -0.8, 0.8)), shiftX: Math.round(between(rng, -12, 12)), shiftY: Math.round(between(rng, -12, 12)),
      paper: [tone, tone - Math.round(between(rng, 1, 5)), tone - Math.round(between(rng, 5, 12))], blur: rng() < 0.5 ? 0 : 1,
      contrast: r2(between(rng, 0.92, 1.08)), brightness: Math.round(between(rng, -8, 6)), noise: r3(between(rng, 0.01, 0.035)),
      specks: Math.round(between(rng, 10, 60)), quality: r2(between(rng, 0.72, 0.88)) };
  }
  if (preset === 'fax') {
    const streaks = Array.from({ length: Math.floor(between(rng, 0, 4)) }, () => { const x0 = r3(between(rng, 0, 0.6)); return { y: r3(between(rng, 0.05, 0.95)), x0, x1: r3(Math.min(1, x0 + between(rng, 0.1, 0.5))), width: rng() < 0.7 ? 1 : 2 }; });
    return { ...base, dpi: 200, rotate: r2(between(rng, -1.2, 1.2)), standard: rng() < 0.5, threshold: r2(between(rng, 0.5, 0.66)),
      speckle: r3(between(rng, 0.0005, 0.004)), streaks };
  }
  if (preset === 'photo') {
    const t = Math.round(between(rng, 60, 140));
    return { ...base, dpi: 150, rotate: r2(between(rng, -4, 4)), keystone: r3(between(rng, 0.015, 0.06)), margin: r3(between(rng, 0.04, 0.09)),
      table: [t, Math.round(t * between(rng, 0.8, 0.95)), Math.round(t * between(rng, 0.6, 0.8))], lightAngle: r2(between(rng, 0, 2 * Math.PI)),
      shade: r2(between(rng, 0.08, 0.28)), vignette: r2(between(rng, 0.15, 0.4)), blur: rng() < 0.4 ? 1 : 2, noise: r3(between(rng, 0.015, 0.04)),
      quality: r2(between(rng, 0.6, 0.8)) };
  }
  return { ...base, dpi: Math.round(between(rng, 60, 90)), quality: r2(between(rng, 0.35, 0.55)) };
}

// Degrade a stamped PDF. Returns { pdf: Buffer, images: [{ page, mimeType, data: Buffer }] }: the image-only PDF,
// stamped and with the specimen metadata, and (with pageImages) one marked image per page drawn from it at the
// recipe's resolution. `label` names the document in the band and in the image markers. keepPictures (for tests)
// also returns the degraded pictures as they were before stamping, base64, unmarked.
export async function degradePdf(browser, bytes, { preset, params, label = null, title = null, pageImages = true, keepPictures = false }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no preset ${preset}`);
  const pictures = await withPdfPage(browser, bytes, async (page, sizes) => {
    const out = [];
    for (let n = 1; n <= sizes.length; n++) {
      const [w, h] = sizes[n - 1];
      const mark = preset === 'fax' ? { width: w, height: h, cells: watermarkCells(w, h) } : null;
      out.push({ ...(await degradePage(page, n, preset, params, mark)), size: sizes[n - 1] });
    }
    return out;
  });
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const pic of pictures) {
    const raw = Buffer.from(pic.data, 'base64');
    const img = pic.mime === 'image/png' ? await doc.embedPng(raw) : await doc.embedJpg(raw);
    // the page keeps the document's scale: a photo with table around the sheet is a larger page
    const w = (pic.width * 72) / params.dpi; const h = (pic.height * 72) / params.dpi;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-degrade-'));
  let pdf;
  try {
    const p = path.join(work, 'degraded.pdf');
    fs.writeFileSync(p, await doc.save());
    await finalizePdf(p, { band: label ? `${label} / ${preset}` : preset, title: title || undefined });
    pdf = fs.readFileSync(p);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  let images = [];
  if (pageImages) {
    const jpeg = preset !== 'fax';
    images = await withPdfPage(browser, pdf, async (page, sizes) => {
      const out = [];
      for (let n = 1; n <= sizes.length; n++) {
        const longSide = Math.round((Math.max(...sizes[n - 1]) * params.dpi) / 72);
        const d = await drawPage(page, n, longSide);
        const mimeType = jpeg ? 'image/jpeg' : 'image/png';
        out.push({ page: n, mimeType, data: Buffer.from(markImage(mimeType, jpeg ? d.jpeg : d.png, label ? `${label} / ${preset}` : preset), 'base64') });
      }
      return out;
    });
  }
  return { pdf, images, ...(keepPictures ? { pictures: pictures.map((p, i) => ({ page: i + 1, mimeType: p.mime, data: p.data })) } : {}) };
}

// A degraded copy of a document already rendered with render(): { bytes, groundTruth, images }, with the answer key
// of the copy (degradation, degradationParams and the copy's SHA-256; the fields are unchanged, since the copy shows
// the same values).
export async function degradeRendered(browser, { type, scenario, seed, preset, clean, pageImages = true }) {
  const params = degradationParams(preset, { type, scenario, seed });
  const label = `${type} / ${scenario} / seed ${seed}`;
  const { pdf, images } = await degradePdf(browser, clean.bytes, { preset, params, label, title: `claimseed specimen - ${type} ${scenario} seed=${seed} (${preset} copy)`, pageImages });
  const groundTruth = JSON.parse(JSON.stringify(clean.groundTruth)); const doc = groundTruth.documents[0];
  doc.degradation = preset; doc.degradationParams = params;
  doc.sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  return { bytes: pdf, groundTruth, images };
}

// Render a document and a degraded copy of it. Returns { pdf, groundTruth, bytes, images, files }. With outDir, writes
// <type>_<scenario>_<seed>_<preset>.pdf, its .ground-truth.json and one image per page (_p<N>.jpg, or .png for a
// fax), each created exclusively.
export async function renderDegraded({ type, scenario, seed = 'claimseed', preset, outDir = null, browser = null, pageImages = true, also = null }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no preset ${preset}; presets: ${PRESETS.join(', ')}`);
  const { render } = await import('./index.js');
  const { launchBrowser } = await import('./browser.js');
  const own = !browser; const b = browser || await launchBrowser();
  try {
    const clean = await render({ type, scenario, seed, browser: b, also });
    const { bytes, groundTruth, images } = await degradeRendered(b, { type, scenario, seed, preset, clean, pageImages });
    const files = [];
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, `${type}_${scenario}_${seed}_${preset}`);
      fs.writeFileSync(base + '.pdf', bytes, { flag: 'wx' }); files.push(base + '.pdf');
      fs.writeFileSync(base + '.ground-truth.json', JSON.stringify(groundTruth, null, 2), { flag: 'wx' }); files.push(base + '.ground-truth.json');
      for (const i of images) { const f = `${base}_p${i.page}.${i.mimeType === 'image/png' ? 'png' : 'jpg'}`; fs.writeFileSync(f, i.data, { flag: 'wx' }); files.push(f); }
      if (clean.remittance !== null) { fs.writeFileSync(base + '.835', clean.remittance, { flag: 'wx' }); files.push(base + '.835'); }
    }
    return { pdf: outDir ? files[0] : null, groundTruth, bytes, images, files, remittance: clean.remittance };
  } finally { if (own) await b.close(); }
}
