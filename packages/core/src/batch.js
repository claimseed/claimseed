// batch.js — render many documents into one folder with a manifest, for building a test set.
//   renderBatch({ types: ['msn'], scenarios: 'all', seeds: 10, seedPrefix: 'batch', outDir })
// writes <type>_<scenario>_<seed>.pdf and .ground-truth.json per document (with `degrade`, a degraded copy instead,
// <type>_<scenario>_<seed>_<preset>.pdf; degrade.js) and manifest.jsonl, one JSON line per
// document with both file names, the PDF's SHA-256, the answer key's SHA-256, the page count, the preset of a degraded
// copy (`degradation`, null for a clean one), the claimseed version and the Chrome version that rendered it. Files are created exclusively: a batch never overwrites anything.
// With `blind` (true, or { salt } to make a set again) every document is blind (blind.js): <id>.pdf (and <id>.835) in
// outDir, written in an order drawn from the set's salt, and the answer keys and manifest.jsonl in keysDir, a folder
// apart from outDir; each manifest line adds the document's id.
// With `set` (a published set's name, set.js) the set file fixes every document, its layout, degraded copy and 835
// included; a set is always blind, and its keys and manifest lines also name the set and carry its canary.
// With `also` holding `bill` (ppo-eob, hmo-eob and commercial-eob only; `bill` names the statement variant, and a claim
// it does not apply to gets a clean statement, as its key says) each EOB comes with the provider's statement for one
// of its claims (index.js render). The statement is a job of its own, written at its own place in the order (drawn from the salt
// when blind), and pairs.jsonl publishes which two belong together; it has its own manifest line (type
// provider-statement, the EOB's scenario and seed, pairOf the EOB's file name without .pdf), and pairs.jsonl in outDir
// lists each pair as { eob, bill } file names without .pdf (blind: the two ids), sorted, and nothing else.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { listScenarios } from './generate/index.js';
import { RENDERERS } from './layouts.js';
import { launchBrowser } from './browser.js';
import { readRegularFile } from './safe-read.js';
import { scalarText } from './scalar-text.js';

import { VariantError, checkVariantOption, variantIds } from './variants.js';
import { blindSalt, blindOrder, blindMessage, checkFolders, blindCopyId } from './blind.js';
import { PRESETS } from './presets.js';
import { SET_STRINGS } from './set.js';
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

export async function renderBatch(options) {
  if (options.set !== undefined && options.set !== null) return renderSet(options);
  const { types, scenarios = 'all', seeds = 10, seedPrefix = 'batch', outDir, browser = null, degrade = null, also = null, bill = null, layoutVariant = null, blind = false, keysDir = null, onProgress = () => {} } = options;
  const { REMITTANCE_TYPES, alsoList } = await import('./index.js');
  const { pairMessage, PAIRED_TYPES, BILL_VARIANTS } = await import('./generate/provider-statement.js');
  if (degrade !== null && !PRESETS.includes(degrade)) throw new Error(`batch: no such preset; presets: ${PRESETS.join(', ')}`);
  checkFolders({ outDir, keysDir }, 'batch');
  const list = alsoList(also, 'batch'); const withBill = list.includes('bill');
  if (bill !== null && bill !== undefined && !withBill) throw new Error(pairMessage('billNeedsAlso', 'batch'));
  if (withBill && !(typeof (bill ?? 'clean') === 'string' && BILL_VARIANTS.includes(bill ?? 'clean'))) throw new Error(pairMessage('billVariant', 'batch'));
  const salt = blind === false ? null : blindSalt(blind);
  const planned = planBatch({ types, scenarios, seeds, seedPrefix, layoutVariant });
  if (list.includes('835') && planned.some((j) => !REMITTANCE_TYPES.includes(j.type))) throw new Error(`batch: an 835 is written for ${REMITTANCE_TYPES.join(', ')} only`);
  if (withBill && planned.some((j) => !PAIRED_TYPES.includes(j.type))) throw new Error(pairMessage('pairTypes', 'batch'));
  // with statements, each EOB job is two: the EOB and its statement, ordered (and, blind, shuffled) as any two jobs
  const parts = withBill ? planned.flatMap((j) => [{ ...j, part: 'eob' }, { ...j, part: 'bill' }]) : planned;
  const jobs = (salt ? blindOrder(salt, parts) : parts).map((j) => ({ ...j, degrade, also: list.length ? list : null, ...(withBill ? { bill: bill ?? 'clean' } : {}) }));
  return writeJobs({ jobs, salt, outDir, keysDir, browser, onProgress, set: null });
}

