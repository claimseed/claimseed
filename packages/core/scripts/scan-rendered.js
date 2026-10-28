#!/usr/bin/env node
// scan-rendered.js — render every scenario of every wired layout for N seeds and scan the extracted text with the
// same rules check-synthetic.js applies to the tree (scripts/lib/text-rules.js): real organization names
// (scripts/lib/brand-denylist.js), NPIs that do not start with 9, phone numbers outside geographic NNN-555-01xx
// (federal lines excepted), real-format Medicare numbers, homoglyph words — and, on EVERY page, the specimen band
// and watermark. Runs in CI on every push.
//   node scripts/scan-rendered.js [--seeds 3] [--type msn]
import fs from 'fs'; import os from 'os'; import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findBrands } from './lib/brand-denylist.js';
import { phoneProblems, mixedScriptWords, REAL_MBI } from './lib/text-rules.js';
import { luhnCheckDigit } from '../src/generate/identifiers.js';
import { listScenarios } from '../src/generate/index.js';
import { RENDERERS } from '../src/layouts.js';
import { watermarkRectsPerPage } from './lib/pdf-markers.js';
import { norm, words, loadPublic, loadOriginal, loadVerifiedSentences, PLAN_NAMES, inlineSelectors, cssOf, textByLayout, pdfWords, assembledLines } from './lib/provenance.js';
import { generateData } from '../src/generate/index.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const seeds = Number(flag('seeds', 2)); const only = flag('type', null);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const problems = []; let rendered = 0;
// Provenance of the printed text itself (not of the literals that produce it). The printed text is normalized and
// then BLANKED, whole string by whole string, of everything the tree is allowed to print beside prose: the document's
// own random values (names, addresses, identifiers, amounts — the strings that change between two seeds of the same
// scenario), the tree's own short strings (template text nodes, stock labels, catalog and scenario strings of fewer than
// six words), the band and the fictional plan names. Each blank is a separator no word run may cross. Every run of six
// consecutive words that survives must occur verbatim in a public-source snapshot or in the reviewed original
// sentences; a tree-sourced data string of six or more words (a generator constant, a catalog description, a scenario
// note) must be there as a whole. Only single-word labels are allowed as free tokens — never the words of longer
// strings, so a sentence composed from the vocabulary of the tree's own labels is reported.
// A sentence assembled from several whole short strings printed side by side (positioned boxes, columns, grid cells) is
// judged by geometry: the words of the PDF are grouped into the lines they print on, and on every line a run of six or
// more words must be verified text, except where the document's own values (names, amounts, dates), numbers, the start
// of a table or text column, or a table cell holding one of the document's data fields separate it
// (scripts/lib/provenance.js, assembledLines). verify-stock-sources.js judges the same assemblies at the source
// (concatenations, arrays, inline-split and side-by-side template text).
const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = fs.existsSync(path.join(CORE, 'data/public-sources')) ? loadPublic(CORE) : null;
const ORIGINAL = loadOriginal(CORE);
const VERIFIED = PUB ? PUB + ' \n ' + [...ORIGINAL].join(' \n ') : '';
// coverage unit: every run of five consecutive words inside a verified sentence (a verified sentence that norm() has
// mangled at a bracketed insertion still covers the words around it; a sentence that is only partly verified is covered
// only in its verified part)
const GRAMS = new Set();
if (PUB) for (const sent of loadVerifiedSentences(CORE)) { const w = sent.split(' '); for (let i = 0; i + 5 <= w.length; i++) GRAMS.add(w.slice(i, i + 5).join(' ')); }
const SEP = ' | ';
const FREE = new Set();        // single-word labels (free tokens)
const SHORT = new Set();       // the tree's own strings of two to five words (blanked whole)
function allStrings(v, out = new Set()) {
  if (typeof v === 'string') out.add(v.trim());
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}
// a string is classified by its sentences, as verify-stock-sources judges it: pieces of one word are free tokens, pieces
// of two to five words are blanked whole, pieces of six or more words must be verified text (judged at the source)
const pieces = (v) => String(v).split(/(?<=[.!?])\s+|\n+|;\s+/).map(norm);
const classify = (v) => { for (const n of pieces(v)) { const w = words(n); if (w === 1) FREE.add(n); else if (w >= 2 && w < 6) SHORT.add(n); } };
for (const t of fs.readdirSync(path.join(CORE, 'data'))) {
  const sp = path.join(CORE, 'data', t, 'stock-content.json');
  if (fs.existsSync(sp)) for (const v of allStrings(JSON.parse(fs.readFileSync(sp, 'utf-8')))) classify(v);   // a stock SENTENCE is neither free nor blanked: it must be verified text
}
function walkTpl(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walkTpl(p, out); else if (/\.(html|njk)$/.test(p)) out.push(p); } return out; }
const TPL_INLINE = inlineSelectors(walkTpl(path.join(CORE, 'templates')).map((f) => cssOf(fs.readFileSync(f, 'utf-8'))).join('\n'));
for (const f of walkTpl(path.join(CORE, 'templates'))) {
  const html = textByLayout(fs.readFileSync(f, 'utf-8').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/\{%\s*block\s+extra_styles\s*%\}[\s\S]*?\{%\s*endblock\s*%\}|\{%\s*macro\s+\w*[sS]tyles\b[\s\S]*?\{%\s*endmacro\s*%\}|\{#[\s\S]*?#\}/g, ' ').replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|<!--[\s\S]*?-->/g, '\n'), TPL_INLINE);   // a template's text nodes as laid out: an inline-level element does not end a piece, so a sentence split across inline blocks is never a set of short blanks
  for (const node of html.replace(/&[a-z]+;|&#\d+;/gi, ' ').split(/\n/)) classify(node);
}
for (const w of norm('synthetic specimen generated by claimseed for software testing not a real document seed ' + PLAN_NAMES.join(' ')).split(' ')) if (w) FREE.add(w);   // the band, and the fictional plan names (which norm() blanks)
const MONTHS = new Set('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday'.split(' '));   // date formatting output
for (const w of MONTHS) FREE.add(w);
// occurrences of a normalized string in a token list (whole-word, longest strings first): the token indices covered
function occurrences(tokens, strings) {
  const hit = new Array(tokens.length).fill(false);
  const byLen = new Map();
  for (const g of strings) { const w = g.split(' ').filter(Boolean); if (w.length) byLen.set(w.length, [...(byLen.get(w.length) || []), w.join(' ')]); }
  const sets = [...byLen.entries()].sort((a, b) => b[0] - a[0]).map(([L, arr]) => [L, new Set(arr)]);
  for (let i = 0; i < tokens.length; i++) for (const [L, set] of sets) if (i + L <= tokens.length && set.has(tokens.slice(i, i + L).join(' '))) { for (let k = i; k < i + L; k++) hit[k] = true; break; }
  return hit;
}
function provenanceProblems(text, data, dataAlts, where, out) {
  if (!PUB) return new Set();
  // the document's strings: random values differ between seeds; what every seed prints identically came from the tree
  // (several alternative seeds, so a value two seeds happen to share — the same fictional facility — is still a value)
  const a = allStrings(data), bs = dataAlts.map((d) => allStrings(d));
  const random = new Set(), tree = new Set();
  for (const v of a) for (const n of pieces(v)) (bs.every((b) => b.has(v)) ? tree : random).add(n);
  const printed = norm(text.replace(/\f/g, ' '));
  for (const n of tree) if (words(n) >= 6 && !VERIFIED.includes(n) && printed.includes(n)) out.push(`${where}: data string neither public nor reviewed original: "${n.slice(0, 120)}"`);   // a tree-sourced string that reaches the page (ground-truth-only fields are judged at the source)
  for (const n of tree) if (words(n) === 1) FREE.add(n);   // single-word tree strings (department names, codes) are labels
  // 1. the document's own random values are REMOVED (a verified sentence that carries a value in a placeholder then reads as the reviewed form)
  const all = printed.split(' ').filter(Boolean);
  const rm = occurrences(all, [...random].filter((n) => words(n) >= 2));   // single-word values ("May", a surname) are free tokens below, never removed from inside a sentence
  const freeHere = new Set([...random].filter((n) => words(n) === 1));
  const w = all.filter((_, i) => !rm[i]);
  // 2. coverage by verified sentences of four or more words (longest match first), computed before any label is blanked,
  //    so a sentence that contains a label is still seen whole; a run is accepted where verified sentences meet end to end
  const covered = new Array(w.length).fill(false);
  const skip = (x) => freeHere.has(x) || MONTHS.has(x);   // a value printed where the reviewed sentence has a placeholder: stepped over when matching
  for (const c of [w.map((_, i) => i), w.map((_, i) => i).filter((i) => !skip(w[i]))])   // as printed, and with the values stepped over
    for (let a = 0; a + 5 <= c.length; a++) if (GRAMS.has(c.slice(a, a + 5).map((i) => w[i]).join(' '))) for (let k = a; k < a + 5; k++) covered[c[k]] = true;
  // a Latin word inside non-Latin text ("agent", "Mandarin" in the Chinese tagline) is part of a sentence whose words the
  // extraction does not delimit reliably; those sentences are verified at the source
  const nonLatin = w.map((x) => /[^\x00-\u024F]/.test(x));
  for (let i = 0; i < w.length; i++) if (!covered[i] && (nonLatin[i] || nonLatin[i - 1] || nonLatin[i + 1] || nonLatin[i - 2] || nonLatin[i + 2])) covered[i] = true;
  // 3. the tree's own short strings (labels, short stock and data pieces, the band) are blanks no window may cross
  const blankTok = occurrences(w, [...SHORT, ...[...tree].filter((n) => words(n) >= 2 && words(n) < 6), norm(where)].filter((n) => n.length >= 3));
  const unknown = new Set();
  for (let i = 0; i + 6 <= w.length; i++) {
    const g = w.slice(i, i + 6);
    if (g.some((x, k) => blankTok[i + k])) continue;
    if (g.filter((x) => /[^\x00-\u024F]/.test(x)).length >= 2) continue;   // non-Latin runs have no word boundaries in extraction (their stock sentences are verified at the source)
    const ok = (k) => covered[i + k] || FREE.has(g[k]) || freeHere.has(g[k]) || g[k].length <= 2 || /[^\x00-\u024F]/.test(g[k]);   // single-word labels and values
    if (g.every((x, k) => ok(k))) continue;
    const run = g.join(' ');
    if (!VERIFIED.includes(run)) unknown.add(run);
  }
  for (const n of unknown) out.push(`${where}: printed text neither public nor reviewed original: "${n}"`);
  return random;
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scan-'));
for (const type of Object.keys(RENDERERS)) {
  if (only && type !== only) continue;
  for (const scenario of listScenarios(type)) {
    for (let k = 1; k <= seeds; k++) {
      const seed = `scan-${k}`;
      execFileSync(process.execPath, [CLI, 'render', type, scenario, '--seed', seed, '--out', work], { stdio: ['ignore', 'ignore', 'inherit'] });
      const pdf = path.join(work, `${type}_${scenario}_${seed}.pdf`); rendered++;
      const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf-8' });
      const where = `${type}/${scenario} seed ${seed}`;
      const data = generateData({ type, scenario, seed }).data, dataAlts = ['-alt', '-alt2', '-alt3'].map((x) => generateData({ type, scenario, seed: seed + x }).data);
      const values = provenanceProblems(execFileSync('pdftotext', ['-raw', pdf, '-'], { encoding: 'utf-8' }), data, dataAlts, where, problems);
      if (PUB) {
        for (const f of assembledLines(pdfWords(pdf), { grams: GRAMS, verified: VERIFIED, values: new Set([...values].filter(Boolean)), band: `${type} ${scenario} seed ${seed}`, fields: new Set([...allStrings(data)].flatMap(pieces).filter((n) => words(n) >= 2)) }))
          problems.push(`${where}: printed line on page ${f.page} assembles text neither public nor reviewed original: "${f.text}" (printed as: ${f.line.slice(0, 160)})`);
      }
      for (const b of findBrands(text)) problems.push(`${where}: real organization name "${b}"`);
      for (const m of text.matchAll(/\b(\d{10})\b/g)) {
        const npi = m[1];
        if (npi[0] !== '9' && luhnCheckDigit('80840' + npi.slice(0, 9)) === +npi[9] && /npi/i.test(text.slice(Math.max(0, m.index - 40), m.index))) problems.push(`${where}: real-format NPI ${npi}`);
      }
      phoneProblems(text.normalize('NFKC'), where, problems);
      for (const m of text.matchAll(REAL_MBI)) problems.push(`${where}: real-format MBI ${m[0]}`);
      for (const w of mixedScriptWords(text)) problems.push(`${where}: word mixing scripts "${w}"`);
      const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }))?.[1] || 0);
      if (!pages) problems.push(`${where}: page count unreadable`);
      const rects = await watermarkRectsPerPage(pdf);
      for (let p = 1; p <= pages; p++) {
        const pt = execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), pdf, '-'], { encoding: 'utf-8' }).replace(/\s+/g, '');
        if (!pt.includes('SYNTHETICSPECIMEN')) problems.push(`${where}: specimen band missing on page ${p}`);
        if (!(rects[p - 1] >= 100)) problems.push(`${where}: watermark missing on page ${p}`);
      }
      fs.rmSync(pdf, { force: true }); fs.rmSync(pdf.replace(/\.pdf$/, '.ground-truth.json'), { force: true });
    }
  }
}
fs.rmSync(work, { recursive: true, force: true });
if (problems.length) { console.error([...new Set(problems)].join('\n')); console.error(`\n${problems.length} problem(s) in ${rendered} rendered documents`); process.exit(1); }
console.log(`scan-rendered: ok (${rendered} documents, ${seeds} seed(s) per scenario)`);
