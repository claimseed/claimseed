// provenance.js — normalization and public-source lookup shared by verify-stock-sources.js (the tree) and
// scan-rendered.js (the rendered text): every printed sentence of six or more words must be verbatim public text or a
// reviewed original sentence.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
export const PLAN_NAMES = ['Corvane Health Insurance Company', 'Corvane Medicare Advantage Choice (PPO)', 'Corvane Medicare Advantage', 'Corvane', 'Tessara Health Plan, Inc.', 'Tessara Complete (HMO)', 'Tessara Health Plan', 'Tessara'];
export function norm(s, source = false) {
  let t = String(s).normalize('NFKC');
  for (const n of PLAN_NAMES) t = t.split(n).join(' ');
  // placeholders only: template tags ({{ x }}, {% x %}), {name}-style fields and short bracketed fields ([date], [Plan
  // name]); bracketed or braced PROSE of four or more words is printed text and is judged like any other
  if (source) t = t.replace(/\{[^}]*\}|\[[^\]]*\]/g, ' ');   // a public snapshot's own placeholders ([Name of covered entity]) are fields, never text
  t = t.replace(/\{\{[^}]*\}\}|\{%[^%]*%\}|\{[A-Za-z0-9_.-]{0,40}\}/g, ' ');   // a {field} placeholder is one identifier: braces around words with spaces are judged below
  t = t.replace(/\[([^\]]*)\]/g, (m, inner) => (inner.trim().split(/\s+/).filter(Boolean).length >= 4 ? ` ${inner} ` : ' '));
  t = t.replace(/\{([^}]*)\}/g, (m, inner) => (inner.trim().split(/\s+/).filter(Boolean).length >= 4 ? ` ${inner} ` : ' '));
  t = t.replace(/https?:\/\/\S+/g, ' ');                    // urls
  t = t.replace(/[0-9]/g, ' ');                             // numbers (phones, amounts, years)
  return t.toLowerCase().replace(/[^\p{L}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
export const words = (t) => t.split(' ').filter(Boolean).length;
export function loadPublic(root) {
  return fs.readdirSync(path.join(root, 'data/public-sources')).filter((f) => f.endsWith('.txt')).map((f) => norm(fs.readFileSync(path.join(root, 'data/public-sources', f), 'utf-8'), true)).join(' \n ');
}
export function loadOriginal(root) {
  const p = path.join(root, 'data/original-sentences.json');
  return new Set(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')).sentences : []);
}
// Sentences of a text: split on sentence punctuation and line breaks. When no piece reaches six words but the whole
// does (a sentence fragmented with ";" or ":" into short pieces), the whole text is judged as the sentence it prints as.
export function sentencesOf(text) {
  const out = [];
  for (const raw of String(text).split(/(?<=[.!?])\s+|\n+/)) { const n = norm(raw); if (words(n) >= 6) out.push(n); }
  if (!out.length) { const whole = norm(text); if (words(whole) >= 6) out.push(whole); }
  return out;
}
// The verified text as a set of normalized sentences and lines (public snapshots split on sentence punctuation and
// line breaks, plus the reviewed originals), for coverage: scan-rendered.js marks every printed word that lies inside
// an occurrence of a verified sentence of four or more words, so a run of printed text is accepted only where verified
// sentences meet end to end.
export function loadVerifiedSentences(root) {
  const out = new Set();
  for (const f of fs.readdirSync(path.join(root, 'data/public-sources')).filter((x) => x.endsWith('.txt')))
    for (const text of [fs.readFileSync(path.join(root, 'data/public-sources', f), 'utf-8')]) {
      for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) { const n = norm(raw, true); if (words(n) >= 4) out.add(n); }                                   // lines and line fragments (headings)
      for (const raw of text.replace(/([^\n])\n(?!\n)/g, '$1 ').split(/(?<=[.!?])\s+|\n+/)) { const n = norm(raw, true); if (words(n) >= 4) out.add(n); }   // sentences joined across wrapped lines
    }
  for (const n of loadOriginal(root)) if (words(n) >= 4) out.add(n);
  return out;
}

// ---- text as it is laid out ----
// Tags end a printed line unless the element is inline: the inline HTML elements, and any element that a style
// attribute or a <style> rule gives an inline-level display (display: inline / inline-block / contents ...) — so
// "<div style=\"display:inline\">We mailed your refund</div> <div style=\"display:inline\">to another person</div>" is
// judged as the one sentence it prints as; the children of a flex or grid container are laid side by side the same way.
// Layouts that place blocks side by side are joined too, where the reader can see that the pieces are one line each:
// an item of a flex or grid container (a child, or the child of a display: contents item) or of a multi-column
// container (columns / column-count / column-width), and an absolutely or fixed positioned element, whose whole text is
// one printed line is joined with its neighbours however deeply its text is nested — so a sentence split over two
// positioned boxes, two columns or two grid cells of nested blocks is judged whole. (A multi-line item keeps its own
// lines; the rendered-text scan judges what actually prints beside it, by geometry.)
// A rule's selector is read by its last compound: its classes, else its id,
// else its tag; a rule that matches by anything else (*, [attr], :pseudo) makes every element inline (over-joining text
// is the safe direction: it can only make a printed sentence longer, never hide one). A rule for a pseudo-element
// (::before, ::after) positions or flows the pseudo-element, not the element, and is not read as columns or position.
export const INLINE_TAGS = new Set('i b em strong span a sup sub u small abbr br code q s strike del ins mark label cite dfn kbd samp var time data bdi bdo font tt big'.split(' '));
const INLINE_DISPLAY = /display\s*:\s*(?:inline(?:-block|-flex|-grid|-table)?|contents|run-in|ruby|table-cell)\b|float\s*:\s*(?:left|right|inline-start|inline-end)\b/i;   // inline-level, a table cell, or floated: printed beside its neighbours
const ROW_DISPLAY = /display\s*:\s*(?:inline-)?(?:flex|grid)\b/i;   // a flex or grid container lays its children out side by side
const CONTENTS = /display\s*:\s*contents\b/i;   // the element's children take its place in its parent's layout
const MULTICOL = /(?:^|[;\s{])column-(?:count|width)\s*:\s*(?!auto\b)|(?:^|[;\s{])columns\s*:\s*(?!auto\b)/i;   // a multi-column container sets its blocks side by side
const POSITIONED = /position\s*:\s*(?:absolute|fixed)\b/i;   // taken out of the flow: may print beside anything
const PSEUDO_ELEMENT = /::?(?:before|after|marker|first-line|first-letter|placeholder|selection|backdrop)\b/i;
const sets = () => ({ tags: new Set(), classes: new Set(), ids: new Set(), all: false });
const KINDS = ['row', 'cols', 'pos', 'contents'];
export function inlineSelectors(css, acc = { ...sets(), row: sets() }) {
  for (const k of KINDS) if (!acc[k]) acc[k] = sets();
  for (const m of String(css).replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [rx, into, ownBox] of [[INLINE_DISPLAY, acc, false], [ROW_DISPLAY, acc.row, false], [MULTICOL, acc.cols, true], [POSITIONED, acc.pos, true], [CONTENTS, acc.contents, true]]) {
      if (!rx.test(m[2])) continue;
      for (const sel of m[1].split(',')) {
        const last = sel.trim().split(/[\s>+~]+/).pop() || '';
        if (ownBox && PSEUDO_ELEMENT.test(last)) continue;
        const cls = [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]); const ids = [...last.matchAll(/#([\w-]+)/g)].map((x) => x[1]); const tag = /^[a-zA-Z][\w-]*/.exec(last);
        if (cls.length) cls.forEach((c) => into.classes.add(c)); else if (ids.length) ids.forEach((c) => into.ids.add(c)); else if (tag && !/[\[:*]/.test(last)) into.tags.add(tag[0].toLowerCase()); else into.all = true;
      }
    }
  }
  return acc;
}
const merge2 = (a = sets(), b = sets()) => ({ tags: new Set([...a.tags, ...b.tags]), classes: new Set([...a.classes, ...b.classes]), ids: new Set([...a.ids, ...b.ids]), all: a.all || b.all });
export function mergeSelectors(a, b) {
  const out = merge2(a, b);
  for (const k of KINDS) out[k] = merge2(a[k], b[k]);
  return out;
}
export function cssOf(html) { return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'); }
const attr = (attrs, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
const VOID = /^(?:br|hr|img|input|meta|link|col|area|base|wbr|source|track|embed|param)$/;
const TAG = /<(\/?)([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
export function textByLayout(html, sel) {
  html = String(html).replace(/<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>/g, '\n');   // comments, doctype and processing instructions print nothing
  const text = (t) => t.replace(/\s+/g, ' ');   // source line breaks and blank lines collapse to one space, as a browser lays them out: only a block element ends a printed line
  const has = (S, el) => Boolean(S) && (S.all || S.tags.has(el.name) || el.cls.some((c) => S.classes.has(c)) || (el.id && S.ids.has(el.id)));
  // the element tree (an end tag closes the nearest open element of its name and everything opened inside it)
  const root = { name: '#root', kids: [], parent: null }; let cur = root; let last = 0;
  for (const m of html.matchAll(TAG)) {
    if (m.index > last) cur.kids.push({ text: html.slice(last, m.index) });
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) {
      let k = cur; while (k !== root && k.name !== name) k = k.parent;
      if (k !== root) { k.closed = true; cur = k.parent; } else cur.kids.push({ stray: name });
      continue;
    }
    const style = attr(m[3], 'style') || '';
    const el = { name, kids: [], parent: cur, cls: (attr(m[3], 'class') || '').split(/\s+/).filter(Boolean), id: attr(m[3], 'id'), closed: false };
    el.inline = INLINE_TAGS.has(name) || INLINE_DISPLAY.test(style) || has(sel, el) || Boolean(cur.row);   // the children of a flex or grid row print side by side
    el.row = ROW_DISPLAY.test(style) || has(sel.row, el);
    el.cols = MULTICOL.test(style) || has(sel.cols, el);
    el.pos = POSITIONED.test(style) || has(sel.pos, el);
    el.contents = CONTENTS.test(style) || has(sel.contents, el);
    el.item = Boolean(cur.row || cur.cols || (cur.contents && cur.item));   // laid out beside its siblings by its container
    cur.kids.push(el);
    if (!VOID.test(name) && !/\/\s*$/.test(m[3])) cur = el;
  }
  if (last < html.length) cur.kids.push({ text: html.slice(last) });
  // emission: every element ends a printed line unless inline; a side-by-side item or positioned element whose text is
  // one line is emitted as that one line, joined with its neighbours
  const base = (n) => {
    if (n.text != null) return text(n.text);
    if (n.stray) return INLINE_TAGS.has(n.stray) ? ' ' : '\n';
    const sep = n.inline ? ' ' : '\n';
    return sep + n.kids.map(emit).join('') + (n.closed ? sep : '');
  };
  const oneLine = (n) => { const t = base(n).split('\n').filter((l) => l.trim()); return t.length === 1 ? t[0] : null; };
  const emit = (n) => {
    if (n.text == null && !n.stray && (n.item || n.pos)) { const line = oneLine(n); if (line != null) return ' ' + line + ' '; }
    return base(n);
  };
  return root.kids.map(emit).join('');
}

// ---- printed lines, by geometry (scan-rendered.js) ----
// The words of a rendered PDF with their boxes (pdftotext -bbox, in reading order), page by page.
export function pdfWords(pdf) {
  const ent = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf-8', maxBuffer: 1 << 28 }).matchAll(/<page[^>]*>([\s\S]*?)<\/page>/g)]
    .map((pg) => [...pg[1].matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: ent(m[5]) })));
}
// Visual lines: words that sit on one baseline, left to right, whatever separates them on the page. A line is cut into
// runs where the space between two words is wider than a word space; a run that starts a table or text column is
// marked as a column start (see below).
export function visualLines(ws) {
  const lines = [];
  for (const w of [...ws].sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0)) {
    const h = w.y1 - w.y0; const l = lines.find((x) => Math.abs(x.base - w.y1) <= 0.3 * Math.max(h, x.h));
    if (l) l.words.push(w); else lines.push({ base: w.y1, h, words: [w] });
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0); l.runs = [];
    for (const w of l.words) { const r = l.runs[l.runs.length - 1]; if (r && w.x0 - r.x1 <= 0.9 * Math.min(w.y1 - w.y0, r.h)) { r.words.push(w); r.x1 = Math.max(r.x1, w.x1); } else l.runs.push({ x0: w.x0, x1: w.x1, h: w.y1 - w.y0, words: [w], line: l }); }
  }
  // a column is two-dimensional: the run lines up with a run on another line of the same region (up to four line
  // heights away), and on that line too there is text under the run to its left (a table row below a header, the next
  // lines of two text columns). One box of several lines beside another lines up only with itself. Alignment far away is
  // no evidence (two unrelated rows line up by chance); a table cell that holds one of the document's own fields is
  // recognised by its content instead (assembledLines).
  const runs = lines.flatMap((l) => l.runs);
  const textAt = (x0, x1, base, h) => ws.some((w) => w.x1 > x0 && w.x0 < x1 && Math.abs(w.y1 - base) <= 0.6 * h);
  for (const l of lines) l.runs.forEach((r, i) => {
    const left = l.runs[i - 1];
    r.column = i > 0 && runs.some((o) => o.line !== l && Math.abs(o.line.base - l.base) <= 4 * Math.max(l.h, o.line.h) && (Math.abs(o.x0 - r.x0) <= 1 || Math.abs(o.x1 - r.x1) <= 1 || Math.abs(o.x0 + o.x1 - r.x0 - r.x1) <= 2) && textAt(left.x0, left.x1, o.line.base, Math.max(l.h, o.line.h)));
  });
  return lines;
}
// Text assembled on a printed line. On every visual line, a run of six or more consecutive words is reported unless it
// is a verified sentence: words are exempt only where a verified sentence covers them (judged in reading order, so a
// sentence wrapped over two lines is covered on both) or where the document prints one of its own values (a name, an
// amount, a date: strings that differ between two seeds), a number or a month; the fictional plan names and the band
// are not text. A new table or text column ends the run, and so does a gap next to a table cell that holds one of the
// document's own data fields (fields: the normalized data strings of two or more words; the cell holds the whole field
// or a part of two or more of its words, e.g. "Full eye exam, returning patient | YES"). Short pieces of the tree
// (labels, template text, stock fragments) exempt nothing here: two pieces that print side by side as one line are
// judged as the line they make.
export function assembledLines(pages, { grams, verified, values = new Set(), band = '', fields = new Set() }) {
  const fieldParts = new Set();
  for (const f of fields) { const w = f.split(' ').filter(Boolean); if (w.length < 2) continue; for (let a = 0; a < w.length; a++) for (let b = a + 2; b <= w.length; b++) fieldParts.add(w.slice(a, b).join(' ')); }
  const MONTH = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/;
  const multi = [...values].filter((v) => words(v) >= 2).map((v) => v.split(' ')).sort((a, b) => b.length - a.length);
  const single = new Set([...values].filter((v) => words(v) === 1));
  const bandWords = norm(band).split(' ').filter(Boolean);
  const planWords = PLAN_NAMES.map((n) => n.split(/\s+/)); const bare = (t) => t.replace(/[,.;:()]+$/g, '');
  const found = [];
  pages.forEach((ws, p) => {
    for (let i = 0; i < ws.length; i++) for (const pn of planWords) if (i + pn.length <= ws.length && pn.every((x, j) => bare(ws[i + j].t) === bare(x))) { for (let j = 0; j < pn.length; j++) ws[i + j].plan = true; break; }
    const tok = [];
    for (const w of ws) { w.toks = []; if (w.plan) continue; const n = norm(w.t); if (!n) { if (/\d/.test(w.t)) { w.toks.push(tok.length); tok.push({ num: true }); } continue; } for (const t of n.split(' ')) { w.toks.push(tok.length); tok.push({ t }); } }   // a printed number (an amount, a date) is a value; punctuation alone is nothing
    const idx = tok.map((x, i) => (x.t ? i : -1)).filter((i) => i >= 0);
    const mark = (seq, k) => { for (let j = 0; j < seq.length; j++) tok[idx[k + j]].val = true; };
    for (let k = 0; k < idx.length; k++) { const v = multi.find((s) => k + s.length <= idx.length && s.every((x, j) => tok[idx[k + j]].t === x)); if (v) mark(v, k); if (single.has(tok[idx[k]].t)) tok[idx[k]].val = true; }
    for (let k = 0; bandWords.length && k + bandWords.length <= idx.length; k++) if (bandWords.every((x, j) => tok[idx[k + j]].t === x)) mark(bandWords, k);
    // coverage in reading order, as printed and with the document's one-word values and months stepped over (a value
    // printed where the reviewed sentence has a placeholder); multi-word values are left out as the reviewed form leaves them
    const kept = idx.filter((i) => !tok[i].val || single.has(tok[i].t));
    for (const c of [kept, kept.filter((i) => !(single.has(tok[i].t) || MONTH.test(tok[i].t)))])
      for (let k = 0; k + 5 <= c.length; k++) if (grams.has(c.slice(k, k + 5).map((i) => tok[i].t).join(' '))) for (let j = k; j < k + 5; j++) tok[c[j]].cov = true;
    // A sentence broken over two lines of one block ("<div>We mailed your refund</div><div>to another person</div>", or
    // ordinary wrapping) is one sentence: when a line of a single run ends without closing punctuation in an open run of
    // words, and the next line starts, left-aligned with it and directly below, with a lower-case word, the run carries over.
    let carry = null;
    const lineText = (l) => l.runs.map((r) => r.words.map((w) => w.t).join(' ')).join(' | ');
    for (const l of visualLines(ws)) {
      let span = []; const spans = [];
      const end = () => { if (span.length >= 6) spans.push(span.join(' ')); span = []; };
      const head = l.runs[0] && l.runs[0].words[0];
      let joined = null;
      if (carry && head && /^\p{Ll}/u.test(head.t) && l.base > carry.line.base && l.base - carry.line.base <= 1.8 * Math.max(l.h, carry.line.h) && Math.abs(l.runs[0].x0 - carry.line.runs[0].x0) <= 2 * Math.max(l.h, carry.line.h)) { span = carry.span.slice(); joined = carry.line; }
      carry = null;
      const runText = (r) => r.words.flatMap((w) => w.toks).filter((i) => tok[i].t).map((i) => tok[i].t).join(' ');
      const cell = l.runs.map((r) => fieldParts.has(runText(r)));
      for (const [k, r] of l.runs.entries()) {
        if (r.column || (k > 0 && (cell[k - 1] || cell[k]))) end();
        for (const w of r.words) for (const i of w.toks) {
          const x = tok[i];
          if (x.num || x.cov || x.val || MONTH.test(x.t) || /[^\x00-\u024F]/.test(x.t)) end(); else span.push(x.t);
        }
      }
      const tail = l.runs.length === 1 ? l.runs[0].words[l.runs[0].words.length - 1] : null;
      if (tail && span.length && span.length < 6 && !/[.!?:;]["')\]]*$/.test(tail.t)) carry = { span: span.slice(), line: l };
      end();
      for (const s of spans) if (!verified.includes(s)) found.push({ page: p + 1, text: s, line: (joined ? lineText(joined) + ' / ' : '') + lineText(l) });
    }
  });
  return found;
}