// A published set (set.js): the set file fixes every document, so no other batch option may be given beside it, and a
// set is always blind. Its answer keys and manifest lines also name the set, and each key carries the set's canary.
async function renderSet({ set, outDir, browser = null, blind = false, keysDir = null, onProgress = () => {}, ...rest }) {
  const { SetError, setMessage, loadSet, drawSalt, canaryOf } = await import('./set.js');
  const spec = loadSet(set);
  for (const k of ['types', 'scenarios', 'seeds', 'seedPrefix', 'degrade', 'also', 'bill', 'layoutVariant']) if (rest[k] !== undefined && rest[k] !== null) throw new SetError(setMessage('setOptions'));
  if (blind === false || keysDir === null || keysDir === undefined) throw new SetError(setMessage('setNotBlind'));
  const { REMITTANCE_TYPES } = await import('./index.js');
  // the floors are checked from the generator before anything is rendered (set.js drawSalt)
  const { salt, plan, draws, missed } = drawSalt(spec, blind, { remittanceTypes: REMITTANCE_TYPES });
  const jobs = blindOrder(salt, plan.jobs);
  const r = await writeJobs({ jobs, salt, outDir, keysDir, browser, onProgress, set: { name: spec.name, canary: canaryOf(spec) } });
  return { ...r, draws, missed };
}

