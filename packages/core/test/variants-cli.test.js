// --layout-variant on the command line: generate, render (one id, seeded, all), batch (and its manifest), verify's seed
// form, degraded copies; every refusal exits 2, repeats nothing typed and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { VARIANT_STRINGS, variantIds } from '../src/variants.js';
import { generateData } from '../src/generate/index.js';
import { readManifest } from '../src/batch.js';
import { findChrome } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const M = VARIANT_STRINGS.messages;
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf-8', timeout: 240000 });

test('refusals: exit 2, the published message, nothing echoed, nothing written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vcli-')); const sec = 'zz-secret-91';
  try {
    const cases = [
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', sec], M.variantUnknown],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', 'h01'], M.variantUnknown],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', `../${sec}`], M.variantUnknown],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', 'x'.repeat(65)], M.variantUnknown],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', 'all'], M.variantAllHere],
      [['generate', 'msn', 'baseline-clean', '--layout-variant', 'seeded'], M.variantMsn],
      [['render', 'msn', 'baseline-clean', '--layout-variant', 'all', '--out', dir], M.variantMsn],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', 'p01', '--layout-variant', 'p02'], M.variantRepeated],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant'], M.variantEmpty],
      [['generate', 'ppo-eob', 'baseline-clean', '--layout-variant', ''], M.variantEmpty],
      [['batch', '--types', 'msn,ppo-eob', '--layout-variant', 'seeded', '--out', dir], M.variantSeededAll],
      [['batch', '--types', 'msn,hmo-eob', '--layout-variant', 'all', '--out', dir], M.variantSeededAll],
      [['batch', '--types', 'ppo-eob,hmo-eob', '--layout-variant', 'p01', '--out', dir], M.variantUnknown],
      [['verify', '--answer-key', 'x.json', '--output', 'y.json', '--layout-variant', 'p01'], null],
    ];
    for (const [args, msg] of cases) {
      const r = run(...args);
      assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status} ${r.stderr}`);
      if (msg) assert.equal(r.stderr.trim(), msg, args.join(' '));
      assert.ok(!r.stderr.includes(sec) && !r.stdout.includes(sec), `${args.join(' ')}: echoed`);
    }
    const eq = run('generate', 'ppo-eob', 'baseline-clean', '--layout-variant=p01'); assert.equal(eq.status, 2);
    assert.deepEqual(fs.readdirSync(dir), [], 'a refused command wrote something');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generate and verify take a variant: the key is the library\'s, and verify scores against the varied key', () => {
  const r = run('generate', 'hmo-eob', 'baseline-clean', '--seed', 'c1', '--layout-variant', 'h05');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.groundTruth.documents[0].layout, 'hmo-eob.h05'); assert.equal('_variant' in out.data, false);
  assert.deepEqual(out.groundTruth, JSON.parse(JSON.stringify(generateData({ type: 'hmo-eob', scenario: 'baseline-clean', seed: 'c1', layoutVariant: 'h05' }).groundTruth)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vver-'));
  try {
    const report = path.join(dir, 'r.json'); fs.writeFileSync(report, JSON.stringify({ fields: out.groundTruth.documents[0].fields }));
    const v = run('verify', 'hmo-eob', 'baseline-clean', '--seed', 'c1', '--layout-variant', 'h05', '--output', report);
    assert.equal(v.status, 0, v.stderr); const s = JSON.parse(v.stdout); assert.equal(s.fields.correct, s.fields.expected);
    const m = run('verify', '--manifest', path.join(dir, 'm.jsonl'), '--outputs', dir, '--layout-variant', 'h05'); assert.equal(m.status, 2, 'the manifest form takes no variant');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('render and batch: file names, band and manifest carry the id; all gives one document per id', { skip, timeout: 900000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vren-'));
  try {
    let r = run('render', 'ppo-eob', 'baseline-clean', '--seed', 'c2', '--layout-variant', 'p04', '--out', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'ppo-eob_baseline-clean_c2.p04.pdf')) && fs.existsSync(path.join(dir, 'ppo-eob_baseline-clean_c2.p04.ground-truth.json')));
    r = run('render', 'itemized-bill', 'baseline-clean', '--seed', 'c2', '--layout-variant', 'all', '--out', path.join(dir, 'all'));
    assert.equal(r.status, 0, r.stderr);
    const pdfs = fs.readdirSync(path.join(dir, 'all')).filter((f) => f.endsWith('.pdf')).sort();
    assert.deepEqual(pdfs, variantIds('itemized-bill').map((id) => `itemized-bill_baseline-clean_c2.${id}.pdf`));
    r = run('render', 'hmo-eob', 'baseline-clean', '--seed', 'c2', '--layout-variant', 'h03', '--degrade', 'low-res', '--out', path.join(dir, 'deg'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readdirSync(path.join(dir, 'deg')).includes('hmo-eob_baseline-clean_c2.h03_low-res.pdf'));
    r = run('batch', '--types', 'ppo-eob,hmo-eob', '--scenarios', 'baseline-clean', '--seeds', '2', '--layout-variant', 'seeded', '--out', path.join(dir, 'b'));
    assert.equal(r.status, 0, r.stderr);
    const m = readManifest(path.join(dir, 'b', 'manifest.jsonl'));
    assert.equal(m.length, 4);
    for (const e of m) {
      assert.match(e.layoutVariant, /^[ph]\d{2}$/); assert.ok(e.pdf.includes(`.${e.layoutVariant}.pdf`));
      const gt = JSON.parse(fs.readFileSync(path.join(dir, 'b', e.groundTruth), 'utf-8')); assert.equal(gt.documents[0].layoutVariant.id, e.layoutVariant);
    }
    const again = run('batch', '--types', 'ppo-eob', '--scenarios', 'baseline-clean', '--seeds', '1', '--layout-variant', 'p02', '--out', path.join(dir, 'b'));
    assert.equal(again.status, 1, 'a batch never writes over another');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
