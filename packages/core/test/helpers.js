// Shared test helpers.
export { watermarkRectsPerPage } from '../scripts/lib/pdf-markers.js';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';

const N = '(-?[\\d.]+)';
const BAND_RECT = new RegExp(`${N} ${N} ${N} rg\\n${N} ${N} ${N} RG\\n[\\d.]+ w\\n\\[\\] 0 d\\n(?:1 0 0 1 -?[\\d.]+ -?[\\d.]+ cm\\n)+0 0 m\\n0 ${N} l\\n${N} -?[\\d.]+ l\\n-?[\\d.]+ 0 l\\nh\\nB\\n`);
const BAND_TEXT = new RegExp(`BT\\n${N} ${N} ${N} rg\\n/\\S+ ${N} Tf\\n`);

// the band on each page, from the stamp's operators: { width, height, fill, ink, size }
export async function bandsOf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const c = page.node.Contents(); const refs = c instanceof PDFArray ? c.asArray() : [c];
    const text = refs.map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1')).join('\n');
    const rect = BAND_RECT.exec(text); const t = BAND_TEXT.exec(text);
    if (!rect || !t) return null;
    return { pageWidth: page.getWidth(), width: Number(rect[8]), height: Number(rect[7]), fill: rect.slice(1, 4).map(Number), ink: t.slice(1, 4).map(Number), size: Number(t[4]) };
  });
}

