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
import { blindSalt, blindSeed, blindId, blindRecord, blindMessage, checkFolders, BLIND_SCHEMA_VERSION } from './blind.js';
import { checkVariantOption } from './variants.js';
import { generatePair } from './generate/index.js';
import { PAIR_STRINGS, pairMessage, PAIRED_TYPES, STATEMENT_TYPE } from './generate/provider-statement.js';
import { renderStatement } from './render.js';
export { PAIR_STRINGS, BILL_VARIANTS, PAIRED_TYPES } from './generate/provider-statement.js';

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
export { SALT as BLIND_SALT, BLIND_ID, BLIND_STRINGS } from './blind.js';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Generate and render one document. Returns { pdf, groundTruth, bytes, remittance } and writes
// <outDir>/<type>_<scenario>_<seed>.pdf and .ground-truth.json when outDir is given. `browser` (optional) is a
// browser from launchBrowser() to render with; it is left open for the caller. Without it, one is launched and closed.
// `also: '835'` adds the X12 835 remittance of the same claims (x12/remittance.js): its text in `remittance`, written
// as <base>.835 byte for byte, and in the answer key as documents[1] with x12Ref on the errors it carries.
// `blind: true` (or { salt }) makes a blind document (blind.js): generated from a seed derived from the salt, its band
// and title naming only an opaque id, written as <id>.pdf (and <id>.835) in outDir and its answer key as
// <id>.ground-truth.json in keysDir, a folder apart from outDir. The result's `id` is that id.
// `also` may also hold `bill` (a ppo-eob or hmo-eob only), alone or with `835` as a list of the two: then the
// provider's statement for one claim of the EOB (generatePair; `bill` names its variant, `billParams` its amounts) is
// rendered too, written as <base>.bill.pdf and <base>.bill.ground-truth.json, or, blind, as <statement id>.pdf with its
// key in keysDir. Both keys are then schema 1.6 and name each other in `pair.with` (the other's file name without its
// extension, or its blind id). The EOB is the same with or without its statement. The result's `bill` holds the
// statement's { pdf, groundTruth, bytes, id?, answerKey? }.
export const ALSO = ['835', 'bill'];
// `also` as a list: nothing, one value, or both values once each (any order); checked before anything else is used
export function alsoList(also, who) {
  if (also === null || also === undefined) return [];
  if (typeof also === 'string') { if (!ALSO.includes(also)) throw new Error(`${who}: also must be one of ${ALSO.join(', ')}`); return [also]; }
  if (Array.isArray(also) && also.length >= 1 && also.length <= ALSO.length) {
    const list = []; for (let i = 0; i < also.length; i++) list.push(Object.hasOwn(also, i) ? also[i] : null);   // a hole is no value
    if (list.every((x) => typeof x === 'string' && ALSO.includes(x)) && new Set(list).size === list.length) return list;
  }
  throw new Error(pairMessage('alsoList', who));
}
// the statement's id beside a blind EOB: drawn from the salt, the EOB's id, the variant and its amounts (two statements of
// one EOB never share an id), so it says nothing of the scenario
function blindPairId(salt, eobId, variant, params) {
  const amounts = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join(',');
  return `doc-${crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(['pair-bill', eobId, variant, amounts].join('\u0000')).digest('hex').slice(0, 16)}`;
}
// a folder for answer keys that a tool reading outDir would also see is refused: keysDir must not be outDir or inside it
// (links resolved, checked before either folder is made, so a refused call creates nothing)
function resolvedPath(p) {
  let head = path.resolve(p); const rest = [];
  while (!fs.existsSync(head)) { rest.unshift(path.basename(head)); const up = path.dirname(head); if (up === head) break; head = up; }
  return path.join(fs.realpathSync(head), ...rest);
}
// the folders a path is in, as far as they exist, nearest first (the path itself when it exists)
function existingFolders(p) {
  const out = []; let d = path.resolve(p);
  for (;;) { if (fs.existsSync(d)) out.push(d); const up = path.dirname(d); if (up === d) return out; d = up; }
}
const sameFolder = (a, b) => { const x = fs.statSync(a); const y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; };
export function keysApart(outDir, keysDir, who) {
  checkFolders({ outDir, keysDir }, who);
  const rel = path.relative(resolvedPath(outDir), resolvedPath(keysDir));
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) throw new Error(blindMessage('keysApart', who));
  // and by the folders themselves, once the documents folder exists and again once the keys folder does, so that a
  // name the file system makes the same folder (another case on a case-insensitive disk, a link that only resolves once
  // a folder is made) is refused too. Whatever was made for the check is taken away again (new, so still empty) when
  // it refuses or a folder cannot be made, so a refused call leaves nothing; the message names no path.
  const made = [];
  const undo = () => { for (const [leaf, top] of made.reverse()) for (let d = path.resolve(leaf); ; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { /* not ours or not empty */ } if (d === path.resolve(top)) break; } };
  // a link on the keys path that points nowhere yet could land anywhere once folders are made: refused as well
  const inside = () => existingFolders(keysDir).some((d) => sameFolder(d, outDir)) || danglingLinkOn(keysDir);
  const INSIDE = Symbol('inside');
  try {
    const o = fs.mkdirSync(outDir, { recursive: true }); if (o) made.push([outDir, o]);
    if (inside()) throw INSIDE;
    const k = fs.mkdirSync(keysDir, { recursive: true }); if (k) made.push([keysDir, k]);
    if (inside()) throw INSIDE;
  } catch (e) { undo(); if (e === INSIDE) throw new Error(blindMessage('keysApart', who)); throw e; }
}
function danglingLinkOn(p) {
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    try { if (fs.lstatSync(d).isSymbolicLink() && !fs.existsSync(d)) return true; } catch { /* not there */ }
    if (path.dirname(d) === d) return false;
  }
}
// What a render refuses in the values a caller gave, checked before any of them is converted, hashed into a blind id
// or seed, or used to make a folder: the type, scenario and seed, the 835, the layout variant, the scenario's file
// and the two folder options. renderDegraded checks the same before it makes any folder.
export function checkRender({ type, scenario, seed = 'claimseed', also = null, bill = null, billParams = null, layoutVariant = null, outDir = null, keysDir = null }, who) {
  if (!SLUG.test(scalarText(type)) || !SLUG.test(scalarText(scenario)) || !SEED.test(scalarText(seed))) throw new Error('render: invalid type, scenario or seed');
  const list = alsoList(also, 'render');
  if (list.includes('835') && !REMITTANCE_TYPES.includes(type)) throw new Error(`render: an 835 is written for ${REMITTANCE_TYPES.join(', ')} only`);
  if (((bill !== null && bill !== undefined) || (billParams !== null && billParams !== undefined)) && !list.includes('bill')) throw new Error(pairMessage('billNeedsAlso', who));
  if (list.includes('bill') && !PAIRED_TYPES.includes(type)) throw new Error(pairMessage('pairTypes', who));
  if (!Object.prototype.hasOwnProperty.call(RENDERERS, type)) throw new Error('render: no renderer for that type');
  checkVariantOption(type, layoutVariant);
  checkFolders({ outDir, keysDir }, who);
  loadScenario(type, scenario);
}

