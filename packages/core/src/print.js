// print.js — the hardened HTML -> single-PDF printing primitive and the HTML hardening filter. INTERNAL: this module is
// not reachable through the package's exports map; the public API (src/index.js, src/render.js) only exposes
// renderHtmlToPdf, which stamps the specimen markers on what it prints. The render functions use printPage directly
// and stamp inside mergePdfs.
import crypto from 'crypto'; import fs from 'fs';
import { printHooks } from './browser.js';

// Content-Security-Policy injected into every rendered document. Fonts and images may only come from data: URIs;
// no network, frame, script or external style of any kind. Belt-and-braces with the request interception below.
const RENDER_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi;   // semicolon optional: browsers decode "&#114efresh" too
function decodeEntities(t) { return t.replace(ENTITY_RE, (m, e) => { if (e[0] === '#') { const cp = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; } return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()] ?? m; }); }
// Find the end of a start tag beginning at `i` (just after the tag name) using the HTML tokenizer's rules: inside
// an attribute NAME a quote character is an ordinary character, inside a VALUE a quote delimits the value. A regex
// that treats every quote as a delimiter desyncs on <meta a"b=">" http-equiv=refresh>, so this is a small state machine.
function tagEnd(s, i) {
  let state = 'name';
  while (i < s.length) {
    const c = s[i];
    if (state === 'name') { if (c === '>') return i + 1; if (c === '=') state = 'before'; i++; continue; }
    if (state === 'before') {
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'") { const j = s.indexOf(c, i + 1); if (j < 0) return s.length; i = j + 1; state = 'name'; continue; }
      if (c === '>') return i + 1;
      state = 'unquoted'; continue;
    }
    if (c === '>') return i + 1; if (/\s/.test(c)) state = 'name'; i++;   // unquoted value
  }
  return s.length;
}
const META_OR_BASE_OPEN = /<\s*\/?\s*(?:meta|base)\b/gi;
function stripMetaBase(html) {
  let out = ''; let last = 0; META_OR_BASE_OPEN.lastIndex = 0; let m;
  while ((m = META_OR_BASE_OPEN.exec(html))) {
    const end = tagEnd(html, m.index + m[0].length); const tag = html.slice(m.index, end);
    const norm = decodeEntities(decodeEntities(tag)).replace(/[\s\/]+/g, ' ').toLowerCase();
    out += html.slice(last, m.index) + (/refresh|<\s*base/.test(norm) ? '' : tag); last = end; META_OR_BASE_OPEN.lastIndex = end;
  }
  return out + html.slice(last);
}
export function hardenHtml(html) {
  // Drop every <meta> whose decoded, whitespace/slash-normalised text mentions refresh (a redirect would blank the
  // page and drop content), and every <base> (would re-root relative URLs). Matching is on the tag text after entity
  // decoding (with or without semicolons), so "<meta/http-equiv", "http-equiv=&#114efresh", a ">" hidden inside a
  // quoted attribute value or name, and odd casing are all caught. Control characters are removed first. This is
  // defence in depth: renderHtmlToPdf also refuses any render in which the document navigated (the sentinel check).
  const out = stripMetaBase(String(html).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
  const csp = `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`;
  return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + csp) : csp + out;
}
// The paper the renderer prints on, in CSS px at 96 dpi (Letter). The PDF is always this size with zero margins; the
// document is laid out and measured on exactly this page box, so a document rule that would print on another box is
// refused (measurePrint below), never silently rescaled.
const PAPER = { portrait: { width: 816, height: 1056 }, landscape: { width: 1056, height: 816 } };
const NAVIGATED = 'render refused: the document navigated or was replaced during rendering (meta refresh or equivalent)';
// Puppeteer reports a document that navigated away under it in several ways, depending on which call was in flight:
// the execution context was destroyed, the frame was detached, the target or session closed, a navigation failed.
// All of them mean the document being measured or printed is not the one that was handed in, so at this boundary
// they are one error: the documented refusal (the original error is kept as `cause`).
const NAVIGATION_ERROR = /context was destroyed|cannot find context|execution context|detached|target closed|session closed|targetcloseerror|navigat|net::err_|no frame (?:for|with)/i;
export function asRefusal(e) {
  if (e instanceof Error && (/^render refused/.test(e.message) || e.name === 'TimeoutError')) return e;
  if (NAVIGATION_ERROR.test(`${e && e.name} ${e && e.message}`)) return new Error(NAVIGATED, { cause: e });
  return e;
}
const REFUSAL = {
  page: 'render refused: the document sets its own print page box (the renderer prints on its own paper with zero margins; an @page size, margin, page-margin box or other @page property would move or rescale what the fit check measured)',
  zoom: 'render refused: an element is zoomed (CSS zoom rescales the printed layout; use font sizes or transforms the fit check can measure)',
  shadow: 'render refused: the document contains a shadow root (its text is outside the document the fit check measures)',
  effect: 'render refused: text is clipped, masked or filtered (clip-path, mask, clip, filter or mix-blend-mode on text or on an element that contains it; the fit check cannot prove what of it prints)',
  hidden: 'render refused: the document contains text that would not print visibly (not laid out, visibility hidden, transparent, fully faded or too small to read)',
  orient: 'render refused: the document contains rotated, skewed or vertical text (the printed-text checks read lines by their horizontal geometry)',
  fit: 'render refused: content overflows its page box (it would be clipped or overprint its neighbours; the data does not fit the layout)',
};
const ORDER = ['page', 'zoom', 'shadow', 'effect', 'hidden', 'orient', 'fit'];

