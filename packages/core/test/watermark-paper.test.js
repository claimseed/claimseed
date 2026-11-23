// The watermark on other paper (render.js watermarkRun): every page the stamp accepts carries a watermark that reaches
// the floors across and up the page, the page shapes it cannot reach are refused with a fixed message on every path
// that places it, and Letter in both orientations keeps its fixed placement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { findChrome, launchBrowser, finalizePdf, mergePdfs, degradePdf, degradationParams } from '../src/index.js';
import { markHeights, watermarkCells } from '../src/render.js';
import { watermarkContrast, belowFloors } from './watermark-contrast.js';
import { faxPattern } from './degrade-floors.js';
import { copyMarks } from '../src/degrade.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser; let dir;
before(async () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-paper-')); if (!skip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const SHAPE = /^stamp refused: visible page \d+x\d+ pt has a shape that cannot carry the watermark, which must reach at least 70% of the page's width and 35% of its height$/;
const BAND = /^stamp refused: visible page \d+x\d+ pt is too small to carry the specimen band/;
// a page of fictional text lines, 18 pt apart, over the whole page
async function textPage(w, h) {
  const d = await PDFDocument.create(); const p = d.addPage([w, h]); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let y = 54; y < h - 42; y += 18) p.drawText('Fictional sample statement line', { x: 48, y, size: 11, font: f });
  return Buffer.from(await d.save());
}
const extent = (w, h, mark = null) => {
  const pts = watermarkCells(w, h, mark).flat(); const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
const hash = (c) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);

test('Letter, portrait and landscape: the watermark cells are exactly the fixed ones, in each placement mode', () => {
  const want = { '612x792 none': '7d947cc4187604c2', '612x792 lines': '8ed495b098259628', '612x792 fy': 'efe0c2a380175755',
    '792x612 none': '81a8f74c24227b6b', '792x612 lines': '81a8f74c24227b6b', '792x612 fy': '7652bc9443a63e44' };
  const lines = [100, 120, 140, 160, 180, 200, 220, 240, 260, 700, 720, 740];
  for (const [w, h] of [[612, 792], [792, 612]]) for (const [name, m] of [['none', null], ['lines', { lines }], ['fy', { fy: 0.62 }]]) {
    assert.equal(hash(watermarkCells(w, h, m)), want[`${w}x${h} ${name}`], `${w}x${h} ${name}`);
  }
});

// named paper sizes, each in both orientations (259.2 x 216 only as the band allows it: 216 pt is under its width)
const NAMED = { Letter: [612, 792], Legal: [612, 1008], A4: [595.28, 841.89], A5: [419.53, 595.28], A3: [841.89, 1190.55], Tabloid: [792, 1224],
  'half-letter': [396, 612], '960x540': [540, 960] };
test('named paper sizes in both orientations: accepted, the watermark inside the page and past the floors', () => {
  const shapes = [...Object.entries(NAMED).flatMap(([n, [a, b]]) => [[`${n} portrait`, a, b], [`${n} landscape`, b, a]]), ['259.2x216', 259.2, 216]];
  for (const [name, w, h] of shapes) {
    const e = extent(w, h);
    assert.ok((e.x1 - e.x0) / w >= 0.72 && (e.y1 - e.y0) / h >= 0.37, `${name}: reach ${((e.x1 - e.x0) / w).toFixed(3)} x ${((e.y1 - e.y0) / h).toFixed(3)}`);
    assert.ok(e.x0 >= 18 - 1e-6 && e.x1 <= w - 18 + 1e-6 && e.y0 >= 29 - 1e-6 && e.y1 <= h - 18 + 1e-6, `${name}: inside the margins, above the band`);
  }
});

test('the refused shapes: exactly these on a grid of page sizes, with the fixed refusal', () => {
  const W = [259.2, 300, 400, 500, 612, 792, 1008, 1224, 1500, 1728]; const H = [216, 259.2, 300, 400, 500, 612, 792, 1008, 1224, 1500, 1728];
  const want = new Set(['1008x216', '1224x216', '1500x216', '1728x216', '1224x259.2', '1500x259.2', '1728x259.2', '1500x300', '1728x300',
    '259.2x1008', '259.2x1224', '300x1224', '259.2x1500', '300x1500', '259.2x1728', '300x1728', '400x1728']);
  const got = new Set();
  for (const w of W) for (const h of H) {
    try { watermarkCells(w, h); } catch (e) { assert.match(e.message, SHAPE, `${w}x${h}`); got.add(`${w}x${h}`); }
  }
  assert.deepEqual([...got].sort(), [...want].sort());
});

