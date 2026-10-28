// The specimen marks on a caller's PDF (finalizePdf, mergePdfs) must be visible on a raster of the page, not only
// present as drawing operators. Page content that a viewer and the content check could read differently is refused by
// both routes: an open marked-content sequence (hidden optional content would hide the marks), a stray EMC, an inline
// image whose data holds "EI" or cannot be measured, an operator inside an array or a dictionary, tokens viewers split
// differently, and a path left open at the end. The well-formed versions of the same constructs are stamped, and both
// marks are counted on a pdftoppm raster against an ordinary page. All page text here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib';
import { finalizePdf, mergePdfs } from '../src/index.js';
import { pageContentBytes } from '../src/pdf-content.js';

const skip = spawnSync('pdftoppm', ['-v']).error && !process.env.CI && 'no poppler (pdftoppm); never skipped in CI';
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p)));

// A one-page document with a line of fictional text, `setup(doc, page)` applied, then each of `streams` appended to the
// page as a content stream of its own.
async function makePdf(streams = [], setup) {
  const doc = await PDFDocument.create(); const page = doc.addPage([612, 792]);
  page.drawText('Fictional sample page', { x: 40, y: 700, size: 18, color: rgb(0, 0, 0) });
  if (setup) setup(doc, page);
  for (const s of streams) page.node.addContentStream(doc.context.register(doc.context.flateStream(s)));
  return doc.save();
}
// an optional-content group that the document's default configuration switches off, named /Hidden in `resources`
function hiddenLayer(doc, resources) {
  const oc = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden layer') }));
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [oc], D: { BaseState: 'ON', OFF: [oc], Order: [oc] } }));
  resources.set(PDFName.of('Properties'), doc.context.obj({ Hidden: oc }));
  return oc;
}
const withHiddenLayer = (doc, page) => hiddenLayer(doc, page.node.Resources());

// Stamp `pdf` through both public routes; returns the two stamped files.
async function stampBoth(dir, name, pdf) {
  const input = path.join(dir, `${name}-input.pdf`); fs.writeFileSync(input, pdf);
  const finalized = path.join(dir, `${name}-finalized.pdf`); fs.copyFileSync(input, finalized); await finalizePdf(finalized);
  const merged = path.join(dir, `${name}-merged.pdf`); await mergePdfs([input], merged);
  return [finalized, merged];
}
async function refusedByBoth(dir, name, pdf, pattern) {
  const input = path.join(dir, `${name}-input.pdf`); fs.writeFileSync(input, pdf);
  const finalized = path.join(dir, `${name}-finalized.pdf`); fs.copyFileSync(input, finalized);
  await assert.rejects(finalizePdf(finalized), pattern, `finalizePdf accepted ${name}`);
  await assert.rejects(mergePdfs([input], path.join(dir, `${name}-merged.pdf`)), pattern, `mergePdfs accepted ${name}`);
}

// Band- and watermark-coloured pixels of page 1 rasterized by pdftoppm at 72 dpi: the band fill, its text and the
// watermark tint over white are all warm (red and green above blue); the band is the bottom 11 pt, the watermark
// everything above it.
function markPixels(pdf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-px-'));
  try {
    execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-singlefile', pdf, path.join(dir, 'p')]);
    const ppm = fs.readFileSync(path.join(dir, 'p.ppm')); const hdr = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 40));
    assert.ok(hdr, 'unexpected raster format');
    const W = +hdr[1], H = +hdr[2], off = hdr[0].length; let band = 0, watermark = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = off + (y * W + x) * 3; const r = ppm[k], g = ppm[k + 1], b = ppm[k + 2];
      if (r > b + 8 && g > b + 2) { if (y >= H - 11) band++; else watermark++; }
    }
    return { band, watermark };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
