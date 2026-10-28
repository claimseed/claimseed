// payloads.js — detection of files and text smuggled as TEXT. The rules are density-based rather than shape-based:
// every line is stripped of the syntax code wraps around an encoded line (quotes, commas, brackets, list / quote /
// comment markers, string concatenation, dump offsets and ASCII columns, 0x prefixes); runs of consecutive encoded
// lines are joined — whitespace inside a line is ignored when the line's character classes look like base64 (upper,
// lower and digits each strongly represented, which prose never shows once its spaces are removed) — and decoded as base64,
// base32, base85/ASCII85, hex, or a byte array (decimal, 0x, or Java-signed). JSON/JS escapes (\n to a newline, \uXXXX,
// \xXX, \NNN octal), quoted-printable and string-literal escapes are decoded first, and every rule runs over the text
// as written AND over its decoded form (a blob written as one escaped JSON string is only visible decoded; a hex dump's
// ASCII column or an ASCII85 stream is corrupted by decoding). A decoded blob with a file signature is a finding; a
// decoded blob that is printable text is returned for the ordinary text rules (a base64 note, a JWT); anything else of
// 1 KB or more — or more than 2 KB in total per file — is a finding, because nothing in this tree has a reason to hold
// one. Text-encoded bitmaps (PNM/XBM/XPM), PostScript, PDF objects and inline SVG with path data (vector-drawn text has
// no text layer) are matched anywhere in a file. Every function returns human-readable problem strings.
import zlib from 'zlib';
// Signatures are built from code points (not written as escapes) so that this file never trips its own escaped-binary rule.
const C = (...codes) => String.fromCharCode(...codes);
const MAGIC = [['%PDF', 'pdf'], [C(0x89) + 'PNG', 'png'], [C(0xff, 0xd8, 0xff), 'jpeg'], ['GIF8', 'gif'], ['RIFF', 'riff (webp/wav)'], ['II*' + C(0), 'tiff'], ['MM' + C(0) + '*', 'tiff'], ['BM', 'bmp'], ['PK' + C(3, 4), 'zip'], [C(0x1f, 0x8b), 'gzip'], ['wOFF', 'woff'], ['wOF2', 'woff2'], [C(0, 1, 0, 0), 'ttf'], ['OTTO', 'otf'], [C(0x7f) + 'ELF', 'elf'], ['MZ', 'exe'], ['Rar!', 'rar'], ['7z' + C(0xbc, 0xaf), '7z'], [C(0xd0, 0xcf, 0x11, 0xe0), 'ole (doc/xls)'], ['%!PS', 'postscript'], ['BZh', 'bzip2'], [C(0xfd) + '7zXZ', 'xz']];
export function magicType(buf) {
  const head = buf.subarray(0, 8).toString('latin1'); for (const [m, t] of MAGIC) if (head.startsWith(m)) return t;
  if (head.slice(4, 12).includes('ftyp')) return 'heic/mp4';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(buf.subarray(0, 400).toString('latin1'))) return 'svg';
  if (buf.length >= 2 && buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1])) {   // zlib stream: look inside
    try { const inner = zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); const t = magicType(inner); return t ? `zlib-compressed ${t}` : 'zlib stream'; } catch { /* not zlib */ }
  }
  return null;
}
// Text-encoded files that are really images or documents; matched anywhere in the text.
export function textImageType(t) {
  if (new RegExp('%PDF' + '-\\d[\\s\\S]*?\\b(?:obj|xref|trailer|stream)\\b').test(t)) return 'pdf (header not at offset 0)';
  if (/\b\d+ 0 obj\b[\s\S]{0,4000}\/Type\s*\/(?:Page|Catalog|XObject)\b/.test(t)) return 'pdf objects without a header';
  if (/^%!PS/m.test(t)) return 'postscript/eps';
  if (/^P[1-6]\s*(?:#[^\n]*\n\s*)*\d+\s+\d+\s/m.test(t)) return 'pnm (text image)';
  if (/^\/\*\s*XPM\s*\*\//m.test(t) || /static\s+(?:const\s+)?char\s*\*\s*\w+\[\]\s*=\s*\{\s*\n?\s*"\d+ \d+ \d+ \d+/m.test(t)) return 'xpm (text image)';
  if (/#define\s+\w+_width\s+\d+[\s\S]{0,200}#define\s+\w+_height\s+\d+/.test(t)) return 'xbm (text image)';
  if (/^begin\s+[0-7]{3}\s+\S+/m.test(t)) return 'uuencoded file';
  if (/<~[!-uz\s]{200,}~>/.test(t) || new RegExp('/ASCII85' + 'Decode\\b').test(t)) return 'ascii85 stream';
  if (/^Content-Transfer-Encoding:\s*(?:base64|quoted-printable)/mi.test(t) || /^Content-Disposition:\s*(?:attachment|inline)/mi.test(t)) return 'mime message with an attachment';
  if (/^=ybegin\b/m.test(t)) return 'yenc stream';
  if (/<svg\b[\s\S]*?<path\b[^>]*\bd\s*=[\s\S]*?<\/svg>/i.test(t)) return 'inline svg with path data (vector-drawn text has no text layer)';
  return null;
}
// Decode quoted-printable (only when the text is quoted-printable: '=' ends code lines too), JSON/JS/C \xXX, \uXXXX,
// \u{...} and \NNN octal escapes, \n and \r to real line breaks (a 76-column blob written as one JSON string is then the
// lines it is), \t \f \v to spaces, and escaped quotes and backslashes inside string literals.
export function decodeEscapes(t) {
  if (/quoted-printable/i.test(t) || (t.match(/=\r?\n/g) || []).length >= 5) t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return t.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([0-3][0-7]{2})/g, (m, a, b, c, o) => { const cp = o !== undefined ? parseInt(o, 8) : parseInt(a || b || c, 16); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; })
          .replace(/\\([nrtfvba'"\\]|0(?![0-9]))/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', b: '\b', a: '\x07', 0: '\0' })[c] ?? c);   // the C/JS single-character escapes, to the bytes they mean (a PNG header written as escapes stays a PNG header)
}
// ---- line stripping -----------------------------------------------------------------------------------------------
const LEAD_RE = /^\s*(?:(?:[-*>|+]\s+|(?:#|\/\/|;|--)\s*|\d+[.)]\s+)){0,3}/;                 // list, quote and comment markers ('+'/'-' only as bullets: they are base64 characters)
const TRAIL_COMMENT_RE = /\s+(?:\/\/|#|;|--)[^\n]*$/;                                       // a comment after the data
const PIPE_COL_RE = /\s*\|[^|]{1,16}\|\s*$/;                                                // hexdump -C's |....| column
const HEXDUMP_RE = /^(?:0x)?[0-9a-fA-F]{4,8}:?\s+((?:[0-9a-fA-F]{2,4}\s{0,2})*?[0-9a-fA-F]{2,4})(?:\s{2,}(?=.*[^0-9a-fA-F\s]).*)?$/;   // offset, hex groups, optional ASCII column (xxd, hexdump, od)
const LABEL_RE = /^(?:[\w.$/-]{1,32}(?:\s+[\w.$/-]{1,32}){0,3}\s*(?::|=(?!=))\s*)+(?=[^\s=])/;   // a key is short; '=' padding at the end of a base64 line is not a separator                     // key: / const x = before the data
export function stripLine(l) {
  let s = l.replace(/\s+$/, '').replace(LEAD_RE, '').replace(PIPE_COL_RE, '').replace(TRAIL_COMMENT_RE, '');
  const m = HEXDUMP_RE.exec(s); if (m) s = m[1];
  s = s.replace(/(['"`])\s*[+\\]\s*$/, '$1').replace(/\s+[+\\]\s*$/, '');                   // 'abc' + / "abc" \ (concatenation, continuation)
  s = s.replace(/['"`,;\[\]{}()\\|]/g, '').trim().replace(LABEL_RE, '').replace(/^\d{1,4}\s+(?=\S{12,})/, '');   // (a markdown table row is its cells; a row index before the data is not data)
  if (/^(?:0x[0-9a-fA-F]{1,2}\s*)+$/.test(s)) s = s.replace(/0x/g, '');
  return s;
}
const B64_ALPHA = /^[A-Za-z0-9+\/=_-]+$/, B32_ALPHA = /^[A-Z2-7=]+$/, HEX_ALPHA = /^[0-9a-fA-F]+$/;
const B85_ALPHA = /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]+$/, A85_ALPHA = /^[!-uz]+$/;
function classes(w) { let up = 0, lo = 0, dg = 0; for (const c of w) { if (/[A-Z]/.test(c)) up++; else if (/[a-z]/.test(c)) lo++; else if (/[0-9]/.test(c)) dg++; } const n = w.length || 1; return [up / n, lo / n, dg / n]; }
// Which alphabet a stripped line belongs to, or null. A line without interior whitespace is judged by alphabet alone;
// a line with interior whitespace (spaced base64, 'abc' + 'def' pieces) is judged with the whitespace removed and must
// also show the character-class mix of base64, which prose, Cased headings and CAPS forms never do. `cont` is the kind
// of the run in progress: a line that merely fits that alphabet continues it (a zero-heavy base64 line is mostly 'A').
export function kindOf(s, cont = null) {
  const toks = s.split(/[\s.:]+/).filter(Boolean);   // groups separated by whitespace, dots or colons
  const w = toks.join(''); if (w.length < (cont ? 8 : 12)) return null;   // a run continues on short lines (an array of 15-character strings, base64 wrapped at 12)
  const spaced = toks.length > 1;
  if (cont === 'b64' && B64_ALPHA.test(w) && (!spaced || toks.every((x) => x.length >= 2)) && (w.length >= 32 || (/[A-Z]/.test(w) && /[a-z0-9]/.test(w)))) return 'b64';   // a short continuation line must still look like base64, not a key or a path
  if (cont === 'hex' && HEX_ALPHA.test(w) && w.length % 2 === 0 && toks.every((x) => x.length % 2 === 0)) return 'hex';
  if (cont === 'b32' && B32_ALPHA.test(w.toUpperCase())) return 'b32';
  if (B64_ALPHA.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w)) {
    // to START a run a line must show the character-class mix of base64 (CamelCase identifiers and slugs do not);
    // inside a run (cont above) the alphabet alone is enough, so a zero-heavy header line still joins
    const [up, lo, dg] = classes(w);
    if (up >= 0.25 && lo >= 0.10 && dg >= 0.05 && (!spaced || toks.every((x) => x.length >= 2))) return 'b64';
  }
  if (HEX_ALPHA.test(w) && w.length % 2 === 0 && (w.match(/[a-fA-F]/g) || []).length >= 0.1 * w.length && toks.every((x) => x.length % 2 === 0)) return 'hex';
  if (B32_ALPHA.test(w.toUpperCase()) && (w.match(/[2-7]/g) || []).length >= 0.1 * w.length && /[A-Za-z]/.test(w) && (w === w.toUpperCase() || w === w.toLowerCase())) return 'b32';
  if (cont === 'b36' && /^(?:[0-9a-z]+|[0-9A-Z]+)$/.test(w)) return 'b36';
  if (!spaced && w.length >= 24 && /^(?:[0-9a-z]+|[0-9A-Z]+)$/.test(w) && (w.match(/[0-9]/g) || []).length >= 0.1 * w.length && (w.match(/[a-zA-Z]/g) || []).length >= 0.1 * w.length) return 'b36';   // one big base-36 number, wrapped
  return null;
}
// quotes, brackets, commas and pipes removed, nothing else: the reading for data in which a '+' or '//' group would
// otherwise be taken for a list bullet or a comment (base64 spaced every two characters)
const LABEL_SPACED_RE = /^(?:[\w.$/-]{1,32}(?:\s+[\w.$/-]{1,32}){0,3}\s*(?::\s+|=(?!=)\s*))+(?=[^\s=])/;   // the light reading strips a label only when whitespace follows the colon (colon-separated data groups are data)
const lightStrip = (l) => l.replace(/\s+$/, '').replace(/['"`,;\[\]{}()\\|]/g, '').trim().replace(LABEL_SPACED_RE, '').replace(/^\d{1,4}\s+(?=\S{12,})/, '');   // a key: label and a row index are never data
// base85 / ASCII85 are judged on the raw line (their alphabets include the quote and bracket characters stripLine
// removes): one unbroken token of 40+ characters with a good share of symbols, not a URL or a path.
function unquote85(raw) { const w = raw.trim(); const m = /^(['"])(.*)\1\s*[,;+]?$/.exec(w); return m ? m[2] : w; }
export function kindOf85(raw, cont = null) {
  const w = unquote85(raw);
  if (w.length < 16 || /\s/.test(w) || w.includes('://') || w.startsWith('http') || /^\.{0,2}\/[\w.-]*(?:\/|$)/.test(w)) return null;
  if (cont === 'b85' && B85_ALPHA.test(w)) return 'b85';
  if (cont === 'a85' && A85_ALPHA.test(w)) return 'a85';
  if (w.length < 40) return null;
  const sym = [...w].filter((c) => !/[A-Za-z0-9]/.test(c)).length / w.length;
  if (B85_ALPHA.test(w) && sym >= 0.12) return 'b85';
  if (A85_ALPHA.test(w) && sym >= 0.15) return 'a85';
  return null;
}
const MIN_RUN = { b64: 120, hex: 200, b32: 160, b85: 160, a85: 160, b36: 300 };
// [kind, joined] for every run of consecutive encoded lines of one kind (blank lines do not break a run; a short final
// line closes one); a single line long enough is a run of its own. 85 runs are emitted twice: verbatim, and unwrapped
// from quotes.
export function runs(t) {
  const out = []; const seen = new Set();
  for (const stripper of [stripLine, lightStrip]) for (const r of runsWith(t, stripper)) { const k = r[0] + ':' + r[1]; if (!seen.has(k)) { seen.add(k); out.push(r); } }   // both readings are decoded
  return out;
}
function runsWith(t, stripper) {
  const out = []; let run = []; let kind = null;
  const flush = () => {
    if (run.length) {
      if (kind === 'a85' || kind === 'b85') { for (const v of [0, 1]) { const j = run.map((x) => x.split('\x00')[v]).join(''); if (run.length >= 3 || j.length >= MIN_RUN[kind]) out.push([kind, j]); } }
      else { const j = run.join(''); if (run.length >= 3 || j.length >= MIN_RUN[kind]) { out.push([kind, j]); if (run.length >= 3 && run[run.length - 1].length < 16) out.push([kind, run.slice(0, -1).join('')]); } }
    }
    run = []; kind = null;
  };
  for (const raw of t.split('\n')) {
    const k85 = kindOf85(raw, kind);
    if (k85) { if (kind !== null && kind !== k85) flush(); kind = k85; run.push(raw.trim() + '\x00' + unquote85(raw)); continue; }
    const s = stripper(raw);
    if (s === '') { if (run.length) continue; flush(); continue; }
    let k = kindOf(s, kind);
    const w = s.replace(/[\s.:]+/g, '');
    if (k === null && run.length && kind === 'b64' && w.length < 16 && B64_ALPHA.test(w)) k = 'b64';   // short final line
    if (k !== null && (kind === null || k === kind)) { kind = k; run.push(w); continue; }
    flush();
    if (k !== null) { kind = k; run.push(w); }
  }
  flush(); return out;
}
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const out = []; let bits = 0, val = 0;
  for (const c of s.replace(/=+$/, '')) { const i = A.indexOf(c); if (i < 0) return null; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function decode85(s, A, zOk) {   // ASCII85 (A = null, z = four zero bytes) or RFC 1924 base85; null when a group overflows or a character is foreign
  const out = []; let grp = [];
  const push = (g, n) => { let v = 0; for (let i = 0; i < 5; i++) v = v * 85 + (i < g.length ? g[i] : 84); if (v > 0xffffffff) throw new Error('overflow'); out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n)); };
  try {
    for (const c of s) {
      if (zOk && c === 'z' && grp.length === 0) { out.push(0, 0, 0, 0); continue; }
      const d = A ? A.indexOf(c) : c.charCodeAt(0) - 33; if (d < 0 || d > 84) return null; grp.push(d); if (grp.length === 5) { push(grp, 4); grp = []; }
    }
    if (grp.length > 1) push(grp, grp.length - 1);
  } catch { return null; }
  return Buffer.from(out);
}
function bigToBytes(digits, radix) {   // a big integer written in `radix` digits, as its big-endian bytes (null when a digit is foreign)
  let n = 0n; const R = BigInt(radix);
  for (const c of digits.toLowerCase()) { const d = parseInt(c, 36); if (Number.isNaN(d) || d >= radix) return null; n = n * R + BigInt(d); }
  let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex');
}
const B85_TABLE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
const b64 = (p) => { try { return Buffer.from(p.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')), 'base64'); } catch { return Buffer.alloc(0); } };
// Decoded bytes that are text: UTF-8 (or Latin-1 without control bytes) with at least 95% printable characters, 24+ of
// them; or text written as UTF-16 / UTF-32 or padded with NUL bytes (unicodeText), read as such.
function printableCore(buf) {
  if (buf.length < 24) return null;
  let s; try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { if (buf.some((x) => x < 9)) return null; s = buf.toString('latin1'); }
  let ok = 0; for (const c of s) if (c === '\n' || c === '\r' || c === '\t' || !/[\p{Cc}\p{Cs}\p{Cn}]/u.test(c)) ok++;
  return ok >= 0.95 * s.length ? s : null;
}
export function printableText(buf) {
  const s = printableCore(buf); if (s !== null || !buf.includes(0)) return s;
  const v = unicodeText(buf); return v ? (printableCore(v) ?? readableCore(v)) : null;
}
// Short decoded text: six or more characters, at least 80% letters and spaces, a run of three letters, no control
// characters. Used for the contents of a compressed stream, whatever its length (UTF-16 / UTF-32 / NUL-padded too).
function readableCore(buf) {
  let s; try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
  if (s.length < 6 || /[\p{Cc}]/u.test(s.replace(/[\n\t\r]/g, ''))) return null;
  const letters = [...s].filter((c) => /[\p{L} ]/u.test(c)).length;
  return letters / [...s].length >= 0.8 && /\p{L}{3}/u.test(s) ? s : null;
}
export function readableShort(buf) {
  const s = readableCore(buf); if (s !== null || !buf.includes(0)) return s;
  const v = unicodeText(buf); return v ? (printableCore(v) ?? readableCore(v)) : null;
}
// Text written as UTF-16 or UTF-32 (a byte-order mark, or the zero bytes Latin text has in those encodings, at any
// alignment) or padded with NUL bytes before and after, re-encoded as UTF-8 when it is readable; else null. Storing
// such text compressed is ordinary, so a decoded stream is read this way before it is judged unreadable. Reads at most
// 256 KB.
const WIDE = [['utf-32le', 4, [1, 2, 3]], ['utf-32be', 4, [0, 1, 2]], ['utf-16le', 2, [1]], ['utf-16be', 2, [0]]];
function decodeWide(b, enc) {
  if (enc === 'utf-16le') return b.subarray(0, b.length - (b.length % 2)).toString('utf16le');
  if (enc === 'utf-16be') { const c = Buffer.from(b.subarray(0, b.length - (b.length % 2))); c.swap16(); return c.toString('utf16le'); }
  const n = b.length - (b.length % 4); let out = '';
  for (let i = 0; i < n; i += 4) { const cp = enc === 'utf-32le' ? b.readUInt32LE(i) : b.readUInt32BE(i); if (cp > 0x10ffff) return null; out += String.fromCodePoint(cp); }
  return out;
}
export function unicodeText(buf) {
  const b = buf.subarray(0, 1 << 18); if (!b.length || !b.includes(0)) return null;
  const views = [];
  const boms = [[[0xff, 0xfe, 0, 0], 'utf-32le'], [[0, 0, 0xfe, 0xff], 'utf-32be'], [[0xff, 0xfe], 'utf-16le'], [[0xfe, 0xff], 'utf-16be']];
  for (const [bom, enc] of boms) if (bom.every((x, i) => b[i] === x)) { const s = decodeWide(b.subarray(bom.length), enc); if (s !== null) views.push(Buffer.from(s.replace(/\0/g, ''), 'utf8')); break; }
  for (const [enc, w, zeros] of WIDE) for (let off = 0; off < w; off++) {
    const smp = b.subarray(off, off + 8192); let live = 0, good = 0;
    for (let i = 0; i + w <= smp.length; i += w) { let any = false; for (let k = 0; k < w; k++) if (smp[i + k]) any = true; if (!any) continue; live++; if (zeros.every((k) => smp[i + k] === 0)) good++; }
    if (live >= 3 && good >= 0.9 * live) { const s = decodeWide(b.subarray(off), enc); if (s !== null) views.push(Buffer.from(s.replace(/\0/g, ''), 'utf8')); }
  }
  const stripped = Buffer.from(b.toString('latin1').replace(/^\0+|\0+$/g, ''), 'latin1');   // NUL padding around the text (NULs inside are a binary format: tar, a database)
  if (stripped.length && !stripped.equals(b) && !stripped.includes(0)) views.push(stripped);
  for (const v of views) if (v.length && (printableCore(v) !== null || readableCore(v) !== null)) return v;
  return null;
}
// raw deflate (no zlib header) inflated when it opens and holds text or a file; a short stream when it inflates
// completely to readable text, or when it breaks off but what it yields up to there is readable text of eight or more
// characters (a truncated record); else null
function inflateRaw(b) {
  try {
    const x = zlib.inflateRawSync(b, { maxOutputLength: 1 << 24 }); if (!x.length) return null;
    if (magicType(x) || printableText(x)) return x;
    return readableShort(x) ? x : null;
  } catch {
    const x = partialInflateRaw(b.subarray(0, 65536));
    return x.length >= 8 && (magicType(x) || wordyText(x)) ? x : null;
  }
}
// Text that reads as words: readable (see readableShort), two or more words, five or more distinct letters, no letter
// above 40% of them. The evidence a broken-off stream must show (random bytes can inflate to "CCCCCCCC").
function wordyText(buf) {
  const s = readableShort(buf); if (!s) return false;
  const letters = [...s.toLowerCase()].filter((c) => /\p{L}/u.test(c)); const count = {};
  for (const c of letters) count[c] = (count[c] || 0) + 1;
  return s.split(/\s+/).filter((w) => /\p{L}{2}/u.test(w)).length >= 2 && Object.keys(count).length >= 5 && Math.max(...Object.values(count)) <= 0.4 * letters.length;
}
// A compressed stream recognised by its signature, however short (a gzip of one 20-byte record is 45 bytes): gzip
// (1f 8b 08 with valid flag bits), the full bzip2 and xz headers, zstd and lz4 frames — a payload even when the stream
// is damaged or truncated ('(damaged)'); the weak two-byte zlib header only when the stream opens, or when its deflate
// body still yields readable text. Its kind, else null.
export function compressedKind(b) {
  if (b.length >= 10 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8 && !(b[3] & 0xe0)) { try { zlib.gunzipSync(b); return 'gzip'; } catch { return 'gzip (damaged)'; } }
  const head = b.subarray(0, 10).toString('latin1');
  if (/^BZh[1-9]1AY&SY/.test(head)) return 'bzip2';
  if (head.startsWith(C(0xfd) + '7zXZ' + C(0))) return 'xz';
  if (head.startsWith(C(0x28, 0xb5, 0x2f, 0xfd))) return 'zstd';
  if (head.startsWith(C(0x04, 0x22, 0x4d, 0x18))) return 'lz4';
  if (b.length >= 2 && b[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b[1])) {
    try { zlib.inflateSync(b); return 'zlib stream'; } catch { const x = partialInflateRaw(b.subarray(2)); return x.length && (printableText(x) || readableShort(x)) ? 'zlib stream (damaged)' : null; }
  }
  return null;
}
// everything raw deflate yields before the stream breaks off or turns out corrupt
function partialInflateRaw(b) {
  try { return zlib.inflateRawSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { /* corrupt further in: keep what the prefix yields */ }
  let best = Buffer.alloc(0);
  for (let n = Math.min(b.length, 4096); n > 0; n = Math.floor(n * 0.75)) { try { best = zlib.inflateRawSync(b.subarray(0, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH }); break; } catch { /* shorter prefix */ } }
  return best;
}
// Brotli has no signature: a candidate is a Brotli stream when it decodes completely to readable text or a file, or
// when it is still producing output at the decoding budget (1 MiB). Decoding is bounded and tri-state: a stream over
// the budget is never mistaken for "not Brotli".
export const BROTLI_BUDGET = 1 << 20;
export function brotliKind(b) {
  if (b.length < 6 || b.length > 65536) return null;
  let x; try { x = zlib.brotliDecompressSync(b, { maxOutputLength: BROTLI_BUDGET }); } catch (e) { return e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 'brotli stream (over the decoding budget)' : null; }
  return x.length && (magicType(x) || printableText(x) || readableShort(x)) ? 'brotli stream' : null;
}
export const brotliText = (b) => brotliKind(b) !== null;
// Short encoded forms that line runs (with their minimum lengths) do not see: string literals (with a b'' / r'' / u'' /
// f'' / L"" / u8"" prefix too) joined by + / .. / || / & / commas / juxtaposition, runs of encoded-alphabet literals assembled
// through a little code between them (variables, .concat(), template interpolation: up to 60 characters on up to three
// lines between two literals), hex bytes separated by colons, dashes, underscores, commas or spaces (or prefixed 0x /
// \x), base32 tokens and evenly sized base32 groups, base64 groups of any widths, base64 wrapped over short lines, and
// short number lists in source or dump syntax (comma, semicolon, space or tab separated; decimal or hex; signed or not;
// casts and suffixes such as (byte)31 or 0x1fu), read as bytes, or as 16- / 32-bit words in either byte order when the
// values need them. Each decoding is [how, bytes]; only a compressed stream inside counts (candidates()).
const LIT_RE = /(?<![A-Za-z0-9_])(?:u8|[bBrRuUfFL]{1,2})?(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const LOOSE_GAP_RE = /^[^"'`\n]{0,60}(?:\n[^"'`\n]{0,60}){0,2}$/;
const ENC_LIT_RE = /^[A-Za-z0-9+\/=_-]{1,512}$/;
const GAP_RE = /^\s*(?:\+|\.\.|\|\||,|&)?\s*(?:\\\r?\n\s*)?$/;
const HEX_SEP_RE = /(?<![0-9A-Za-z])(?:(?:0x|\\x)?[0-9A-Fa-f]{2}(?:[ \t]*[:,;\-_][ \t]*|[ \t]+|(?=\\x|0x))){11,}(?:0x|\\x)?[0-9A-Fa-f]{2}(?![0-9A-Za-z])/g;
const B32_TOK_RE = /(?<![A-Za-z0-9=])(?:[A-Z2-7]{16,}|[a-z2-7]{16,})={0,6}(?![A-Za-z0-9=])/g;
const B32_GROUPS_RE = /(?<![A-Za-z0-9])(?:(?:[A-Z2-7]{2,8}[ \t-]){2,}[A-Z2-7]{1,8}|(?:[a-z2-7]{2,8}[ \t-]){2,}[a-z2-7]{1,8})={0,6}(?![A-Za-z0-9])/g;
const B64_GROUPS_RE = /(?<![A-Za-z0-9+\/])(?:[A-Za-z0-9+\/]{4,76}[ \t]){2,}[A-Za-z0-9+\/]{2,76}={0,2}(?![A-Za-z0-9+\/=])/g;
const NUM = String.raw`(?:\(\s*[A-Za-z_][\w ]{0,24}\)\s*)?[-+]?(?:0[xX][0-9a-fA-F]{1,8}|\d{1,10})(?:[uU][lL]{0,2}|[lL]{1,2}[uU]?)?`;
const NUM_LIST_RE = new RegExp(String.raw`(?<![\w.\-+])` + NUM + String.raw`(?:(?:[ \t]*[,;]\s*|[ \t]+)` + NUM + String.raw`){3,4095}(?![\w.])`, 'g');
const B64_LINE_RE = /^[ \t]*["']?([A-Za-z0-9+\/_-]{2,76}={0,2})["']?[ \t]*[,;+]?[ \t]*$/;
// The bytes a list of numbers can stand for: one byte each when every value fits a byte (signed or not), else 16- or
// 32-bit words in both byte orders when the values fit them (Uint16Array / Uint32Array); [] when too few for a stream.
export function numberListBytes(g) {
  const nums = [];
  for (const x of g.trim().split(/[ \t]*[,;]\s*|[ \t]+/)) {
    const m = /[-+]?(?:0[xX][0-9a-fA-F]+|\d+)/.exec(x.replace(/^\(\s*[A-Za-z_][\w ]{0,24}\)\s*/, ''));
    if (m) { const v = m[0].replace('+', ''); const neg = v.startsWith('-'); const a = neg ? v.slice(1) : v; const n = /^0[xX]/.test(a) ? parseInt(a.slice(2), 16) : parseInt(a, 10); nums.push(neg ? -n : n); }
  }
  const words = (w, bo) => { const b = Buffer.alloc(nums.length * w); nums.forEach((n, i) => { const u = w === 2 ? (n + 65536) % 65536 : (n + 2 ** 32) % 2 ** 32; if (w === 2) (bo === 'le' ? b.writeUInt16LE(u, i * 2) : b.writeUInt16BE(u, i * 2)); else (bo === 'le' ? b.writeUInt32LE(u, i * 4) : b.writeUInt32BE(u, i * 4)); }); return b; };
  if (nums.length >= 12 && nums.every((n) => n >= -128 && n <= 255)) return [['number list', Buffer.from(nums.map((n) => (n + 256) % 256))]];
  if (nums.length >= 6 && nums.every((n) => n >= -32768 && n <= 65535)) return [['16-bit number list', words(2, 'le')], ['16-bit number list', words(2, 'be')]];
  if (nums.length >= 4 && nums.every((n) => n >= -(2 ** 31) && n <= 2 ** 32 - 1)) return [['32-bit number list', words(4, 'le')], ['32-bit number list', words(4, 'be')]];
  return [];
}
// base64 wrapped over two to 64 short lines (each line one token of at most 76 characters), joined (at most 4096 characters)
export function wrappedBase64(t) {
  const out = []; let run = [];
  for (const line of [...t.split('\n'), '']) {
    const m = B64_LINE_RE.exec(line);
    if (m && run.length < 64) { run.push(m[1]); continue; }
    if (run.length >= 2) { const w = run.join('').slice(0, 4096); if (/[A-Z]/.test(w) && /[a-z]/.test(w) && /[0-9+\/]/.test(w)) out.push(w); }
    run = m ? [m[1]] : [];
  }
  return out;
}
export function joinedLiterals(t) {
  const out = []; let chain = []; let end = 0;
  for (const m of t.matchAll(LIT_RE)) {
    if (chain.length && GAP_RE.test(t.slice(end, m.index))) chain.push(m[2]);
    else { if (chain.length >= 2) out.push(chain.join('')); chain = [m[2]]; }
    end = m.index + m[0].length;
  }
  if (chain.length >= 2) out.push(chain.join(''));
  return out;
}
export function assembledLiterals(t) {
  t = t.replace(/`/g, ' ');   // the literals interpolated into a template literal are its parts
  const out = []; let chain = []; let end = 0;
  for (const m of t.matchAll(LIT_RE)) {
    const enc = ENC_LIT_RE.test(m[2]);
    if (chain.length && enc && chain.length < 64 && LOOSE_GAP_RE.test(t.slice(end, m.index))) chain.push(m[2]);
    else { if (chain.length >= 2) out.push(chain.join('').slice(0, 4096)); chain = enc ? [m[2]] : []; }
    end = m.index + m[0].length;
  }
  if (chain.length >= 2) out.push(chain.join('').slice(0, 4096));
  return out;
}
const evenGroups = (parts) => parts.length < 2 || new Set(parts.slice(0, -1).map((x) => x.length)).size === 1;
function decodings(str) {
  const out = []; const t = str.trim();
  const h = t.replace(/0x|\\x|[\s:,;\-_]/g, '');
  if (h.length >= 24 && h.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(h)) out.push(['hex', Buffer.from(h, 'hex')]);
  let w = t.replace(/[\s-]/g, '');
  if (w.length >= 16 && (/^[A-Z2-7]+=*$/.test(w) || /^[a-z2-7]+=*$/.test(w))) { for (let off = 0; off < 8; off++) { const d = b32decode(w.slice(off).toUpperCase()); if (d) { out.push(['base32', d]); break; } } }
  w = t.replace(/\s/g, '');
  if (w.length >= 16 && /^[A-Za-z0-9+\/_-]+={0,2}$/.test(w)) out.push(['base64', b64(w)]);
  return out;
}
export function shortForms(t) {
  const out = [];
  for (const j of joinedLiterals(t)) for (const [how, b] of decodings(j)) out.push([`joined-literal ${how}`, b]);
  for (const j of assembledLiterals(t)) for (const [how, b] of decodings(j)) out.push([`assembled-literal ${how}`, b]);
  for (const m of t.matchAll(HEX_SEP_RE)) for (const [how, b] of decodings(m[0])) if (how === 'hex') out.push(['separated hex', b]);
  for (const [re, name] of [[B32_TOK_RE, 'base32'], [B32_GROUPS_RE, 'grouped base32']]) for (const m of t.matchAll(re)) {
    const g = m[0]; const parts = g.replace(/=+$/, '').split(/[ \t-]+/);
    if (g === g.toLowerCase() && !/[2-7]/.test(g)) continue;   // a long lowercase word is not base32
    if (!evenGroups(parts)) continue;                           // encoded groups are evenly sized; words are not
    for (const [how, b] of decodings(g)) if (how === 'base32') out.push([name, b]);
  }
  for (const m of t.matchAll(B64_GROUPS_RE)) {
    const parts = m[0].split(/\s+/); const w = parts.join('');
    if (/[A-Z]/.test(w) && /[a-z]/.test(w) && /[0-9+\/]/.test(w)) out.push(['grouped base64', b64(w)]);   // prose groups never show base64's mix; groups of any widths (only a compressed stream inside counts)
  }
  for (const w of wrappedBase64(t)) out.push(['wrapped base64', b64(w)]);
  for (const m of t.matchAll(NUM_LIST_RE)) out.push(...numberListBytes(m[0]));   // signed or not, mixed too: only a compressed stream inside counts
  return out.filter(([, b]) => b && b.length >= 10);
}
const ESCAPED_MAGIC = new RegExp([C(0x89) + 'PNG', C(0xff, 0xd8, 0xff), 'GIF8[79]a', '%PDF' + '-[0-9]', C(0xd0, 0xcf, 0x11, 0xe0), 'PK' + C(3, 4), C(0x1f, 0x8b)].join('|'), 'g');
// Every decodable payload in t as [kind, bytes, how]; kind is null when the bytes carry no signature. Runs over the text
// as written and over its decoded form.
export function candidates(raw) {
  const seen = new Set(); const out = [];
  const emit = (b, how, min = 12) => { if (!b || b.length < min) return; const k = b.subarray(0, 64).toString('latin1') + ':' + b.length; if (seen.has(k)) return; seen.add(k); out.push([compressedKind(b) || magicType(b) || brotliKind(b), b, how]); };
  for (const t of [raw, decodeEscapes(raw).replace(/[\u200B-\u200F\u2060\uFEFF\u00AD]/g, '')]) {   // zero-width and soft-hyphen characters hide nothing
    if (t !== raw) for (const m of t.matchAll(ESCAPED_MAGIC)) {   // a binary written as escapes (repr(bytes), a JS string of hex escapes, C octal): the decoded characters are the bytes
      let j = m.index; while (j < t.length && j - m.index < 4000000 && t.charCodeAt(j) < 256) j++;
      emit(Buffer.from(t.slice(m.index, j), 'latin1'), 'escape');
    }
    for (const m of t.matchAll(/data:([^,;"'\s]{0,80})(;[^,"'\s]{0,40})*,([A-Za-z0-9+\/=_\-%\s"'\\]{8,})/gi)) emit(b64(m[3].replace(/[\s"'\\]+/g, '')), `data: URI with ${(m[1] || 'no').toLowerCase()} MIME type`);
    for (const m of t.matchAll(/[A-Za-z0-9+\/=_-]{20,}/g)) {   // one long token anywhere (120+), or a shorter one (20+: a JWT segment, a compressed record) that decodes to text or to a compressed stream that opens
      const p = m[0]; if (!(/[a-z]/.test(p) && /[A-Z]/.test(p))) continue;
      const b = b64(p); if (p.length >= 120 || compressedKind(b) || inflateRaw(b) || brotliText(b) || (p.length >= 32 && printableText(b))) emit(b, 'base64', 10);
    }
    for (const m of t.matchAll(/[A-Za-z0-9+\/=_-]{16,19}/g)) { const b = b64(m[0]); if (/[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && (compressedKind(b) || brotliText(b))) emit(b, 'base64', 10); }
    for (const [how, b] of shortForms(t)) if (compressedKind(b) || inflateRaw(b) || brotliText(b)) emit(b, how, 10);   // a short form counts only when it holds a compressed stream
    for (const m of t.matchAll(/(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}){12,}(?![0-9A-Fa-f])/g)) {   // a compressed stream written as one hex string
      const b = Buffer.from(m[0], 'hex'); if (compressedKind(b) || (b.length < 200 && (inflateRaw(b) || brotliText(b)))) emit(b, 'hex', 10);
    }
    for (const [kind, p] of runs(t)) {
      let b = null;
      if (kind === 'b64') b = b64(p); else if (kind === 'b32') b = b32decode(p.toUpperCase()); else if (kind === 'hex') b = p.length % 2 ? null : Buffer.from(p, 'hex'); else if (kind === 'b85') b = decode85(p, B85_TABLE, false); else if (kind === 'a85') b = decode85(p, null, true); else if (kind === 'b36') b = bigToBytes(p, 36);
      if (b) emit(b, kind === 'b64' ? 'base64' : kind === 'b32' ? 'base32' : kind);
    }
    // byte arrays: 64+ small integers in a row, comma separated (xxd -i, Uint8Array.from([...]), Java signed byte[])
    for (const m of t.matchAll(/(?<![\d.])(?:(?:0x[0-9a-fA-F]{1,2}|-?\d{1,3})(?:\s*[,;]\s*|\s+)){63,}(?:0x[0-9a-fA-F]{1,2}|-?\d{1,3})(?![\d.])/g)) {   // comma, semicolon or whitespace separated (xxd -i, od -tu1)
      const nums = m[0].trim().split(/\s*[,;]\s*|\s+/).filter(Boolean).map((x) => (x.toLowerCase().startsWith('0x') ? parseInt(x, 16) : parseInt(x, 10)));
      if (nums.every((n) => n >= -128 && n <= 255)) emit(Buffer.from(nums.map((n) => (n + 256) % 256)), 'byte-array');
    }
    // one big number: a hex or decimal BigInt literal holding the bytes of a file
    for (const m of t.matchAll(/\b0x([0-9a-fA-F]{400,})n?\b/g)) emit(Buffer.from(m[1].length % 2 ? '0' + m[1] : m[1], 'hex'), 'bigint');
    for (const m of t.matchAll(/(?<![\w.])(\d{300,})n?(?![\w.])/g)) emit(bigToBytes(m[1], 10), 'bigint');
  }
  return out;
}
// Problems for every payload in t, and the decoded texts (for the caller's text rules). Nothing in this tree has a reason
// to hold an encoded file of any kind, so every data: URI and every recovered image/document is a problem; a decoded
// blob with no signature is a problem at 1 KB, or at 2 KB in total per file (a chunked file).
export const TREE_UNKNOWN = { bytes: 0 };   // signature-less decoded blobs (200 B .. 1 KB each) across every file of a run: chunks spread over many files add up
export function payloadProblems(t, r, out, depth = 0) {
  const texts = []; let unknownTotal = 0;
  for (const m of t.matchAll(/data:([^,;"'\s]{0,80})(;[^,"'\s]{0,40})*,([A-Za-z0-9+\/=_\-%\s"'\\]{8,})/gi)) {
    const mime = (m[1] || '').toLowerCase(); const payload = m[3].replace(/[\s"'\\]+/g, '');
    if (/^(image|font|application|video|audio)\//.test(mime) || mime === '') out.push(`data: URI with ${mime || 'no'} MIME type in ${r}`);
    else if (payload.length > 512) out.push(`data: URI with a ${payload.length}-character payload in ${r}`);   // a text MIME label does not make a long payload legitimate here; its decoded text is scanned too
  }
  for (const [kind, b, how] of candidates(t)) {
    if (kind) { out.push(`${how}-encoded ${kind} in ${r}`); continue; }
    const inner = inflateRaw(b);   // raw deflate: judged by what is inside
    if (inner && magicType(inner)) { out.push(`${how}-encoded deflated ${magicType(inner)} in ${r}`); continue; }
    if (inner) { out.push(`${how}-encoded deflate stream in ${r}`); texts.push(inner.toString('utf8')); continue; }   // compressed text has no reason to be in this tree either
    const txt = printableText(inner || b);
    if (txt !== null) { texts.push(txt); if (depth < 3) texts.push(...payloadProblems(txt, `${r} (decoded)`, out, depth + 1)); continue; }   // base64 of base64: the decoded text is judged again
    if (b.length >= 1024) out.push(`${b.length}-byte ${how} blob of unknown type in ${r}`); else if (b.length >= 200) { unknownTotal += b.length; TREE_UNKNOWN.bytes += b.length; }
  }
  if (unknownTotal >= 2048) out.push(`${unknownTotal} bytes of encoded blobs of unknown type in total (a chunked file) in ${r}`);
  return texts;
}
