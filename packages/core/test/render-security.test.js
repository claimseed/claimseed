// Renders a scenario whose caller-supplied note text is a hostile payload and asserts none of it executes,
// escapes, or reaches the page as markup. Requires Chrome (CLAIMSEED_CHROME); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { generateData } from '../src/generate/index.js';
import { findChrome, launchBrowser } from '../src/browser.js';
import { watermarkRectsPerPage } from './helpers.js';

const payload = `<iframe src="file:///etc/passwd"></iframe><script>document.title='JS-RAN'</script><img src="http://127.0.0.1:9/beacon"><style>body{display:none}</style>&lt;b&gt;x`;

test('hostile data cannot read files, run script, or inject markup', { skip: !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI' }, async () => {
  const { data } = generateData({ type: 'msn', scenario: 'denied-not-reasonable-necessary', seed: 'sec-1',
    overrides: { mutations: [{ op: 'deny-line', args: { claim: 0, line: 0, note: { text: payload, rule: 'test' } } }] } });
  const render = await import('../src/render.js');
  const stock = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, 'msn', 'stock-content.json'), 'utf-8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sec-'));
  const pdf = await render.renderMsn(data, stock, work);
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf-8' });
  assert.ok(!text.includes('root:x:0:0'), 'local file content leaked into the PDF');
  assert.ok(text.includes("document.title"), 'payload should be visible as inert escaped text');
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' });
  assert.ok(!/Title:.*JS-RAN/.test(info), 'script executed');
  assert.ok(text.includes('Medicare Summary Notice') || text.includes('MEDICARE'), 'page body hidden — CSS injection succeeded');
  fs.rmSync(work, { recursive: true, force: true });
});

