// Degraded copies (src/degrade.js): every preset of every layout keeps the specimen band and watermark on top of the
// degraded pixels (measured against the picture before stamping), every output file carries the markers, the settings
// come from the seed, and the command line writes copies one at a time or as a set that scores like any other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { launchBrowser, findChrome, render, renderDegraded, degradationParams, DEGRADE_PRESETS } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);

let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test('the settings come from the seed: the same document and preset give the same settings, within each preset\'s ranges', () => {
  const doc = { type: 'msn', scenario: 'baseline-clean', seed: 'p-1' };
  for (const preset of DEGRADE_PRESETS) {
    const a = degradationParams(preset, doc); const b = degradationParams(preset, doc);
    assert.deepEqual(a, b, preset);
    assert.notDeepEqual(a, degradationParams(preset, { ...doc, seed: 'p-2' }), `${preset}: another seed, other settings`);
    assert.ok(Number.isInteger(a.dpi) && a.dpi >= (preset === 'low-res' ? 75 : 60) && a.dpi <= 200, `${preset}: dpi ${a.dpi}`);
  }
  const s = degradationParams('scan', doc); assert.ok(Math.abs(s.rotate) <= 0.8 && s.quality >= 0.72 && s.quality <= 0.88);
  const f = degradationParams('fax', doc); assert.ok(f.threshold >= 0.5 && f.threshold <= 0.66 && Array.isArray(f.streaks));
  const p = degradationParams('photo', doc); assert.ok(Math.abs(p.rotate) <= 4 && p.keystone > 0 && p.keystone <= 0.06);
  assert.throws(() => degradationParams('blur', doc), (e) => e.message === 'degrade: no such preset; presets: scan, fax, photo, low-res');
});

// The band and the watermark on every page of every preset of every layout, above their floors: test/degrade-floors-*.test.js.

test('the same seed gives the same settings and pictures within a small tolerance, and the answer key records them', { skip, timeout: 600000 }, async () => {
  for (const preset of DEGRADE_PRESETS) {
  const a = await renderDegraded({ type: 'hmo-eob', scenario: 'baseline-clean', seed: 'deg-same', preset, browser });
  const b = await renderDegraded({ type: 'hmo-eob', scenario: 'baseline-clean', seed: 'deg-same', preset, browser });
  const da = a.groundTruth.documents[0]; const db = b.groundTruth.documents[0];
  assert.equal(da.degradation, preset); assert.deepEqual(da.degradationParams, db.degradationParams);
  assert.equal(da.sha256, crypto.createHash('sha256').update(a.bytes).digest('hex'));
  assert.deepEqual(da.fields, db.fields); assert.equal(a.groundTruth.schemaVersion, '1.3');
  assert.ok(validate(a.groundTruth), JSON.stringify(validate.errors));
  const page = await browser.newPage();
  try {
    for (const [x, y] of a.images.map((im, k) => [im, b.images[k]])) {
      const diff = await page.evaluate(async (u, v) => {
        const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
        const px = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
        const [A, B] = [px(await load(u)), px(await load(v))]; let s = 0; for (let k = 0; k < A.length; k += 4) s += Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]);
        return s / (A.length / 4) / 3;
      }, `data:${x.mimeType};base64,${x.data.toString('base64')}`, `data:${y.mimeType};base64,${y.data.toString('base64')}`);
      assert.ok(diff < 1, `${preset} page ${x.page}: mean difference ${diff}`);
    }
  } finally { await page.close(); }
  }
});

