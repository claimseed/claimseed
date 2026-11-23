// pdf-text.js: the text of a PDF's pages as the watermark's placement reads it (render.js), with pdf.js in Node.
// The text baselines of every page of a PDF (bytes), in the page's own coordinates, read with pdf.js: one list per
// page (empty for a page with no text). `pages` is the page count pdf-lib reads; a PDF pdf.js cannot read, or reads
// with another page count, gives null.
let pdfjsLib = null;
export async function markLines(bytes, pages) {
  try {
    pdfjsLib ||= await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
    try {
      const doc = await task.promise; if (doc.numPages !== pages) return null;
      const out = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const tc = await (await doc.getPage(n)).getTextContent();
        out.push([...new Set(tc.items.filter((i) => typeof i.str === 'string' && i.str.trim()).map((i) => Math.round(i.transform[5] * 2) / 2))].sort((x, y) => x - y));
      }
      return out;
    } finally { await task.destroy(); }
  } catch { return null; }
}