// Direct renderer probes: hostile markup handed straight to renderHtmlToPdf (as if a template had marked it
// `| safe`). Nothing may reach the network — not even link prefetch/prerender hints — and a meta refresh must
// not blank the page or drop the specimen band.
test('renderHtmlToPdf: no network reachability, no file reads, band survives hostile markup', { skip: !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI' }, async () => {
  const http = await import('http');
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('x'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; const base = `http://127.0.0.1:${port}`;
  const render = await import('../src/render.js');
  const { launchBrowser } = await import('../src/browser.js');
  const vectors = [
    `<link rel="prefetch" href="${base}/prefetch">`, `<link rel="prerender" href="${base}/prerender">`, `<link rel="preload" as="image" href="${base}/preload">`,
    `<link rel="dns-prefetch" href="${base}">`, `<link rel="preconnect" href="${base}">`, `<link rel="stylesheet" href="${base}/css">`,
    `<meta http-equiv="refresh" content="0;url=${base}/refresh">`, `<iframe src="${base}/frame"></iframe>`, `<iframe src="file:///etc/passwd"></iframe>`,
    `<img src="${base}/img">`, `<object data="${base}/obj"></object>`, `<embed src="${base}/embed">`, `<video poster="${base}/poster"></video>`,
    `<style>@import url(${base}/import); body{background:url(${base}/bg)} @font-face{font-family:x;src:url(${base}/font)}</style>`,
    `<svg><use href="${base}/use#x"/><image href="${base}/svgimg"/></svg>`, `<script src="${base}/js"></script><script>document.title='JS-RAN'</script>`,
    `<base href="${base}/">`, `<a ping="${base}/ping" href="#">p</a>`, `<form action="${base}/form"><input type=submit></form>`,
  ];
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${vectors.slice(0, 7).join('')}</head><body>${vectors.slice(7).join('')}
    <div style="font:12pt sans-serif">BODY-MARKER root</div></body></html>`;
  const browser = await launchBrowser();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sec2-'));
  const pdf = path.join(work, 'probe.pdf');
  try { await render.renderHtmlToPdf(browser, html, pdf, { band: 'probe' }); } finally { await browser.close(); }   // the public single-document path stamps on its own
  await new Promise((r) => setTimeout(r, 300));
  server.close();
  assert.deepEqual(hits, [], `renderer reached the network: ${hits.join(', ')}`);
  const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, '');
  assert.ok(text.includes('MARKER'), 'page body missing (meta refresh or CSS blanked the page)');
  assert.ok(text.includes('SYNTHETICSPECIMEN'), 'specimen band missing');
  assert.ok(!text.includes('root:x:0:0'), 'local file content leaked into the PDF');
  assert.ok(!/Title:.*JS-RAN/.test(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' })), 'script executed');
  fs.rmSync(work, { recursive: true, force: true });
});

test('hardenHtml strips every refresh/base form and data cannot steer output paths', async () => {
  const { hardenHtml, renderMsn } = await import('../src/render.js');
  for (const v of ['<meta http-equiv="refresh" content="0;url=http://x/">', '<meta/http-equiv="refresh" content="0;url=http://x/">', '<META HTTP-EQUIV = "Refresh" CONTENT="0">',
    '<meta http-equiv="&#114;efresh" content="0">', '<meta http-equiv="&amp;#114;efresh" content="0">', '<meta\n\thttp-equiv=refresh content=0>', '<base href="http://x/">', '<BASE/href="http://x/">',
    '<meta foo=">" http-equiv="refresh" content="0;url=about:blank">', '<meta http-equiv="&#114efresh" content="0">', "<meta foo='>' http-equiv=refresh content=0>", '<meta http-equiv="re\u0000fresh" content="0">', '<meta http-equiv="&#x72;&#x65;fresh">',
    '<meta a"b=">" http-equiv=refresh content="0">', "<meta a'b='>' http-equiv=refresh content=0>", '<meta =">" http-equiv=refresh>']) {
    const out = hardenHtml(`<html><head>${v}</head><body>x</body></html>`);
    assert.ok(!/refresh|<\s*base/i.test(out), `not stripped: ${v}`);
  }
  assert.match(hardenHtml('<html><head></head><body>x</body></html>'), /Content-Security-Policy/);
  assert.match(hardenHtml('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>x</body></html>'), /charset="utf-8"[\s\S]*viewport/, 'harmless meta tags must survive');
  if (findChrome() || process.env.CI) {
    const { generateData } = await import('../src/generate/index.js');
    const { data } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'trav-1' });
    data.scenario = '/../../escaped'; data.carrier = '../../x';
    const stock = JSON.parse(fs.readFileSync(path.join((await import('../src/render.js')).DATA_DIR, 'msn', 'stock-content.json'), 'utf-8'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-trav-'));
    const pdf = await renderMsn(data, stock, work);
    assert.equal(path.dirname(path.resolve(pdf)), path.resolve(work), 'renderer wrote outside the work dir');
    assert.deepEqual(fs.readdirSync(work), ['msn.pdf'], 'unexpected files in the work dir (debug output?)');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// Hostile data keys that collide with renderer globals (fontFaces, stock) or carry CSS must not remove or alter
// the stamped markers: the band and watermark are drawn by mergePdfs (pdf-lib), not by the HTML. The render
// function is called the way a library consumer would, with no CLI and no finalizePdf, so this also proves the
// library path is stamped.
test('data cannot shadow renderer globals or strip the specimen markers', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { generateData } = await import('../src/generate/index.js');
  const render = await import('../src/render.js');
  const { RENDERERS } = await import('../src/layouts.js');
  const css = "400; } .specimen-band,.specimen-watermark,.specimen-badge,body{display:none!important} x{a:b";
  for (const type of ['msn', 'ppo-eob']) {
    const { listScenarios } = await import('../src/generate/index.js');
    const { data } = generateData({ type, scenario: listScenarios(type)[0], seed: 'shadow-1' });
    data.fontFaces = [{ family: 'Inter', weight: css, dataUri: 'data:font/woff2;base64,AAAA' }];
    data.specimenBand = ''; data.specimenBandText = '<script>x</script>'; data.stock = { colors: {}, fonts: {} };
    const stock = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, type, 'stock-content.json'), 'utf-8'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shadow-'));
    const pdf = await RENDERERS[type](data, stock, work);
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))[1]);
    const rects = await watermarkRectsPerPage(pdf);
    for (let p = 1; p <= pages; p++) {
      const t = execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, '');
      assert.ok(t.includes('SYNTHETICSPECIMEN'), `${type} page ${p}: band missing under hostile data`);
      assert.ok(rects[p - 1] >= 100, `${type} page ${p}: watermark missing under hostile data`);
    }
    const t1 = execFileSync('pdftotext', ['-f', '1', '-l', '1', pdf, '-'], { encoding: 'utf-8' });
    assert.ok(/MEDICARE|Explanation of Benefits|SPECIMEN/i.test(t1), `${type}: page body hidden by injected CSS`);
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// The navigation sentinel is the second layer behind hardenHtml: hand the print step a refresh tag the stripper
// never saw and the render must be refused, never a blank page. Sub-second delays and about:blank targets included.
// The property is the refusal and the absence of output, whichever Puppeteer call the navigation interrupted, so each
// vector runs several times (the phase it lands in varies with machine load), and a document is also replaced on
// purpose right before each step of the print path: the sentinel check, the measurement, the print and the check
// after it.
test('navigation sentinel refuses a render whose document was replaced', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const render = await import('../src/render.js'); const { printPage, asRefusal } = await import('../src/print.js');
  const browser = await launchBrowser();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sentinel-'));
  const refusedWithoutOutput = async (promise, out, what) => {
    await assert.rejects(promise, (e) => { assert.match(e.message, /^render refused/, `${what}: ${e.stack}`); return true; });
    assert.ok(!fs.existsSync(out), `${what}: a PDF was written`);
  };
  try {
    let k = 0;
    for (let round = 0; round < 4; round++) for (const v of ['<meta http-equiv="refresh" content="0">', '<meta http-equiv="refresh" content="0;url=about:blank">', '<meta http-equiv="refresh" content="0.5;url=about:blank#x">', '<meta http-equiv="refresh" content="0.05">', '<meta http-equiv="refresh" content="0.1">']) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${v}</head><body><div>MARKER</div></body></html>`;
      const out = path.join(work, `x${k++}.pdf`);
      await refusedWithoutOutput(printPage(browser, html, out), out, `round ${round}: ${v}`);
    }
    // a browser whose pages reload their document right before the nth call of one page method
    const reloading = (method, nth) => ({ newPage: async () => {
      const page = await browser.newPage(); let calls = 0;
      return new Proxy(page, { get(t, key) { const v = Reflect.get(t, key, t); if (key === method) return async (...a) => { if (++calls === nth) await t.evaluate(() => { location.reload(); }).catch(() => {}); return v.apply(t, a); }; return typeof v === 'function' ? v.bind(t) : v; } });
    } });
    const plain = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div>MARKER</div></body></html>';
    for (let round = 0; round < 2; round++) for (const [method, nth, phase] of [['evaluateHandle', 1, 'while fonts load'], ['evaluate', 1, 'at the sentinel check'], ['evaluate', 2, 'during measurement (content capture)'], ['pdf', 1, 'right before printing'], ['evaluate', 3, 'after printing']]) {
      const out = path.join(work, `p${k++}.pdf`);
      await refusedWithoutOutput(printPage(reloading(method, nth), plain, out), out, `document replaced ${phase}`);
    }
    // the Puppeteer errors a navigation produces are the documented refusal at this boundary; others pass through
    for (const m of ['Execution context was destroyed, most likely because of a navigation.', 'Navigating frame was detached', 'Protocol error (Runtime.callFunctionOn): Target closed', 'Protocol error: Session closed. Most likely the page has been closed.', 'Execution context is not available in detached frame "about:blank"'])
      assert.match(asRefusal(new Error(m)).message, /^render refused: the document navigated/, m);
    assert.equal(asRefusal(new Error('boom')).message, 'boom');
    // and the same HTML through the public entry point renders fine because the stripper removes the tag
    const ok = path.join(work, 'ok.pdf');
    await render.renderHtmlToPdf(browser, '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0"></head><body><div>MARKER</div></body></html>', ok);
    assert.match(execFileSync('pdftotext', ['-raw', ok, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ''), /M?ARKER/);
  } finally { await browser.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

// Library callers must never be able to obtain an unstamped PDF, not even from the debris of a failed render: page
// PDFs live in a private temp dir that is removed in `finally`, and a band string outside WinAnsi is sanitised instead
// of throwing after pages were rendered.
test('render functions leave no partial PDFs behind and tolerate a non-Latin band', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { RENDERERS } = await import('../src/layouts.js');
  const render = await import('../src/render.js');
  const stock = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, 'hmo-eob', 'stock-content.json'), 'utf-8'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-partials-'));
  const { data } = generateData({ type: 'hmo-eob', scenario: 'baseline-clean', seed: 'band-1' });
  const pdf = await RENDERERS['hmo-eob'](data, stock, out, { band: 'batch \u2713 nightly \u4e2d' });
  assert.deepEqual(fs.readdirSync(out), ['hmo-eob.pdf'], 'only the finished PDF may be written to the caller directory');
  assert.match(execFileSync('pdftotext', ['-raw', '-l', '1', pdf, '-'], { encoding: 'utf-8' }), /batch \? nightly \?/);
  // a render that fails half-way (a throwing getter in the data) leaves nothing in the caller directory
  const bad = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'band-2' }).data;
  Object.defineProperty(bad.metadata, 'appealDeadline', { get() { throw new Error('boom'); }, enumerable: true });
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-partials-'));
  const msnStock = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, 'msn', 'stock-content.json'), 'utf-8'));
  await assert.rejects(RENDERERS.msn(bad, msnStock, out2), /boom/);
  assert.deepEqual(fs.readdirSync(out2), [], 'a failed render left files in the caller directory');
  fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(out2, { recursive: true, force: true });
});