test('a refused shape is refused on every path, and the band keeps its own refusal', { skip, timeout: 300000 }, async () => {
  for (const [w, h] of [[259.2, 1500], [1500, 216]]) {
    const bytes = await textPage(w, h); const f = path.join(dir, `r-${w}x${h}.pdf`);
    fs.writeFileSync(f, bytes); await assert.rejects(finalizePdf(f), (e) => SHAPE.test(e.message), `finalizePdf ${w}x${h}`);
    fs.writeFileSync(f, bytes); await assert.rejects(mergePdfs([f], path.join(dir, 'm.pdf')), (e) => SHAPE.test(e.message), `mergePdfs ${w}x${h}`);
    await assert.rejects(markHeights(bytes), (e) => SHAPE.test(e.message), `markHeights ${w}x${h}`);
    for (const preset of ['scan', 'fax']) {
      const params = degradationParams(preset, { type: 'msn', scenario: 'baseline-clean', seed: 'paper' });
      await assert.rejects(degradePdf(browser, bytes, { preset, params, pageImages: false }), (e) => SHAPE.test(e.message), `degradePdf ${preset} ${w}x${h}`);
    }
  }
  const f = path.join(dir, 'narrow.pdf'); fs.writeFileSync(f, await textPage(216, 259.2));
  await assert.rejects(finalizePdf(f), (e) => BAND.test(e.message), 'a page under the band\'s width keeps the band\'s refusal');
});

// The measured floors, clean, on a page of text lines through both entry points: Legal, A4, Tabloid and A5 both
// ways, half-letter, the suite's 312 x 492 CropBox size, and the steepest and flattest shapes the stamp accepts
const MEASURED = [[612, 1008], [1008, 612], [595.28, 841.89], [841.89, 595.28], [792, 1224], [1224, 792], [419.53, 595.28], [595.28, 419.53],
  [396, 612], [312, 492], [259.2, 900], [960, 216]];
test('other paper: the watermark on a page of text meets the clean floors through finalizePdf and mergePdfs', { skip, timeout: 600000 }, async () => {
  for (const [w, h] of MEASURED) {
    const original = await textPage(w, h); const marks = await markHeights(original);
    for (const mode of ['finalize', 'merge']) {
      const input = path.join(dir, 'in.pdf'); const merged = path.join(dir, 'merged.pdf');
      fs.writeFileSync(input, original);
      if (mode === 'finalize') await finalizePdf(input); else await mergePdfs([input], merged);
      const m = await watermarkContrast(browser, fs.readFileSync(mode === 'finalize' ? input : merged), 1, null, marks[0]);
      assert.deepEqual(belowFloors(m, { clean: true }), [], `${w}x${h} ${mode}: ${JSON.stringify({ spanX: m.spanX, spanY: m.spanY, tiles: m.tiles })}`);
    }
  }
});

test('a fax copy of Legal paper, both ways: its dots are the watermark the stamp draws, at the stamp\'s angle and place', { skip, timeout: 300000 }, async () => {
  for (const [w, h] of [[612, 1008], [1008, 612]]) {
    const f = path.join(dir, `fax-${w}x${h}.pdf`); fs.writeFileSync(f, await textPage(w, h)); await finalizePdf(f);
    const stamped = fs.readFileSync(f);
    const params = degradationParams('fax', { type: 'msn', scenario: 'baseline-clean', seed: `paper-${w}` });
    const deg = await degradePdf(browser, stamped, { preset: 'fax', params, pageImages: true });
    const mark = copyMarks('fax', params, await markHeights(stamped))[0];
    const m = await faxPattern(browser, deg.pdf, deg.images[0], 1, 'fax', params, mark);
    assert.ok(m.maskPixels > 500 && m.inside - m.ring >= 0.3, `${w}x${h}: inside ${m.inside.toFixed(2)}, ring ${m.ring.toFixed(2)}`);
  }
});
