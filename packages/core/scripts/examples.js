#!/usr/bin/env node
// examples.js — the example set: one document per published scenario, and one per layout variant id (on the type's
// published scenarios in turn), rendered with the seed "example".
//   node scripts/examples.js --check          render every example and compare it with examples/manifest.json
//   node scripts/examples.js --check --part i/m   (CI) the examples whose index is i - 1 modulo m, compared the same
//                                             way; every part also checks the manifest's entries and the README
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
import { render, loadScenario, launchBrowser, REMITTANCE_TYPES, resolveVariant } from '../src/index.js';
import { exampleJobs, ciPartCount, EXAMPLE_SEED } from './lib/rendered-plan.js';
import { parseIndex, partOf, partTooSlow, DOC_SECONDS, DRIFT } from './lib/test-plan.js';
import { compareExamples } from './lib/examples-check.js';

const ROOT = repoRoot();
const DIR = path.join(ROOT, 'examples');
const SEED = EXAMPLE_SEED;
const args = process.argv.slice(2);
const mode = args.includes('--update') ? 'update' : 'check';
// a folder option without a value (missing, empty or another option) is refused, not read as the current folder
const folder = (name) => {
  const i = args.indexOf(name); if (i < 0) return null;
  const v = args[i + 1]; if (v === undefined || v === '' || v.startsWith('--')) { console.error(`${name} needs a value`); process.exit(2); }
  return path.resolve(v);
};
const outDir = folder('--out'); const wordsDir = folder('--words');
// --part i/m: with --check only; m must be the plan's count (scripts/lib/rendered-plan.js)
let part = null;
{
  const i = args.indexOf('--part');
  if (i >= 0) {
    part = parseIndex(args[i + 1]);
    if (!part) { console.error('--part takes i/m, whole numbers with 1 <= i <= m'); process.exit(2); }
    if (mode !== 'check' || outDir || wordsDir) { console.error('--part runs with --check only'); process.exit(2); }
    const m = ciPartCount(); if (part.n !== m) { console.error(`--part: the plan has ${m} part(s), not ${part.n}; the CI matrix must come from ci-plan.js`); process.exit(2); }
  }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const EXAMPLE_TEXT = JSON.parse(fs.readFileSync(new URL('./lib/examples-text.json', import.meta.url), 'utf-8'));

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

// one per published scenario, then one per layout variant id on the type's published scenarios in turn
// (scripts/lib/rendered-plan.js; the test in test/ma-errors.test.js holds the counts: 56 scenario examples and 36 variant examples)
const examples = exampleJobs();
const mine = part ? partOf(examples, part.i, part.n) : examples;
const stem = (e) => `${e.type}_${e.scenario}_${e.seed}${e.layoutVariant ? `.${e.layoutVariant}` : ''}${e.insurer ? `.${e.insurer}` : ''}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-examples-'));
if (outDir) fs.mkdirSync(outDir, { recursive: true });
if (wordsDir) fs.mkdirSync(wordsDir, { recursive: true });
const browser = await launchBrowser();
const poppler = spawnSync('pdftotext', ['-v'], { encoding: 'utf-8' });
const environment = { chrome: await browser.version(), poppler: `${poppler.stderr || poppler.stdout || ''}`.split('\n')[0].trim(), platform: `${process.platform}-${process.arch}` };
const results = [];
const started = Date.now();
try {
  for (const ex of mine) {
    // examples of a type with an 835 (the MSN and the EOBs) also carry it, compared byte for byte (it is plain text)
    const extra = [...(REMITTANCE_TYPES.includes(ex.type) ? ['835'] : []), ...(ex.bill ? ['bill'] : [])];
    const { bytes, groundTruth, remittance, bill } = await render({ ...ex, browser, also: extra.length ? extra : null });
    const name = stem(ex);
    const pdf = path.join(work, name + '.pdf'); fs.writeFileSync(pdf, bytes);
    const { pages, textSha256, text } = textHash(pdf);
    if (wordsDir) fs.writeFileSync(path.join(wordsDir, name + '.words.txt'), text + '\n');
    // a statement beside the example: its own page words and key, hashed the same way (<name>.bill.pdf)
    let statement = null;
    if (bill) {
      const sp = path.join(work, name + '.bill.pdf'); fs.writeFileSync(sp, bill.bytes);
      const h = textHash(sp); const sg = bill.groundTruth;
      if (wordsDir) fs.writeFileSync(path.join(wordsDir, name + '.bill.words.txt'), h.text + '\n');
      statement = { file: name + '.bill.pdf', title: sg.documents[0].fields['metadata.title'] ?? null, variant: sg.pair.variant, pages: h.pages, errors: sg.errors.map((e) => e.kind), decoys: (sg.decoys || []).map((d) => d.kind), textSha256: h.textSha256, groundTruthSha256: groundTruthHash(sg) };
      if (outDir) { fs.copyFileSync(sp, path.join(outDir, name + '.bill.pdf')); fs.writeFileSync(path.join(outDir, name + '.bill.ground-truth.json'), JSON.stringify(sg, null, 2)); }
    }
    results.push({ ...ex, file: name + '.pdf', pages, errors: groundTruth.errors.map((e) => e.kind), decoys: (groundTruth.decoys || []).map((d) => d.kind), textSha256, groundTruthSha256: groundTruthHash(groundTruth),
      remittanceSha256: remittance === null ? null : sha(remittance), ...(statement ? { statement } : {}) });
    if (outDir) { fs.copyFileSync(pdf, path.join(outDir, name + '.pdf')); fs.writeFileSync(path.join(outDir, name + '.ground-truth.json'), JSON.stringify(groundTruth, null, 2)); if (remittance !== null) fs.writeFileSync(path.join(outDir, name + '.835'), remittance); }
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
  const readmeNow = fs.existsSync(path.join(DIR, 'README.md')) ? fs.readFileSync(path.join(DIR, 'README.md'), 'utf-8') : '';
  const bad = compareExamples({ examples, results, recorded: recorded.examples || [], readmeNow, readme, whole: !part });
  const took = (Date.now() - started) / 1000;
  if (part) {
    console.log(`examples: part ${part.i}/${part.n}: ${mine.length} of ${examples.length} examples in ${took.toFixed(0)} s (${(took / Math.max(1, mine.length)).toFixed(1)} s each; planned ${DOC_SECONDS})`);
    if (partTooSlow(took, mine.length)) console.log(`examples: note: part ${part.i}/${part.n} took ${took.toFixed(0)} s, over ${(mine.length * DOC_SECONDS * DRIFT.factor).toFixed(0)} s (${mine.length} examples at ${DOC_SECONDS} s, times ${DRIFT.factor})`);
  }
  if (bad.length) {
    const env = (e) => (e ? `Chrome ${e.chrome}, ${e.poppler}, ${e.platform}` : 'not recorded');
    const other = JSON.stringify(recorded.environment) !== JSON.stringify(environment)
      ? `\n  The hashes were recorded with ${env(recorded.environment)}; this run used ${env(environment)}. pdftotext can read the same page as\n  different words under another Chrome, Poppler or platform: compare word lists (--words DIR) with a run in the recorded\n  environment before treating a text-hash difference as a change.` : '';
    console.error(`examples: ${bad.length} difference(s); if intended, run node packages/core/scripts/examples.js --update\n  ${bad.join('\n  ')}${other}`); process.exit(1);
  }
  console.log(`examples: ok (${results.length} examples${part ? ` of ${examples.length}, part ${part.i}/${part.n},` : ''} match examples/manifest.json)`);
}

function readme(rs) {
  const list = (ks) => ks.map((k) => `\`${k}\``).join(', ');
  const rows = rs.filter((r) => !r.layoutVariant).map((r) => `| \`${r.type}${r.insurer ? `.${r.insurer}` : ''}\` | \`${r.scenario}\` | ${r.pages} | ${r.errors.length ? list(r.errors) : r.decoys.length ? 'none (decoys only)' : 'none (clean)'} | ${r.decoys.length ? list(r.decoys) : ''} | ${loadScenario(r.type, r.scenario).description.replace(/\|/g, '\\|')} |`);
  const srows = rs.filter((r) => r.statement).map((r) => `| \`${r.type}${r.insurer ? `.${r.insurer}` : ''}\` | \`${r.scenario}\` | ${r.statement.title ?? ''} | \`${r.statement.variant}\` | ${r.statement.pages} | ${r.statement.errors.length ? list(r.statement.errors) : 'none'} | ${r.statement.decoys.length ? list(r.statement.decoys) : ''} |`);
  const vrows = rs.filter((r) => r.layoutVariant).map((r) => {
    const v = resolveVariant(r.type, r.layoutVariant, SEED); const st = v.styleDef;
    return `| \`${r.type}\` | \`${r.layoutVariant}\` | \`${r.scenario}\` | ${r.pages} | ${v.columns.join(', ')} | \`${v.labels}\` | ${st.font}, ${st.density}, ${st.palette} | \`${v.breaks}\` |`;
  });
  return `# Examples

One document per published scenario (two for each commercial EOB scenario, one per insurer), one per layout variant
id, and a provider's statement beside five of them, all rendered with the seed \`example\`. The PDFs and their ground
truth are not kept in the repository (it holds no binary files); render them with

    node packages/core/scripts/examples.js --check --out ./examples-out

or one at a time with \`node packages/core/src/cli.js render <type> <scenario> --seed example --out DIR\` (add
\`--layout-variant <id>\` for a variant, and \`--insurer a\` or \`--insurer b\` for a commercial example, written as
\`commercial-eob_<scenario>_example.<insurer>.pdf\`; the tables show it as \`commercial-eob.a\` or \`commercial-eob.b\`).
The variant examples take the type's scenarios in turn, in the order of the first table: the first id uses the first
scenario, the second id the second, and so on, starting again after the last; each is written as
\`<type>_<scenario>_example.<id>.pdf\`. CI renders every example on each push and compares it with \`manifest.json\`: a
hash of each page's words and a hash of the ground truth (without the PDF's SHA-256, which depends on the Chrome
build), and for the Medicare Summary Notice and the Medicare Advantage and commercial EOBs the SHA-256 of the 835
remittance written beside them (\`--out\` writes it as \`<name>.835\`), which does not depend on the environment. The
variant examples are compared the same way. The words pdftotext reads also depend on the Chrome and Poppler versions
and the platform: \`manifest.json\` names the environment the hashes were recorded in, and \`--words DIR\` writes each
example's words so two runs can be compared. This file is generated by the same script.

| Type | Scenario | Pages | Expected findings | Decoys (correct lines that look wrong) | Description |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Provider's statements

${EXAMPLE_TEXT.statementsIntro}

| EOB | Scenario | Statement | Variant | Pages | Expected findings | Decoys |
| --- | --- | --- | --- | --- | --- | --- |
${srows.join('\n')}

## Layout variants

One document per layout variant id of the itemized bill and the two Medicare Advantage EOBs, on the type's scenarios
in turn; the Medicare Summary Notice and the commercial EOB take no layout variant and are not listed. The ids, and what each one fixes,
are defined in \`packages/core/data/<type>/variants.json\`, with the wording sets in \`labels.json\` beside it.

| Type | Variant id | Scenario | Pages | Column order | Wording set | Style (font, density, palette) | Continued tables |
| --- | --- | --- | --- | --- | --- | --- | --- |
${vrows.join('\n')}
`;
}
