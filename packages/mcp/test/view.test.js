// The MCP Apps view (ui://claimseed/preview) in a stand-in host: a page that frames the view the way MCP Apps hosts
// do (a sandboxed iframe that may run script) and speaks the host side of the protocol over postMessage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchBrowser, findChrome, generateData } from '@claimseed/core';
import { VIEW_HTML } from '../src/view.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const HOST = 'https://host.claimseed.invalid/';
const HOST_PAGE = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><iframe id="f" sandbox="allow-scripts" style="width:700px;height:300px;border:0"></iframe><script>
window.log = []; const f = document.getElementById('f');
const send = (m) => f.contentWindow.postMessage({ jsonrpc: '2.0', ...m }, '*');
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data; window.log.push(m);
  if (m.method === 'ui/initialize') send({ id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'stand-in', version: '0' }, hostCapabilities: {}, hostContext: { theme: 'dark', displayMode: 'inline', styles: { variables: { '--color-text-primary': 'rgb(1, 2, 3)', 'bad name': 'x', '--color-background-primary': 'url("https://canary.claimseed.invalid/bg")', '--cs-bg': 'url(https://canary.claimseed.invalid/cs)', '--font-sans': 'x, image-set("https://canary.claimseed.invalid/f" 1x)', '--color-border-primary': 'url(relative.png)' } } } } });
  if (m.method === 'ui/notifications/initialized') send({ method: 'ui/notifications/tool-result', params: window.RESULT });
  if (m.method === 'ui/notifications/size-changed') f.style.height = m.params.height + 'px';
});
window.start = (result, html) => { window.RESULT = result; f.srcdoc = html; };
window.ask = (m) => send(m);
</script></body></html>`;

// a 4 x 4 white PNG, made here
function whitePng(w = 4, h = 4) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PNG = whitePng();
const RESULT = {
  content: [{ type: 'text', text: 'Rendered msn / baseline-clean / seed v: 3 page(s)' }, { type: 'image', mimeType: 'image/png', data: PNG }, { type: 'image', mimeType: 'image/png', data: PNG },
    { type: 'image', mimeType: 'image/svg+xml', data: PNG }, { type: 'image', mimeType: 'image/png', data: '"><img src=x onerror=alert(1)>' }],
  structuredContent: { type: 'msn', scenario: 'baseline-clean', seed: 'v', pdf: null, groundTruthFile: null, sha256: 'ab'.repeat(32), pages: 3, bytes: 1000,
    preview: { pages: [1, 2], omitted: 1, next: 3 },
    groundTruth: { errors: [
      { kind: '<img src=x onerror=alert(2)>', documentId: 'd', severity: 'high', fieldRef: 'claims[0].lineItems[1]', expected: 20, actual: 40 },
      { kind: 'math-error', documentId: 'd', severity: 'medium', lineRef: null, fieldRef: null, expected: null, actual: '<b>x</b>' }] } },
};

let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function host(result) {
  const page = await browser.newPage();
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => { requests.push(r.url()); if (r.url() === HOST) r.respond({ status: 200, contentType: 'text/html', body: HOST_PAGE }); else if (r.url().startsWith('data:')) r.continue(); else r.abort(); });
  const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(HOST);
  await page.evaluate((r, html) => window.start(r, html), result, VIEW_HTML);
  await page.waitForFunction(() => window.log.some((m) => m.method === 'ui/notifications/size-changed'), { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300));
  const frame = page.frames().find((f) => f !== page.mainFrame());
  return { page, frame, requests, dialogs };
}

test('the view opens with ui/initialize, says it is initialized once the host answers, then reports its size', { skip, timeout: 30000 }, async () => {
  const { page } = await host(RESULT);
  try {
    const log = await page.evaluate(() => window.log);
    assert.equal(log[0].method, 'ui/initialize');
    assert.equal(log[0].params.protocolVersion, '2026-01-26');
    assert.ok(log[0].id !== undefined && log[0].params.appCapabilities, 'a request, with the view\'s capabilities');
    const order = log.map((m) => m.method);
    assert.ok(order.indexOf('ui/notifications/initialized') > 0);
    assert.ok(order.indexOf('ui/notifications/size-changed') > order.indexOf('ui/notifications/initialized'), 'no size before initialized');
    for (const m of log) assert.equal(m.jsonrpc, '2.0');
    // a teardown request is answered; an unknown request gets "method not found"
    await page.evaluate(() => { window.ask({ id: 'td', method: 'ui/resource-teardown', params: {} }); window.ask({ id: 'zz', method: 'ui/something-else', params: {} }); });
    await page.waitForFunction(() => window.log.some((m) => m.id === 'zz'), { timeout: 5000 });
    const replies = await page.evaluate(() => window.log.filter((m) => m.id === 'td' || m.id === 'zz'));
    assert.deepEqual(replies.find((m) => m.id === 'td').result, {});
    assert.equal(replies.find((m) => m.id === 'zz').error.code, -32601);
  } finally { await page.close(); }
});

test('the view shows the page images and the injected errors as text, loads nothing, and runs no markup from the result', { skip, timeout: 30000 }, async () => {
  const { page, frame, requests, dialogs } = await host(RESULT);
  try {
    const v = await frame.evaluate(() => ({
      imgs: [...document.querySelectorAll('img')].map((i) => { const src = i.getAttribute('src'); return [src.slice(0, 5), src.slice(5, src.indexOf(',')), src.slice(src.indexOf(',') + 1).length]; }),
      captions: [...document.querySelectorAll('figcaption')].map((c) => c.textContent),
      rows: [...document.querySelectorAll('tr')].slice(1).map((r) => [...r.children].map((c) => c.textContent)),
      title: document.querySelector('h1').textContent, text: document.body.textContent, bold: document.querySelectorAll('b').length,
      theme: document.documentElement.dataset.theme, fg: getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim(),
      hostile: ['--color-background-primary', '--cs-bg', '--font-sans', '--color-border-primary'].map((k) => document.documentElement.style.getPropertyValue(k)),
      bg: getComputedStyle(document.body).backgroundImage,
    }));
    assert.equal(v.imgs.length, 2, 'of the four images given, the two PNGs in plain base64 are shown');
    for (const [scheme, type, n] of v.imgs) { assert.equal(scheme, 'data:'); assert.equal(type, 'image/png;base64'); assert.equal(n, PNG.length); }
    assert.deepEqual(v.captions, ['Page 1 of 3', 'Page 2 of 3']);
    assert.equal(v.title, 'msn / baseline-clean / seed v');
    assert.deepEqual(v.rows, [['<img src=x onerror=alert(2)>', 'high', 'claims[0].lineItems[1]', '$20.00', '$40.00'], ['math-error', 'medium', 'document', '', '<b>x</b>']]);
    assert.equal(v.bold, 0);
    assert.match(v.text, /SYNTHETIC SPECIMEN/);
    assert.match(v.text, /1 more page\(s\) not shown here: render again with from_page 3/);
    assert.equal(v.theme, 'dark'); assert.equal(v.fg, 'rgb(1, 2, 3)');
    assert.deepEqual(v.hostile, ['', '', '', ''], 'a host style variable that names a URL, or one the view does not read, was applied');
    assert.equal(v.bg, 'none');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(requests.filter((u) => u !== HOST && !(u.startsWith('data:') && u.endsWith(`;base64,${PNG}`))), [], 'only the page and the images it was given');
  } finally { await page.close(); }
});

// the section headings and the decoy rows the view shows for a result, after the host hands it a new one
async function headings(page, frame, result) {
  await frame.evaluate(() => { document.getElementById('app').replaceChildren(); });
  await page.evaluate((r) => window.ask({ method: 'ui/notifications/tool-result', params: r }), result);
  await frame.waitForFunction(() => document.querySelector('h2'), { timeout: 5000 });
  return frame.evaluate(() => ({
    h2: [...document.querySelectorAll('h2')].map((h) => h.textContent),
    decoyRows: [...document.querySelectorAll('section.decoys tr')].slice(1).map((r) => [...r.children].map((c) => c.textContent)),
    bold: document.querySelectorAll('b').length,
  }));
}
const withKey = (groundTruth) => ({ content: [{ type: 'text', text: 'Rendered' }], structuredContent: { type: 'msn', scenario: 's', seed: 'v', pages: 1, groundTruth } });

test('only a result with neither errors nor decoys is called a clean control; decoys are listed as text', { skip, timeout: 30000 }, async () => {
  const { page, frame, dialogs } = await host(withKey({ errors: [], decoys: [] }));
  try {
    let v = await headings(page, frame, withKey({ errors: [], decoys: [] }));
    assert.deepEqual(v.h2, ['No injected errors: a clean control']); assert.deepEqual(v.decoyRows, []);
    v = await headings(page, frame, withKey({ errors: [] })); // a key without a decoys list
    assert.deepEqual(v.h2, ['No injected errors: a clean control']);
    v = await headings(page, frame, withKey({ errors: [], decoys: [
      { id: 'decoy-1', kind: 'repeat-service-different-date', lineRef: 'claims[0].lines[1]', fieldRef: 'claims[0].lines[1].serviceDate' },
      { id: 'decoy-2', kind: '<b>high</b>', lineRef: 'claims[0].lines[2]', fieldRef: null }, null, 'x'] }));
    assert.deepEqual(v.h2, ['No injected errors, but 2 decoys: not a clean control', 'Decoys (2): lines that look wrong but follow the rules']);
    assert.deepEqual(v.decoyRows, [['repeat-service-different-date', 'claims[0].lines[1].serviceDate'], ['<b>high</b>', 'claims[0].lines[2]']]);
    assert.equal(v.bold, 0);
    v = await headings(page, frame, withKey({ errors: [{ kind: 'duplicate-line', severity: 'high', lineRef: 'claims[1].lines[2]' }, null, 7], decoys: [{ kind: 'repeat-service-different-date', lineRef: null }] }));
    assert.deepEqual(v.h2, ['Injected errors (1)', 'Decoy (1): a line that looks wrong but follows the rules']);
    assert.deepEqual(v.decoyRows, [['repeat-service-different-date', 'document']]);
    v = await headings(page, frame, withKey({ errors: [], decoys: [{ kind: 'high-charge-within-limits', lineRef: 'claims[0].lines[0]' }] }));
    assert.deepEqual(v.h2, ['No injected errors, but 1 decoy: not a clean control', 'Decoy (1): a line that looks wrong but follows the rules']);
    assert.deepEqual(dialogs, []);
  } finally { await page.close(); }
});

// The server's catalog and the view must agree on which scenarios are clean controls, for every scenario it offers;
// and a real render_document result of a decoy scenario, handed over unchanged, is not called one.
test('the view and describe_document_type agree on clean controls for every scenario, and on a real decoy render', { skip, timeout: 180000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js')],
    env: { ...process.env, CLAIMSEED_WORKSPACE: '', CLAIMSEED_MCP_TIMEOUT_MS: '120000' }, stderr: 'ignore' });
  const client = new Client({ name: 'claimseed-view-test', version: '0.0.0' });
  await client.connect(transport);
  const { page, frame } = await host(withKey({ errors: [] }));
  try {
    await client.listTools();
    const types = (await client.callTool({ name: 'list_document_types', arguments: {} })).structuredContent.types.map((t) => t.type);
    let clean = 0; let decoyOnly = 0;
    for (const type of types) {
      const { scenarios } = (await client.callTool({ name: 'describe_document_type', arguments: { type } })).structuredContent;
      for (const s of scenarios) {
        const { groundTruth } = generateData({ type, scenario: s.scenario, seed: 'view-check' });
        const v = await headings(page, frame, withKey(groundTruth));
        assert.equal(v.h2[0] === 'No injected errors: a clean control', s.cleanControl, `${type}/${s.scenario}: the view and the catalog disagree`);
        assert.equal(v.decoyRows.length, (groundTruth.decoys || []).length, `${type}/${s.scenario}: decoy rows`);
        if (s.cleanControl) clean++; else if (!s.injectedErrors.length) decoyOnly++;
      }
    }
    assert.ok(clean > 0 && decoyOnly > 0, 'the catalog has clean controls and decoy-only scenarios to compare');
    const r = await client.callTool({ name: 'render_document', arguments: { type: 'itemized-bill', scenario: 'decoys-repeat-therapy-high-charge', seed: 'view-decoy', preview: 'none' } }, undefined, { timeout: 120000 });
    assert.ok(!r.isError, r.content?.[0]?.text);
    // the text summary every client gets says the same
    assert.match(r.content[0].text, /, no injected errors but 2 decoys \(not a clean control\)\.$/m);
    const cleanRender = await client.callTool({ name: 'render_document', arguments: { type: 'msn', scenario: 'baseline-clean', seed: 'view-clean', preview: 'none' } }, undefined, { timeout: 120000 });
    assert.match(cleanRender.content[0].text, /, no injected errors\.$/m);
    const v = await headings(page, frame, r);
    assert.deepEqual(v.h2, ['No injected errors, but 2 decoys: not a clean control', 'Decoys (2): lines that look wrong but follow the rules']);
  } finally { await page.close(); await client.close(); }
});

test('a failed render is shown as its error message', { skip, timeout: 30000 }, async () => {
  const { page, frame } = await host({ isError: true, content: [{ type: 'text', text: 'render timed out after 100 ms' }] });
  try {
    assert.equal(await frame.evaluate(() => document.querySelector('.error').textContent), 'render timed out after 100 ms');
  } finally { await page.close(); }
});

test('the view is one self-contained page: no external URL, no remote script, style or frame', () => {
  assert.doesNotMatch(VIEW_HTML, /https?:\/\//);
  assert.doesNotMatch(VIEW_HTML, /<(script|link|iframe|img)\b[^>]*\b(src|href)=/i);
  assert.doesNotMatch(VIEW_HTML, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