// Refusals come before anything is rendered or created, so this needs no browser. An explicitly empty value is
// refused like a missing one (a wrapper's unset variable must not turn a degraded set into clean copies, or send the
// output to the current folder), and no refused value is repeated.
test('the command line refuses an empty, missing, blank or unknown preset or folder, an unknown or repeated option and an extra argument, and creates nothing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deg-args-'));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf-8', cwd, timeout: 30000 });
  const out = path.join(cwd, 'out');
  const cases = [
    [['--degrade', ''], /^--degrade needs a value\n$/],
    [['--degrade'], /^--degrade needs a value\n$/],
    [['--degrade', '--seed', 'x'], /^--degrade needs a value\n$/],
    [['--degrade', '   '], /^--degrade must be one of scan, fax, photo, low-res\n$/],
    [['--degrade', 'FAX'], /^--degrade must be one of scan, fax, photo, low-res\n$/],
    [['--degrade', '../canary-preset'], /^--degrade must be one of scan, fax, photo, low-res\n$/],
  ];
  for (const [extra, message] of cases) {
    for (const argv of [['render', 'itemized-bill', 'baseline-clean', '--seed', 'args', '--out', out, ...extra], ['batch', '--types', 'itemized-bill', '--scenarios', 'baseline-clean', '--seeds', '1', '--out', out, ...extra]]) {
      const r = run(...argv);
      assert.equal(r.status, 2, `${argv[0]} ${JSON.stringify(extra)}: exit ${r.status}`);
      assert.match(r.stderr, message, `${argv[0]} ${JSON.stringify(extra)}`);
      assert.doesNotMatch(r.stderr, /canary|FAX/); assert.equal(r.stdout, '');
    }
  }
  // the --name=value form, a misspelt option, an option given twice and an extra argument are refused too
  const more = [
    [['--degrade=fax'], () => /^--degrade takes its value in the next argument, not after an equals sign\n$/],
    [['--degrade=canary'], () => /^--degrade takes its value in the next argument, not after an equals sign\n$/],
    [['--degrad', 'fax'], (c) => (c === 'render' ? /^render: unknown option; the options are --seed, --out, --degrade, --also, --bill, --layout-variant, --blind-keys, --blind-salt, --insurer\n$/
      : /^batch: unknown option; the options are --types, --scenarios, --seeds, --seed-prefix, --degrade, --also, --bill, --out, --layout-variant, --blind-keys, --blind-salt, --set\n$/)],
    [['--canary=1'], (c) => new RegExp(`^${c}: unknown option; the options are --`)],
    [['--degrade', 'fax', '--degrade', 'scan'], () => /^--degrade may be given only once\n$/],
    [['canary-extra'], (c) => new RegExp(`^${c}: too many arguments\n$`)],
  ];
  for (const [extra, message] of more) {
    for (const argv of [['render', 'itemized-bill', 'baseline-clean', '--seed', 'args', '--out', out, ...extra], ['batch', '--types', 'itemized-bill', '--scenarios', 'baseline-clean', '--seeds', '1', '--out', out, ...extra]]) {
      const r = run(...argv);
      assert.equal(r.status, 2, `${argv[0]} ${JSON.stringify(extra)}: exit ${r.status}`);
      assert.match(r.stderr, message(argv[0]), `${argv[0]} ${JSON.stringify(extra)}`);
      assert.doesNotMatch(r.stderr, /canary/); assert.equal(r.stdout, '');
    }
  }
  for (const argv of [['render', 'itemized-bill', 'baseline-clean', '--out', ''], ['batch', '--types', 'itemized-bill', '--seeds', '1', '--out', ''],
    ['render', 'itemized-bill', 'baseline-clean', '--seed', '', '--out', out], ['batch', '--types', '', '--out', out], ['batch', '--types', 'itemized-bill', '--seeds', '', '--out', out]]) {
    const r = run(...argv);
    assert.equal(r.status, 2, `${JSON.stringify(argv)}: exit ${r.status}`); assert.match(r.stderr, /^--[a-z-]+ needs a value\n$/, JSON.stringify(argv));
  }
  // the other commands read their options the same way
  for (const [argv, message] of [[['list', '--canary'], /^list: unknown option; this command takes no options\n$/], [['list', 'msn', 'canary'], /^list: too many arguments\n$/],
    [['generate', 'msn', 'baseline-clean', '--seed', 'a', '--seed', 'b'], /^--seed may be given only once\n$/], [['generate', 'msn', 'baseline-clean', '--seed=canary'], /^--seed takes its value/],
    [['verify', 'msn', 'baseline-clean', '--manifest', 'm.jsonl', '--outputs', 'o'], /^verify: too many arguments\n$/], [['verify', '--answer-key', 'k.json', '--output', 'o.json', 'canary'], /^verify: too many arguments\n$/],
    [['verify', '--output', ''], /^--output needs a value\n$/],
    [['verify', '--answer-key', 'k.json', '--output', 'o.json', '--seed', 'canary'], /^verify: --seed cannot be used with --answer-key\n$/],
    [['verify', '--manifest', 'm.jsonl', '--outputs', 'o', '--answer-key', 'canary.json'], /^verify: --answer-key cannot be used with --manifest\n$/],
    [['verify', '--answer-key', 'k.json', '--output', 'o.json', '--outputs', 'canary'], /^verify: --outputs cannot be used with --answer-key\n$/],
    [['verify', 'msn', 'baseline-clean', '--seed', 's', '--output', 'o.json', '--outputs', 'canary'], /^verify: --outputs cannot be used with a type and scenario\n$/],
    // a missing type or scenario, and a name that is not a command (inherited object keys included)
    [['render', 'msn', '--seed', 's', '--out', out], /^scenario must match /], [['generate', '--seed', 's'], /^type must match /],
    [['constructor', '--canary'], /^usage: /], [['__proto__', '--seed', 'canary'], /^usage: /], [['toString'], /^usage: /]]) {
    const r = run(...argv);
    assert.equal(r.status, 2, `${JSON.stringify(argv)}: exit ${r.status}`); assert.match(r.stderr, message, JSON.stringify(argv)); assert.doesNotMatch(r.stderr, /canary/); assert.equal(r.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(cwd), [], 'a refused command wrote into the folder it ran in');
});

