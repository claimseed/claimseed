// pdf-raster.js — draw the pages of a stamped claimseed PDF as pixels, with PDF.js in a page of the caller's Chrome.
// The page lives in a browser context of its own, loads nothing but PDF.js and its fonts from this package (served
// from memory under an origin that does not exist), cannot reach the network, and is closed when the caller's work
// is done. It runs script, unlike the pages documents are printed from, but the only document it ever opens is the
// PDF handed to it. The MCP server's page images and the degraded copies (degrade.js) are both drawn here.
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));
export const RASTER_ORIGIN = 'https://preview.claimseed.invalid';
const PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

// The page's own script: open the PDF, draw a page at a size, and apply a degradation recipe to the drawn pixels.
// Every random choice comes from the recipe's seed (mulberry32), so the same recipe gives the same pixels on the same
// Chrome build.
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
async function drawCanvas(n, scale) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: 'rgb(255,255,255)', annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  page.cleanup();
  return canvas;
}
const b64 = (u) => u.slice(u.indexOf(',') + 1);
window.claimseedDraw = async (n, longSide) => {
  const page = await doc.getPage(n); const v1 = page.getViewport({ scale: 1 });
  const canvas = await drawCanvas(n, longSide / Math.max(v1.width, v1.height));
  return { width: canvas.width, height: canvas.height, png: b64(canvas.toDataURL('image/png')), jpeg: b64(canvas.toDataURL('image/jpeg', 0.8)) };
};
// a page drawn at a scale and kept on the window, for callers that measure pixels
window.claimseedCanvas = async (n, scale) => { window.claimseedLast = await drawCanvas(n, scale); return { width: window.claimseedLast.width, height: window.claimseedLast.height }; };

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function canvasOf(w, h, fill) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); if (fill) { g.fillStyle = fill; g.fillRect(0, 0, w, h); } return c; }
// a box blur of the given radius, horizontal then vertical, on RGB
function boxBlur(img, r) {
  if (!r) return;
  const { width: w, height: h, data: d } = img; const tmp = new Float32Array(w * h * 3); const n = 2 * r + 1;
  for (let y = 0; y < h; y++) for (let ch = 0; ch < 3; ch++) {
    let s = 0; for (let k = -r; k <= r; k++) s += d[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + ch];
    for (let x = 0; x < w; x++) { tmp[(y * w + x) * 3 + ch] = s / n; s += d[(y * w + Math.min(w - 1, x + r + 1)) * 4 + ch] - d[(y * w + Math.max(0, x - r)) * 4 + ch]; }
  }
  for (let x = 0; x < w; x++) for (let ch = 0; ch < 3; ch++) {
    let s = 0; for (let k = -r; k <= r; k++) s += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + ch];
    for (let y = 0; y < h; y++) { d[(y * w + x) * 4 + ch] = s / n; s += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + ch] - tmp[(Math.max(0, y - r) * w + x) * 3 + ch]; }
  }
}
function rotated(src, deg, dx, dy, fill) {
  const c = canvasOf(src.width, src.height, fill); const g = c.getContext('2d');
  g.translate(src.width / 2 + dx, src.height / 2 + dy); g.rotate((deg * Math.PI) / 180); g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
const RECIPES = {
  // a flatbed scan: off-white paper, a slight turn and shift, softened edges, grain and dust, saved as a JPEG
  scan(src, p, rand) {
    const c = canvasOf(src.width, src.height, 'rgb(' + p.paper.join(',') + ')'); const g = c.getContext('2d');
    g.globalCompositeOperation = 'multiply'; g.drawImage(rotated(src, p.rotate, p.shiftX, p.shiftY, '#ffffff'), 0, 0); g.globalCompositeOperation = 'source-over';
    const img = g.getImageData(0, 0, c.width, c.height); boxBlur(img, p.blur);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const e = (rand() - 0.5) * 2 * p.noise * 255; for (let ch = 0; ch < 3; ch++) d[i + ch] = clamp((d[i + ch] - 128) * p.contrast + 128 + p.brightness + e); }
    g.putImageData(img, 0, 0);
    g.fillStyle = 'rgb(70,66,60)';
    for (let k = 0; k < p.specks; k++) { g.beginPath(); g.arc(rand() * c.width, rand() * c.height, 0.6 + rand() * 2.2, 0, 2 * Math.PI); g.fill(); }
    return { canvas: c, mime: 'image/jpeg', quality: p.quality };
  },
  // a fax: black and white after a threshold, at half the vertical resolution in standard mode, with speckle and
  // streaks from the line, saved as a PNG
  fax(src, p, rand, mark) {
    const c = rotated(src, p.rotate, 0, 0, '#ffffff'); const g = c.getContext('2d');
    const img = g.getImageData(0, 0, c.width, c.height); const d = img.data; const w = c.width, h = c.height;
    const grey = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) grey[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    if (p.standard) for (let y = 0; y + 1 < h; y += 2) for (let x = 0; x < w; x++) { const v = (grey[y * w + x] + grey[(y + 1) * w + x]) / 2; grey[y * w + x] = v; grey[(y + 1) * w + x] = v; }
    for (let i = 0; i < w * h; i++) {
      let v = grey[i] < p.threshold * 255 ? 0 : 255;
      if (rand() < p.speckle) v = 255 - v;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    for (const s of p.streaks) {
      const y0 = Math.round(s.y * h), x0 = Math.round(s.x0 * w), x1 = Math.round(s.x1 * w);
      for (let y = y0; y < Math.min(h, y0 + s.width); y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; }
    }
    // the watermark again, as a pattern of black dots inside its letters: its light tint would not survive the
    // threshold, so a fax prints it the way a fax machine prints a grey area (a fine dot pattern, every other pixel;
    // pairs of rows in standard mode). The cells come in page points, y up, from the stamp's own geometry.
    if (mark) {
      const sx = w / mark.width, sy = h / mark.height;
      const m = canvasOf(w, h); const mg = m.getContext('2d'); mg.fillStyle = '#000';
      for (const q of mark.cells) { mg.beginPath(); q.forEach(([x, y], k) => (k ? mg.lineTo : mg.moveTo).call(mg, x * sx, h - y * sy)); mg.closePath(); mg.fill(); }
      const md = mg.getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (md[i + 3] >= 128 && (x + (p.standard ? y >> 1 : y)) % 2 === 0) d[i] = d[i + 1] = d[i + 2] = 0;
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas: c, mime: 'image/png' };
  },
  // a phone photo of the page on a table: margins of table around it, the far edge narrower than the near one, a
  // slight turn, uneven light, softness and grain, saved as a JPEG
  photo(src, p, rand) {
    // each output pixel is looked up in the page through the inverse of the turn and the keystone (bilinear), so the
    // narrowing far edge leaves no seams; outside the sheet is the table
    const sw = src.width, sh = src.height; const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const mx = Math.round(sw * p.margin), my = Math.round(sh * p.margin); const W = sw + 2 * mx, H = sh + 2 * my;
    const c = canvasOf(W, H); const g = c.getContext('2d'); const out = g.createImageData(W, H); const od = out.data;
    const a = (p.rotate * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - W / 2, dy = y - H / 2;
      const qx = sw / 2 + dx * cos + dy * sin, v = sh / 2 - dx * sin + dy * cos;
      const s = 1 - p.keystone * (1 - v / sh); const u = sw / 2 + (qx - sw / 2) / s;
      const o = (y * W + x) * 4;
      // uneven light: darker towards one side, and towards the corners
      const t = Math.max(0, Math.min(1, 0.5 + ((x / W - 0.5) * Math.cos(p.lightAngle) + (y / H - 0.5) * Math.sin(p.lightAngle))));
      const rr = Math.min(1, Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2)) / Math.SQRT2);
      const light = (1 - p.shade * t) * (1 - p.vignette * Math.max(0, (rr - 0.45) / 0.55) ** 2);
      if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) { od[o] = p.table[0] * light; od[o + 1] = p.table[1] * light; od[o + 2] = p.table[2] * light; od[o + 3] = 255; continue; }
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      for (let ch = 0; ch < 3; ch++) {
        const i00 = (y0 * sw + x0) * 4 + ch, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        od[o + ch] = ((sd[i00] * (1 - fx) + sd[i10] * fx) * (1 - fy) + (sd[i01] * (1 - fx) + sd[i11] * fx) * fy) * light;
      }
      od[o + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height); boxBlur(img, p.blur);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const e = (rand() - 0.5) * 2 * p.noise * 255; for (let ch = 0; ch < 3; ch++) d[i + ch] = clamp(d[i + ch] + e); }
    g.putImageData(img, 0, 0);
    return { canvas: c, mime: 'image/jpeg', quality: p.quality };
  },
  // a low-resolution copy: drawn at a low resolution and saved as a heavily compressed JPEG
  'low-res'(src, p) { return { canvas: src, mime: 'image/jpeg', quality: p.quality }; },
};
window.claimseedDegrade = async (n, preset, p, mark) => {
  const src = await drawCanvas(n, p.dpi / 72);
  const out = RECIPES[preset](src, p, rng(p.seed + n * 7919), mark);
  const url = out.canvas.toDataURL(out.mime, out.quality);
  return { width: out.canvas.width, height: out.canvas.height, mime: out.mime, data: b64(url) };
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

// Open `bytes` (a PDF) in a fresh isolated page and call fn(page, sizes), where sizes holds each page's [width,
// height] in points; the browser context is closed afterwards whatever happens. `onRequest(url, served)`, for tests,
// sees every request the page makes and whether it was served.
export async function withPdfPage(browser, bytes, fn, { onRequest = null } = {}) {
  const files = loadAssets();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      let u; try { u = new URL(req.url()); } catch { u = null; }
      const hit = u && u.origin === RASTER_ORIGIN && req.method() === 'GET' && (u.pathname === '/document.pdf' ? { type: 'application/pdf', body: bytes } : files.get(u.pathname));
      onRequest?.(req.url(), !!hit);
      if (hit) req.respond({ status: 200, contentType: hit.type, body: hit.body, headers: { 'Cache-Control': 'no-store' } }).catch(() => {});
      else req.abort('blockedbyclient').catch(() => {});
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(`${RASTER_ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction('window.claimseedReady === true', { timeout: 10000 });
    const sizes = await page.evaluate('window.claimseedOpen()');
    return await fn(page, sizes);
  } finally { await context.close().catch(() => {}); }
}
// Page n (from 1) at `longSide` pixels on its longer side: { width, height, png, jpeg } (base64), no file markers.
export function drawPage(page, n, longSide) { return page.evaluate((a, b) => window.claimseedDraw(a, b), n, longSide); }
// Page n degraded by a recipe: { width, height, mime, data } (base64).
// `mark` (the fax only): { width, height, cells } of the page in points, from watermarkCells, for the dot-pattern watermark
export function degradePage(page, n, preset, params, mark = null) { return page.evaluate((a, b, c, d) => window.claimseedDegrade(a, b, c, d), n, preset, params, mark); }
