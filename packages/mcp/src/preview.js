// Page images of a rendered PDF, so a client can show the document in the chat itself. The stamped PDF (the same
// bytes render_document returns, specimen band and watermark included) is drawn by PDF.js in an isolated page of the
// server's own Chrome (pdf-raster.js in @claimseed/core: a browser context of its own, nothing loaded but PDF.js and
// its fonts from memory, no network, closed after each preview). The only document it ever opens is one this server
// just rendered.
import { withPdfPage, drawPage, markImage } from '@claimseed/core';

// The longer side of a page image, in pixels: a Letter page is 1200 x 927 (about 110 dpi), enough to read every
// line of the smallest print on these documents.
export const LONG_SIDE = 1200;
const MIN_LONG_SIDE = 700;

// Draw pages of `bytes` (a PDF) as images, from page `from` on: that page alone ('first') or every page after it too
// ('all'). Pages are drawn in order until the next one would take the images past `budget` bytes of base64; with
// `forceFirst` (the default) the first one is always drawn, made smaller if it alone would not fit, and at its smallest
// even over the budget. A page is a PNG, or a JPEG when only a JPEG of it still fits. Every image file carries the
// specimen markers (image-markers.js in @claimseed/core); `label` names the document in them.
// Returns { pageCount, images: [{ page, mimeType, data, width, height }] }. `onRequest(url, served)`, for tests, sees
// every request the page makes and whether it was served.
export async function previewPages(browser, bytes, { pages = 'first', from = 1, budget = 800 * 1024, longSide = LONG_SIDE, label = null, onRequest = null, forceFirst = true } = {}) {
  return withPdfPage(browser, bytes, async (page, sizes) => {
    const last = pages === 'all' ? sizes.length : Math.min(from, sizes.length);
    const images = [];
    for (let n = from, used = 0; n <= last; n++) {
      let side = longSide; let d; let img;
      for (;;) {
        d = await draw(page, n, side, label); img = pick(d, budget - used);
        if (img || images.length || !forceFirst || side <= MIN_LONG_SIDE) break;
        side = Math.max(MIN_LONG_SIDE, Math.round(side * 0.8));   // the first page must be shown: draw it smaller
      }
      if (!img) {
        if (images.length || !forceFirst) break;
        img = { mimeType: 'image/jpeg', data: d.jpeg, width: d.width, height: d.height };   // the first page at its smallest, even over the budget
      }
      used += img.data.length; images.push({ page: n, ...img });
    }
    return { pageCount: sizes.length, images };
  }, { onRequest });
}
async function draw(page, n, side, label) {
  const d = await drawPage(page, n, side);
  return { ...d, png: markImage('image/png', d.png, label), jpeg: markImage('image/jpeg', d.jpeg, label) };
}
// the PNG when it fits in `room`, else the JPEG when that fits, else nothing
function pick({ width, height, png, jpeg }, room) {
  if (png.length <= room) return { mimeType: 'image/png', data: png, width, height };
  if (jpeg.length <= room) return { mimeType: 'image/jpeg', data: jpeg, width, height };
  return null;
}
