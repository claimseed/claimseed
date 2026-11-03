// batch.js — render many documents into one folder with a manifest, for building a test set.
//   renderBatch({ types: ['msn'], scenarios: 'all', seeds: 10, seedPrefix: 'batch', outDir })
// writes <type>_<scenario>_<seed>.pdf and .ground-truth.json per document (with `degrade`, a degraded copy instead,
// <type>_<scenario>_<seed>_<preset>.pdf; degrade.js) and manifest.jsonl, one JSON line per
// document with both file names, the PDF's SHA-256, the answer key's SHA-256, the page count, the preset of a degraded
// copy (`degradation`, null for a clean one), the claimseed version and the Chrome version that rendered it. Files are created exclusively: a batch never overwrites anything.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { listScenarios } from './generate/index.js';
import { RENDERERS } from './layouts.js';
import { launchBrowser } from './browser.js';
import { readRegularFile } from './safe-read.js';
import { scalarText } from './scalar-text.js';

import { VariantError, checkVariantOption, variantIds } from './variants.js';
const PKG = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf-8'));
export const VERSION = PKG.version;
export const MAX_BATCH = 10000;
const MAX_MANIFEST = 64 * 2 ** 20;   // far above 10,000 lines
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The documents a batch would render, in order; throws on an unknown type or scenario.
export function planBatch({ types, scenarios = 'all', seeds = 10, seedPrefix = 'batch', layoutVariant = null }) {
  if (!Array.isArray(types) || !types.length) throw new Error('batch: name at least one type');
  if (!Number.isSafeInteger(seeds) || seeds < 1) throw new Error('batch: seeds must be a whole number of at least 1');
  if (typeof seedPrefix !== 'string' || !SEED.test(`${seedPrefix}-${seeds}`)) throw new Error('batch: the seed prefix must be letters, digits, . _ - and start with a letter or digit');
  // count first, build after: a request over the limit is refused before anything is allocated for it
  // no message repeats a requested name; a scenario is kept for the named types that have it, but one that none of
  // them has is refused rather than dropped
  const plan = [];
  if (scenarios !== 'all' && !Array.isArray(scenarios)) throw new Error('batch: invalid scenario name; use only lowercase letters, digits and hyphens');
  if (scenarios !== 'all') for (const s of scenarios) if (!SLUG.test(scalarText(s))) throw new Error('batch: invalid scenario name; use only lowercase letters, digits and hyphens');
  // a type or scenario named twice is planned once (twice would give two documents of the same file name)
  types = [...new Set(types)]; if (scenarios !== 'all') scenarios = [...new Set(scenarios)];
  for (const type of types) {
    if (!SLUG.test(scalarText(type)) || !Object.hasOwn(RENDERERS, type)) throw new Error(`batch: unknown document type; the known types are ${Object.keys(RENDERERS).join(', ')}`);
    const available = listScenarios(type);
    plan.push([type, scenarios === 'all' ? available : scenarios.filter((s) => available.includes(s))]);
  }
  if (scenarios !== 'all') for (const s of scenarios) if (!plan.some(([, chosen]) => chosen.includes(s))) throw new Error('batch: a named scenario exists for none of the named types');
  // a layout variant applies to every named type: an id is one type's, and seeded or all cannot include the MSN (refused whole)
  if (layoutVariant !== null) {
    if (types.includes('msn') && (layoutVariant === 'seeded' || layoutVariant === 'all')) throw new VariantError('variantSeededAll');
    for (const type of types) checkVariantOption(type, layoutVariant, { allowAll: true });
  }
  const perJob = layoutVariant === 'all' ? (t) => variantIds(t).length : () => 1;
  const count = plan.reduce((n, [type, chosen]) => n + chosen.length * seeds * perJob(type), 0);
  if (!count) throw new Error('batch: none of the named scenarios exists for the named types');
  if (count > MAX_BATCH) throw new Error(`batch: ${count} documents is over the limit of ${MAX_BATCH}`);
  const jobs = [];
  for (const [type, chosen] of plan) for (const scenario of chosen) for (let i = 1; i <= seeds; i++) {
    const job = { type, scenario, seed: `${seedPrefix}-${i}` };
    if (layoutVariant === 'all') for (const id of variantIds(type)) jobs.push({ ...job, layoutVariant: id });
    else jobs.push(layoutVariant === null ? job : { ...job, layoutVariant });
  }
  return jobs;
}

