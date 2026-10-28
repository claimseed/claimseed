// pdf-markers.js — structural check for the stamped watermark, shared by the test suite and scan-rendered.js.
import fs from 'fs';
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { WATERMARK_COLOR } from '../../src/render.js';

// The watermark is drawn as filled rectangles in a fixed colour (no text, so it cannot pollute text extraction).
// Returns, per page, the number of filled paths drawn after the watermark colour is first set — a structural
// proof the watermark is on that page. The band is checked separately through pdftotext.
export async function watermarkRectsPerPage(pdfPath) {
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath), { updateMetadata: false });
  const c = WATERMARK_COLOR; const colorOp = `${c.red} ${c.green} ${c.blue} rg`;
  return doc.getPages().map((page) => {
    const contents = page.node.Contents(); let streams = [];
    if (contents instanceof PDFArray) streams = contents.asArray().map((r) => doc.context.lookup(r)); else if (contents) streams = [contents];
    const text = streams.map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '')).join('\n');
    const i = text.indexOf(colorOp); if (i < 0) return 0;
    return (text.slice(i).match(/\nh\nf\n/g) || []).length;
  });
}
