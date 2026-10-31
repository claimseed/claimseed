// Degraded copies (src/degrade.js): every preset of every layout keeps the specimen band and watermark on top of the
// degraded pixels (measured against the picture before stamping), every output file carries the markers, the settings
// come from the seed, and the command line writes copies one at a time or as a set that scores like any other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { launchBrowser, findChrome, render, renderDegraded, degradePdf, degradationParams, DEGRADE_PRESETS, withPdfPage, finalizePdf, BAND_TEXT, SPECIMEN_SUBJECT } from '../src/index.js';
import { readMarkers } from './markers-read.js';
import { pdfWords } from '../scripts/lib/provenance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const TYPES = [['msn', 'combined-three-errors'], ['itemized-bill', 'duplicate-charge'], ['ppo-eob', 'baseline-clean'], ['hmo-eob', 'baseline-clean']];
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
    assert.ok(Number.isInteger(a.dpi) && a.dpi >= 60 && a.dpi <= 200, `${preset}: dpi ${a.dpi}`);
  }
  const s = degradationParams('scan', doc); assert.ok(Math.abs(s.rotate) <= 0.8 && s.quality >= 0.72 && s.quality <= 0.88);
  const f = degradationParams('fax', doc); assert.ok(f.threshold >= 0.5 && f.threshold <= 0.66 && Array.isArray(f.streaks));
  const p = degradationParams('photo', doc); assert.ok(Math.abs(p.rotate) <= 4 && p.keystone > 0 && p.keystone <= 0.06);
  assert.throws(() => degradationParams('blur', doc), /no preset blur/);
});

// On one page of a degraded PDF, compare the stamped raster with the picture before stamping and with a blank page
// stamped the same way (which shows where the watermark goes). Returns the tint the watermark adds inside its own
// shapes and elsewhere, and how the band strip looks.
async function measure(pdf, picture, n, label) {
  const scale = 100 / 72;
  const [w, h] = await withPdfPage(browser, pdf, async (page, sizes) => sizes[n - 1]);
  const ref = await PDFDocument.create(); ref.addPage([w, h]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ref-')); const refPath = path.join(dir, 'ref.pdf');
  fs.writeFileSync(refPath, await ref.save()); await finalizePdf(refPath, { band: label });
  const refPng = await withPdfPage(browser, fs.readFileSync(refPath), async (page) => { await page.evaluate((s) => window.claimseedCanvas(1, s), scale); return page.evaluate(() => window.claimseedLast.toDataURL('image/png')); });
  return withPdfPage(browser, pdf, async (page) => {
    await page.evaluate((a, s) => window.claimseedCanvas(a, s), n, scale);
    return page.evaluate(async (refUrl, picUrl, bandPt, s) => {
      const A = window.claimseedLast; const W = A.width, H = A.height;
      const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
      const pixels = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
      const a = A.getContext('2d').getImageData(0, 0, W, H).data; const r = pixels(await load(refUrl)); const p = pixels(await load(picUrl));
      const bandTop = H - Math.round(bandPt * s);
      let inSum = 0, inN = 0, outSum = 0, outN = 0, bg = 0, dark = 0, bandN = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (y > bandTop + 1 && y < H - 1) { bandN++; if (Math.abs(a[i] - 251) + Math.abs(a[i + 1] - 243) + Math.abs(a[i + 2] - 234) < 30) bg++; if (a[i] + a[i + 1] + a[i + 2] < 420) dark++; continue; }
        if (y >= bandTop - 2) continue;
        const tint = (a[i] - p[i]) - (a[i + 2] - p[i + 2]);
        if (r[i] - r[i + 2] > 12) { inSum += tint; inN++; } else if ((x + y) % 7 === 0) { outSum += tint; outN++; }
      }
      return { tintIn: inSum / inN, tintOut: outSum / outN, maskPixels: inN, bandBackground: bg / bandN, bandDark: dark };
    }, refPng, `data:${picture.mimeType};base64,${picture.data}`, 11, scale);
  });
}