// Fixed-height pages must never clip silently: data that does not fit a page box is refused, so the ground truth can
// never describe text that is absent from the PDF.
test('render refuses data that overflows a page box instead of clipping it', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { RENDERERS } = await import('../src/layouts.js');
  const render = await import('../src/render.js');
  const { data } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'overflow-1' });
  data.notes[0].text = 'This note goes on and on without end so that it cannot fit on the page. '.repeat(120) + 'ENDMARKER';
  const stock = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, 'msn', 'stock-content.json'), 'utf-8'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-overflow-'));
  await assert.rejects(RENDERERS.msn(data, stock, out), /overflows its page box/);
  assert.deepEqual(fs.readdirSync(out), []);
  // an unbreakable token in a fixed-layout table cell overprints the neighbouring columns and runs off the page edge
  // while every element rectangle stays in bounds: the text itself is measured, so this is refused too
  for (const [type, mutate] of [['msn', (d) => { d.claims[0].lineItems[0].description = 'Q'.repeat(260) + 'ENDMARKER'; }], ['msn', (d) => { d.claims[0].providerName = 'Q'.repeat(260) + 'ENDMARKER'; }], ['ppo-eob', (d) => { d.claims[0].lineItems[0].description = 'Q'.repeat(260) + 'ENDMARKER'; }], ['hmo-eob', (d) => { d.claims[0].lineItems[0].description = 'Q'.repeat(260) + 'ENDMARKER'; }]]) {
    const g = generateData({ type, scenario: 'baseline-clean', seed: 'overflow-2' }); mutate(g.data);
    const st = JSON.parse(fs.readFileSync(path.join(render.DATA_DIR, type, 'stock-content.json'), 'utf-8'));
    await assert.rejects(RENDERERS[type](g.data, st, out), /overflows its page box/, `${type}: unbreakable token not refused`);
    assert.deepEqual(fs.readdirSync(out), []);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

// The page size is the renderer's, never the document's: a caller's @page rule cannot shrink the page under the band.
// The page box is the renderer's own as well: a document @page rule that would print on another box (a size other
// than the paper, a margin, a page-margin box) is refused, wherever the rule is nested, because the fit check measured
// the paper; the templates' own rule (the paper's size, zero margins) is accepted.
test('renderHtmlToPdf prints on its own page box: a document @page size or margin is refused', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { renderHtmlToPdf, launchBrowser } = await import('../src/index.js');
  const browser = await launchBrowser(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pagesize-'));
  try {
    const { execFileSync } = await import('child_process');
    const body = '<body><div class="page">tiny</div></body>';
    for (const rule of ['@page { size: 2in 2in; margin: 0 }', '@page { margin: 3in }', '@page { size: A4 }', '@page { size: landscape }', '@media print { @supports (display: block) { @layer x { @page :first { margin-top: 1in } } } }', '@page wide { size: 11in 8.5in } .page { page: wide }', '@page { margin: 0; @top-center { content: "PRINTED IN THE MARGIN" } }']) {
      const f = path.join(out, 'refused.pdf');
      await assert.rejects(renderHtmlToPdf(browser, `<html><head><style>${rule}</style></head>${body}</html>`, f), /render refused: the document sets its own print page box/, `not refused: ${rule}`);
      assert.ok(!fs.existsSync(f), `a PDF was written for ${rule}`);
    }
    for (const rule of ['@page { size: 8.5in 11in; margin: 0 }', '@page { size: letter portrait; margin: 0mm } @page :first { margin: 0 }']) {
      const pdf = await renderHtmlToPdf(browser, `<html><head><style>${rule}</style></head>${body}</html>`, path.join(out, 'tiny.pdf'));
      assert.match(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }), /Page size:\s+612 x 792 pts/);
    }
    // text that runs into a positioned running footer is refused, not printed under it
    const crowded = '<html><head><style>body { margin: 0; } .page { position: relative; width: 8.5in; height: 11in; } .ft { position: absolute; left: 0.5in; right: 0.5in; bottom: 0.3in; border-top: 1px solid #000; }</style></head><body><div class="page"><p style="position: absolute; top: 10.5in; left: 0.5in; margin: 0; font-size: 14pt;">This closing note is long enough to reach the footer line.</p><div class="ft">Footer text</div></div></body></html>';
    await assert.rejects(renderHtmlToPdf(browser, crowded, path.join(out, 'crowded.pdf')), /runs into a positioned/);
    // a caller's own small page through finalizePdf still carries the whole fixed band text (shrunk to fit, suffix dropped);
    // a page under 3 in is refused; an offset MediaBox, a CropBox and annotations do not move or hide the markers
    const { PDFDocument, rgb } = await import('pdf-lib'); const { finalizePdf } = await import('../src/index.js');
    const small = await PDFDocument.create(); small.addPage([240, 240]); const sp = path.join(out, 'small.pdf'); fs.writeFileSync(sp, await small.save());
    await finalizePdf(sp, { band: 'a long suffix that cannot fit on a page this narrow at all' });
    const text = execFileSync('pdftotext', ['-raw', sp, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ');
    assert.match(text, /SYNTHETIC SPECIMEN - generated by claimseed for software testing - not a real document/, `band not whole on a small page: ${text}`);
    const tiny = await PDFDocument.create(); tiny.addPage([144, 144]); const tp = path.join(out, 'tiny.pdf'); fs.writeFileSync(tp, await tiny.save());
    await assert.rejects(finalizePdf(tp, {}), /stamp refused/);
    const off = await PDFDocument.create(); const pg = off.addPage([612, 792]); pg.setMediaBox(2000, 2000, 612, 792);
    pg.drawRectangle({ x: 2000, y: 2000, width: 612, height: 40, color: rgb(1, 1, 1) });
    const op = path.join(out, 'offset.pdf'); fs.writeFileSync(op, await off.save());
    await finalizePdf(op, {});
    const otext = execFileSync('pdftotext', ['-raw', op, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ');
    assert.match(otext, /SYNTHETIC SPECIMEN/, `band missing on an offset MediaBox: ${otext}`);
    const { watermarkRectsPerPage } = await import('./helpers.js'); assert.ok((await watermarkRectsPerPage(op))[0] >= 100, 'watermark missing on an offset MediaBox');
    // a CropBox reaching outside the MediaBox: the markers go inside the visible intersection (pdftotext -cropbox reads
    // only what a viewer shows); an intersection under 3 in is refused, whatever the nominal CropBox size
    const crop = await PDFDocument.create(); const cp0 = crop.addPage([612, 792]); cp0.setCropBox(-300, -300, 612, 792);
    const ccp = path.join(out, 'crop.pdf'); fs.writeFileSync(ccp, await crop.save()); await finalizePdf(ccp, {});
    const ctext = execFileSync('pdftotext', ['-cropbox', '-raw', ccp, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' ');
    assert.match(ctext, /SYNTHETIC SPECIMEN/, `band outside the visible page: ${ctext}`);
    const crop2 = await PDFDocument.create(); const cq = crop2.addPage([612, 792]); cq.setCropBox(500, 700, 612, 792);
    const cqp = path.join(out, 'crop2.pdf'); fs.writeFileSync(cqp, await crop2.save());
    await assert.rejects(finalizePdf(cqp, {}), /stamp refused/);
  } finally { await browser.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

// The markers must be VISIBLE, not merely present: a caller's page whose content leaves the graphics state unbalanced
// (an extra Q pops the wrapper pdf-lib puts around it, so a clip set afterwards covers the markers; an unclosed q keeps
// its clip past the wrapper) is refused by both public stamping routes, and the band of an ordinary page is checked on
// a raster of the page, not only in its text layer. The fit check measures the print layout: a rule under @media print
// that clips a block, or a clipping block in a document without .page elements, is refused.
test('markers stay visible: unbalanced page content refused, band seen on a raster; print-only clipping refused', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { PDFDocument, PDFName, PDFString, rgb } = await import('pdf-lib'); const { finalizePdf, mergePdfs, renderHtmlToPdf } = await import('../src/index.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-visible-'));
  try {
    const make = async (extra) => {
      const doc = await PDFDocument.create(); const p = doc.addPage([612, 792]); p.drawText('Ordinary page', { x: 40, y: 700, size: 16, color: rgb(0, 0, 0) });
      if (extra) p.node.addContentStream(doc.context.register(doc.context.flateStream(extra)));
      return doc.save();
    };
    for (const [what, ops] of [['an extra Q before a clip', 'Q 0 0 1 1 re W n'], ['an unclosed q with a clip', 'q 0 0 1 1 re W n'], ['an extra Q inside a later stream', '0 0 1 1 re W n Q Q']]) {
      const f = path.join(out, 'bad.pdf'); fs.writeFileSync(f, await make(ops));
      await assert.rejects(finalizePdf(f, {}), /stamp refused/, `finalizePdf accepted ${what}`);
      await assert.rejects(mergePdfs([f], path.join(out, 'bad-merged.pdf'), {}), /stamp refused/, `mergePdfs accepted ${what}`);
    }
    // document and page actions are dropped: nothing runs when the stamped document opens
    const act = await PDFDocument.create(); act.addPage([612, 792]);
    act.catalog.set(PDFName.of('OpenAction'), act.context.obj({ S: 'JavaScript', JS: PDFString.of('void 0') }));
    act.getPages()[0].node.set(PDFName.of('AA'), act.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('void 0') } }));
    const ap = path.join(out, 'actions.pdf'); fs.writeFileSync(ap, await act.save()); await finalizePdf(ap, {});
    const stamped = await PDFDocument.load(fs.readFileSync(ap));
    assert.equal(stamped.catalog.get(PDFName.of('OpenAction')), undefined, 'OpenAction kept'); assert.equal(stamped.getPages()[0].node.get(PDFName.of('AA')), undefined, 'page action kept');
    // balanced content with its own clip, a string and a comment holding "Q", and an inline image whose one data byte is "Q" are accepted
    const okp = path.join(out, 'ok.pdf'); fs.writeFileSync(okp, await make('q 0 0 1 1 re W n /Span <</ActualText (a Q in a string)>> BDC EMC % a Q in a comment\nQ q 1 0 0 1 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID Q EI Q'));
    await finalizePdf(okp, {});
    execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-singlefile', okp, path.join(out, 'ok')]);
    const ppm = fs.readFileSync(path.join(out, 'ok.ppm')); const hdr = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 40)); assert.ok(hdr, 'unexpected raster format');
    const W = +hdr[1], H = +hdr[2], off = hdr[0].length; const px = (x, y) => [...ppm.subarray(off + (y * W + x) * 3, off + (y * W + x) * 3 + 3)];
    const band = px(2, H - 5); assert.ok(band.every((v, i) => Math.abs(v - [251, 243, 234][i]) <= 6), `band not visible on the raster: ${band}`);
    // fit measured on the print layout, and for a document without .page elements
    const { launchBrowser } = await import('../src/browser.js'); const browser = await launchBrowser();
    try {
      await assert.rejects(renderHtmlToPdf(browser, '<style>.page{width:816px;height:1056px}.probe{height:100px}@media print{.probe{height:8px;overflow:hidden}}</style><div class="page"><div class="probe">FIRST LINE<br>SECOND LINE MUST REMAIN VISIBLE</div></div>', path.join(out, 'pc.pdf')), /render refused/);
      await assert.rejects(renderHtmlToPdf(browser, '<div style="height:8px;overflow:hidden">FIRST LINE<br>SECOND LINE MUST REMAIN VISIBLE</div>', path.join(out, 'np.pdf')), /render refused/);
      await renderHtmlToPdf(browser, '<p>A short note that fits.</p>', path.join(out, 'fits.pdf'));
    } finally { await browser.close(); }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// The fit check measures the area that actually prints: what a print-only margin, zoom, a clip or mask, a transform
// or a shadow root would cut, move or hide is refused, and so is text that would not print visibly (no layout box,
// visibility hidden, transparent, faded to under 5 % opacity, too small to read). Nothing is written for a refused
// document; ordinary documents (including a rotated or half-transparent line) still print.
test('fit check: print-only margins, zoom, clipping, transforms and invisible text are refused', { skip: !findChrome() && !process.env.CI && 'no Chrome' }, async () => {
  const { renderHtmlToPdf, launchBrowser } = await import('../src/index.js');
  const browser = await launchBrowser(); const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-printarea-'));
  const T = 'LEFT WORDS MUST REMAIN VISIBLE AND RIGHT WORDS MUST REMAIN VISIBLE';
  const page = (style, inner = `<p>${T}</p>`, css = '') => `<style>body, p { margin: 0 } .page { width: 816px; height: 1056px; box-sizing: border-box } ${css}</style><div class="page" style="${style}">${inner}</div>`;
  const refused = {
    'print margin': [page('', undefined, '@page { margin: 3in }'), /own print page box/],
    'zoom on the page': [page('zoom: 4'), /zoomed/],
    'zoom on the root': [page('', undefined, 'html { zoom: 0.5 }'), /zoomed/],
    'clip-path': [`<div class="page" style="width:816px;height:1056px"><p style="clip-path:inset(0 90% 0 0)">${T}</p></div>`, /clipped, masked or filtered/],
    'mask on an ancestor': [page('', `<div style="-webkit-mask-image: linear-gradient(black, transparent)"><p>${T}</p></div>`), /clipped, masked or filtered/],
    'legacy clip': [page('position: relative', `<p style="position: absolute; clip: rect(0px, 40px, 40px, 0px)">${T}</p>`), /clipped, masked or filtered/],
    'filter': [page('', `<p style="filter: opacity(0)">${T}</p>`), /clipped, masked or filtered/],
    'page moved off the paper': [page('transform: translateX(600px)'), /overflows its page box/],
    'text moved left out of a clipping box': [page('', `<div style="overflow: hidden; width: 400px"><p style="transform: translateX(-300px)">${T}</p></div>`), /overflows its page box/],
    'text above the paper': [`<p style="position: absolute; left: 0; top: -30px">${T}</p>`, /overflows its page box/],
    'page taller than the paper': [`<style>body { margin: 0 } .page { width: 816px; height: 1500px; padding-top: 1300px }</style><div class="page">${T}</div>`, /overflows its page box/],
    'page break inside a page': [page('', `<p>first</p><p style="break-before: page">${T}</p>`), /overflows its page box/],
    'shadow root': [page('', '<div><template shadowrootmode="closed"><p>WORDS INSIDE A SHADOW ROOT</p></template></div>'), /shadow root/],
    'visibility hidden': ['<div class="page" style="width:816px;height:1056px"><h1 style="visibility:hidden">SPECIMEN HEADER</h1><p>Fictional billing document</p></div>', /would not print visibly/],
    'opacity 0': ['<div class="page" style="width:816px;height:1056px"><h1 style="opacity:0">SPECIMEN HEADER</h1><p>Fictional billing document</p></div>', /would not print visibly/],
    'opacity product': [page('', `<div style="opacity: 0.2"><div style="opacity: 0.2"><p>${T}</p></div></div>`), /would not print visibly/],
    'transparent colour': [page('', `<p style="color: transparent">${T}</p>`), /would not print visibly/],
    'display none': [page('', `<p>${T}<span style="display: none">HIDDEN WORDS</span></p>`), /would not print visibly/],
    'one pixel type': [page('', `<p style="font-size: 1px">${T}</p>`), /would not print visibly/],
    // paint containment on the root or the body clips like any other clipping ancestor
    'paint containment on the body': [`<style>body { margin: 0; height: 20px; contain: paint }</style><p>${T}</p><p>${T}</p>`, /overflows its page box/],
    'paint containment on the root': [`<style>html { height: 20px; contain: paint } body { margin: 0 }</style><p>${T}</p><p>${T}</p>`, /overflows its page box/],
    // the printed-text checks read lines by their horizontal geometry: rotated, skewed and vertical text is refused
    'a rotated line': [page('padding: 120px', `<p style="width: 500px; transform: rotate(5deg)">${T}</p>`), /rotated, skewed or vertical/],
    'a rotated block': [page('', `<div style="height: 300px"><div style="width: 300px; transform: translateX(100px) rotate(90deg); transform-origin: 0 0"><div>We mailed your refund</div></div></div>`), /rotated, skewed or vertical/],
    'skewed text': [page('padding: 120px', `<p style="transform: skewX(20deg)">${T}</p>`), /rotated, skewed or vertical/],
    'the rotate property': [page('padding: 120px', `<p style="rotate: 3deg">${T}</p>`), /rotated, skewed or vertical/],
    'vertical writing mode': [page('', `<div style="writing-mode: vertical-rl; height: 300px"><div>We mailed your refund</div></div>`), /rotated, skewed or vertical/],
  };
  try {
    for (const [what, [html, re]] of Object.entries(refused)) {
      const f = path.join(out, 'refused.pdf');
      await assert.rejects(renderHtmlToPdf(browser, html, f), re, `not refused: ${what}`);
      assert.ok(!fs.existsSync(f), `${what}: a PDF was written`);
    }
    for (const [what, html] of Object.entries({ 'a plain page': page(''), 'a scaled and moved line with room': page('padding: 120px', `<p style="width: 500px; transform: translateX(10px) scale(0.9)">${T}</p>`), 'half-transparent text': page('', `<p style="opacity: 0.5">${T}</p>`), 'a long page-less document': `<p>${(T + ' ').repeat(200)}</p>`, 'overflow on the body (passes to the viewport)': `<style>body { margin: 0; height: 20px; overflow: hidden }</style><p>${T}</p><p>${T}</p>` })) {
      const pdf = await renderHtmlToPdf(browser, html, path.join(out, 'ok.pdf'));
      assert.match(execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, ' '), /RIGHT WORDS MUST REMAIN VISIB/, `${what}: text missing`);   // (no web font here: the fallback glyphs extract with a letter or two missing)
    }
  } finally { await browser.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