// Render planned jobs ({ type, scenario, seed, layoutVariant?, degrade, also }) into outDir, the answer keys and
// manifest.jsonl beside them or, for a blind set, in keysDir. Not exported from index.js: renderBatch is the entry point.
export async function writeJobs({ jobs, salt, outDir, keysDir = null, browser = null, onProgress = () => {}, set = null }) {
  const { degradeRendered } = await import('./degrade.js');
  const { STATEMENT_TYPE } = await import('./generate/provider-statement.js');
  const { keysApart } = await import('./index.js');
  checkFolders({ outDir, keysDir }, 'batch');
  if (!outDir) throw new Error('batch: an output folder is required');
  if (salt && !keysDir) throw new Error(blindMessage('needKeys', 'batch'));
  if (!salt && keysDir !== null) throw new Error(blindMessage('keysOnlyBlind', 'batch'));
  if (salt) keysApart(outDir, keysDir, 'batch');   // makes both folders, or neither when it refuses
  else fs.mkdirSync(outDir, { recursive: true });
  const keys = salt ? keysDir : outDir;
  const manifestPath = path.join(keys, 'manifest.jsonl');
  // pairs.jsonl (a batch with statements) is claimed first and the manifest second, each refusing a folder that already
  // holds one; when the manifest is refused, the empty pairs.jsonl just made goes again, so a refusal leaves nothing
  const pairsPath = path.join(outDir, 'pairs.jsonl');
  let pairsFd = jobs.some((j) => j.part) ? fs.openSync(pairsPath, 'wx') : null;
  let manifest;
  try { manifest = fs.openSync(manifestPath, 'wx'); }   // refuses a folder that already holds a batch
  catch (e) { if (pairsFd !== null) { fs.closeSync(pairsFd); fs.unlinkSync(pairsPath); } throw e; }
  const { render } = await import('./index.js');
  const own = !browser; const b = browser || await launchBrowser();
  try {
    const chrome = typeof b.version === 'function' ? await b.version() : null;
    const held = new Map(); const pairs = [];   // a pair rendered for one part waits here for its other part's turn
    for (const [n, planned] of jobs.entries()) {
      const { degrade, also, bill, part, ...job } = planned;
      if (part) {
        const k = JSON.stringify([job.type, job.scenario, job.seed, job.layoutVariant ?? null]);
        const r = held.get(k) || await render({ ...job, browser: b, also, bill, billOrClean: true, ...(salt ? { blind: { salt } } : {}) });
        if (held.has(k)) held.delete(k); else held.set(k, r);
        const vid = r.groundTruth.documents[0].layoutVariant?.id; const { layoutVariant: _lv, ...fields } = job;
        // the two names, of the documents or, with `degrade`, of their copies (the statement's settings from its own type)
        const eobBase = salt ? (degrade ? blindCopyId(salt, r.id, degrade) : r.id) : `${job.type}_${job.scenario}_${job.seed}${vid ? `.${vid}` : ''}${degrade ? `_${degrade}` : ''}`;
        const billBase = salt ? (degrade ? blindCopyId(salt, r.bill.id, degrade) : r.bill.id) : `${job.type}_${job.scenario}_${job.seed}${vid ? `.${vid}` : ''}.bill${degrade ? `_${degrade}` : ''}`;
        let doc = part === 'eob' ? { bytes: r.bytes, groundTruth: r.groundTruth, remittance: r.remittance } : { bytes: r.bill.bytes, groundTruth: r.bill.groundTruth, remittance: null };
        if (degrade) {
          const copy = await degradeRendered(b, { ...job, ...(part === 'bill' ? { type: STATEMENT_TYPE } : {}), preset: degrade, clean: { bytes: doc.bytes, groundTruth: doc.groundTruth }, pageImages: false });
          copy.groundTruth.pair = { ...copy.groundTruth.pair, with: part === 'eob' ? billBase : eobBase };
          doc = { ...doc, bytes: copy.bytes, groundTruth: copy.groundTruth };
        }
        const base = part === 'eob' ? eobBase : billBase;
        if (set) doc.groundTruth.blind = { ...doc.groundTruth.blind, set: set.name, canary: set.canary };
        const gt = Buffer.from(JSON.stringify(doc.groundTruth, null, 2));
        fs.writeFileSync(path.join(outDir, `${base}.pdf`), doc.bytes, { flag: 'wx' });
        fs.writeFileSync(path.join(keys, `${base}.ground-truth.json`), gt, { flag: 'wx' });
        const line = { pdf: `${base}.pdf`, groundTruth: `${base}.ground-truth.json`, ...(salt ? { id: base } : {}), ...(set ? { set: set.name, canary: set.canary } : {}), ...fields, ...(part === 'bill' ? { type: doc.groundTruth.documents[0].type, pairOf: eobBase } : {}),
          ...(vid && part === 'eob' ? { layoutVariant: vid } : {}), degradation: degrade, pages: doc.groundTruth.documents[0].pages, sha256: sha(doc.bytes), groundTruthSha256: sha(gt), claimseedVersion: VERSION, chrome };
        if (doc.remittance !== null) { const x = Buffer.from(doc.remittance); fs.writeFileSync(path.join(outDir, `${base}.835`), x, { flag: 'wx' }); line.remittance = `${base}.835`; line.remittanceSha256 = sha(x); }
        fs.writeSync(manifest, JSON.stringify(line) + '\n');
        if (part === 'eob') pairs.push({ eob: eobBase, bill: billBase });
        onProgress(n + 1, jobs.length, base);
        continue;
      }
      let { bytes, groundTruth, remittance } = await render({ ...job, browser: b, also, ...(salt ? { blind: { salt } } : {}) });
      // a layout variant (seeded resolves here) names the files and its manifest line: <stem>.<id>
      const id = groundTruth.documents[0].layoutVariant?.id; const { layoutVariant: _asked, ...jobFields } = job;
      if (degrade) ({ bytes, groundTruth } = await degradeRendered(b, { ...job, preset: degrade, clean: { bytes, groundTruth }, pageImages: false }));
      if (set) groundTruth.blind = { ...groundTruth.blind, set: set.name, canary: set.canary };
      // a blind document (or its degraded copy) is named by its id
      const base = salt ? groundTruth.blind.id : `${job.type}_${job.scenario}_${job.seed}${id ? `.${id}` : ''}${degrade ? `_${degrade}` : ''}`;
      const gt = Buffer.from(JSON.stringify(groundTruth, null, 2));
      fs.writeFileSync(path.join(outDir, `${base}.pdf`), bytes, { flag: 'wx' });
      fs.writeFileSync(path.join(keys, `${base}.ground-truth.json`), gt, { flag: 'wx' });
      const line = { pdf: `${base}.pdf`, groundTruth: `${base}.ground-truth.json`, ...(salt ? { id: base } : {}), ...(set ? { set: set.name, canary: set.canary } : {}), ...jobFields, ...(id ? { layoutVariant: id } : {}), degradation: degrade, pages: groundTruth.documents[0].pages,
        sha256: sha(bytes), groundTruthSha256: sha(gt), claimseedVersion: VERSION, chrome };
      if (remittance !== null) { const r = Buffer.from(remittance); fs.writeFileSync(path.join(outDir, `${base}.835`), r, { flag: 'wx' }); line.remittance = `${base}.835`; line.remittanceSha256 = sha(r); }
      fs.writeSync(manifest, JSON.stringify(line) + '\n');
      onProgress(n + 1, jobs.length, base);
    }
    if (pairsFd !== null) fs.writeSync(pairsFd, pairs.sort((x, y) => (x.eob < y.eob ? -1 : 1)).map((p) => JSON.stringify(p) + '\n').join(''));
  } finally {
    fs.closeSync(manifest); if (pairsFd !== null) fs.closeSync(pairsFd);
    if (own) await b.close();
  }
  return { count: jobs.length, outDir, manifest: manifestPath, ...(salt ? { keysDir, salt } : {}) };
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
    // a degraded document names its preset; a clean one names none (or null). The breakdowns are grouped by it.
    if (!(e.degradation === undefined || e.degradation === null || PRESETS.includes(e.degradation))) throw new Error(SET_STRINGS.messages.manifestDegradation.replace('{line}', String(i + 1)).replace('{presets}', PRESETS.join(', ')));
    return e;
  });
}
