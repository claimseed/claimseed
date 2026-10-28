// Output guarantees for every wired layout: only bundled fonts are embedded, PDF bytes are identical across two
// renders, the metadata marker is set, the specimen band is on every page, and the ground truth validates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findChrome } from '../src/browser.js';
import { watermarkRectsPerPage } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
// bundled web fonts, plus the PDF-standard Helvetica that the band stamp uses (not embedded)
const BUNDLED = /^(Inter|NotoSans|NotoSerif|CourierPrime|Helvetica(-Bold)?$)/;
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';

function renderTo(dir, type, scenario, seed) {
  execFileSync(process.execPath, [CLI, 'render', type, scenario, '--seed', seed, '--out', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
  const base = path.join(dir, `${type}_${scenario}_${seed}`);
  return { pdf: base + '.pdf', gt: JSON.parse(fs.readFileSync(base + '.ground-truth.json', 'utf-8')) };
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const { RENDERERS } = await import('../src/layouts.js');
const { listScenarios } = await import('../src/generate/index.js');
for (const type of Object.keys(RENDERERS)) {
  const scenario = listScenarios(type)[0];
  test(`${type}/${scenario}: fonts, determinism, markers, page count`, { skip }, async () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-out-')); const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-out-'));
    const a = renderTo(d1, type, scenario, 'det-1'); const b = renderTo(d2, type, scenario, 'det-1');
    assert.equal(sha(a.pdf), sha(b.pdf), 'PDF bytes differ between two renders of the same seed');
    assert.equal(a.gt.documents[0].sha256, sha(a.pdf));
    const fonts = execFileSync('pdffonts', [a.pdf], { encoding: 'utf-8' }).split('\n').slice(2).filter(Boolean).map((l) => l.split(/\s+/)[0].replace(/^[A-Z]{6}\+/, ''));
    const foreign = fonts.filter((f) => !BUNDLED.test(f));
    assert.deepEqual(foreign, [], `non-bundled font embedded: ${foreign.join(', ')}`);
    assert.ok(!fonts.some((f) => /ClaimseedNotdef/.test(f)), 'a character outside the bundled glyph sets rendered as a box');
    const info = execFileSync('pdfinfo', [a.pdf], { encoding: 'utf-8' });
    assert.match(info, /Subject:\s+synthetic specimen, not a real document/);
    const pages = Number(/Pages:\s+(\d+)/.exec(info)[1]);
    assert.equal(a.gt.documents[0].pages, pages); assert.equal(a.gt.documents[0].fields['metadata.pageCount'], pages);
    const rects = await watermarkRectsPerPage(a.pdf);
    for (let p = 1; p <= pages; p++) {
      const t = execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), a.pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, '');
      assert.ok(t.includes('SYNTHETICSPECIMEN'), `page ${p} has no specimen band`);
      assert.ok(rects[p - 1] >= 100, `page ${p} has no watermark (${rects[p - 1]} rects)`);
    }
    // the watermark must not leak letters into layout-mode text extraction (the extractor-testing use case)
    const layout = execFileSync('pdftotext', ['-layout', a.pdf, '-'], { encoding: 'utf-8' });
    assert.ok(!/\bS P E C I M E N\b|\bC L A I M S E E D\b|\bS P EC I M EN\b/.test(layout), 'watermark letters interleaved into -layout text');
    fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
  });
}

test('mergePdfs refuses a planned/actual page-count mismatch', async () => {
  const { mergePdfs } = await import('../src/render.js');
  const { PDFDocument } = await import('pdf-lib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-merge-'));
  const one = await PDFDocument.create(); one.addPage([612, 792]); fs.writeFileSync(path.join(dir, 'a.pdf'), await one.save());
  await assert.rejects(() => mergePdfs([path.join(dir, 'a.pdf')], path.join(dir, 'out.pdf'), { expectedPages: 2 }), /pagination mismatch/);
  await mergePdfs([path.join(dir, 'a.pdf')], path.join(dir, 'out.pdf'), { expectedPages: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'out.pdf')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The rendered-text provenance check in scan-rendered.js: a sentence that reaches the page from anywhere — here a
// stock message with words outside the verified vocabulary — fails the scan of the rendered document, whatever
// literal or template produced it.
test('scan-rendered refuses rendered text that is neither public nor reviewed original', { skip }, () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prov-'));
  for (const e of fs.readdirSync(path.join(here, '..'))) if (e !== 'node_modules' && e !== 'output') fs.cpSync(path.join(here, '..', e), path.join(copy, e), { recursive: true });
  fs.symlinkSync(path.join(here, '../../../node_modules'), path.join(copy, 'node_modules'));
  const sp = path.join(copy, 'data/msn/stock-content.json'); const stock = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  stock.page2.messages.push('Members who travel outside the service area should carry this card and present it at every visit.');
  fs.writeFileSync(sp, JSON.stringify(stock));
  let r = spawnSync(process.execPath, [path.join(copy, 'scripts/scan-rendered.js'), '--seeds', '1', '--type', 'msn'], { encoding: 'utf-8', env: process.env });
  assert.equal(r.status, 1, 'a lifted sentence rendered on the page passed scan-rendered');
  assert.match(r.stderr + r.stdout, /printed text neither public nor reviewed original/);
  // a sentence built only from words the tree already prints (labels, headings, verified prose) is still
  // reported — only single-word labels are free tokens, never the words of longer strings
  stock.page2.messages.pop(); stock.page2.messages.push('Your claim amount for this service date is the total you may owe the provider after Medicare paid its share.');
  fs.writeFileSync(sp, JSON.stringify(stock));
  r = spawnSync(process.execPath, [path.join(copy, 'scripts/scan-rendered.js'), '--seeds', '1', '--type', 'msn'], { encoding: 'utf-8', env: process.env });
  assert.equal(r.status, 1, 'a sentence composed of vocabulary words passed scan-rendered');
  // a generator constant that reaches the page through data is a tree-sourced string and must be verified too
  stock.page2.messages.pop(); fs.writeFileSync(sp, JSON.stringify(stock));
  const gp = path.join(copy, 'src/generate/msn.js'); const gsrc = fs.readFileSync(gp, 'utf-8');
  fs.writeFileSync(gp, gsrc.replace("deductible: 'This amount was applied to your Part B deductible.'", "deductible: 'Wendell Beaumont visited the Example Orthopaedic Clinic for the fitting of a brace.'"));
  assert.notEqual(fs.readFileSync(gp, 'utf-8'), gsrc, 'the deductible note constant was not found');
  r = spawnSync(process.execPath, [path.join(copy, 'scripts/scan-rendered.js'), '--seeds', '1', '--type', 'msn'], { encoding: 'utf-8', env: process.env });
  assert.equal(r.status, 1, `a generator constant printed through data passed scan-rendered: ${(r.stderr + r.stdout).slice(0, 300)}`);
  fs.rmSync(copy, { recursive: true, force: true });
});
