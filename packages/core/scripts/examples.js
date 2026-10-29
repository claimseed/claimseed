#!/usr/bin/env node
// examples.js — the example set: one document per published scenario, rendered with the seed "example".
//   node scripts/examples.js --check          render every example and compare it with examples/manifest.json (CI)
//   node scripts/examples.js --update         rewrite examples/manifest.json and examples/README.md
//   node scripts/examples.js --out DIR        also write the PDFs and ground truth to DIR (release assets)
//   node scripts/examples.js --words DIR      also write each example's page words, as hashed, to DIR (to compare runs)
// The repository holds no PDF (check-synthetic.js allows no binary), so the manifest records, per example, a hash of
// the printed text and a hash of the ground truth. The text hash is taken over each page's words in sorted order
// (pdftotext), so it changes when what a page says changes, but not with the PDF bytes, which differ between Chrome
// builds. The ground-truth hash leaves out the PDF's SHA-256 for the same reason. A changed hash means an example's
// content changed: if that was intended, run --update and commit the result with the change. The words pdftotext
// reads also depend on the Chrome and Poppler versions and the platform, so the manifest records the environment its
// hashes were recorded in, and --check names both environments when they differ.
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import { spawnSync } from 'child_process';
import { repoRoot } from './lib/repo-root.js';
import { pdfWords } from './lib/provenance.js';
import { render, listScenarios, loadScenario, launchBrowser, RENDERERS } from '../src/index.js';

const ROOT = repoRoot();
const DIR = path.join(ROOT, 'examples');
const SEED = 'example';
const args = process.argv.slice(2);
const mode = args.includes('--update') ? 'update' : 'check';
const outIdx = args.indexOf('--out'); const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1] || '') : null;
const wordsIdx = args.indexOf('--words'); const wordsDir = wordsIdx >= 0 ? path.resolve(args[wordsIdx + 1] || '') : null;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function textHash(pdfPath) {
  const pages = pdfWords(pdfPath).map((ws) => ws.map((w) => w.t).sort().join(' '));
  const text = pages.join('\n\f\n');
  return { pages: pages.length, textSha256: sha(text), text };
}
export function groundTruthHash(gt) {
  const g = JSON.parse(JSON.stringify(gt));
  for (const d of g.documents) delete d.sha256;
  return sha(JSON.stringify(g));
}

