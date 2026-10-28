#!/usr/bin/env node
// check-synthetic.js — repo-wide structural checks that run in public CI.
//  1. no binary file anywhere (detected by magic bytes and by non-UTF-8 content, not by extension) except the one
//     bundled fallback font; text-encoded images (EPS, PNM, XPM, large SVG, base64 payloads) count as binaries
//  2. every scenario has a non-empty sources[]
//  3. no real organization name anywhere (scripts/lib/brand-denylist.js; normalization defeats case/spacing/entity tricks)
//  4. no NPI-looking 10-digit number that is Luhn-valid with an 80840 prefix unless it starts with 9
//  5. no phone number outside (geographic) NNN-555-01xx, except the public federal lines printed on CMS forms
//  6. no data: URI carrying an image/font/PDF payload under any MIME label, no long base64 run that decodes to one,
//     no inline <svg> logo in any text file (binary smuggling); HTML entities and CSS escapes are decoded first
//  7. no non-ASCII decimal digit anywhere (a phone number written in Arabic-Indic or fullwidth digits), no word mixing
//     Latin letters with look-alike letters of another script (homoglyph brand names), no real-format MBI
// Rules shared with scan-rendered.js live in scripts/lib/text-rules.js so the tree and the rendered text are held to the same bar.
// Every text file is scanned regardless of extension; every hit in a file is reported.
import fs from 'fs'; import path from 'path';
import { luhnCheckDigit } from '../src/generate/identifiers.js';
import { findBrands } from './lib/brand-denylist.js';
import { repoRoot } from './lib/repo-root.js';
import { phoneProblems, mixedScriptWords, REAL_MBI, foldText } from './lib/text-rules.js';
import { magicType, textImageType, payloadProblems, decodeEscapes, TREE_UNKNOWN } from './lib/payloads.js';
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot();
const problems = [];
// The only file allowed to be binary is the bundled fallback font. Everything else must be UTF-8 text; example PDFs
// are rendered by CI and attached to releases, never committed.
const ALLOWED_BINARY = (r) => r === 'packages/core/fonts/ClaimseedNotdef-Regular.ttf';
// Decode HTML entities (semicolon optional) and CSS escapes (\69 = i) so "data:&#105;mage" and "data:\69mage" read as data:image.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', semi: ';', sol: '/', num: '#', period: '.', comma: ',', equals: '=', plus: '+', lpar: '(', rpar: ')', excl: '!', quest: '?', lowbar: '_', hyphen: '-', dash: '-', ndash: '-', mdash: '-', minus: '-', shy: '', zwsp: '', zwnj: '', zwj: '' };
function decodeText(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (NAMED[e.toLowerCase()] ?? m)))
          .replace(/\\([0-9a-f]{1,6})\s?/gi, (m, h) => { const cp = parseInt(h, 16); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; });
}
function isUtf8Text(buf) { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return false; } return !buf.subarray(0, 8192).includes(0); }
// The denylist and its bypass test are the only files allowed to contain the names they guard against; every OTHER
// rule (binaries, payloads, phones, identifiers, digits, scripts) still applies to them, and their fixtures are
// assembled at runtime from fragments so that they do not trip those rules.
const SELF = new Set(['packages/core/scripts/lib/brand-denylist.js', 'packages/core/test/denylist.test.js', 'packages/core/test/check-synthetic.test.js']);
// Only node_modules and .git are skipped, and only at any depth by exact name; nothing else is exempt.
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', '.git'].includes(e.name)) continue; const p = path.join(dir, e.name); e.isDirectory() ? walk(p, fn) : fn(p); } }
const rel = (p) => path.relative(ROOT, p);
let scanned = 0;
walk(ROOT, (p) => {
  const r = rel(p); const ext = path.extname(p).toLowerCase();
  const buf = fs.readFileSync(p); scanned++;
  const magic = magicType(buf) || textImageType(buf.toString('latin1'));
  if (magic || !isUtf8Text(buf)) {
    if (!ALLOWED_BINARY(r)) problems.push(`binary file (${magic || 'non-UTF-8'}) in the tree: ${r}`);
    return;
  }
  const t = buf.toString('utf-8');
  if (r.startsWith('packages/core/scenarios/') && ext === '.json') {
    const s = JSON.parse(t);
    if (!Array.isArray(s.sources) || !s.sources.length) problems.push(`scenario without sources[]: ${r}`);
  }
  // npm lockfile integrity values are random base64 digests (checked by npm ci on install); a short denylist entry can
  // turn up in one by chance, so those values alone, of exactly a digest's length, in the root package-lock.json alone,
  // are left out of the brand rule (every other rule still reads them)
  const brandText = r === 'package-lock.json'
    ? t.replace(/("integrity":\s*")(?:sha1-[A-Za-z0-9+/]{27}=|sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)(")/g, '$1$2') : t;
  if (!SELF.has(r)) for (const b of findBrands(decodeEscapes(brandText))) problems.push(`real organization name "${b}" in ${r}`);   // the denylist and its tests contain the very names they guard against
  for (const m of t.matchAll(/\b(\d{10})\b/g)) {
    const npi = m[1];
    if (npi[0] !== '9' && luhnCheckDigit('80840' + npi.slice(0, 9)) === +npi[9] && /npi|provider/i.test(t.slice(Math.max(0, m.index - 80), m.index + 20)))
      problems.push(`possible real-format NPI ${npi} in ${r} (synthetic NPIs start with 9)`);
  }
  // data/public-sources/ holds verbatim snapshots of federal documents (reference for verify-stock-sources.js, never
  // printed); they legitimately contain federal phone numbers, so the phone rule is not applied there. The brand rule is.
  const decoded = foldText(decodeText(decodeEscapes(t)));
  // payloads: the rules run over the raw text (and, inside, over its decoded form); decoded blobs that are text come back
  // and are held to every text rule below, as if they had been written in the clear (a base64 note, a JWT, a data:text URI)
  const recovered = [...new Set([...payloadProblems(t, r, problems), ...payloadProblems(decodeText(t), r, problems)])].map((x) => foldText(x));   // as written (octal escapes read as octal) and entity/CSS-decoded (data:&#105;mage)
  if (/data:\s*image\//i.test(decoded)) problems.push(`embedded data:image in ${r}`);
  if (/<svg[^>]*>[\s\S]{2000,}<\/svg>/i.test(decoded)) problems.push(`large inline svg in ${r}`);
  if (ext === '.svg' && buf.length > 16384) problems.push(`svg over 16 KB (an image, not an icon): ${r}`);
  for (const [text, where] of [[decoded, r], ...recovered.map((x, i) => [x, `${r} (decoded payload ${i + 1})`])]) {
    if (!r.startsWith('packages/core/data/public-sources/') || where !== r) phoneProblems(text, where, problems);
    if (where !== r) for (const b of findBrands(text)) problems.push(`real organization name "${b}" in ${where}`);
    const odd = text.match(/[^\x00-\x7F]/gu)?.filter((c) => /\p{Nd}/u.test(c));
    if (odd && odd.length) problems.push(`non-ASCII decimal digits (${[...new Set(odd)].join('')}) in ${where}`);
    for (const w of mixedScriptWords(text)) problems.push(`word mixing Latin with look-alike script letters "${w}" in ${where}`);
    for (const m of text.matchAll(REAL_MBI)) problems.push(`real-format Medicare number ${m[0]} in ${where} (synthetic MBIs carry the letter S)`);
    for (const m of text.matchAll(/\b(\d{10})\b/g)) { const npi = m[1]; if (where !== r && npi[0] !== '9' && luhnCheckDigit('80840' + npi.slice(0, 9)) === +npi[9]) problems.push(`possible real-format NPI ${npi} in ${where}`); }
  }
});
if (scanned === 0) { console.error('check-synthetic: scanned 0 files — refusing to pass'); process.exit(1); }
if (TREE_UNKNOWN.bytes >= 8192) problems.push(`${TREE_UNKNOWN.bytes} bytes of signature-less decoded blobs across the whole tree (a file spread over many files)`);
const unique = [...new Set(problems)];
if (unique.length) { console.error(unique.join('\n')); console.error(`\n${unique.length} problem(s)`); process.exit(1); }
console.log(`check-synthetic: ok (${scanned} files)`);