// The fit check. Runs inside the page through DevTools evaluation (the page's own JavaScript stays disabled) on the
// layout the PDF is printed from: print media, a viewport the size of the paper, and — enforced here — no @page rule
// that changes the page box, no zoom. Returns [kind, where] pairs.
//  * @page: every @page rule in every stylesheet, including those nested in @media, @supports, @layer, @container and
//    imported sheets, may set only `size` equal to the paper (or auto) and zero margins; page-margin boxes
//    (@top-center { content: ... }) and any other @page property are refused.
//  * zoom other than 1 on any element.
//  * effects: clip-path, mask / mask-image / mask-border, the legacy `clip`, `filter` and `mix-blend-mode` on any element
//    that contains text or on any of its ancestors: their visible result is not a rectangle the check can compare.
//  * invisible text: text with no layout box (display: none and equivalents), visibility hidden or collapse, an effective
//    opacity (product over its ancestors) under 0.05, a fill colour whose alpha times that opacity is under 0.05 (with
//    no visible stroke), or a printed height under 3 px. Text drawn in the background colour (white on white) and text
//    under an opaque box are NOT detected: the check compares geometry, not pixels.
//  * geometry: every text run's client rectangles (Range.getClientRects, which include transforms) must lie inside its
//    .page box, and every .page box on one sheet of paper — the layout is continuous and the PDF cuts it into sheets of
//    the paper's height, so after the first .page each must start at the top of a sheet of its own. Text outside any
//    .page (all of a document without .page elements) must lie within the paper's width and below its top edge, and may
//    not straddle the edge of a sheet if it is transformed or if the document has .page elements. Text must also lie inside
//    every ancestor that clips it (overflow other than visible, contain: paint — on the root and the body too), inside its table cell (an unbreakable
//    token in a fixed-layout cell overprints the neighbouring columns while the cell's own box stays in bounds), and
//    may not run into an absolutely or fixed positioned block it is not part of (a running footer). Elements that hide
//    overflowing content (scroll size larger than client size) are refused, as are element boxes outside their page.
//  * orientation: rotated or skewed text (a transform or rotate on the text or an ancestor) and vertical writing modes are
//    refused: the rendered-text provenance check reads printed lines by their horizontal geometry.
//  * pagination: in a document with .page elements, a forced page break (break-before/after page, left, right, recto,
//    verso, or a named `page`) is allowed only on a .page element, and position: fixed text is refused in a document of
//    more than one sheet (it would repeat on every sheet).
function measurePrint({ W, H }) {
  const found = [];
  const add = (kind, where) => { if (found.filter((f) => f[0] === kind).length < 3) found.push([kind, where]); };
  const tag = (el) => `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? ' class="' + el.className + '"' : ''}>`;
  const quote = (el) => `("${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}")`;
  // ---- @page rules
  const LEN = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 };
  const isZero = (v) => /^[-+]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/i.test(String(v).trim());
  const sizeIsPaper = (v) => {
    let dims = null; let orient = null; const lens = [];
    const t = String(v).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!t.length || (t.length === 1 && t[0] === 'auto')) return true;
    for (const x of t) {
      if (x === 'portrait' || x === 'landscape') { orient = x; continue; }
      if (x === 'letter') { dims = [816, 1056]; continue; }
      const m = /^(\d*\.?\d+)(px|in|cm|mm|q|pt|pc)$/.exec(x);
      if (!m) return false;
      lens.push(Number(m[1]) * LEN[m[2]]);
    }
    if (lens.length) { if (dims || lens.length > 2) return false; dims = lens.length === 1 ? [lens[0], lens[0]] : lens; }
    if (!dims) dims = [Math.min(W, H), Math.max(W, H)];   // an orientation alone: the paper in that orientation
    if (orient === 'landscape') dims = [Math.max(...dims), Math.min(...dims)]; else if (orient === 'portrait') dims = [Math.min(...dims), Math.max(...dims)];
    return Math.abs(dims[0] - W) <= 0.5 && Math.abs(dims[1] - H) <= 0.5;
  };
  const visitRules = (rules) => {
    for (const r of rules) {
      if (r instanceof CSSPageRule) {
        const at = `@page${r.selectorText ? ' ' + r.selectorText : ''}`;
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style[i]; const v = r.style.getPropertyValue(p);
          const ok = p.startsWith('margin') ? isZero(v) : p === 'size' ? sizeIsPaper(v) : p === 'page-orientation' && v === 'upright';
          if (!ok) add('page', `${at} { ${p}: ${v} }`);
        }
        if (r.cssRules && r.cssRules.length) add('page', `${at} has a page-margin box (${r.cssRules[0].cssText.slice(0, 60)})`);
        continue;
      }
      if (r instanceof CSSImportRule) { if (r.styleSheet) visitSheet(r.styleSheet); continue; }
      if (r.cssRules) visitRules(r.cssRules);
    }
  };
  // An external sheet (<link>, @import) never applies — the CSP allows inline styles only — and its rules are not
  // readable; an inline sheet whose rules cannot be read is refused.
  const visitSheet = (sheet) => { let rules = null; try { rules = sheet.cssRules; } catch { if (!sheet.href) add('page', 'an inline stylesheet whose rules cannot be read'); } if (rules) visitRules(rules); };
  for (const sheet of document.styleSheets) visitSheet(sheet);
  // ---- zoom
  for (const el of document.querySelectorAll('*')) { const z = getComputedStyle(el).zoom; if (z && Number(z) !== 1) add('zoom', `${tag(el)} has zoom: ${z}`); }
  // ---- per-element facts, inherited down the tree (memoized)
  const alpha = (c) => { c = String(c).trim(); if (c === 'transparent') return 0; const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c) || /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(c); return m ? Number(m[1]) / (m[2] ? 100 : 1) : 1; };
  const FORCED = /^(?:page|left|right|recto|verso|always)$/;
  const facts = new Map(); const ROOT = { opacity: 1, effect: null, transformed: false, rotated: false, fixed: false, clips: [] };
  const factsOf = (el) => {
    const chain = []; for (let a = el; a && !facts.has(a); a = a.parentElement) chain.push(a);   // iterative: a deep tree cannot exhaust the stack
    for (let i = chain.length - 1; i >= 0; i--) facts.set(chain[i], ownFacts(chain[i], chain[i].parentElement ? facts.get(chain[i].parentElement) : ROOT));
    return facts.get(el);
  };
  function ownFacts(el, up) {
    const cs = getComputedStyle(el);
    let effect = up.effect;
    if (!effect) {
      const own = [['clip-path', cs.clipPath], ['mask-image', cs.maskImage], ['-webkit-mask-image', cs.webkitMaskImage], ['mask-border', cs.webkitMaskBoxImageSource], ['filter', cs.filter], ['mix-blend-mode', cs.mixBlendMode === 'normal' ? 'none' : cs.mixBlendMode], ['clip', /^(?:absolute|fixed)$/.test(cs.position) && cs.clip !== 'auto' ? cs.clip : 'none']].find(([, v]) => v && v !== 'none');
      if (own) effect = `${tag(el)} has ${own[0]}: ${own[1].slice(0, 60)}`;
    }
    // overflow on the root and the body passes to the viewport and clips nothing in print; paint containment clips there
    // too (it does not pass on), so it counts on every element
    const root = el === document.documentElement || el === document.body; const paint = /paint|strict|content/.test(cs.contain);
    const clipX = cs.display !== 'inline' && ((!root && cs.overflowX !== 'visible') || paint);
    const clipY = cs.display !== 'inline' && ((!root && cs.overflowY !== 'visible') || paint);
    // rotated or skewed text: a printed line is judged by its geometry, which only horizontal text keeps
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(cs.transform || '');
    const v = m ? m[2].split(',').map(Number) : null;
    const turns = Boolean(v && (m[1] ? [1, 2, 4, 6, 8, 9].some((k) => Math.abs(v[k]) > 1e-6) : Math.abs(v[1]) > 1e-6 || Math.abs(v[2]) > 1e-6)) || Boolean(cs.rotate && !/^(?:none|0deg|0rad|0turn|0)$/.test(cs.rotate));
    const f = {
      cs, opacity: up.opacity * Number(cs.opacity), effect,
      transformed: up.transformed || cs.transform !== 'none' || (cs.translate && cs.translate !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none'),
      rotated: up.rotated || turns,
      fixed: up.fixed || cs.position === 'fixed',
      clips: clipX || clipY ? [...up.clips, { el, x: clipX, y: clipY }] : up.clips,
    };
    return f;
  }
  // ---- the sheets: the layout is continuous and the PDF cuts it into sheets of the paper's height. Each .page must lie
  // on one sheet; after the first, each must start at the top of a sheet of its own (that is where the print puts a
  // page that follows a page break, so the measured position is the printed one).
  const pages = [...document.querySelectorAll('.page')];
  const pageBox = new Map(); let lastSheet = -1;
  pages.forEach((pg, i) => {
    const r = pg.getBoundingClientRect();
    pageBox.set(pg, r);
    if (r.width === 0 && r.height === 0) return;
    const k = lastSheet < 0 ? Math.floor((r.top + 1) / H) : Math.round(r.top / H);
    if (r.top < -1 || (lastSheet >= 0 && (Math.abs(r.top - k * H) > 1 || k <= lastSheet)) || r.bottom > (k + 1) * H + 1 || r.left < -1 || r.right > W + 1)
      add('fit', `page ${i + 1}: the .page box (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} px) does not lie on a ${W}x${H} px sheet of paper of its own`);
    lastSheet = k;
  });
  const multiSheet = pages.length > 1 || document.documentElement.scrollHeight > H + 1;
  const pageOf = (el) => { const pg = el.closest('.page'); return pg && pageBox.has(pg) ? pg : null; };
  const label = (el) => { const pg = pageOf(el); return pg ? `page ${pages.indexOf(pg) + 1}: ` : ''; };
  const outside = (r, b) => r.bottom > b.bottom + 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.left < b.left - 1;
  const PAPER_BAND = { top: 0, bottom: Infinity, left: 0, right: W };   // outside any .page: Chrome cuts the layout into sheets vertically
  const boxOf = (el) => { const pg = pageOf(el); return pg ? pageBox.get(pg) : PAPER_BAND; };
  // ---- forced breaks (documents with .page elements)
  if (pages.length) for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); const isPage = pageBox.has(el);
    const bad = [['break-before', cs.breakBefore], ['break-after', cs.breakAfter]].find(([, v]) => FORCED.test(v) && !(isPage && v === 'page')) || (cs.page && cs.page !== 'auto' ? ['page', cs.page] : null);
    if (bad) add('fit', `${label(el)}${tag(el)} forces a page break (${bad[0]}: ${bad[1]}) inside the page layout`);
  }
  // ---- element boxes
  for (const el of document.querySelectorAll('body, body *')) {
    if (pageBox.has(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (!el.textContent.trim() && !/^(IMG|SVG|TABLE|HR|INPUT|TEXTAREA|SELECT|BUTTON|CANVAS|VIDEO|OBJECT|EMBED|IFRAME)$/.test(el.tagName.toUpperCase())) continue;   // empty spacers do not count
    if (outside(r, boxOf(el))) add('fit', `${label(el)}${tag(el)} outside the page box ${quote(el)}`);
    const cs = getComputedStyle(el);
    if (el !== document.body && /hidden|clip|scroll|auto/.test(cs.overflowX + cs.overflowY) && cs.display !== 'inline' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) add('fit', `${label(el)}${tag(el)} hides overflowing content ${quote(el)}`);
  }
  // absolutely positioned blocks (running footers and headers) sit on top of the flow: no other text may run into them
  const positioned = [...document.querySelectorAll('body *')].filter((el) => !pageBox.has(el) && /^(absolute|fixed)$/.test(getComputedStyle(el).position) && el.textContent.trim()).map((el) => ({ el, r: el.getBoundingClientRect() }));
  const hits = (r, b) => r.left < b.right - 0.5 && r.right > b.left + 0.5 && r.top < b.bottom - 0.5 && r.bottom > b.top + 0.5;
  // ---- every text run
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const p = n.parentElement; if (!p || /^(STYLE|SCRIPT|TEMPLATE)$/i.test(p.tagName)) continue;
    const f = factsOf(p); const where = `${label(p)}${tag(p)} ${quote(p)}`;
    const range = document.createRange(); range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    if (f.effect) { add('effect', `${where}: ${f.effect}`); continue; }
    if (!rects.length) { add('hidden', `${where}: text is not laid out (display: none or equivalent)`); continue; }
    if (f.cs.visibility !== 'visible') { add('hidden', `${where}: visibility: ${f.cs.visibility}`); continue; }
    if (f.rotated) { add('orient', `${where}: rotated or skewed text`); continue; }
    if (f.cs.writingMode && f.cs.writingMode !== 'horizontal-tb') { add('orient', `${where}: vertical text (writing-mode: ${f.cs.writingMode})`); continue; }
    const fill = alpha(f.cs.webkitTextFillColor || f.cs.color) * f.opacity; const stroke = parseFloat(f.cs.webkitTextStrokeWidth) > 0 ? alpha(f.cs.webkitTextStrokeColor) * f.opacity : 0;
    if (f.opacity < 0.05 || Math.max(fill, stroke) < 0.05) { add('hidden', `${where}: effective opacity ${+f.opacity.toFixed(3)}, colour ${f.cs.webkitTextFillColor || f.cs.color}`); continue; }
    if (Math.max(...rects.map((r) => r.height)) < 3 || Math.max(...rects.map((r) => r.width)) < 0.5) { add('hidden', `${where}: printed ${Math.max(...rects.map((r) => r.height)).toFixed(1)} px high`); continue; }
    if (f.fixed && multiSheet) { add('fit', `${where}: position: fixed text repeats on every printed sheet`); continue; }
    const box = boxOf(p); const cell = p.closest('td, th'); const cb = cell ? cell.getBoundingClientRect() : null;
    const own = positioned.filter((x) => x.el.contains(n));
    for (const r of rects) {
      if (outside(r, box)) { add('fit', `${where}: text outside the page box`); break; }
      if (box === PAPER_BAND && (f.transformed || pages.length) && Math.floor((r.top + 1) / H) !== Math.floor((r.bottom - 1) / H)) { add('fit', `${where}: ${f.transformed ? 'transformed ' : ''}text straddles the edge of a sheet`); break; }   // a transformed run is cut there; any run outside the pages would push the pages after it off their sheets
      const clip = f.clips.find(({ el, x, y }) => {
        const b = el.getBoundingClientRect(); const L = b.left + el.clientLeft, T = b.top + el.clientTop;
        const rootish = el === document.documentElement || el === document.body;   // their client size can be the viewport's (quirks mode): use their own box
        const cw = rootish ? b.width - 2 * el.clientLeft : el.clientWidth, ch = rootish ? b.height - 2 * el.clientTop : el.clientHeight;
        return (x && (r.left < L - 1 || r.right > L + cw + 1)) || (y && (r.top < T - 1 || r.bottom > T + ch + 1));
      });
      if (clip) { add('fit', `${where}: text outside the clipping box of ${tag(clip.el)}`); break; }
      const hit = positioned.find((x) => !own.includes(x) && !p.contains(x.el) && hits(r, x.r));
      if (hit) { add('fit', `${where}: text runs into a positioned ${tag(hit.el)}`); break; }
      if (cb && (r.right > cb.right + 1 || r.left < cb.left - 1)) { add('fit', `${where}: text wider than its table cell by ${Math.round(Math.max(r.right - cb.right, cb.left - r.left))}px`); break; }
    }
  }
  return found;
}

