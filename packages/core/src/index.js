// @claimseed/core — library entry point. The CLI (src/cli.js) is a thin wrapper over these exports.
//
//   import { generateData, listScenarios, render } from '@claimseed/core';
//   const { data, groundTruth } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'demo' });
//   const pdfPath = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'demo', outDir: './out' });
//
// Every PDF produced here is stamped with the specimen band and watermark on every page and carries the specimen
// metadata; that happens inside mergePdfs, which every render function goes through, so no library caller can
// obtain an unstamped claimseed document.
import fs from 'fs'; import path from 'path'; import os from 'os'; import crypto from 'crypto';
import { generateData, listScenarios, loadScenario } from './generate/index.js';
import { RENDERERS } from './layouts.js';
import { scalarText } from './scalar-text.js';
import { DATA_DIR, hardenHtml, renderHtmlToPdf, finalizePdf, mergePdfs, templateContext, BAND_TEXT, WATERMARK_TEXT, SPECIMEN_SUBJECT } from './render.js';
import { launchBrowser, findChrome } from './browser.js';

export { generateData, listScenarios, loadScenario, RENDERERS, hardenHtml, renderHtmlToPdf, finalizePdf, mergePdfs, templateContext, launchBrowser, findChrome, BAND_TEXT, WATERMARK_TEXT, SPECIMEN_SUBJECT };
export { PRESETS as DEGRADE_PRESETS, degradationParams, degradePdf, degradeRendered, renderDegraded } from './degrade.js';
export { withPdfPage, drawPage, RASTER_ORIGIN } from './pdf-raster.js';
export { markImage, markPng, markJpeg, markerTexts } from './image-markers.js';

export { scoreExtraction, verifyFromSeed, checkOutput, LIMITS as VERIFY_LIMITS } from './verify.js';
export { renderBatch, planBatch, readManifest } from './batch.js';
import { buildRemittance, REMITTANCE_TYPES } from './x12/remittance.js';
export { buildRemittance, remittanceFor, REMITTANCE_TYPES, SPECIMEN_STRINGS as X12_SPECIMEN_STRINGS } from './x12/remittance.js';
export { check835, checkSpecimen835, parse835 } from './x12/check835.js';
export { VARIANT_TYPES, VARIANT_STRINGS, variantIds, checkVariantOption, resolveVariant } from './variants.js';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Generate and render one document. Returns { pdf, groundTruth, bytes, remittance } and writes
// <outDir>/<type>_<scenario>_<seed>.pdf and .ground-truth.json when outDir is given. `browser` (optional) is a
// browser from launchBrowser() to render with; it is left open for the caller. Without it, one is launched and closed.
// `also: '835'` adds the X12 835 remittance of the same claims (x12/remittance.js): its text in `remittance`, written
// as <base>.835 byte for byte, and in the answer key as documents[1] with x12Ref on the errors it carries.
export const ALSO = ['835'];
export async function render({ type, scenario, seed = 'claimseed', outDir = null, browser = null, also = null, layoutVariant = null }) {
  if (!SLUG.test(scalarText(type)) || !SLUG.test(scalarText(scenario)) || !SEED.test(scalarText(seed))) throw new Error('render: invalid type, scenario or seed');
  if (also !== null && !ALSO.includes(also)) throw new Error(`render: also must be one of ${ALSO.join(', ')}`);
  if (also === '835' && !REMITTANCE_TYPES.includes(type)) throw new Error(`render: an 835 is written for ${REMITTANCE_TYPES.join(', ')} only`);
  const fn = Object.prototype.hasOwnProperty.call(RENDERERS, type) ? RENDERERS[type] : null;
  if (!fn) throw new Error('render: no renderer for that type');
  const generated = generateData({ type, scenario, seed, layoutVariant }); const { data, groundTruth } = generated;
  const variant = data._variant || null;   // a layout variant names the file, the band and the title (0.5.0)
  const label = variant ? variant.layout : type;
  const stock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, type, 'stock-content.json'), 'utf-8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-'));
  let bytes;
  try {
    const pdfPath = await fn(data, stock, work, { title: `claimseed specimen - ${label} ${scenario} seed=${seed}`, band: `${label} / ${scenario} / seed ${seed}`, browser });
    bytes = fs.readFileSync(pdfPath);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  const doc = groundTruth.documents[0];
  doc.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  doc.pages = (await (await import('pdf-lib')).PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  doc.fields['metadata.pageCount'] = doc.pages;
  let remittance = null;
  if (also === '835') {
    const r = buildRemittance({ type, scenario, seed, generated });
    remittance = r.text; groundTruth.documents.push(r.document); groundTruth.errors.forEach((e, i) => { e.x12Ref = r.x12Refs[i]; });
  }
  let pdf = null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${type}_${scenario}_${seed}${variant ? `.${variant.id}` : ''}`);
    fs.writeFileSync(base + '.pdf', bytes); fs.writeFileSync(base + '.ground-truth.json', JSON.stringify(groundTruth, null, 2));
    if (remittance !== null) fs.writeFileSync(base + '.835', remittance);
    pdf = base + '.pdf';
  }
  return { pdf, groundTruth, bytes, remittance };
}
