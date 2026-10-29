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
import { DATA_DIR, hardenHtml, renderHtmlToPdf, finalizePdf, mergePdfs, templateContext, BAND_TEXT, WATERMARK_TEXT, SPECIMEN_SUBJECT } from './render.js';
import { launchBrowser, findChrome } from './browser.js';

export { generateData, listScenarios, loadScenario, RENDERERS, hardenHtml, renderHtmlToPdf, finalizePdf, mergePdfs, templateContext, launchBrowser, findChrome, BAND_TEXT, WATERMARK_TEXT, SPECIMEN_SUBJECT };

export { scoreExtraction, verifyFromSeed, checkOutput, LIMITS as VERIFY_LIMITS } from './verify.js';
export { renderBatch, planBatch, readManifest } from './batch.js';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Generate and render one document. Returns { pdf, groundTruth, bytes } and writes
// <outDir>/<type>_<scenario>_<seed>.pdf and .ground-truth.json when outDir is given. `browser` (optional) is a
// browser from launchBrowser() to render with; it is left open for the caller. Without it, one is launched and closed.
export async function render({ type, scenario, seed = 'claimseed', outDir = null, browser = null }) {
  if (!SLUG.test(String(type)) || !SLUG.test(String(scenario)) || !SEED.test(String(seed))) throw new Error('render: invalid type, scenario or seed');
  const fn = RENDERERS[type];
  if (!fn) throw new Error(`render: no renderer for type ${type}`);
  const { data, groundTruth } = generateData({ type, scenario, seed });
  const stock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, type, 'stock-content.json'), 'utf-8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-'));
  let bytes;
  try {
    const pdfPath = await fn(data, stock, work, { title: `claimseed specimen - ${type} ${scenario} seed=${seed}`, band: `${type} / ${scenario} / seed ${seed}`, browser });
    bytes = fs.readFileSync(pdfPath);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  const doc = groundTruth.documents[0];
  doc.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  doc.pages = (await (await import('pdf-lib')).PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  doc.fields['metadata.pageCount'] = doc.pages;
  let pdf = null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${type}_${scenario}_${seed}`);
    fs.writeFileSync(base + '.pdf', bytes); fs.writeFileSync(base + '.ground-truth.json', JSON.stringify(groundTruth, null, 2));
    pdf = base + '.pdf';
  }
  return { pdf, groundTruth, bytes };
}