const examples = [];
for (const type of Object.keys(RENDERERS)) for (const scenario of listScenarios(type)) {
  if (loadScenario(type, scenario).status === 'published') examples.push({ type, scenario, seed: SEED });
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-examples-'));
if (outDir) fs.mkdirSync(outDir, { recursive: true });
if (wordsDir) fs.mkdirSync(wordsDir, { recursive: true });
const browser = await launchBrowser();
const poppler = spawnSync('pdftotext', ['-v'], { encoding: 'utf-8' });
const environment = { chrome: await browser.version(), poppler: `${poppler.stderr || poppler.stdout || ''}`.split('\n')[0].trim(), platform: `${process.platform}-${process.arch}` };
const results = [];
try {
  for (const ex of examples) {
    const { bytes, groundTruth } = await render({ ...ex, browser });
    const name = `${ex.type}_${ex.scenario}_${ex.seed}`;
    const pdf = path.join(work, name + '.pdf'); fs.writeFileSync(pdf, bytes);
    const { pages, textSha256, text } = textHash(pdf);
    if (wordsDir) fs.writeFileSync(path.join(wordsDir, name + '.words.txt'), text + '\n');
    results.push({ ...ex, file: name + '.pdf', pages, errors: groundTruth.errors.map((e) => e.kind), decoys: (groundTruth.decoys || []).map((d) => d.kind), textSha256, groundTruthSha256: groundTruthHash(groundTruth) });
    if (outDir) { fs.copyFileSync(pdf, path.join(outDir, name + '.pdf')); fs.writeFileSync(path.join(outDir, name + '.ground-truth.json'), JSON.stringify(groundTruth, null, 2)); }
    process.stderr.write(`examples: ${name} (${pages} pages)\n`);
  }
} finally { await browser.close(); fs.rmSync(work, { recursive: true, force: true }); }

const manifestPath = path.join(DIR, 'manifest.json');
if (mode === 'update') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ seed: SEED, note: 'written by packages/core/scripts/examples.js --update; checked in CI', environment, examples: results }, null, 2) + '\n');
  fs.writeFileSync(path.join(DIR, 'README.md'), readme(results));
  console.log(`examples: wrote ${results.length} entries to examples/manifest.json and examples/README.md`);
} else {
  const recorded = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};
  const want = recorded.examples || [];
  const key = (e) => `${e.type}/${e.scenario}/${e.seed}`;
  const byKey = new Map(want.map((e) => [key(e), e]));
  const bad = [];
  for (const r of results) {
    const w = byKey.get(key(r)); byKey.delete(key(r));
    if (!w) { bad.push(`${key(r)}: not in the manifest`); continue; }
    for (const f of ['pages', 'textSha256', 'groundTruthSha256']) if (w[f] !== r[f]) bad.push(`${key(r)}: ${f} ${w[f]} -> ${r[f]}`);
    if (w.errors.join() !== r.errors.join()) bad.push(`${key(r)}: errors ${w.errors.join(',')} -> ${r.errors.join(',')}`);
    if ((w.decoys || []).join() !== r.decoys.join()) bad.push(`${key(r)}: decoys ${(w.decoys || []).join(',')} -> ${r.decoys.join(',')}`);
  }
  for (const k of byKey.keys()) bad.push(`${k}: in the manifest but no longer published`);
  const readmeNow = fs.existsSync(path.join(DIR, 'README.md')) ? fs.readFileSync(path.join(DIR, 'README.md'), 'utf-8') : '';
  if (readmeNow !== readme(results)) bad.push('examples/README.md is out of date');
  if (bad.length) {
    const env = (e) => (e ? `Chrome ${e.chrome}, ${e.poppler}, ${e.platform}` : 'not recorded');
    const other = JSON.stringify(recorded.environment) !== JSON.stringify(environment)
      ? `\n  The hashes were recorded with ${env(recorded.environment)}; this run used ${env(environment)}. pdftotext can read the same page as\n  different words under another Chrome, Poppler or platform: compare word lists (--words DIR) with a run in the recorded\n  environment before treating a text-hash difference as a change.` : '';
    console.error(`examples: ${bad.length} difference(s); if intended, run node packages/core/scripts/examples.js --update\n  ${bad.join('\n  ')}${other}`); process.exit(1);
  }
  console.log(`examples: ok (${results.length} examples match examples/manifest.json)`);
}

function readme(rs) {
  const list = (ks) => ks.map((k) => `\`${k}\``).join(', ');
  const rows = rs.map((r) => `| \`${r.type}\` | \`${r.scenario}\` | ${r.pages} | ${r.errors.length ? list(r.errors) : 'none (clean)'} | ${r.decoys.length ? list(r.decoys) : ''} | ${loadScenario(r.type, r.scenario).description.replace(/\|/g, '\\|')} |`);
  return `# Examples

One document per published scenario, rendered with the seed \`${SEED}\`. The PDFs and their ground truth are not kept in
the repository (it holds no binary files); render them with

    node packages/core/scripts/examples.js --check --out ./examples-out

or one at a time with \`node packages/core/src/cli.js render <type> <scenario> --seed ${SEED} --out DIR\`. CI renders every
example on each push and compares it with \`manifest.json\`: a hash of each page's words and a hash of the ground truth
(without the PDF's SHA-256, which depends on the Chrome build). The words pdftotext reads also depend on the Chrome
and Poppler versions and the platform: \`manifest.json\` names the environment the hashes were recorded in, and
\`--words DIR\` writes each example's words so two runs can be compared. This file is generated by the same script.

| Type | Scenario | Pages | Injected errors | Decoys (correct lines that look wrong) | Scenario |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}
