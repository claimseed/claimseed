// --also 835 on the command line and in the library: render and batch write the 835 beside the PDF byte for byte,
// the answer key carries it as documents[1] with x12Ref on its errors, a batch manifest lists it with its SHA-256, and
// an unknown value or a type without an 835 is refused before anything is written, without repeating the value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findChrome, launchBrowser, render, readManifest } from '../src/index.js';
import { check835 } from '../src/x12/check835.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-also-'));
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test('render with also 835 writes the 835 byte for byte and adds it to the answer key; without it nothing changes', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  const r = await render({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'also-1', browser, outDir: dir, also: '835' });
  const file = path.join(dir, 'msn_duplicate-office-visit_also-1.835');
  assert.equal(fs.readFileSync(file, 'utf-8'), r.remittance);
  const gt = JSON.parse(fs.readFileSync(path.join(dir, 'msn_duplicate-office-visit_also-1.ground-truth.json'), 'utf-8'));
  assert.deepEqual(gt.documents.map((d) => d.type), ['msn', 'x12-835']);
  assert.equal(gt.documents[1].sha256, sha(fs.readFileSync(file)));
  assert.equal(gt.errors[0].x12Ref, '0001:CLP1:SVC2');
  assert.ok(check835(r.remittance).findings.some((f) => f.check === 'duplicate-service' && f.ref === gt.errors[0].x12Ref));
  const plain = await render({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'also-1', browser });
  assert.equal(plain.remittance, null); assert.equal(plain.groundTruth.documents.length, 1); assert.equal(plain.groundTruth.errors[0].x12Ref, undefined);
  assert.deepEqual(plain.groundTruth.documents[0], r.groundTruth.documents[0], 'the PDF and its key are the same with or without the 835');
  await assert.rejects(render({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'x', browser, also: '835' }), /835 is written for msn, ppo-eob, hmo-eob only/);
  await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', seed: 'x', browser, also: '837' }), /also must be one of 835/);
});

test('the command line: render and batch with --also 835, a degraded copy with its 835, and the refusals', { skip, timeout: 300000 }, () => {
  const dir = tmp(); const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf-8', env: process.env });
  let r = run('render', 'hmo-eob', 'baseline-clean', '--seed', 'also-2', '--out', dir, '--also', '835');
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(dir, 'hmo-eob_baseline-clean_also-2.835')));
  r = run('render', 'ppo-eob', 'baseline-clean', '--seed', 'also-2', '--out', dir, '--degrade', 'low-res', '--also', '835');
  assert.equal(r.status, 0, r.stderr);
  const dgt = JSON.parse(fs.readFileSync(path.join(dir, 'ppo-eob_baseline-clean_also-2_low-res.ground-truth.json'), 'utf-8'));
  assert.equal(dgt.documents[0].degradation, 'low-res'); assert.equal(dgt.documents[1].sha256, sha(fs.readFileSync(path.join(dir, 'ppo-eob_baseline-clean_also-2_low-res.835'))));
  for (const [args, msg] of [[['render', 'msn', 'baseline-clean', '--out', dir, '--also', 'x12-secret'], /--also must be one of 835/], [['render', 'itemized-bill', 'baseline-clean', '--out', dir, '--also', '835'], /--also 835 is for msn, ppo-eob, hmo-eob only/],
    [['batch', '--types', 'msn,itemized-bill', '--seeds', '1', '--out', path.join(dir, 'never'), '--also', '835'], /--also 835 is for/],
    // --also is read like every other option: an empty value, the = form and a repeat are refused
    [['render', 'msn', 'baseline-clean', '--out', dir, '--also', ''], /^--also needs a value\n$/], [['batch', '--types', 'msn', '--seeds', '1', '--out', path.join(dir, 'never'), '--also=x12-secret'], /^--also takes its value in the next argument/],
    [['render', 'msn', 'baseline-clean', '--out', dir, '--also', '835', '--also', '835'], /^--also may be given only once\n$/]]) {
    r = run(...args); assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, msg); assert.doesNotMatch(r.stderr, /x12-secret/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'never')), false);
  const set = path.join(dir, 'set');
  r = run('batch', '--types', 'msn,ppo-eob', '--scenarios', 'baseline-clean', '--seeds', '2', '--out', set, '--also', '835');
  assert.equal(r.status, 0, r.stderr);
  const entries = readManifest(path.join(set, 'manifest.jsonl'));
  assert.equal(entries.length, 4);
  for (const e of entries) {
    assert.match(e.remittance, /\.835$/); assert.equal(e.remittanceSha256, sha(fs.readFileSync(path.join(set, e.remittance))));
    const gt = JSON.parse(fs.readFileSync(path.join(set, e.groundTruth), 'utf-8')); assert.equal(gt.documents[1].sha256, e.remittanceSha256);
    assert.deepEqual(check835(fs.readFileSync(path.join(set, e.remittance), 'utf-8')).findings, []);
  }
});

test('a manifest line that names an 835 outside the set, or without its hash, is refused', () => {
  const dir = tmp(); const m = path.join(dir, 'manifest.jsonl');
  const line = { pdf: 'a.pdf', groundTruth: 'a.ground-truth.json', type: 'msn', scenario: 'baseline-clean', seed: 's', sha256: 'a'.repeat(64), groundTruthSha256: 'b'.repeat(64) };
  fs.writeFileSync(m, JSON.stringify({ ...line, remittance: '../a.835', remittanceSha256: 'c'.repeat(64) }) + '\n');
  assert.throws(() => readManifest(m), /names an 835 outside the batch folder/);
  fs.writeFileSync(m, JSON.stringify({ ...line, remittance: 'a.835' }) + '\n');
  assert.throws(() => readManifest(m), /without its SHA-256/);
  fs.writeFileSync(m, JSON.stringify({ ...line, remittance: 'a.835', remittanceSha256: 'c'.repeat(64) }) + '\n');
  assert.equal(readManifest(m)[0].remittance, 'a.835');
});
