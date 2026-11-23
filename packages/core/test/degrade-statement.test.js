// Degraded copies of a provider's statement: render --degrade with also bill (the library's renderDegraded and the
// command line) and a batch with degrade and also bill make the statement's copy beside the EOB's, same preset, its
// settings drawn from its own type; each copy's key names the other copy (pair.with), the batch's pairs.jsonl lists the
// copies, named and blind; the statement copy carries the markers. The refusals that stay, and the seeds that would
// name another document's files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { renderDegraded, renderBatch, render, checkRender, launchBrowser, findChrome, readManifest, BAND_TEXT } from '../src/index.js';
import { pairMessage } from '../src/generate/provider-statement.js';
import { variantIds } from '../src/variants.js';
import { readMarkers } from './markers-read.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const SALT = 'fedcba9876543210fedcba9876543210';
let browser; let dir;
before(async () => { if (!skip) { browser = await launchBrowser(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-degrade-st-')); } });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const key = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'));
const text = (f) => execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf-8' });

// both keys valid, each a copy at the preset naming the other, the statement's settings not the EOB's
function checkPair(eob, st, eobName, stName, preset, where) {
  for (const k of [eob, st]) assert.ok(validate(k), `${where}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual([eob.documents[0].degradation, st.documents[0].degradation], [preset, preset], `${where}: degradation`);
  assert.equal(st.documents[0].type, 'provider-statement'); assert.equal(st.schemaVersion, '1.6');
  assert.equal(eob.schemaVersion, eob.documents[0].type === 'commercial-eob' ? '1.7' : '1.6', `${where}: the EOB's key version`);
  assert.deepEqual([eob.pair.with, st.pair.with], [stName, eobName], `${where}: pair.with names the copies`);
  assert.notDeepEqual(st.documents[0].degradationParams, eob.documents[0].degradationParams, `${where}: the statement's own settings`);
  for (const f of ['claim', 'variant', 'params']) assert.deepEqual(eob.pair[f], st.pair[f], `${where}: pair.${f}`);
}

test('render --degrade with also bill: the statement\'s copy beside the EOB\'s, named, blind and from the command line, with its markers', { skip, timeout: 600000 }, async () => {
  // named, a Medicare Advantage pair with its 835
  const a = path.join(dir, 'a');
  const r = await renderDegraded({ type: 'ppo-eob', scenario: 'duplicate-visit', seed: 'dst-1', preset: 'scan', also: ['835', 'bill'], bill: 'over-owed', billParams: { by: 12.34 }, outDir: a, browser });
  const stem = path.join(a, 'ppo-eob_duplicate-visit_dst-1');
  for (const f of ['_scan.pdf', '_scan.ground-truth.json', '_scan.835', '.bill_scan.pdf', '.bill_scan.ground-truth.json', '.bill_scan_p1.jpg']) assert.ok(fs.existsSync(stem + f), f);
  checkPair(key(`${stem}_scan.ground-truth.json`), key(`${stem}.bill_scan.ground-truth.json`), 'ppo-eob_duplicate-visit_dst-1_scan', 'ppo-eob_duplicate-visit_dst-1.bill_scan', 'scan', 'named');
  assert.equal(r.bill.pdf, `${stem}.bill_scan.pdf`); assert.equal(r.bill.images.length, 1);
  // the caller's statement variant and its amount reach the copy
  const stKey = key(`${stem}.bill_scan.ground-truth.json`);
  assert.equal(stKey.pair.variant, 'over-owed'); assert.equal(stKey.pair.params.by, 12.34); assert.deepEqual(stKey.errors.map((e) => e.kind), ['bill-vs-eob-mismatch']);
  assert.match(text(`${stem}.bill_scan.pdf`), /SYNTHETIC SPECIMEN/);
  assert.equal(readMarkers(r.bill.images[0].mimeType, r.bill.images[0].data.toString('base64')).description, BAND_TEXT);
  // blind, a commercial pair: both named by their copy ids, keys apart
  const b = path.join(dir, 'b'); const bk = path.join(dir, 'bk');
  const s = await renderDegraded({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'dst-2', preset: 'photo', also: 'bill', blind: { salt: SALT }, outDir: b, keysDir: bk, browser });
  assert.match(s.id, /^doc-[0-9a-f]{16}$/); assert.match(s.bill.id, /^doc-[0-9a-f]{16}$/); assert.notEqual(s.id, s.bill.id);
  assert.deepEqual(fs.readdirSync(bk).sort(), [`${s.bill.id}.ground-truth.json`, `${s.id}.ground-truth.json`].sort());
  checkPair(key(path.join(bk, `${s.id}.ground-truth.json`)), key(path.join(bk, `${s.bill.id}.ground-truth.json`)), s.id, s.bill.id, 'photo', 'blind');
  for (const id of [s.id, s.bill.id]) { assert.equal(key(path.join(bk, `${id}.ground-truth.json`)).blind.id, id, 'named by its key\'s copy id'); assert.ok(fs.existsSync(path.join(b, `${id}.pdf`)), id); }
  assert.ok(!fs.readdirSync(b).some((f) => /commercial|baseline|dst-2|bill/.test(f)), 'blind file names carry no scenario, seed or kind');
  // the command line, a named insurer: its suffix before .bill
  const c = path.join(dir, 'c');
  const out = spawnSync(process.execPath, [CLI, 'render', 'commercial-eob', 'baseline-clean', '--seed', 'dst-3', '--insurer', 'b', '--degrade', 'low-res', '--also', 'bill', '--bill', 'over-owed', '--out', c], { encoding: 'utf-8' });
  assert.equal(out.status, 0, out.stderr);
  checkPair(key(path.join(c, 'commercial-eob_baseline-clean_dst-3.b_low-res.ground-truth.json')), key(path.join(c, 'commercial-eob_baseline-clean_dst-3.b.bill_low-res.ground-truth.json')),
    'commercial-eob_baseline-clean_dst-3.b_low-res', 'commercial-eob_baseline-clean_dst-3.b.bill_low-res', 'low-res', 'command line');
  assert.equal(key(path.join(c, 'commercial-eob_baseline-clean_dst-3.b.bill_low-res.ground-truth.json')).pair.variant, 'over-owed', 'the command line\'s --bill');
});

test('a batch with degrade and also bill writes both copies, each with its manifest line, and pairs.jsonl lists the copies, named and blind', { skip, timeout: 600000 }, async () => {
  const n = path.join(dir, 'bn');
  await renderBatch({ types: ['hmo-eob'], scenarios: ['denied-service'], seeds: 1, degrade: 'fax', also: ['835', 'bill'], outDir: n, browser });
  const lines = readManifest(path.join(n, 'manifest.jsonl'));
  assert.deepEqual(lines.map((l) => [l.pdf, l.degradation, l.pairOf ?? null]).sort(), [
    ['hmo-eob_denied-service_batch-1.bill_fax.pdf', 'fax', 'hmo-eob_denied-service_batch-1_fax'], ['hmo-eob_denied-service_batch-1_fax.pdf', 'fax', null]].sort());
  assert.deepEqual(fs.readFileSync(path.join(n, 'pairs.jsonl'), 'utf-8'), `${JSON.stringify({ eob: 'hmo-eob_denied-service_batch-1_fax', bill: 'hmo-eob_denied-service_batch-1.bill_fax' })}\n`);
  checkPair(key(path.join(n, 'hmo-eob_denied-service_batch-1_fax.ground-truth.json')), key(path.join(n, 'hmo-eob_denied-service_batch-1.bill_fax.ground-truth.json')),
    'hmo-eob_denied-service_batch-1_fax', 'hmo-eob_denied-service_batch-1.bill_fax', 'fax', 'batch');
  assert.ok(fs.existsSync(path.join(n, 'hmo-eob_denied-service_batch-1_fax.835')));
  const bo = path.join(dir, 'bo'); const bk = path.join(dir, 'bok');
  await renderBatch({ types: ['commercial-eob'], scenarios: ['care-settings-clean'], seeds: 1, degrade: 'scan', also: 'bill', outDir: bo, keysDir: bk, blind: { salt: SALT }, browser });
  const [pair] = fs.readFileSync(path.join(bo, 'pairs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  checkPair(key(path.join(bk, `${pair.eob}.ground-truth.json`)), key(path.join(bk, `${pair.bill}.ground-truth.json`)), pair.eob, pair.bill, 'scan', 'blind batch');
  for (const id of [pair.eob, pair.bill]) assert.equal(key(path.join(bk, `${id}.ground-truth.json`)).blind.id, id, 'named by its key\'s copy id');
  assert.deepEqual(fs.readdirSync(bo).sort(), [`${pair.bill}.pdf`, `${pair.eob}.pdf`, 'pairs.jsonl'].sort());
});

test('the refusals that stay: a statement for a type without one, a variant or amount without also bill; and a seed ending in a suffix the namer adds for its type, refused before anything is made', { skip, timeout: 120000 }, async () => {
  const exact = (key, who) => (e) => e.message === pairMessage(key, who);
  const d = path.join(dir, 'refused');
  await assert.rejects(renderDegraded({ type: 'msn', scenario: 'baseline-clean', seed: 'r-1', preset: 'scan', also: 'bill', outDir: d, browser }), exact('pairTypes', 'degrade'));
  await assert.rejects(renderDegraded({ type: 'ppo-eob', scenario: 'baseline-clean', seed: 'r-1', preset: 'scan', bill: 'over-owed', outDir: d, browser }), exact('billNeedsAlso', 'degrade'));
  await assert.rejects(renderBatch({ types: ['msn'], seeds: 1, degrade: 'scan', also: 'bill', outDir: d, browser }), exact('pairTypes', 'batch'));
  const cases = [['ppo-eob', 'x.bill'], ['hmo-eob', 'x.BILL'], ['commercial-eob', 'x.bill'], ['commercial-eob', 'x.a'], ['commercial-eob', 'x.B'],
    ...['itemized-bill', 'ppo-eob', 'hmo-eob'].map((t) => [t, `x.${variantIds(t)[3]}`]), ...['msn', 'itemized-bill', 'ppo-eob'].flatMap((t) => ['scan', 'fax', 'photo', 'low-res'].map((p) => [t, `x_${p}`]))];
  for (const [type, seed] of cases) {
    await assert.rejects(render({ type, scenario: 'baseline-clean', seed, outDir: d, browser }), exact('seedSuffix', 'render'), `${type} ${seed}`);
    await assert.rejects(renderDegraded({ type, scenario: 'baseline-clean', seed, preset: 'scan', outDir: d, browser }), exact('seedSuffix', 'degrade'), `${type} ${seed} degraded`);
  }
  assert.ok(!fs.existsSync(d), 'nothing made');
  // the same endings on a type the namer does not add them for are a seed like any other
  for (const [type, seed] of [['msn', 'x.bill'], ['itemized-bill', 'x.bill'], ['ppo-eob', 'x.a'], ['msn', `x.${variantIds('ppo-eob')[0]}`], ['commercial-eob', `x.${variantIds('hmo-eob')[0]}`]]) {
    assert.doesNotThrow(() => checkRender({ type, scenario: 'baseline-clean', seed }, 'render'), `${type} ${seed}`);
  }
});

// The watermark's floors (test/watermark-contrast.js) on the degraded statement, page and image, every preset but fax:
// a Medicare Advantage statement and a commercial group practice's, whose treating row is on the page
test('a degraded statement keeps the watermark above its floors on the page and its image', { skip, timeout: 600000 }, async () => {
  const { watermarkContrast, belowFloors } = await import('./watermark-contrast.js');
  const { degradationParams, degradePdf } = await import('../src/index.js');
  const { markHeights } = await import('../src/render.js'); const { copyMarks } = await import('../src/degrade.js');
  for (const [type, scenario] of [['ppo-eob', 'duplicate-visit'], ['commercial-eob', 'baseline-clean']]) {
    const r = await render({ type, scenario, seed: 'dst-f', also: 'bill', outDir: fs.mkdtempSync(path.join(dir, 'f-')), browser });
    if (type === 'commercial-eob') assert.ok(r.bill.groundTruth.documents[0].fields['metadata.treatingProvider'], 'a group practice\'s statement');
    for (const preset of ['scan', 'photo', 'low-res']) {
      const params = degradationParams(preset, { type: 'provider-statement', scenario, seed: 'dst-f' });
      const { pdf, images } = await degradePdf(browser, r.bill.bytes, { preset, params, label: `statement / ${preset}` });
      const im = images[0]; const [mark] = copyMarks(preset, params, await markHeights(r.bill.bytes));
      for (const [where, m] of [['page', await watermarkContrast(browser, pdf, 1, null, mark)], ['image', await watermarkContrast(browser, pdf, 1, { url: `data:${im.mimeType};base64,${im.data.toString('base64')}`, dpi: params.dpi }, mark)]]) {
        assert.deepEqual(belowFloors(m), [], `${type} statement ${preset} ${where}: ${JSON.stringify(m)}`);
      }
    }
  }
});
