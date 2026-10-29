// Batch output (src/batch.js and `claimseed-core batch`): a folder of documents, answer keys and a manifest whose
// hashes match the files; it never overwrites; the manifest drives scoring a whole set with `verify --manifest`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { planBatch, readManifest, MAX_BATCH, VERSION } from '../src/batch.js';
import { generateData } from '../src/generate/index.js';
import { findChrome } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('a batch plan names every document once and refuses unknown types, bad prefixes and oversized sets', () => {
  const jobs = planBatch({ types: ['msn', 'itemized-bill'], scenarios: ['baseline-clean', 'duplicate-charge'], seeds: 3, seedPrefix: 'set' });
  assert.equal(jobs.length, 3 + 6, 'msn has baseline-clean only of the two; the bill has both');
  assert.equal(new Set(jobs.map((j) => `${j.type}/${j.scenario}/${j.seed}`)).size, jobs.length);
  assert.throws(() => planBatch({ types: ['w2'] }), /no document type w2/);
  assert.throws(() => planBatch({ types: ['msn'], seedPrefix: '../x' }), /seed prefix/);
  assert.throws(() => planBatch({ types: ['msn'], seeds: 0 }), /at least 1/);
  assert.throws(() => planBatch({ types: ['msn'], scenarios: ['nope'] }), /none of the named scenarios/);
  assert.throws(() => planBatch({ types: ['msn'], seeds: MAX_BATCH }), /over the limit/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-manifest-'));
  const line = { pdf: 'a.pdf', groundTruth: 'a.ground-truth.json', type: 'msn', scenario: 'baseline-clean', seed: 's', groundTruthSha256: '0'.repeat(64) };
  for (const bad of [{ pdf: '..' }, { groundTruth: '../a.ground-truth.json' }, { groundTruth: '.' }, { pdf: 'a.json' }, { groundTruth: 'sub/a.ground-truth.json' }]) {
    fs.writeFileSync(path.join(dir, 'm.jsonl'), JSON.stringify({ ...line, ...bad }) + '\n');
    assert.throws(() => readManifest(path.join(dir, 'm.jsonl')), /outside the batch folder/, JSON.stringify(bad));
  }
  fs.writeFileSync(path.join(dir, 'm.jsonl'), JSON.stringify(line) + '\n'); assert.equal(readManifest(path.join(dir, 'm.jsonl')).length, 1);
});

test('a plan over the limit is refused before it is built, however many seeds it asks for', () => {
  const t = Date.now();
  assert.throws(() => planBatch({ types: ['msn'], scenarios: ['baseline-clean'], seeds: 1e9 }), /1000000000 documents is over the limit/);
  assert.throws(() => planBatch({ types: ['msn'], seeds: 2 ** 60 }), /whole number/);
  assert.ok(Date.now() - t < 1000, 'the refusal took too long');
});

// A set made without a browser: answer keys and a manifest are all that scoring reads.
function fakeSet(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fake-')); const set = path.join(root, 'set'); const reports = path.join(root, 'reports'); const outside = path.join(root, 'outside');
  for (const d of [set, reports, outside]) fs.mkdirSync(d);
  const lines = names.map((n) => {
    const gt = generateData({ type: 'msn', scenario: 'baseline-clean', seed: n }).groundTruth; const bytes = Buffer.from(JSON.stringify(gt));
    fs.writeFileSync(path.join(set, `${n}.ground-truth.json`), bytes);
    fs.writeFileSync(path.join(reports, `${n}.json`), JSON.stringify({ fields: gt.documents[0].fields, errors: [] }));
    return { pdf: `${n}.pdf`, groundTruth: `${n}.ground-truth.json`, type: 'msn', scenario: 'baseline-clean', seed: n, groundTruthSha256: sha(path.join(set, `${n}.ground-truth.json`)) };
  });
  fs.writeFileSync(path.join(set, 'manifest.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const verify = () => spawnSync(process.execPath, [CLI, 'verify', '--manifest', path.join(set, 'manifest.jsonl'), '--outputs', reports], { encoding: 'utf-8', timeout: 30000 });
  return { root, set, reports, outside, lines, verify };
}

test('scoring a set reads only regular files the manifest names: links, folders and FIFOs are refused, never followed or waited on', { skip: process.platform === 'win32' && 'POSIX links and FIFOs' }, () => {
  const f = fakeSet(['a', 'b', 'c', 'd']);
  // reports: a link to a report outside the folder, a folder, and a FIFO with no writer, beside one good report
  fs.renameSync(path.join(f.reports, 'a.json'), path.join(f.outside, 'a.json')); fs.symlinkSync(path.join(f.outside, 'a.json'), path.join(f.reports, 'a.json'));
  fs.rmSync(path.join(f.reports, 'b.json')); fs.mkdirSync(path.join(f.reports, 'b.json'));
  fs.rmSync(path.join(f.reports, 'c.json')); spawnSync('mkfifo', [path.join(f.reports, 'c.json')]);
  const r = f.verify();
  assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
  assert.deepEqual(out.invalidOutputs.map((x) => [x.document, x.problem]), ['a', 'b', 'c'].map((n) => [`${n}.pdf`, 'extractor output: not a regular file (a link, a folder or a special file)']));
  assert.equal(out.scored, 1); assert.equal(out.fields.accuracy, 1);
  // an answer key replaced by a link to a file with the same bytes elsewhere is refused, hash or no hash
  const k = path.join(f.set, 'd.ground-truth.json'); fs.renameSync(k, path.join(f.outside, 'd.ground-truth.json')); fs.symlinkSync(path.join(f.outside, 'd.ground-truth.json'), k);
  const linked = f.verify();
  assert.equal(linked.status, 1); assert.match(linked.stderr, /d\.ground-truth\.json is not a regular file/);
});

test('a manifest line or answer key of the wrong shape is refused with a message, not a crash', () => {
  const f = fakeSet(['a']);
  fs.writeFileSync(path.join(f.set, 'manifest.jsonl'), 'null\n');
  let r = f.verify(); assert.equal(r.status, 1); assert.match(r.stderr, /manifest line 1 is not an object/); assert.doesNotMatch(r.stderr, /TypeError/);
  fs.writeFileSync(path.join(f.set, 'a.ground-truth.json'), 'null');
  fs.writeFileSync(path.join(f.set, 'manifest.jsonl'), JSON.stringify({ ...f.lines[0], groundTruthSha256: sha(path.join(f.set, 'a.ground-truth.json')) }) + '\n');
  r = f.verify(); assert.equal(r.status, 1); assert.match(r.stderr, /answer key: not a claimseed answer key/); assert.doesNotMatch(r.stderr, /TypeError/);
});

test('a batch writes PDFs, answer keys and a manifest that matches them, never overwrites, and scores as a set', { skip, timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-batch-'));
  const out = path.join(dir, 'set');
  execFileSync(process.execPath, [CLI, 'batch', '--types', 'msn,itemized-bill', '--scenarios', 'baseline-clean,duplicate-office-visit', '--seeds', '2', '--seed-prefix', 'b', '--out', out], { stdio: ['ignore', 'ignore', 'inherit'] });
  const entries = readManifest(path.join(out, 'manifest.jsonl'));
  assert.equal(entries.length, 2 * 2 + 1 * 2);
  for (const e of entries) {
    assert.equal(sha(path.join(out, e.pdf)), e.sha256, e.pdf); assert.equal(sha(path.join(out, e.groundTruth)), e.groundTruthSha256, e.groundTruth);
    assert.equal(e.claimseedVersion, VERSION); assert.match(String(e.chrome), /Chrom/);
    assert.ok(e.pages >= 1);
  }
  const again = spawnSync(process.execPath, [CLI, 'batch', '--types', 'msn', '--scenarios', 'baseline-clean', '--seeds', '1', '--out', out], { encoding: 'utf-8' });
  assert.equal(again.status, 1); assert.match(again.stderr, /EEXIST|exists/);
  // score the set: perfect reports for all but one document, which reports nothing and one false alarm
  const reports = path.join(dir, 'reports'); fs.mkdirSync(reports);
  entries.forEach((e, i) => {
    const gt = JSON.parse(fs.readFileSync(path.join(out, e.groundTruth), 'utf-8'));
    const report = i === 0 ? { fields: {}, errors: [{ kind: 'math-error', fieldRef: 'claims[0].lineItems[0]' }] }
      : { fields: gt.documents[0].fields, errors: gt.errors.map((x) => ({ kind: x.kind, fieldRef: x.fieldRef })) };
    if (i !== 1) fs.writeFileSync(path.join(reports, e.pdf.replace(/\.pdf$/, '.json')), i === 3 ? '{ not json' : JSON.stringify(report));
  });
  const r = JSON.parse(execFileSync(process.execPath, [CLI, 'verify', '--manifest', path.join(out, 'manifest.jsonl'), '--outputs', reports], { encoding: 'utf-8' }));
  assert.equal(r.documents, entries.length); assert.equal(r.missingOutputs, 1); assert.equal(r.scored, entries.length - 2);
  assert.deepEqual(r.invalidOutputs, [{ document: entries[3].pdf, problem: 'extractor output: not valid JSON' }]);
  assert.equal(r.errors.falseAlarms, 1);
  assert.ok(r.fields.accuracy > 0.5 && r.fields.accuracy < 1);
  // only a report that is not there is missing: one holding JSON null or a list is of the wrong shape, and {} scores nothing
  const shapes = path.join(dir, 'reports-shapes'); fs.mkdirSync(shapes);
  const body = { 0: '{}', 2: 'null', 3: '{}', 4: '[]', 5: '{}' };
  for (const [i, text] of Object.entries(body)) fs.writeFileSync(path.join(shapes, entries[i].pdf.replace(/\.pdf$/, '.json')), text);
  const s = JSON.parse(execFileSync(process.execPath, [CLI, 'verify', '--manifest', path.join(out, 'manifest.jsonl'), '--outputs', shapes], { encoding: 'utf-8' }));
  assert.equal(s.missingOutputs, 1); assert.equal(s.scored, 3);
  assert.deepEqual(s.invalidOutputs, [2, 4].map((i) => ({ document: entries[i].pdf, problem: 'extractor output: must be a JSON object' })));
  // an answer key changed after the set was written is refused, not scored
  const k = path.join(out, entries[2].groundTruth);
  fs.writeFileSync(k, JSON.stringify({ ...JSON.parse(fs.readFileSync(k, 'utf-8')), errors: [] }));
  const edited = spawnSync(process.execPath, [CLI, 'verify', '--manifest', path.join(out, 'manifest.jsonl'), '--outputs', reports], { encoding: 'utf-8' });
  assert.equal(edited.status, 1); assert.match(edited.stderr, /does not match its hash/);
});
