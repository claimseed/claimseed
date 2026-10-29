// Page images of a rendered PDF, so a client can show the document in the chat itself. The stamped PDF (the same
// bytes render_document returns, specimen band and watermark included) is drawn by pdf.js in a page of the server's
// own Chrome. That page lives in a browser context of its own, loads nothing but pdf.js and its fonts from this
// package (served from memory under an origin that does not exist), cannot reach the network, and is closed after
// each preview. It runs script, unlike the pages documents are printed from, but the only document it ever opens is
// one this server just rendered.
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
import { markImage } from './image-markers.js';

const require = createRequire(import.meta.url);
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));
const ORIGIN = 'https://preview.claimseed.invalid';
const PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

// The longer side of a page image, in pixels: a Letter page is 1200 x 927 (about 110 dpi), enough to read every
// line of the smallest print on these documents.
export const LONG_SIDE = 1200;
const MIN_LONG_SIDE = 700;

const MAIN = `import * as pdfjs from '/pdf.min.mjs';
import { WorkerMessageHandler } from '/pdf.worker.min.mjs';
globalThis.pdfjsWorker = { WorkerMessageHandler };   // pdf.js runs on this page's own thread: no worker to load
let doc = null;
window.claimseedOpen = async () => {
  const data = new Uint8Array(await (await fetch('/document.pdf')).arrayBuffer());
  doc = await pdfjs.getDocument({ data, standardFontDataUrl: '/standard_fonts/', useSystemFonts: false, isEvalSupported: false,
    enableXfa: false, stopAtErrors: true, disableAutoFetch: true, disableStream: true }).promise;
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n++) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); sizes.push([v.width, v.height]); }
  return sizes;
};
window.claimseedDraw = async (n, longSide) => {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: longSide / Math.max(v1.width, v1.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: 'rgb(255,255,255)', annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  const b64 = (u) => u.slice(u.indexOf(',') + 1);
  const out = { width: canvas.width, height: canvas.height, png: b64(canvas.toDataURL('image/png')), jpeg: b64(canvas.toDataURL('image/jpeg', 0.8)) };
  page.cleanup();
  return out;
};
window.claimseedReady = true;
`;
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><link rel="icon" href="data:,"></head><body><script type="module" src="/main.mjs"></script></body></html>`;

let assets = null;
function loadAssets() {
  if (assets) return assets;
  const a = new Map([
    ['/', { type: 'text/html; charset=utf-8', body: Buffer.from(HTML) }],
    ['/main.mjs', { type: 'text/javascript', body: Buffer.from(MAIN) }],
    ['/pdf.min.mjs', { type: 'text/javascript', body: fs.readFileSync(path.join(PDFJS, 'build/pdf.min.mjs')) }],
    ['/pdf.worker.min.mjs', { type: 'text/javascript', body: fs.readFileSync(path.join(PDFJS, 'build/pdf.worker.min.mjs')) }],
  ]);
  for (const f of fs.readdirSync(path.join(PDFJS, 'standard_fonts'))) {
    if (/\.(pfb|ttf)$/.test(f)) a.set(`/standard_fonts/${f}`, { type: 'application/octet-stream', body: fs.readFileSync(path.join(PDFJS, 'standard_fonts', f)) });
  }
  return (assets = a);
}

// Draw pages of `bytes` (a PDF) as images, from page `from` on: that page alone ('first') or every page after it too
// ('all'). Pages are drawn in order until the next one would take the images past `budget` bytes of base64; with
// `forceFirst` (the default) the first one is always drawn, made smaller if it alone would not fit, and at its smallest
// even over the budget. A page is a PNG, or a JPEG when only a JPEG of
// it still fits. Every image file carries the specimen markers (image-markers.js); `label` names the document in them.
// Returns { pageCount, images: [{ page, mimeType, data, width, height }] }. `onRequest(url, served)`, for tests, sees
// every request the page makes and whether it was served.
export async function previewPages(browser, bytes, { pages = 'first', from = 1, budget = 800 * 1024, longSide = LONG_SIDE, label = null, onRequest = null, forceFirst = true } = {}) {
  const files = loadAssets();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      let u; try { u = new URL(req.url()); } catch { u = null; }
      const hit = u && u.origin === ORIGIN && req.method() === 'GET' && (u.pathname === '/document.pdf' ? { type: 'application/pdf', body: bytes } : files.get(u.pathname));
      onRequest?.(req.url(), !!hit);
      if (hit) req.respond({ status: 200, contentType: hit.type, body: hit.body, headers: { 'Cache-Control': 'no-store' } }).catch(() => {});
      else req.abort('blockedbyclient').catch(() => {});
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.claimseedReady === true', { timeout: 10000 });
    const sizes = await page.evaluate('window.claimseedOpen()');
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
  } finally { await context.close().catch(() => {}); }
}
async function draw(page, n, side, label) {
  const d = await page.evaluate((a, b) => window.claimseedDraw(a, b), n, side);
  return { ...d, png: markImage('image/png', d.png, label), jpeg: markImage('image/jpeg', d.jpeg, label) };
}
// the PNG when it fits in `room`, else the JPEG when that fits, else nothing
function pick({ width, height, png, jpeg }, room) {
  if (png.length <= room) return { mimeType: 'image/png', data: png, width, height };
  if (jpeg.length <= room) return { mimeType: 'image/jpeg', data: jpeg, width, height };
  return null;
}
