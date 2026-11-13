// Every way a blind document could tell a tool what was planted in it, checked from the outside: file names, the PDF's
// text (pdftotext), its document information and XMP metadata (pdfinfo, pdfinfo -meta), its raw bytes, every stream
// decoded (object streams, the structure tree, content and metadata streams), every string and name of the PDF's own
// syntax decoded, in the file and in every stream as stored and as decoded (pdfStrings: escaped literals, hex strings,
// UTF-16 and UTF-8 text, #xx in names), every stream's text with NUL bytes left out and XML character references
// decoded, page images (raw bytes and their PNG tEXt / JPEG comment and Exif markers, read independently of
// the writer), and any text a tool hands back (an MCP result, an 835). A token is a scenario name, an error kind, a
// decoy rule or the seed asked for.
import fs from 'fs'; import path from 'path'; import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { readPng, readJpeg } from './markers-read.js';

const lower = (s) => String(s).toLowerCase();
function hits(where, haystack, tokens) {
  const h = lower(haystack); return tokens.filter((t) => t && h.includes(lower(t))).map((token) => ({ where, token }));
}

// the body of every stream of a PDF, in file order, and the file's text with those bodies left out
function streamBodies(bytes) {
  const s = bytes.toString('latin1'); const bodies = []; const rest = []; let from = 0; const re = /(?<!end)stream\r?\n/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length; const end = s.indexOf('endstream', start); if (end < 0) break;
    bodies.push(bytes.subarray(start, end)); rest.push(s.slice(from, start)); from = end;
    re.lastIndex = end + 'endstream'.length;
  }
  rest.push(s.slice(from));
  return { bodies, rest: rest.join('\n') };
}
const inflate = (b) => { try { return zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; } };
// ASCIIHexDecode and ASCII85Decode, each only for a body that is wholly in its alphabet (else null)
function asciiHex(b) {
  const t = b.toString('latin1'); if (!/^[0-9A-Fa-f\s]*>?\s*$/.test(t) || !/[0-9A-Fa-f]/.test(t)) return null;
  const d = t.replace(/[^0-9A-Fa-f]/g, ''); return Buffer.from(d.length % 2 ? `${d}0` : d, 'hex');
}
function ascii85(b) {
  const t = b.toString('latin1'); if (!/^[!-uz\s]*(~>)?\s*$/.test(t) || !/[!-uz]/.test(t)) return null;
  const out = []; let tuple = 0; let count = 0;
  for (const ch of t.replace(/\s/g, '').replace(/~>$/, '')) {
    if (ch === 'z' && count === 0) { out.push(0, 0, 0, 0); continue; }
    if (ch === 'z') return null;
    tuple = tuple * 85 + (ch.charCodeAt(0) - 33); count++;
    if (count === 5) { out.push(Math.floor(tuple / 2 ** 24) % 256, Math.floor(tuple / 2 ** 16) % 256, Math.floor(tuple / 2 ** 8) % 256, tuple % 256); tuple = 0; count = 0; }
  }
  if (count === 1) return null;
  if (count > 1) { for (let k = count; k < 5; k++) tuple = tuple * 85 + 84; out.push(...[Math.floor(tuple / 2 ** 24) % 256, Math.floor(tuple / 2 ** 16) % 256, Math.floor(tuple / 2 ** 8) % 256, tuple % 256].slice(0, count - 1)); }
  return Buffer.from(out);
}

// every stream of a PDF, decoded, each as a latin1 text: Flate, ASCIIHex, ASCII85, and either of the two ASCII filters
// followed by Flate. Read without the stream's dictionary, so a filter it names wrongly or leaves out hides nothing;
// a stream none of them decodes is left out (its raw bytes are searched with the file's).
export function decodedStreams(bytes) {
  const out = [];
  for (const body of streamBodies(bytes).bodies) {
    const flat = inflate(body); if (flat) out.push(flat.toString('latin1'));
    for (const text of [asciiHex(body), ascii85(body)]) if (text) { out.push(text.toString('latin1')); const inner = inflate(text); if (inner) out.push(inner.toString('latin1')); }
  }
  return out;
}
// A stream's text as a reader of its contents could see it: as it is, with NUL bytes left out (UTF-16 text, with a
// byte-order mark or without), and with XML character references decoded (&#100; and &#x64; in XMP metadata).
function streamReadings(t) {
  const r = [t];
  if (t.includes('\u0000')) r.push(t.replace(/\u0000/g, ''));
  if (t.includes('&#')) r.push(t.replace(/&#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/g, (m, h, d) => { const n = h ? parseInt(h, 16) : Number(d); return n <= 0x10ffff ? String.fromCodePoint(n) : m; }));
  return r;
}
// the decoded streams as one text (kept for callers that read them so)
export const inflatedStreams = (bytes) => decodedStreams(bytes).join('\n');

// A string read as bytes, and as a reader of text strings would: UTF-16 after a byte-order mark (FE FF or FF FE),
// UTF-8 after EF BB BF, and with its NUL bytes left out (UTF-16 without a mark).
function readings(b) {
  const t = b.toString('latin1'); const r = [t];
  if (t.includes('\u0000')) r.push(t.replace(/\u0000/g, ''));
  const even = (from) => Buffer.from(b.subarray(from, from + ((b.length - from) & ~1)));
  if (b[0] === 0xfe && b[1] === 0xff) r.push(even(2).swap16().toString('utf16le'));
  else if (b[0] === 0xff && b[1] === 0xfe) r.push(even(2).toString('utf16le'));
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) r.push(b.subarray(3).toString('utf8'));
  return r;
}
const SPACE = '\u0000\t\n\f\r ';
const DELIM = '()<>[]{}/%';
const ESCAPE = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
// a literal string from its "(" at i: its bytes, and where it ends (at the end of the text when never closed)
function literalAt(s, i) {
  const out = []; let depth = 1; i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const e = s[i + 1];
      if (e === undefined) { i++; break; }
      if (Object.hasOwn(ESCAPE, e)) { out.push(ESCAPE[e]); i += 2; } else if (e >= '0' && e <= '7') {
        let j = i + 1; let v = 0; while (j < i + 4 && s[j] >= '0' && s[j] <= '7') { v = v * 8 + s.charCodeAt(j) - 48; j++; }
        out.push(v & 255); i = j;
      } else if (e === '\r') i += s[i + 2] === '\n' ? 3 : 2;
      else if (e === '\n') i += 2;
      else { out.push(s.charCodeAt(i + 1) & 255); i += 2; }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) { i++; break; }
    out.push(s.charCodeAt(i) & 255); i++;
  }
  return [Buffer.from(out), i];
}
// a hex string from its "<" at i: its bytes (an odd last digit read as followed by 0) and where it ends, or no bytes
// when what follows is not a hex string
function hexAt(s, i) {
  let j = i + 1; let d = '';
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '>') { j++; break; }
    if (/[0-9A-Fa-f]/.test(c)) d += c; else if (!SPACE.includes(c)) return [null, i + 1];
  }
  return [Buffer.from(d.length % 2 ? `${d}0` : d, 'hex'), j];
}