let control;
async function assertMarksVisible(dir, name, pdf) {
  if (!control) {
    const [f, m] = await stampBoth(dir, 'control', await makePdf());
    control = markPixels(f);
    assert.ok(control.band > 3000 && control.watermark > 5000, `control page has too few marker pixels: ${JSON.stringify(control)}`);
    assert.deepEqual(markPixels(m), control, 'the two routes stamp an ordinary page differently');
  }
  for (const out of await stampBoth(dir, name, pdf)) {
    const px = markPixels(out);
    assert.ok(px.band >= 0.95 * control.band && px.watermark >= 0.95 * control.watermark, `${path.basename(out)}: marks not visible (${JSON.stringify(px)} vs ${JSON.stringify(control)})`);
    const text = execFileSync('pdftotext', ['-raw', out, '-'], { encoding: 'utf-8' });
    assert.match(text, /Fictional sample page/, `${path.basename(out)}: the page's own text is gone`);
    assert.match(text, /SYNTHETIC SPECIMEN/, `${path.basename(out)}: band text missing`);
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-markers-'));

test('marked content: an unclosed BDC or BMC and a stray EMC are refused by finalizePdf and mergePdfs', { skip }, async () => {
  const dir = tmp();
  try {
    await refusedByBoth(dir, 'open-hidden-layer', await makePdf(['/OC /Hidden BDC\n'], withHiddenLayer), /^Error: stamp refused: page 1 content leaves 1 marked-content sequence\(s\) open/);
    await refusedByBoth(dir, 'open-bmc', await makePdf(['/Artifact BMC 0 0 1 rg', '10 10 5 5 re f\n']), /stamp refused: page 1 content leaves 1 marked-content sequence\(s\) open/);
    await refusedByBoth(dir, 'stray-emc', await makePdf(['EMC\n']), /stamp refused: page 1 content ends a marked-content sequence it never began/);
    // an EMC before the BDC it would "match" balances the count but leaves the hidden sequence open
    await refusedByBoth(dir, 'emc-before-bdc', await makePdf(['EMC /OC /Hidden BDC\n'], withHiddenLayer), /stamp refused: page 1 content ends a marked-content sequence it never began/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('marked content: closed optional content is stamped with both marks visible', { skip }, async () => {
  const dir = tmp();
  try {
    await assertMarksVisible(dir, 'closed-hidden-layer', await makePdf(['/OC /Hidden BDC 0 0 1 rg 100 600 50 50 re f EMC\n'], withHiddenLayer));
    await assertMarksVisible(dir, 'nested-sequences-across-streams', await makePdf(['/P <</MCID 0>> BDC /Span <</ActualText (a Q and an EMC)>> BDC', 'EMC EMC\n']));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inline images: data holding EI, unmeasurable filters, colour spaces and lengths are refused', { skip }, async () => {
  const dir = tmp(); const refusal = /stamp refused: page 1 content cannot be read \(inline image cannot be parsed unambiguously/;
  try {
    // 96 bytes of RGB data whose first bytes are " EI q ": a first-EI search ends the image there and counts the q
    await refusedByBoth(dir, 'false-ei', await makePdf([bytes('BI /W 32 /H 1 /CS /RGB /BPC 8 ID\n', ' EI q ', Buffer.alloc(90, 65), '\nEI\nQ 0 0 1 1 re W n\n')]), refusal);
    for (const [name, content] of [
      ['flate-filter', bytes('q BI /W 2 /H 2 /CS /G /BPC 8 /F /Fl ID ', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1]), ' EI Q\n')],
      ['dct-filter-array', bytes('q BI /W 2 /H 2 /CS /G /BPC 8 /F [/DCT] ID ', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), ' EI Q\n')],
      ['two-filters', 'q BI /W 4 /H 1 /CS /G /BPC 8 /F [/AHx /Fl] ID 61626364> EI Q\n'],
      ['named-colour-space', 'q BI /W 4 /H 1 /CS /CS0 /BPC 8 ID abcd EI Q\n'],
      ['length-disagrees', 'q BI /W 4 /H 1 /CS /G /BPC 8 /L 9 ID abcd EI Q\n'],
      ['bytes-after-data', 'q BI /W 4 /H 1 /CS /G /BPC 8 ID abcdXY EI Q\n'],
      ['data-shorter-than-dimensions', 'q BI /W 40 /H 40 /CS /G /BPC 8 ID abcd EI Q\n'],
      ['repeated-key', 'q BI /W 4 /Width 8 /H 1 /CS /G /BPC 8 ID abcd EI Q\n'],
      ['ahx-non-hex-byte', 'q BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 41 EI 42> EI Q\n'],
      ['a85-holding-ei', 'q BI /W 4 /H 1 /CS /G /BPC 8 /F /A85 ID 5s EI dq,~> EI Q\n'],
    ]) await refusedByBoth(dir, name, await makePdf([content]), refusal);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inline images that can be measured exactly are stamped with both marks visible', { skip }, async () => {
  const dir = tmp();
  try {
    // the well-formed twin of the false-EI image: 96 bytes of data full of q and Q bytes, none of them operators
    await assertMarksVisible(dir, 'raw-rgb', await makePdf([bytes('q 64 0 0 8 40 600 cm BI /W 32 /H 1 /CS /RGB /BPC 8 ID\n', 'q Q '.repeat(24), '\nEI Q\n')]));
    await assertMarksVisible(dir, 'ascii-hex', await makePdf(['q 64 0 0 8 40 600 cm BI /W 2 /H 1 /CS /DeviceGray /BPC 8 /F /ASCIIHexDecode ID 4142> EI Q\n']));
    await assertMarksVisible(dir, 'ascii85-length', await makePdf(['q 64 0 0 8 40 600 cm BI /W 4 /H 1 /CS /G /BPC 8 /F [/A85] /L 7 ID 5sdq,~> EI Q\n']));
    await assertMarksVisible(dir, 'image-mask-and-indexed', await makePdf([bytes('q 0 g 64 0 0 8 40 600 cm BI /IM true /W 16 /H 2 ID ', Buffer.from([0xf0, 0x0f, 0x55, 0xaa]), ' EI Q\n',
      'q 64 0 0 8 40 620 cm BI /W 4 /H 1 /CS [/I /RGB 1 <000000808080>] /BPC 1 ID ', Buffer.from([0xa0]), ' EI Q\n')]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tokens that viewers read differently are refused, so a hidden Q cannot pop the state the marks are drawn in', { skip }, async () => {
  const dir = tmp();
  try {
    // around a clip, a "Q" that a plain token counter counts but a viewer does not run, or one a viewer runs that the
    // counter does not see: the clip would then stay in force over the marks in at least one viewer
    for (const [name, streams] of [
      ['operator-in-array', ['0 0 1 1 re W n q [ Q ] 0 d\n']],
      ['operator-in-dictionary', ['0 0 1 1 re W n q /Span << /X Q >> BDC EMC\n']],
      ['number-glued-to-operator', ['1Q 0 0 1 1 re W n\n']],
      ['glued-operators', ['0 0 1 1 re W n qQ\n']],
      ['string-escape-at-a-stream-boundary', ['0 0 1 1 re W n q (\\', ') Q )']],
      ['id-outside-an-image', ['q ID Q\n']],
    ]) await refusedByBoth(dir, name, await makePdf(streams), /stamp refused: page 1 content cannot be read/);
    await refusedByBoth(dir, 'pending-clip', await makePdf(['0 0 1 1 re W']), /stamp refused: page 1 content ends inside a path object/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A viewer saves the graphics state before a Form XObject and restores it after; poppler, PDFium and Chrome also end a
// marked-content sequence left open inside one. A Form XObject the page draws cannot reach the marks with either.
test('a Form XObject drawn by the page cannot carry open optional content or an unbalanced q/Q past its Do', { skip }, async () => {
  const dir = tmp();
  try {
    for (const [name, ops] of [['open-hidden-layer', '/OC /Hidden BDC 0 0 1 rg 100 600 50 50 re f\n'], ['clip-then-open-q', '0 0 1 1 re W n q\n'], ['extra-Q-then-clip', 'Q 0 0 1 1 re W n\n']]) {
      await assertMarksVisible(dir, `form-${name}`, await makePdf(['/Fm Do\n'], (doc, page) => {
        const res = doc.context.obj({}); hiddenLayer(doc, res);
        const form = doc.context.register(doc.context.flateStream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: res }));
        page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm: form }));
      }));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the page draws its checked content as one Form XObject, and tagged content keeps its structure', { skip }, async () => {
  const dir = tmp();
  try {
    const doc = await PDFDocument.create(); const page = doc.addPage([612, 792]); const ctx = doc.context;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.node.Resources().set(PDFName.of('Font'), ctx.obj({ F1: font.ref }));
    page.node.addContentStream(ctx.register(ctx.flateStream('/P <</MCID 0>> BDC BT /F1 18 Tf 40 700 Td (Fictional tagged line) Tj ET EMC\n')));
    page.node.addContentStream(ctx.register(ctx.flateStream('/Span <</MCID 1>> BDC BT /F1 12 Tf 40 650 Td (Second fictional line) Tj ET EMC\n')));
    const [rootRef, docRef, pRef, sRef] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
    ctx.assign(pRef, ctx.obj({ Type: 'StructElem', S: 'P', P: docRef, Pg: page.ref, K: 0 }));
    ctx.assign(sRef, ctx.obj({ Type: 'StructElem', S: 'Span', P: docRef, K: [{ Type: 'MCR', Pg: page.ref, MCID: 1 }] }));
    ctx.assign(docRef, ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: [pRef, sRef] }));
    ctx.assign(rootRef, ctx.obj({ Type: 'StructTreeRoot', K: docRef, ParentTree: { Nums: [0, [pRef, sRef]] }, ParentTreeNextKey: 1 }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef); doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
    page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
    const original = pageContentBytes(doc, page);
    const f = path.join(dir, 'tagged.pdf'); fs.writeFileSync(f, await doc.save()); await finalizePdf(f);

    const out = await PDFDocument.load(fs.readFileSync(f)); const p = out.getPages()[0];
    const pageText = pageContentBytes(out, p).toString('latin1');
    assert.match(pageText, /^\s*q\s+\/PageContent Do\s+Q\s/, 'the page does not start by drawing its content Form XObject');
    assert.ok(!pageText.includes('Fictional tagged line'), 'the original content is still in the page content stream');
    const form = out.context.lookup(p.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('PageContent')));
    assert.equal(Buffer.from(decodePDFRawStream(form).decode()).toString('latin1'), original.toString('latin1'), 'the Form XObject does not hold exactly the checked bytes');
    assert.equal(form.dict.get(PDFName.of('StructParents')).asNumber(), 0); assert.equal(p.node.get(PDFName.of('StructParents')), undefined);
    const struct = execFileSync('pdfinfo', ['-struct-text', f], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(struct, /P \(block\)\s+"Fictional tagged line"/, `structure lost its text: ${struct}`);
    assert.match(struct, /Span \(inline\)\s+"Second fictional line"/, `structure lost its text: ${struct}`);
    assert.match(execFileSync('pdftotext', ['-raw', f, '-'], { encoding: 'utf-8' }), /Fictional tagged line[\s\S]*SYNTHETIC SPECIMEN/);
    // stamping twice stays readable: the stamped page is itself well-formed content
    await finalizePdf(f);
    assert.match(execFileSync('pdfinfo', ['-struct-text', f], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }), /"Fictional tagged line"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
