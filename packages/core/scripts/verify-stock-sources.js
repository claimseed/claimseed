#!/usr/bin/env node
// verify-stock-sources.js — provenance check for printed text. Every sentence of >= 6 words found in the stock
// files (data/*/stock-content.json), scenario note text and the generator's own note strings must be either
// (a) present in a public-source snapshot (data/public-sources/*.txt), after normalization that ignores case,
//     punctuation, bracketed/braced placeholders, plan names and numbers, or
// (b) listed verbatim in data/original-sentences.json, the reviewed list of claimseed's own sentences.
// Anything else fails. --write-original rewrites data/original-sentences.json from the current unmatched set
// (use only when adding reviewed original text; the diff is what reviewers look at).
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
// --root DIR checks another copy of the package (used by test/verify-stock-sources.test.js to prove a lifted sentence fails).
const rootArg = process.argv.indexOf('--root');
const root = rootArg >= 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import { norm, words, loadPublic, loadOriginal, sentencesOf, PLAN_NAMES, inlineSelectors, mergeSelectors, cssOf, textByLayout } from './lib/provenance.js';
if (!fs.existsSync(path.join(root, 'data/public-sources'))) { console.error('verify-stock-sources: data/public-sources/ is not present (it is kept in the repository, not the npm package); run this check from a checkout'); process.exit(2); }
const pub = loadPublic(root);
const sentences = new Map(); // normalized sentence -> where
function addText(text, where) { for (const n of sentencesOf(text)) sentences.set(n, where); }
function walkJson(v, where) {
  if (typeof v === 'string') addText(v, where);
  else if (Array.isArray(v)) {
    v.forEach((x, i) => walkJson(x, where));
    // an array of strings is also judged as the run it prints as (a sentence split into short items)
    if (v.length > 1 && v.every((x) => typeof x === 'string')) addText(v.join(' '), where + ' (joined)');
  }
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'sources') continue; walkJson(x, where + '.' + k); }
}
for (const t of fs.readdirSync(path.join(root, 'data'))) {
  const p = path.join(root, 'data', t, 'stock-content.json'); if (fs.existsSync(p)) walkJson(JSON.parse(fs.readFileSync(p, 'utf-8')), `data/${t}/stock-content.json`);
}
for (const t of fs.readdirSync(path.join(root, 'scenarios'))) for (const f of fs.readdirSync(path.join(root, 'scenarios', t))) {
  const s = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', t, f), 'utf-8'));
  for (const m of s.mutations || []) if (m.args && m.args.note && m.args.note.text) addText(m.args.note.text, `scenarios/${t}/${f}`);
  if (s.description) addText(s.description, `scenarios/${t}/${f} description`);
}
// Every string literal in every source file under src/ ('…', "…" and `…` including multi-line template literals, with
// ${…} placeholders blanked) that reads like prose: six or more words after normalization. Code-looking literals
// (containing braces, semicolon-free statements, operators) are excluded by the normalization itself only when they
// carry fewer than six words, so a sentence with a semicolon or parentheses is still checked. Comments are removed
// first so an apostrophe in a comment cannot desync the pairing.
// Scanned: everything under src/generate/ and the render modules (the files whose strings reach a page); the CLI, browser
// launcher and printer carry only error messages and paths.
const generatorLiterals = [];
function walkSrc(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walkSrc(p, out); else if (p.endsWith('.js')) out.push(p); } return out; }
const srcFiles = [...(fs.existsSync(path.join(root, 'src/generate')) ? walkSrc(path.join(root, 'src/generate')) : []), ...['src/render.js', 'src/render-ma.js', 'src/layouts.js'].map((f) => path.join(root, f)).filter(fs.existsSync)];
for (const f of srcFiles) {
  const src = fs.readFileSync(f, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  // Literals are judged one by one, and ALSO as the runs they are concatenated into: consecutive literals
  // joined by '+' (or by ',' inside an array that is .join()ed) print as one string, so a sentence split into five-word
  // pieces is judged whole. A run is every maximal chain of literals whose separating source is only whitespace, '+',
  // ',' or line breaks; array chains count when the array is followed by .join( (anything else is separate strings).
  const lits = [];
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const lit = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' ');
    if (/=>|[{}]/.test(lit) && !/[.!?]\s*$/.test(lit)) continue;   // code inside a template literal (never a printed sentence)
    addText(lit, path.relative(root, f));
    lits.push({ lit, start: m.index, end: m.index + m[0].length }); generatorLiterals.push(lit);
  }
  let run = [];
  const flush = () => { if (run.length > 1) addText(run.map((x) => x.lit).join(' '), path.relative(root, f) + ' (concatenated)'); run = []; };
  for (let i = 0; i < lits.length; i++) {
    const between = i ? src.slice(lits[i - 1].end, lits[i].start) : '';
    const plus = /^\s*\+\s*$/.test(between);
    const comma = /^\s*,\s*$/.test(between) && /^\s*(?:,\s*)?\]\s*\.join\(/.test(src.slice(lits[i].end, lits[i].end + 400).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '').replace(/^(?:\s*,\s*)+/, ''));
    if (!(plus || comma)) flush();
    run.push(lits[i]);
  }
  flush();
}
// Prose in templates: text nodes of six or more words (everything outside tags and {{ }} / {% %} expressions).
function walkTpl(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walkTpl(p, out); else if (/\.(html|njk)$/.test(p)) out.push(p); } return out; }
// Stock values interpolated into a template are substituted before the text is judged, so a sentence spread over
// sibling stock keys printed side by side ({{ stock.a }} {{ stock.b }} ...) is judged as the sentence it prints as.
// A template under templates/<type>/ takes that type's stock file; a partial is tried against every stock file.
const STOCKS = {};
for (const t of fs.readdirSync(path.join(root, 'data'))) { const sp = path.join(root, 'data', t, 'stock-content.json'); if (fs.existsSync(sp)) STOCKS[t] = JSON.parse(fs.readFileSync(sp, 'utf-8')); }
// inline-level elements of every template's CSS: text is split into printed lines by layout
const TPL_INLINE = inlineSelectors((fs.existsSync(path.join(root, 'templates')) ? walkTpl(path.join(root, 'templates')) : []).map((f) => cssOf(fs.readFileSync(f, 'utf-8'))).join('\n'));
const textOfTpl = (rawHtml) => textByLayout(rawHtml.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\{%\s*block\s+extra_styles\s*%\}[\s\S]*?\{%\s*endblock\s*%\}|\{%\s*macro\s+\w*[sS]tyles\b[\s\S]*?\{%\s*endmacro\s*%\}|\{#[\s\S]*?#\}/g, ' ').replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<!--[\s\S]*?-->/g, '\n'), TPL_INLINE).replace(/&[a-z]+;|&#\d+;/gi, ' ');
const resolve = (obj, p) => p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function substituteStock(html, type) {
  const stocks = type && STOCKS[type] ? [STOCKS[type]] : Object.values(STOCKS);
  return html.replace(/\{\{\s*stock((?:\.\w+|\[\d+\])+)\s*(?:\|[^}]*)?\}\}/g, (m, p) => { for (const st of stocks) { const v = resolve(st, p); if (typeof v === 'string') return v; } return ' '; });
}
for (const f of fs.existsSync(path.join(root, 'templates')) ? walkTpl(path.join(root, 'templates')) : []) {
  const type = path.relative(path.join(root, 'templates'), f).split(path.sep)[0];
  const rawHtml = substituteStock(fs.readFileSync(f, 'utf-8'), STOCKS[type] ? type : null);
  for (const m of rawHtml.matchAll(/content\s*:\s*(["'])((?:(?!\1).){6,})\1/g)) addText(m[2], path.relative(root, f) + ' (css content)');
  // inline elements (<i>, <b>, <em>, <strong>, <span>, <a>, <sup>, <sub>, <u>, <small>, <abbr>, <br>) do not end a text
  // node: prose split by empty inline tags is judged whole; block tags become line breaks, except that a one-line
  // positioned box, column or flex/grid cell is joined with its neighbours (scripts/lib/provenance.js, textByLayout)
  const html = textByLayout(rawHtml.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\{%\s*block\s+extra_styles\s*%\}[\s\S]*?\{%\s*endblock\s*%\}|\{%\s*macro\s+\w*[sS]tyles\b[\s\S]*?\{%\s*endmacro\s*%\}|\{#[\s\S]*?#\}/g, ' ').replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<!--[\s\S]*?-->/g, ' '), TPL_INLINE);   // inline-level elements (by tag, style attribute or CSS rule) do not end a text node
  // text nodes: tags become line breaks, but a text node wrapped across source lines is one node (joined with spaces)
  for (const node of html.replace(/&[a-z]+;|&#\d+;/gi, ' ').split(/\n+/)) addText(node, path.relative(root, f));   // one printed line per block (textByLayout collapses source line breaks)
}
const catPath = path.join(root, 'reference-data/service-catalog.json');
if (fs.existsSync(catPath)) for (const svc of JSON.parse(fs.readFileSync(catPath, 'utf-8')).services || []) addText(svc.lay || '', 'reference-data/service-catalog.json');
// The printed text itself: every type and scenario is rendered through the real render path in capture mode (no
// browser; print.js hands each page's HTML to a hook), with two seeds. Random values are the strings that differ
// between the seeds; after they are removed, every LINE of printed text (block elements end lines, inline elements
// do not) with six or more words left must be covered by verified sentences — five-word runs of a public snapshot or
// a reviewed original — so a sentence assembled on the page from pieces that are short on their own (sibling stock
// keys, object fields, aliases, loops, macros) is judged as the sentence it prints as.
const originalPath = path.join(root, 'data/original-sentences.json');
const original = new Set(fs.existsSync(originalPath) ? JSON.parse(fs.readFileSync(originalPath, 'utf-8')).sentences : []);
const allStrings = (v, out = new Set()) => { if (typeof v === 'string') out.add(v.trim()); else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out)); return out; };
if (!process.argv.includes('--no-render') && fs.existsSync(path.join(root, 'src/index.js')) && path.resolve(root) === path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))) {
  const idx = await import(path.join(root, 'src/index.js')); const { printHooks } = await import(path.join(root, 'src/browser.js'));
  const { loadVerifiedSentences } = await import('./lib/provenance.js');
  const GRAMS = new Set(); for (const sent of loadVerifiedSentences(root)) { const w = sent.split(' '); for (let i = 0; i + 5 <= w.length; i++) GRAMS.add(w.slice(i, i + 5).join(' ')); }
  const MONTHS = new Set('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday'.split(' '));
  // the tree's own short strings: single words are free tokens; two-to-four-word pieces (labels, terms, the language
  // names before a tagline) cover their words — but a run of six or more consecutive words covered ONLY by such pieces
  // is a sentence assembled from fragments and is reported (a term before a verified sentence is fine)
  const FREE = new Set(['synthetic', 'specimen', 'generated', 'by', 'claimseed', 'for', 'software', 'testing', 'not', 'a', 'real', 'document', 'seed', ...MONTHS]); const SHORT = new Set();
  const pieces = (v) => String(v).split(/(?<=[.!?])\s+|\n+|;\s+|:\s+/).map(norm);
  const classify = (v) => { for (const n of pieces(v)) { const k = words(n); if (k === 1) FREE.add(n); else if (k >= 2 && k <= 5) SHORT.add(n); } };
  for (const st of Object.values(STOCKS)) for (const v of allStrings(st)) classify(v);
  for (const f of walkTpl(path.join(root, 'templates'))) for (const node of textOfTpl(fs.readFileSync(f, 'utf-8')).split('\n')) classify(node);
  for (const lit of generatorLiterals) classify(lit);   // generator constants ("This service was denied.")
  for (const n of original) if (words(n) <= 5) SHORT.add(n);
  const quiet = console.log; console.log = () => {};   // the renderers narrate their progress
  for (const w of norm(PLAN_NAMES.join(' ')).split(' ')) if (w) FREE.add(w);
  const SHORT_BY_LEN = new Map(); for (const g of SHORT) { const k = words(g); SHORT_BY_LEN.set(k, SHORT_BY_LEN.get(k) || new Set()); SHORT_BY_LEN.get(k).add(g); }
  const textOf = (html) => { const sel = mergeSelectors(inlineSelectors(cssOf(html)), TPL_INLINE); return textByLayout(html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' '), sel).replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, ' '); };   // printed lines by layout
  for (const type of Object.keys(idx.RENDERERS)) for (const scenario of idx.listScenarios(type)) {
    const stock = JSON.parse(fs.readFileSync(path.join(root, 'data', type, 'stock-content.json'), 'utf-8'));
    const pagesBySeed = {};
    for (const seed of ['vss-a', 'vss-b']) {
      const pages = []; printHooks.capture = (h) => pages.push(h);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vss-render-'));
      try { await idx.RENDERERS[type](idx.generateData({ type, scenario, seed }).data, stock, work, {}); } finally { printHooks.capture = null; fs.rmSync(work, { recursive: true, force: true }); }
      pagesBySeed[seed] = { pages, data: idx.generateData({ type, scenario, seed }).data };
    }
    const a = allStrings(pagesBySeed['vss-a'].data), b = allStrings(pagesBySeed['vss-b'].data);
    const random = new Set([...a].filter((v) => !b.has(v)).map(norm).filter((n) => words(n) >= 1));
    const freeHere = new Set([...random].filter((n) => words(n) === 1)); const randomMulti = [...random].filter((n) => words(n) >= 2).sort((x, y) => y.length - x.length);
    for (const html of pagesBySeed['vss-a'].pages) for (const line of textOf(html).split('\n')) {
      let n = norm(line); if (words(n) < 6) continue;
      for (const r of randomMulti) n = n.replace(new RegExp(`(^|\\s)${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g'), '$1 ');
      const w = n.split(' ').filter(Boolean); if (w.length < 6) continue;
      const covered = new Array(w.length).fill(false);
      for (const c of [w.map((_, i) => i), w.map((_, i) => i).filter((i) => !(freeHere.has(w[i]) || MONTHS.has(w[i])))])
        for (let k = 0; k + 5 <= c.length; k++) if (GRAMS.has(c.slice(k, k + 5).map((i) => w[i]).join(' '))) for (let j = k; j < k + 5; j++) covered[c[j]] = true;
      const nonLatin = w.map((x) => /[^\x00-\u024F]/.test(x));
      const short = new Array(w.length).fill(false);   // covered by a short tree string
      for (let i = 0; i < w.length; i++) for (const [L, set] of SHORT_BY_LEN) if (i + L <= w.length && set.has(w.slice(i, i + L).join(' '))) for (let j = i; j < i + L; j++) short[j] = true;
      const free = (x, i) => freeHere.has(x) || MONTHS.has(x) || FREE.has(x) || x.length <= 2 || nonLatin[i] || nonLatin[i - 1] || nonLatin[i + 1];
      const bad = w.filter((x, i) => !(covered[i] || short[i] || free(x, i)));
      let span = 0, maxSpan = 0;   // consecutive words whose only cover is a short tree string
      const breaker = (x, i) => freeHere.has(x) || MONTHS.has(x) || nonLatin[i];   // a printed value breaks a run of pieces; a short word does not
      for (let i = 0; i < w.length; i++) { if (!covered[i] && !breaker(w[i], i) && (short[i] || FREE.has(w[i]) || w[i].length <= 2)) { span++; maxSpan = Math.max(maxSpan, span); } else span = 0; }
      // uncovered words, or a sentence-length run assembled from short pieces: judged as the sentence it prints as
      // (a term before its short definition is reviewed once as that line; a lifted sentence spread over sibling keys is reported)
      if (bad.length || maxSpan >= 6 || original.has(w.join(' '))) sentences.set(w.join(' '), `${type}/${scenario} (rendered page text${maxSpan >= 6 ? ', assembled from short pieces' : ''})`);   // (a reviewed line keeps appearing once reviewed, so it is never dropped from the list)
    }
  }
  console.log = quiet;
}
const unmatched = [...sentences].filter(([n]) => !pub.includes(n));
const unknown = unmatched.filter(([n]) => !original.has(n));
const stale = [...original].filter((o) => !sentences.has(o));
if (process.argv.includes('--write-original')) {
  fs.writeFileSync(originalPath, JSON.stringify({ note: 'Reviewed original sentences (normalized). Regenerate with: node scripts/verify-stock-sources.js --write-original; the diff is what reviewers look at.', sentences: unmatched.map(([n]) => n).sort() }, null, 1) + '\n');
  console.log(`wrote ${unmatched.length} original sentences`); process.exit(0);
}
console.log(`verify-stock-sources: ${sentences.size} sentences; ${sentences.size - unmatched.length} verbatim from public sources; ${unmatched.length} original (${original.size} reviewed)`);
if (stale.length) console.log(`note: ${stale.length} reviewed original sentence(s) no longer appear anywhere`);
if (unknown.length) { console.error('sentences neither in a public source nor reviewed as original:'); for (const [n, w] of unknown) console.error(`  [${w}] ${n}`); process.exit(1); }