// The strings and names of PDF syntax in one text (the file with its stream bodies left out, or one stream as stored
// or decoded),
// decoded: literal strings with their escapes (\n, \ddd, \( \) \\, a line continuation), hex strings, each in every
// reading above, and names with #xx escapes. One pass over the text; comments are skipped. Returns the decoded texts.
export function pdfStrings(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(') { const [b, j] = literalAt(s, i); out.push(...readings(b)); i = j; continue; }
    if (c === '<') {
      if (s[i + 1] === '<') { i += 2; continue; }
      const [b, j] = hexAt(s, i); if (b) out.push(...readings(b)); i = j; continue;
    }
    if (c === '/') {
      let j = i + 1; while (j < s.length && !SPACE.includes(s[j]) && !DELIM.includes(s[j])) j++;
      const name = s.slice(i + 1, j); if (name.includes('#')) out.push(name.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
      i = j; continue;
    }
    i++;
  }
  return out;
}

// the tokens a document's own answer key gives away: its scenario (slug and type.scenario), its error kinds, its
// decoys' kinds and rules, and the seed asked for (the blind record's)
export function tokensOf(key, extra = []) {
  const scenario = String(key.scenario).split('.').slice(1).join('.');
  return [...new Set([scenario, key.scenario, ...(key.errors || []).map((e) => e.kind), ...(key.decoys || []).flatMap((d) => [d.kind, d.rule]),
    key.blind?.seed, ...extra].filter((t) => typeof t === 'string' && t.length >= 4))];
}

// leaks in the files named (each by its own name and content) and the texts given ({ where, text })
export function leaksIn({ files = [], texts = [] }, tokens) {
  const found = [];
  for (const f of files) {
    found.push(...hits(`file name ${path.basename(f)}`, path.basename(f), tokens));
    const bytes = fs.readFileSync(f); const name = path.basename(f);
    found.push(...hits(`${name} bytes`, bytes.toString('latin1'), tokens));
    if (/\.pdf$/i.test(f)) {
      found.push(...hits(`${name} text`, execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf-8' }), tokens));
      found.push(...hits(`${name} info`, execFileSync('pdfinfo', [f], { encoding: 'utf-8' }), tokens));
      found.push(...hits(`${name} xmp`, execFileSync('pdfinfo', ['-meta', f], { encoding: 'utf-8' }), tokens));
      // a stream is read as it is stored (with no filter, or one none of the decoders reads) and as decoded; the
      // strings and names of PDF syntax are read in the file and in every stream, stored or decoded
      const { bodies, rest } = streamBodies(bytes); const stored = bodies.map((b) => b.toString('latin1')); const streams = decodedStreams(bytes);
      found.push(...hits(`${name} streams`, [...stored, ...streams].flatMap(streamReadings).join('\n'), tokens));
      found.push(...hits(`${name} strings`, [rest, ...stored, ...streams].flatMap(pdfStrings).join('\n'), tokens));
    } else if (/\.png$/i.test(f)) found.push(...hits(`${name} markers`, JSON.stringify(readPng(bytes).text), tokens));
    else if (/\.jpe?g$/i.test(f)) { const j = readJpeg(bytes); found.push(...hits(`${name} markers`, JSON.stringify({ exif: j.exif, comments: j.comments }), tokens)); }
  }
  for (const { where, text } of texts) found.push(...hits(where, text, tokens));
  return found;
}

// every regular file under a folder, recursively
export function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
}