test('the command line writes a degraded copy, refuses an unknown preset, and degrades a whole set that scores like any other', { skip, timeout: 300000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deg-cli-'));
  execFileSync(process.execPath, [CLI, 'render', 'itemized-bill', 'duplicate-charge', '--seed', 'cli-d', '--out', dir, '--degrade', 'fax'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['itemized-bill_duplicate-charge_cli-d_fax.ground-truth.json', 'itemized-bill_duplicate-charge_cli-d_fax.pdf',
    ...[1, 2, 3].map((n) => `itemized-bill_duplicate-charge_cli-d_fax_p${n}.png`)]);
  const gt = JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf-8'));
  assert.equal(gt.documents[0].degradation, 'fax'); assert.ok(validate(gt), JSON.stringify(validate.errors));
  // the control: without --degrade, the same command writes the clean document and no page images
  const plain = path.join(dir, 'plain');
  execFileSync(process.execPath, [CLI, 'render', 'itemized-bill', 'duplicate-charge', '--seed', 'cli-d', '--out', plain], { stdio: ['ignore', 'ignore', 'inherit'] });
  assert.deepEqual(fs.readdirSync(plain).sort(), ['itemized-bill_duplicate-charge_cli-d.ground-truth.json', 'itemized-bill_duplicate-charge_cli-d.pdf']);
  const plainKey = JSON.parse(fs.readFileSync(path.join(plain, 'itemized-bill_duplicate-charge_cli-d.ground-truth.json'), 'utf-8')).documents[0];
  assert.equal(plainKey.degradation, null); assert.equal(plainKey.degradationParams, null);
  const bad = spawnSync(process.execPath, [CLI, 'render', 'msn', 'baseline-clean', '--out', dir, '--degrade', 'sepia'], { encoding: 'utf-8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--degrade must be one of scan, fax, photo, low-res/);
  const badSet = spawnSync(process.execPath, [CLI, 'batch', '--types', 'msn', '--seeds', '1', '--out', path.join(dir, 'never'), '--degrade', 'sepia'], { encoding: 'utf-8' });
  assert.equal(badSet.status, 2); assert.match(badSet.stderr, /--degrade must be one of scan, fax, photo, low-res/); assert.doesNotMatch(badSet.stderr, /sepia/);
  assert.equal(fs.existsSync(path.join(dir, 'never')), false, 'a refused batch created its folder');
  const set = path.join(dir, 'set');
  execFileSync(process.execPath, [CLI, 'batch', '--types', 'itemized-bill', '--scenarios', 'duplicate-charge,baseline-clean', '--seeds', '1', '--degrade', 'low-res', '--out', set], { stdio: ['ignore', 'ignore', 'inherit'] });
  const lines = fs.readFileSync(path.join(set, 'manifest.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const reports = path.join(dir, 'reports'); fs.mkdirSync(reports);
  for (const e of lines) {
    assert.equal(e.degradation, 'low-res'); assert.match(e.pdf, /_low-res\.pdf$/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(set, e.pdf))).digest('hex'), e.sha256);
    const key = JSON.parse(fs.readFileSync(path.join(set, e.groundTruth), 'utf-8')); assert.equal(key.documents[0].degradation, 'low-res');
    fs.writeFileSync(path.join(reports, e.pdf.replace(/\.pdf$/, '.json')), JSON.stringify({ fields: key.documents[0].fields, errors: key.errors.map((x) => ({ kind: x.kind, fieldRef: x.fieldRef })) }));
  }
  const score = JSON.parse(execFileSync(process.execPath, [CLI, 'verify', '--manifest', path.join(set, 'manifest.jsonl'), '--outputs', reports], { encoding: 'utf-8' }));
  assert.equal(score.fields.accuracy, 1); assert.equal(score.errors.recall, 1);
});
