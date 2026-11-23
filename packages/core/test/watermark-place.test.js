// Where the stamp puts the watermark (render.js): across the page it is centred; up the page it goes as near the middle
// as it can while crossing at least half of the page's text baselines. The placement is read back from a stamped PDF
// as from the page before stamping, the drawn letters sit where watermarkCells says, and a PDF whose text cannot be
// read has no text lines (finalizePdf then keeps the middle; mergePdfs refuses it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { PDFDocument, PDFArray, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { finalizePdf, mergePdfs } from '../src/index.js';
import { markHeights, markLines, watermarkCells, WATERMARK_COLOR } from '../src/render.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-place-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
// a page with `rows` text rows from `top` (points from the page's foot) down, 14 pt apart
async function page({ size = [612, 792], rows = 0, top = 760 } = {}) {
  const d = await PDFDocument.create(); const p = d.addPage(size); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < rows; i++) p.drawText(`Row ${i} of printed text`, { x: 40, y: top - i * 14, size: 9, font: f });
  return Buffer.from(await d.save());
}
const file = (bytes, name) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
// the first watermark cell's corner on each page, from the stamp's operators
async function firstCells(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false }); const c = WATERMARK_COLOR;
  const re = new RegExp(`${c.red} ${c.green} ${c.blue} rg\\n0 w\\n\\[\\] 0 d\\n1 0 0 1 (-?[\\d.]+) (-?[\\d.]+) cm`);
  return doc.getPages().map((pg) => {
    const k = pg.node.Contents(); const refs = k instanceof PDFArray ? k.asArray() : [k];
    const t = refs.map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1')).join('\n');
    const m = re.exec(t); return m ? [Number(m[1]), Number(m[2])] : null;
  });
}
// the share of a page's text rows inside the watermark's vertical reach
const held = (rows, top, cells) => { const ys = cells.flat().map(([, y]) => y); const lo = Math.min(...ys), hi = Math.max(...ys);
  let n = 0; for (let i = 0; i < rows; i++) { const y = top - i * 14; if (y >= lo && y <= hi) n++; } return n / rows; };

test('a page whose text sits in its top quarter gets the watermark over it; a full page keeps it near the middle, an empty one in it', async () => {
  const sparse = await page({ rows: 14, top: 760 }); const [m] = await markHeights(sparse);
  assert.ok(m.fy > 0.5, `moved up: ${m.fy}`);
  assert.ok(held(14, 760, watermarkCells(612, 792, m)) >= 0.5, 'it crosses at least half of the rows');
  const [full] = await markHeights(await page({ rows: 50, top: 760 })); assert.ok(Math.abs(full.fy - 0.5) < 0.02, `full page: ${full.fy}`);
  assert.equal((await markHeights(await page()))[0].fy, 0.5);
  const land = await page({ size: [792, 612], rows: 8, top: 580 }); const [l] = await markHeights(land);
  assert.ok(l.fy > 0.5 && held(8, 580, watermarkCells(792, 612, l)) >= 0.5, `landscape: ${l.fy}`);
});

test('the placement read back from the stamped PDF is the page\'s own, through finalizePdf and mergePdfs, and the letters are drawn there', async () => {
  const sparse = await page({ rows: 14, top: 760 }); const [before] = await markHeights(sparse);
  const fin = file(sparse, 'fin.pdf'); await finalizePdf(fin, {});
  const merged = path.join(dir, 'merged.pdf'); await mergePdfs([file(sparse, 'in.pdf'), file(await page(), 'blank.pdf')], merged, {});
  for (const [what, bytes] of [['finalizePdf', fs.readFileSync(fin)], ['mergePdfs', fs.readFileSync(merged)]]) {
    const marks = await markHeights(bytes);
    assert.ok(Math.abs(marks[0].fy - before.fy) < 1e-9, `${what}: ${marks[0].fy} against ${before.fy}`);
    const cells = await firstCells(bytes);
    marks.forEach((mk, i) => { const want = watermarkCells(612, 792, mk)[0][0]; assert.ok(cells[i] && Math.abs(cells[i][0] - want[0]) < 0.001 && Math.abs(cells[i][1] - want[1]) < 0.001, `${what} p${i + 1}: ${cells[i]} against ${want}`); });
  }
});

// pdf.js reads every PDF pdf-lib reads in these tests; the two ways it could fail are fed to markLines directly
test('a PDF whose text cannot be read, or whose pages pdf.js counts differently, has no text lines: the middle', async () => {
  assert.equal(await markLines(Buffer.from('not a pdf'), 1), null);
  const one = await page({ rows: 14, top: 760 });
  assert.equal(await markLines(one, 2), null);
  assert.equal((await markLines(one, 1)).length, 1);
  assert.ok((await markHeights(one))[0].fy > 0.5);
});