// On one fax page image, threshold it again at the preset's own threshold (as a fax reader would) and compare the black
// share inside the watermark's letters with the ring around them (the letters grown by 6 pixels, minus the letters,
// above the band). The letters come from a blank page stamped the same way, drawn at the image's resolution.
async function faxPattern(pdf, image, n, label, params) {
  const [w, h] = await withPdfPage(browser, pdf, async (page, sizes) => sizes[n - 1]);
  const ref = await PDFDocument.create(); ref.addPage([w, h]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fax-')); const refPath = path.join(dir, 'ref.pdf');
  fs.writeFileSync(refPath, await ref.save()); await finalizePdf(refPath, { band: label });
  return withPdfPage(browser, fs.readFileSync(refPath), async (page) => {
    await page.evaluate((s) => window.claimseedCanvas(1, s), params.dpi / 72);
    return page.evaluate(async (imgUrl, threshold, bandPt, s) => {
      const R = window.claimseedLast; const W = R.width, H = R.height; const r = R.getContext('2d').getImageData(0, 0, W, H).data;
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = imgUrl; });
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
      const a = g.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H); for (let k = 0; k < W * H; k++) mask[k] = r[k * 4] - r[k * 4 + 2] > 12 ? 1 : 0;
      // grow the mask by 6 pixels (a 13 x 13 square), rows then columns
      const grow = (m) => { const o = new Uint8Array(W * H); const t = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = Math.max(0, x - 6); k <= Math.min(W - 1, x + 6) && !v; k++) v = m[y * W + k]; t[y * W + x] = v; }
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { let v = 0; for (let k = Math.max(0, y - 6); k <= Math.min(H - 1, y + 6) && !v; k++) v = t[k * W + x]; o[y * W + x] = v; }
        return o; };
      const big = grow(mask); const bandTop = H - Math.round(bandPt * s) - 2;
      let inB = 0, inN = 0, ringB = 0, ringN = 0;
      for (let y = 0; y < bandTop; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x; const i = k * 4; const black = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2] < threshold * 255;
        if (mask[k]) { inN++; if (black) inB++; } else if (big[k]) { ringN++; if (black) ringB++; }
      }
      return { inside: inB / inN, ring: ringB / ringN, maskPixels: inN };
    }, `data:${image.mimeType};base64,${image.data.toString('base64')}`, params.threshold, 11, params.dpi / 72);
  });
}

test('every preset of every layout: the band and the watermark are drawn on top of the degraded pages, and every file carries the markers', { skip, timeout: 600000 }, async () => {
  for (const [type, scenario] of TYPES) {
    const clean = await render({ type, scenario, seed: 'deg-t', browser });
    for (const preset of DEGRADE_PRESETS) {
      const params = degradationParams(preset, { type, scenario, seed: 'deg-t' }); const label = `${type} / ${scenario} / seed deg-t`;
      const { pdf, images, pictures } = await degradePdf(browser, clean.bytes, { preset, params, label, keepPictures: true });
      const what = `${type} ${preset}`;
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      assert.equal(doc.getPageCount(), clean.groundTruth.documents[0].pages, `${what}: page count`);
      assert.equal(doc.getSubject(), SPECIMEN_SUBJECT, `${what}: PDF metadata`); assert.equal(doc.getProducer(), 'claimseed');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-deg-')); fs.writeFileSync(path.join(dir, 'd.pdf'), pdf);
      // a second, independent reader of the metadata (Poppler); it must be installed, so its absence fails the test
      const info = spawnSync('pdfinfo', [path.join(dir, 'd.pdf')], { encoding: 'utf-8' });
      assert.equal(info.status, 0, `${what}: pdfinfo did not run (${info.error?.code || info.stderr})`);
      assert.equal((info.stdout.split('\n').find((l) => l.startsWith('Subject:')) || '').replace(/^Subject:\s+/, ''), SPECIMEN_SUBJECT, `${what}: pdfinfo Subject`);
      const words = pdfWords(path.join(dir, 'd.pdf'));
      assert.ok(words.every((ws) => ws.map((w) => w.t).join(' ').includes('SYNTHETIC SPECIMEN')), `${what}: a page without the band text`);
      assert.equal(images.length, doc.getPageCount());
      for (const i of images) {
        assert.equal(i.mimeType, preset === 'fax' ? 'image/png' : 'image/jpeg');
        const m = readMarkers(i.mimeType, i.data.toString('base64'));
        assert.equal(m.description, BAND_TEXT, `${what} page ${i.page}: image without its marker`); assert.ok(String(m.label ?? m.comment).includes(`${type} / ${scenario} / seed deg-t / ${preset}`), `${what}: image label`);
      }
      // the fax pattern on every page (portrait and landscape pages differ); the tint and band on the first and last
      const pages = preset === 'fax' ? Array.from({ length: doc.getPageCount() }, (_, k) => k + 1) : [1, doc.getPageCount()];
      for (const n of pages) {
        const m = await measure(pdf, pictures[n - 1], n, `${label} / ${preset}`);
        assert.ok(m.maskPixels > 500, `${what} p${n}: watermark mask ${m.maskPixels}`);
        assert.ok(m.tintIn > 8, `${what} p${n}: the watermark adds ${m.tintIn.toFixed(1)} of tint inside its shapes`);
        assert.ok(Math.abs(m.tintOut) < 3, `${what} p${n}: ${m.tintOut.toFixed(1)} of tint outside them`);
        assert.ok(m.bandBackground > 0.6 && m.bandDark > 40, `${what} p${n}: band ${JSON.stringify(m)}`);
        if (preset === 'fax') {
          const f = await faxPattern(pdf, images[n - 1], n, `${label} / ${preset}`, params);
          assert.ok(f.maskPixels > 500 && f.inside - f.ring >= 0.3, `${what} p${n}: after thresholding the watermark is ${f.inside.toFixed(2)} black inside its letters, ${f.ring.toFixed(2)} beside them`);
        }
      }
    }
  }
});

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
    [['--degrad', 'fax'], (c) => (c === 'render' ? /^render: unknown option; the options are --seed, --out, --degrade, --also\n$/
      : /^batch: unknown option; the options are --types, --scenarios, --seeds, --seed-prefix, --degrade, --also, --out\n$/)],
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