export async function renderBatch({ types, scenarios = 'all', seeds = 10, seedPrefix = 'batch', outDir, browser = null, degrade = null, also = null, layoutVariant = null, onProgress = () => {} }) {
  const { PRESETS, degradeRendered } = await import('./degrade.js');
  const { ALSO, REMITTANCE_TYPES } = await import('./index.js');
  if (degrade !== null && !PRESETS.includes(degrade)) throw new Error(`batch: no degradation preset ${degrade}; presets: ${PRESETS.join(', ')}`);
  if (also !== null && !ALSO.includes(also)) throw new Error(`batch: also must be one of ${ALSO.join(', ')}`);
  const jobs = planBatch({ types, scenarios, seeds, seedPrefix, layoutVariant });
  if (also === '835' && jobs.some((j) => !REMITTANCE_TYPES.includes(j.type))) throw new Error(`batch: an 835 is written for ${REMITTANCE_TYPES.join(', ')} only`);
  if (!outDir) throw new Error('batch: an output folder is required');
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.jsonl');
  const manifest = fs.openSync(manifestPath, 'wx');   // refuses a folder that already holds a batch
  const { render } = await import('./index.js');
  const own = !browser; const b = browser || await launchBrowser();
  try {
    const chrome = typeof b.version === 'function' ? await b.version() : null;
    for (const [n, job] of jobs.entries()) {
      let { bytes, groundTruth, remittance } = await render({ ...job, browser: b, also });
      // a layout variant (seeded resolves here) names the files and its manifest line: <stem>.<id>
      const id = groundTruth.documents[0].layoutVariant?.id; const { layoutVariant: _asked, ...jobFields } = job;
      const base = `${job.type}_${job.scenario}_${job.seed}${id ? `.${id}` : ''}${degrade ? `_${degrade}` : ''}`;
      if (degrade) ({ bytes, groundTruth } = await degradeRendered(b, { ...job, preset: degrade, clean: { bytes, groundTruth }, pageImages: false }));
      const gt = Buffer.from(JSON.stringify(groundTruth, null, 2));
      fs.writeFileSync(path.join(outDir, `${base}.pdf`), bytes, { flag: 'wx' });
      fs.writeFileSync(path.join(outDir, `${base}.ground-truth.json`), gt, { flag: 'wx' });
      const line = { pdf: `${base}.pdf`, groundTruth: `${base}.ground-truth.json`, ...jobFields, ...(id ? { layoutVariant: id } : {}), degradation: degrade, pages: groundTruth.documents[0].pages,
        sha256: sha(bytes), groundTruthSha256: sha(gt), claimseedVersion: VERSION, chrome };
      if (remittance !== null) { const r = Buffer.from(remittance); fs.writeFileSync(path.join(outDir, `${base}.835`), r, { flag: 'wx' }); line.remittance = `${base}.835`; line.remittanceSha256 = sha(r); }
      fs.writeSync(manifest, JSON.stringify(line) + '\n');
      onProgress(n + 1, jobs.length, base);
    }
  } finally {
    fs.closeSync(manifest);
    if (own) await b.close();
  }
  return { count: jobs.length, outDir, manifest: manifestPath };
}

// Read a batch manifest back: one entry per line, each checked for the fields scoring needs.
export function readManifest(manifestPath) {
  let text;
  try { text = readRegularFile(manifestPath, MAX_MANIFEST, { follow: true }).toString('utf-8'); }
  catch (err) { throw new Error(`the manifest is ${err.code === 'NOT_REGULAR' ? 'not a regular file' : err.code === 'TOO_LARGE' ? `over ${MAX_MANIFEST / 2 ** 20} MB` : err.code === 'ENOENT' ? 'missing' : 'unreadable'}`); }
  return text.split('\n').filter((l) => l.trim()).map((l, i) => {
    let e; try { e = JSON.parse(l); } catch { throw new Error(`manifest line ${i + 1} is not JSON`); }
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`manifest line ${i + 1} is not an object`);
    for (const k of ['pdf', 'groundTruth', 'type', 'scenario', 'seed']) if (typeof e[k] !== 'string') throw new Error(`manifest line ${i + 1} has no ${k}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.pdf$/.test(e.pdf) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.ground-truth\.json$/.test(e.groundTruth)) throw new Error(`manifest line ${i + 1} names a file outside the batch folder, or not a PDF and its answer key`);
    if (!/^[0-9a-f]{64}$/.test(scalarText(e.groundTruthSha256))) throw new Error(`manifest line ${i + 1} has no groundTruthSha256`);
    if (e.remittance !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.835$/.test(scalarText(e.remittance)) || !/^[0-9a-f]{64}$/.test(scalarText(e.remittanceSha256)))) throw new Error(`manifest line ${i + 1} names an 835 outside the batch folder, or without its SHA-256`);
    return e;
  });
}
