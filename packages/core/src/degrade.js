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
import { scalarText } from './scalar-text.js';
import { blindCopyId, blindMessage, blindSalt } from './blind.js';
import { finalizePdfAt, markHeights, watermarkCells } from './render.js';
import { withPdfPage, degradePage, drawPage } from './pdf-raster.js';
import { markImage } from './image-markers.js';
import { PRESETS } from './presets.js';
export { PRESETS };
// The low-resolution copy's lowest resolution: its page images keep enough plain paper around the watermark's letters
// for the marks' floors at every resolution from here to 90 dpi.
export const LOW_RES_MIN_DPI = 75;

const r2 = (v) => Math.round(v * 100) / 100; const r3 = (v) => Math.round(v * 1000) / 1000;
const between = (rng, lo, hi) => lo + rng() * (hi - lo);

// The seeded settings of one preset for one document. Every number is rounded, so the answer key states exactly
// what was applied.
export function degradationParams(preset, { type, scenario, seed }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no such preset; presets: ${PRESETS.join(', ')}`);
  if ([type, scenario, seed].some((v) => scalarText(v) === '')) throw new Error('degrade: invalid type, scenario or seed');
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
  return { ...base, dpi: Math.round(between(rng, LOW_RES_MIN_DPI, 90)), quality: r2(between(rng, 0.35, 0.55)) };
}

// Where a copy's stamped watermark goes on each page: where the original's went (`heights`, from markHeights). A photo's
// page is the sheet with table around it, so there the share is of the sheet's place on the larger page.
export function copyMarks(preset, params, heights) {
  return preset === 'photo' ? heights.map((h) => ({ fy: (params.margin + h.fy) / (1 + 2 * params.margin) })) : heights;
}
// Degrade a stamped PDF. Returns { pdf: Buffer, images: [{ page, mimeType, data: Buffer }] }: the image-only PDF,
// stamped and with the specimen metadata, and (with pageImages) one marked image per page drawn from it at the
// recipe's resolution. `label` names the document in the band and in the image markers. keepPictures (for tests)
// also returns the degraded pictures as they were before stamping, base64, unmarked.
export async function degradePdf(browser, bytes, { preset, params, label = null, title = null, pageImages = true, keepPictures = false }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no such preset; presets: ${PRESETS.join(', ')}`);
  // the stamped PDF's watermark heights: the copy's goes where the original's went (a PDF pdf-lib cannot read fails below,
  // where the browser reads it)
  let heights = []; try { heights = await markHeights(bytes); } catch { heights = []; }
  const pictures = await withPdfPage(browser, bytes, async (page, sizes) => {
    const out = [];
    for (let n = 1; n <= sizes.length; n++) {
      const [w, h] = sizes[n - 1];
      const mark = preset === 'fax' ? { width: w, height: h, cells: watermarkCells(w, h, heights[n - 1]) } : null;
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
    await finalizePdfAt(p, { band: label ? `${label} / ${preset}` : preset, title: title || undefined, degraded: true }, copyMarks(preset, params, heights));
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
// A copy of a blind document is blind too: its settings come from the document's own (salted) seed, and its band, title
// and image markers name the copy's id only (blind.js).
export async function degradeRendered(browser, { type, scenario, seed, preset, clean, pageImages = true }) {
  const blind = clean.groundTruth.blind || null;
  const params = degradationParams(preset, { type, scenario, seed: blind ? clean.groundTruth.seed : seed });
  const layout = clean.groundTruth.documents[0].layout || type;   // the type, or <type>.<id> for a layout variant
  const id = blind ? blindCopyId(blind.salt, blind.id, preset) : null;
  const label = blind ? id : `${layout} / ${scenario} / seed ${seed}`;
  const { pdf, images } = await degradePdf(browser, clean.bytes, { preset, params, label, title: blind ? `claimseed specimen - ${id}` : `claimseed specimen - ${layout} ${scenario} seed=${seed} (${preset} copy)`, pageImages });
  const groundTruth = JSON.parse(JSON.stringify(clean.groundTruth)); const doc = groundTruth.documents[0];
  if (blind) groundTruth.blind = { ...blind, id, copyOf: blind.id };
  doc.degradation = preset; doc.degradationParams = params;
  doc.sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  return { bytes: pdf, groundTruth, images };
}

// Render a document and a degraded copy of it. Returns { pdf, groundTruth, bytes, images, files }. With outDir, writes
// <type>_<scenario>_<seed>_<preset>.pdf, its .ground-truth.json and one image per page (_p<N>.jpg, or .png for a
// fax), each created exclusively.
export async function renderDegraded({ type, scenario, seed = 'claimseed', preset, outDir = null, browser = null, pageImages = true, also = null, bill = null, billParams = null, layoutVariant = null, blind = false, keysDir = null, insurer = null }) {
  if (!PRESETS.includes(preset)) throw new Error(`degrade: no such preset; presets: ${PRESETS.join(', ')}`);
  const { render, checkRender, checkStatementOptions, keysApart } = await import('./index.js');
  const { STATEMENT_TYPE } = await import('./generate/provider-statement.js');
  const { launchBrowser } = await import('./browser.js');
  // everything render would refuse, and the blind option, is refused before any folder is made
  checkRender({ type, scenario, seed, also, bill, billParams, layoutVariant, outDir, keysDir }, 'degrade');
  const { checkInsurer } = await import('./generate/commercial-eob.js'); checkInsurer({ type, insurer, blind }, 'degrade');
  // the salt is drawn once, so the statement's options are checked with the seed render generates from
  const salted = blind !== false ? { salt: blindSalt(blind) } : false;
  if (blind !== false && outDir && !keysDir) throw new Error(blindMessage('needKeys', 'degrade'));
  if (keysDir !== null && (blind === false || !outDir)) throw new Error(blindMessage('keysOnlyBlind', 'degrade'));
  checkStatementOptions({ type, scenario, seed, also, bill, billParams, layoutVariant, blind: salted, insurer }, 'degrade');
  if (blind !== false && outDir) keysApart(outDir, keysDir, 'degrade');
  const own = !browser; const b = browser || await launchBrowser();
  try {
    const clean = await render({ type, scenario, seed, browser: b, also, bill, billParams, layoutVariant, blind: salted, insurer });
    const id = clean.groundTruth.documents[0].layoutVariant?.id;   // a variant names its files: <stem>.<id>_<preset>
    const { bytes, groundTruth, images } = await degradeRendered(b, { type, scenario, seed, preset, clean, pageImages });
    const copyId = groundTruth.blind?.id || null;   // a blind copy is named by its id, its key written to keysDir
    const stem = `${type}_${scenario}_${seed}${id ? `.${id}` : ''}${insurer ? `.${insurer}` : ''}`;   // a named insurer names the copy as render names the document
    const name = copyId || `${stem}_${preset}`;
    // the statement beside an EOB gets its own copy, same preset, settings from its own type: <stem>.bill_<preset>
    let stCopy = null;
    if (clean.bill) {
      const st = await degradeRendered(b, { type: STATEMENT_TYPE, scenario, seed, preset, clean: clean.bill, pageImages });
      const stName = st.groundTruth.blind?.id || `${stem}.bill_${preset}`;
      groundTruth.pair = { ...groundTruth.pair, with: stName }; st.groundTruth.pair = { ...st.groundTruth.pair, with: name };
      stCopy = { ...st, name: stName, ...(st.groundTruth.blind ? { id: stName } : {}) };
    }
    const files = []; let billFiles = [];
    const write = (n, doc, remittance) => {
      const out = []; const base = path.join(outDir, n);
      fs.writeFileSync(base + '.pdf', doc.bytes, { flag: 'wx' }); out.push(base + '.pdf');
      const key = doc.groundTruth.blind ? path.join(keysDir, `${n}.ground-truth.json`) : base + '.ground-truth.json';
      fs.writeFileSync(key, JSON.stringify(doc.groundTruth, null, 2), { flag: 'wx' }); out.push(key);
      for (const i of doc.images) { const f = `${base}_p${i.page}.${i.mimeType === 'image/png' ? 'png' : 'jpg'}`; fs.writeFileSync(f, i.data, { flag: 'wx' }); out.push(f); }
      if (remittance !== null) { fs.writeFileSync(base + '.835', remittance, { flag: 'wx' }); out.push(base + '.835'); }
      return out;
    };
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      files.push(...write(name, { bytes, groundTruth, images }, clean.remittance));
      if (stCopy) billFiles = write(stCopy.name, stCopy, null);
    }
    const billOut = stCopy ? { pdf: outDir ? billFiles[0] : null, groundTruth: stCopy.groundTruth, bytes: stCopy.bytes, images: stCopy.images, files: billFiles, ...(stCopy.id ? { id: stCopy.id } : {}) } : null;
    return { pdf: outDir ? files[0] : null, groundTruth, bytes, images, files, remittance: clean.remittance, ...(copyId ? { id: copyId } : {}), ...(billOut ? { bill: billOut } : {}) };
  } finally { if (own) await b.close(); }
}