export async function render({ type, scenario, seed = 'claimseed', outDir = null, browser = null, also = null, bill = null, billParams = null, layoutVariant = null, blind = false, keysDir = null, billOrClean = false }) {
  checkRender({ type, scenario, seed, also, bill, billParams, layoutVariant, outDir, keysDir }, 'render');
  const list = alsoList(also, 'render');
  const fn = RENDERERS[type];
  let b = null;
  if (blind !== false) {
    const salt = blindSalt(blind); const job = { type, scenario, seed: scalarText(seed), layoutVariant };
    b = { salt, job, seed: blindSeed(salt, job), id: blindId(salt, job) };
    if (outDir && !keysDir) throw new Error(blindMessage('needKeys', 'render'));
  }
  if (keysDir !== null && (!b || !outDir)) throw new Error(blindMessage('keysOnlyBlind', 'render'));
  const genSeed = b ? b.seed : seed;
  // generated before any folder is made, so that nothing the generator refuses leaves one behind
  const generated = generateData({ type, scenario, seed: genSeed, layoutVariant }); const { data, groundTruth } = generated;
  // the statement is drawn from a stream of its own, so the EOB above is the one generatePair makes too
  const statement = list.includes('bill') ? generatePair({ type, scenario, seed: genSeed, layoutVariant, bill: bill ?? 'clean', billParams, orClean: billOrClean === true, who: 'render' }).statement : null;
  if (b && outDir) keysApart(outDir, keysDir, 'render');
  if (b) { groundTruth.schemaVersion = BLIND_SCHEMA_VERSION; groundTruth.blind = blindRecord(b.salt, b.job, b.id); }
  const variant = data._variant || null;   // a layout variant names the file, the band and the title (0.5.0)
  const label = variant ? variant.layout : type;
  // a blind document's band and title name its id only
  const marks = b ? { title: `claimseed specimen - ${b.id}`, band: b.id } : { title: `claimseed specimen - ${label} ${scenario} seed=${seed}`, band: `${label} / ${scenario} / seed ${seed}` };
  const stock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, type, 'stock-content.json'), 'utf-8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-'));
  let bytes;
  try {
    const pdfPath = await fn(data, stock, work, { ...marks, browser });
    bytes = fs.readFileSync(pdfPath);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  const doc = groundTruth.documents[0];
  doc.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  doc.pages = (await (await import('pdf-lib')).PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  doc.fields['metadata.pageCount'] = doc.pages;
  let remittance = null;
  if (list.includes('835')) {
    const r = buildRemittance({ type, scenario, seed: genSeed, generated });
    remittance = r.text; groundTruth.documents.push(r.document); groundTruth.errors.forEach((e, i) => { e.x12Ref = r.x12Refs[i]; });
  }
  const name = b ? b.id : `${type}_${scenario}_${seed}${variant ? `.${variant.id}` : ''}`;
  let billOut = null;
  if (statement) {
    const st = statement.groundTruth; const stId = b ? blindPairId(b.salt, b.id, st.pair.variant, st.pair.params) : null; const stName = b ? stId : `${name}.bill`;
    const stMarks = b ? { title: `claimseed specimen - ${stId}`, band: stId } : { title: `claimseed specimen - ${STATEMENT_TYPE} ${scenario} seed=${seed}`, band: `${STATEMENT_TYPE} / ${scenario} / seed ${seed}` };
    const billStock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'itemized-bill', 'stock-content.json'), 'utf-8'));
    const stWork = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-'));
    let stBytes;
    try { stBytes = fs.readFileSync(await renderStatement(statement.data, billStock, PAIR_STRINGS.labels, stWork, { ...stMarks, browser })); }
    finally { fs.rmSync(stWork, { recursive: true, force: true }); }
    st.documents[0].sha256 = crypto.createHash('sha256').update(stBytes).digest('hex');
    st.documents[0].pages = (await (await import('pdf-lib')).PDFDocument.load(stBytes, { updateMetadata: false })).getPageCount();
    st.pair.with = name;
    groundTruth.schemaVersion = '1.6';
    groundTruth.pair = { role: 'eob', with: stName, claim: st.pair.claim, variant: st.pair.variant, params: st.pair.params };
    if (b) st.blind = { ...blindRecord(b.salt, b.job, stId) };
    billOut = { pdf: null, groundTruth: st, bytes: stBytes, ...(b ? { id: stId } : {}), stName };
  }
  let pdf = null; let answerKey = null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, name);
    answerKey = b ? path.join(keysDir, `${b.id}.ground-truth.json`) : base + '.ground-truth.json';
    fs.writeFileSync(base + '.pdf', bytes); fs.writeFileSync(answerKey, JSON.stringify(groundTruth, null, 2));
    if (remittance !== null) fs.writeFileSync(base + '.835', remittance);
    pdf = base + '.pdf';
    if (billOut) {
      billOut.pdf = path.join(outDir, `${billOut.stName}.pdf`);
      billOut.answerKey = b ? path.join(keysDir, `${billOut.stName}.ground-truth.json`) : path.join(outDir, `${billOut.stName}.ground-truth.json`);
      fs.writeFileSync(billOut.pdf, billOut.bytes); fs.writeFileSync(billOut.answerKey, JSON.stringify(billOut.groundTruth, null, 2));
    }
  }
  if (billOut) delete billOut.stName;
  return { pdf, groundTruth, bytes, remittance, ...(b ? { id: b.id, answerKey } : {}), ...(billOut ? { bill: billOut } : {}) };
}