// Print HTML that has ALREADY been through hardenHtml to a single unstamped PDF. The test suite hands it a raw
// refresh tag to prove the sentinel below refuses the render; the render functions call it for each page group.
// A capture hook for the repository's own provenance check (scripts/verify-stock-sources.js): when set, every page's
// hardened HTML is handed to it and a blank page is written in place of the Chrome print, so the whole render path can
// be driven without a browser. Not part of the public API (print.js is not exported by the package).
export { printHooks };
export async function printPage(browser, hardened, outputPath, options = {}) {
  if (printHooks.capture) {
    printHooks.capture(hardened, options);
    const { PDFDocument } = await import('pdf-lib'); const doc = await PDFDocument.create();
    const n = Math.max(1, (hardened.match(/class="(?:[^"]*\s)?page(?:\s[^"]*)?"/g) || []).length);   // one blank page per .page element (the class token, not page-title-bar), so the page-count check downstream still holds
    for (let i = 0; i < n; i++) doc.addPage(options.landscape ? [792, 612] : [612, 792]);
    fs.writeFileSync(outputPath, await doc.save()); return outputPath;
  }
  // Hardened render path (see SECURITY.md): the HTML is handed to Chrome as a string on about:blank — never
  // written to disk and loaded over file:// — JavaScript is disabled, a CSP forbids every non-inline resource, the
  // browser is launched with a dead proxy and no prefetch/prerender, and request interception refuses anything
  // that is not about:blank. Caller-supplied data therefore cannot read local files, reach the network, or run
  // script, even if a template mis-marks it `| safe`. test/render-security.test.js exercises these vectors.
  const page = await browser.newPage();
  let printed = false; let navigated = false;
  try {
    // Lay the document out exactly as it will print before measuring it: print media (an @media print rule that clips
    // a block must be measured, not the screen layout) and a viewport the size of the paper.
    const paper = options.landscape ? PAPER.landscape : PAPER.portrait;
    await page.emulateMediaType('print');
    await page.setViewport(paper);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url === 'about:blank' || url.startsWith('data:')) req.continue().catch(() => {}); else req.abort('blockedbyclient').catch(() => {});
    });
    // A hidden sentinel element is appended; if anything managed to navigate or replace the document (a refresh form
    // the stripper did not recognise), the sentinel is gone and the render fails loudly instead of producing a blank
    // page. The document is checked before it is measured and again after it is printed, and any main-frame
    // navigation after the content was set refuses the render even if the sentinel check raced it.
    const sentinel = `cs-sentinel-${crypto.randomBytes(8).toString('hex')}`;
    const tag = `<i id="${sentinel}" hidden></i>`;
    await page.setContent(/<\/body>/i.test(hardened) ? hardened.replace(/<\/body>/i, tag + '</body>') : hardened + tag, { waitUntil: 'load', timeout: 30000 });
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigated = true; });
    const intact = async () => !navigated && page.url() === 'about:blank' && (await page.evaluate((id) => Boolean(document.getElementById(id)), sentinel));
    await page.evaluateHandle('document.fonts.ready').catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    if (!(await intact())) throw new Error(NAVIGATED);
    // A shadow root's text is not part of the document the fit check walks (and a closed one is invisible to it), so
    // a document that has one is refused. DevTools sees open and closed roots alike. (The session stays attached until
    // the page closes: detaching a DevTools session drops the print-media emulation the measurement depends on.)
    const { root } = await (await page.createCDPSession()).send('DOM.getDocument', { depth: -1, pierce: true });
    const authored = (node) => (node.shadowRoots || []).some((s) => s.shadowRootType !== 'user-agent') || [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])].some(authored);
    if (authored(root)) throw new Error(REFUSAL.shadow);
    const found = await page.evaluate(measurePrint, { W: paper.width, H: paper.height });
    if (found.length) {
      const kind = ORDER.find((k) => found.some((f) => f[0] === k));
      throw new Error(`${REFUSAL[kind]} — ${found.filter((f) => f[0] === kind).map((f) => f[1]).join('; ')}`);
    }
    const pdfOptions = {
      path: outputPath,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      preferCSSPageSize: false,   // the page size is this function's, never the document's (and a document @page rule that differs was refused above)
    };
    if (options.landscape) { pdfOptions.width = '11in'; pdfOptions.height = '8.5in'; }
    else { pdfOptions.width = '8.5in'; pdfOptions.height = '11in'; }
    printed = true;
    await page.pdf(pdfOptions);
    if (!(await intact())) throw new Error(NAVIGATED);   // the document was replaced while it was being printed
  } catch (e) {
    if (printed) fs.rmSync(outputPath, { force: true });   // a refused render leaves no PDF behind
    throw navigated && !/^render refused/.test(e && e.message) ? new Error(NAVIGATED, { cause: e }) : asRefusal(e);
  } finally {
    // closing a page whose document is mid-navigation can wait forever for the target to report itself destroyed;
    // the render's outcome is already decided, so the wait is bounded
    await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
  }
  return outputPath;
}
