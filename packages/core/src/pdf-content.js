// pdf-content.js — INTERNAL. Reads a page's content before the specimen markers are stamped on it.
//
// stampPages draws the page's own content as one Form XObject and the markers after it. The bytes this module checks
// (pageContentBytes) are exactly the bytes of that Form XObject, so the content a viewer runs is the content that was
// checked. The content is parsed the way a viewer parses it: operands are objects (numbers, names, strings, arrays,
// dictionaries) and an inline image is measured, so a "Q" inside a string, a comment, an array, a dictionary or the
// data of an inline image is not an operator. A page is refused when
//   - a Q restores a graphics state the content never saved, or a q is never restored (the Form XObject boundary
//     already discards whatever the content leaves in the graphics state; the check is a second layer);
//   - an EMC ends a marked-content sequence the content never began, or a BMC/BDC is never ended: an optional-content
//     sequence (/OC ... BDC) left open hides everything drawn after it, the markers included;
//   - the content ends inside a path object: an unpainted path and a pending W clip are not part of the graphics
//     state, so some viewers carry them past a Q and past the end of a Form XObject;
//   - any part of it could be read differently by different viewers: an inline image whose data cannot be measured
//     exactly, a token that is neither a valid number nor a known operator (viewers split "1Q" or "qQ" differently), an
//     operator inside an array or a dictionary, a stray delimiter, an ID or EI outside an inline image, or an
//     unterminated string, array or dictionary.
import { PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);   // ( ) < > [ ] { } / %
const HEX = new Set([...'0123456789abcdefABCDEF'].map((c) => c.charCodeAt(0)));
// Every operator of the PDF content-stream grammar; anything else outside a string is refused.
const OPERATORS = new Set(['b', 'B', 'b*', 'B*', 'BDC', 'BI', 'BMC', 'BT', 'BX', 'c', 'cm', 'CS', 'cs', 'd', 'd0', 'd1', 'Do', 'DP', 'EI', 'EMC',
  'ET', 'EX', 'f', 'F', 'f*', 'G', 'g', 'gs', 'h', 'i', 'ID', 'j', 'J', 'K', 'k', 'l', 'm', 'M', 'MP', 'n', 'q', 'Q', 're', 'RG', 'rg', 'ri', 's', 'S',
  'SC', 'sc', 'SCN', 'scn', 'sh', 'T*', 'Tc', 'Td', 'TD', 'Tf', 'TJ', 'Tj', 'TL', 'Tm', 'Tr', 'Ts', 'Tw', 'Tz', 'v', 'w', 'W', 'W*', 'y', "'", '"']);
const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*']);
const PATH_END = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const MAX_NESTING = 32;
// inline-image dictionary keys and values: the abbreviations and their full names
const IMAGE_KEYS = { BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width', L: 'Length' };
const COMPONENTS = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4, I: 1, Indexed: 1 };
const MEASURED_FILTERS = { AHx: 'AHx', ASCIIHexDecode: 'AHx', A85: 'A85', ASCII85Decode: 'A85' };

class Unreadable extends Error {}
const imageError = (why) => new Unreadable(`inline image cannot be parsed unambiguously: ${why}`);

// The decoded bytes of every content stream of a page, in order, one newline between streams. A stream whose filters
// pdf-lib cannot decode is an error: content that cannot be read cannot be shown to leave the markers visible.
export function pageContentBytes(doc, page) {
  const contents = page.node.Contents();
  if (!contents) return Buffer.alloc(0);
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const parts = [];
  for (const r of refs) {
    const s = doc.context.lookup(r);
    if (s instanceof PDFRawStream) parts.push(Buffer.from(decodePDFRawStream(s).decode()));
    else if (s instanceof PDFStream && typeof s.getUnencodedContents === 'function') parts.push(Buffer.from(s.getUnencodedContents()));
    else if (s) throw new Error('stamp refused: a page content stream cannot be read');
    parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

// Parse content bytes and return { min, end, marked, markedMin, pathOpen, error? }: the lowest graphics-state save
// depth reached and the depth at the end, the same for marked-content sequences, whether the content ends inside a path
// object, and, when the content cannot be read unambiguously, why.
export function scanContent(buf) {
  const n = buf.length; let i = 0;
  let depth = 0; let min = 0; let marked = 0; let markedMin = 0; let pathOpen = false;
  const regularEnd = (j) => { while (j < n && !WS.has(buf[j]) && !DELIM.has(buf[j])) j++; return j; };
  const printable = (s) => s.slice(0, 24).replace(/[^\x21-\x7e]/g, '?');
  // a name's #xx escapes are decoded, as every viewer does, so /W and /#57 are the same key
  const nameText = (s) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // One token: { t: 'num' | 'name' | 'str' | 'const' | 'op' | '[' | ']' | '<<' | '>>' | 'eof', v }.
  function token() {
    for (;;) {
      while (i < n && WS.has(buf[i])) i++;
      if (i >= n) return { t: 'eof' };
      const c = buf[i];
      if (c === 0x25) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; }                     // % comment
      if (c === 0x28) {                                                                                       // ( literal string )
        let lvl = 1; i++;
        while (i < n && lvl > 0) { const d = buf[i]; if (d === 0x5c) { i += 2; continue; } if (d === 0x28) lvl++; else if (d === 0x29) lvl--; i++; }
        if (lvl > 0 || i > n) throw new Unreadable('an unterminated string');
        return { t: 'str' };
      }
      if (c === 0x3c) {
        if (buf[i + 1] === 0x3c) { i += 2; return { t: '<<' }; }
        i++;                                                                                                  // <hex string>
        while (i < n && buf[i] !== 0x3e) { if (!HEX.has(buf[i]) && !WS.has(buf[i])) throw new Unreadable('a malformed hex string'); i++; }
        if (i >= n) throw new Unreadable('an unterminated hex string');
        i++; return { t: 'str' };
      }
      if (c === 0x3e) { if (buf[i + 1] === 0x3e) { i += 2; return { t: '>>' }; } throw new Unreadable('a stray >'); }
      if (c === 0x5b) { i++; return { t: '[' }; }
      if (c === 0x5d) { i++; return { t: ']' }; }
      if (c === 0x2f) { const j = regularEnd(i + 1); const v = nameText(buf.toString('latin1', i + 1, j)); i = j; return { t: 'name', v }; }
      if (DELIM.has(c)) throw new Unreadable(`a stray ${String.fromCharCode(c)}`);                              // ) { }
      const j = regularEnd(i); const tok = buf.toString('latin1', i, j); i = j;
      if (/^[0-9+\-.]/.test(tok)) {
        if (!NUMBER.test(tok)) throw new Unreadable(`the token "${printable(tok)}", which viewers split into tokens differently`);
        return { t: 'num', v: Number(tok), int: /^[+-]?\d+$/.test(tok) };
      }
      if (tok === 'true' || tok === 'false' || tok === 'null') return { t: 'const', v: tok === 'null' ? null : tok === 'true' };
      if (!OPERATORS.has(tok)) throw new Unreadable(`the unknown operator "${printable(tok)}", which viewers split into tokens differently`);
      return { t: 'op', v: tok };
    }
  }

  // The operand object that starts with `tok`. Arrays and dictionaries hold objects only: an operator inside one is
  // read as data by some viewers and could be run by others, so it is refused.
  function object(tok, level = 0) {
    if (tok.t === '[' || tok.t === '<<') {
      if (level >= MAX_NESTING) throw new Unreadable('arrays or dictionaries nested too deeply');
      const close = tok.t === '[' ? ']' : '>>'; const items = [];
      for (;;) {
        const t = token();
        if (t.t === close) break;
        if (t.t === 'eof') throw new Unreadable(`an unterminated ${tok.t === '[' ? 'array' : 'dictionary'}`);
        if (close === '>>' && items.length % 2 === 0 && t.t !== 'name') throw new Unreadable('a dictionary key that is not a name');
        items.push(object(t, level + 1));
      }
      if (close === ']') return { t: 'array', v: items };
      if (items.length % 2) throw new Unreadable('a dictionary key without a value');
      const v = new Map(); for (let k = 0; k < items.length; k += 2) v.set(items[k].v, items[k + 1]);
      return { t: 'dict', v };
    }
    if (tok.t === 'op') throw new Unreadable(`the operator ${tok.v} inside an array or dictionary`);
    if (tok.t === ']' || tok.t === '>>') throw new Unreadable(`a stray ${tok.t}`);
    return tok;
  }

  // BI has been read: read the image dictionary up to ID, measure the image data, and require EI right after it.
  function inlineImage() {
    const dict = new Map();
    for (;;) {
      const t = token();
      if (t.t === 'op' && t.v === 'ID') break;
      if (t.t === 'eof') throw imageError('it has no ID');
      if (t.t !== 'name') throw imageError('its dictionary is malformed');
      const key = IMAGE_KEYS[t.v] || t.v;
      if (dict.has(key)) throw imageError(`its dictionary repeats /${key}`);
      const vt = token();
      if (vt.t === 'op' || vt.t === 'eof') throw imageError(`/${t.v} has no value`);
      dict.set(key, object(vt));
    }
    if (!WS.has(buf[i])) throw imageError('ID is not followed by a single white-space byte');
    const start = i + 1;   // exactly one white-space byte separates ID from the data
    const int = (key) => { const o = dict.get(key); return o && o.t === 'num' && o.int ? o.v : undefined; };
    let filter = dict.get('Filter');
    if (filter && filter.t === 'array') { if (filter.v.length > 1) throw imageError('it has more than one filter'); filter = filter.v[0]; }
    if (filter && filter.t === 'const' && filter.v === null) filter = undefined;
    if (filter && filter.t !== 'name') throw imageError('its filter is not a name');
    const kind = filter ? MEASURED_FILTERS[filter.v] : 'raw';
    if (!kind) throw imageError(`the length of /${filter.v} data cannot be determined`);
    let end;
    if (kind === 'raw') {
      const w = int('Width'); const h = int('Height');
      if (!(w > 0 && h > 0)) throw imageError('its /W or /H is not a positive integer');
      const mask = dict.get('ImageMask'); const isMask = mask && mask.t === 'const' && mask.v === true;
      if (mask && !(mask.t === 'const' && typeof mask.v === 'boolean')) throw imageError('its /IM is not a boolean');
      let bpc = int('BitsPerComponent'); let comps;
      if (isMask) {
        if (dict.has('BitsPerComponent') && bpc !== 1) throw imageError('an image mask with /BPC other than 1');
        bpc = 1; comps = 1;
      } else {
        if (![1, 2, 4, 8, 16].includes(bpc)) throw imageError('its /BPC is missing or invalid');
        const cs = dict.get('ColorSpace');
        if (cs && cs.t === 'name' && COMPONENTS[cs.v]) comps = COMPONENTS[cs.v];
        else if (cs && cs.t === 'array' && cs.v.length === 4 && cs.v[0].t === 'name' && (cs.v[0].v === 'I' || cs.v[0].v === 'Indexed')) comps = 1;
        else throw imageError('its colour space is missing or not a device or indexed colour space');
      }
      const length = Math.ceil((w * comps * bpc) / 8) * h;   // rows are padded to whole bytes
      if (!(start + length <= n)) throw imageError('its data is shorter than its dimensions say');
      end = start + length;
    } else {
      let j = start;
      if (kind === 'AHx') {
        while (j < n && buf[j] !== 0x3e) { if (!HEX.has(buf[j]) && !WS.has(buf[j])) throw imageError('its ASCIIHex data holds a byte that is not hex'); j++; }
        if (j >= n) throw imageError('its ASCIIHex data has no >');
        end = j + 1;
      } else {
        while (j < n && buf[j] !== 0x7e) { const d = buf[j]; if (!((d >= 0x21 && d <= 0x75) || d === 0x7a || WS.has(d))) throw imageError('its ASCII85 data holds a byte outside the alphabet'); j++; }
        if (j >= n || buf[j + 1] !== 0x3e) throw imageError('its ASCII85 data has no ~>');
        end = j + 2;
      }
    }
    if (dict.has('Length')) {
      const l = int('Length');
      if (!(l >= 0) || start + l !== end) throw imageError('its /L length disagrees with the data');
    }
    // A viewer that searches for EI instead of measuring the data (and a measuring viewer recovering from an error)
    // would stop at an "EI" inside the data and run the rest of the data as operators.
    for (let k = start; k + 1 < end; k++) {
      if (buf[k] === 0x45 && buf[k + 1] === 0x49 && (k + 2 >= end || WS.has(buf[k + 2]) || DELIM.has(buf[k + 2]))) throw imageError('its data contains EI');
    }
    let j = end; while (j < n && WS.has(buf[j])) j++;
    if (!(buf[j] === 0x45 && buf[j + 1] === 0x49 && (j + 2 >= n || WS.has(buf[j + 2])))) throw imageError('EI does not follow its data');
    i = j + 2;
  }

  const result = (extra = {}) => ({ min, end: depth, marked, markedMin, pathOpen, ...extra });
  try {
    for (;;) {
      const tok = token();
      if (tok.t === 'eof') break;
      if (tok.t !== 'op') { object(tok); continue; }
      const op = tok.v;
      if (op === 'q') depth++;
      else if (op === 'Q') { depth--; if (depth < min) min = depth; }
      else if (op === 'BMC' || op === 'BDC') marked++;
      else if (op === 'EMC') { marked--; if (marked < markedMin) markedMin = marked; }
      else if (op === 'BI') inlineImage();
      else if (op === 'ID' || op === 'EI') throw new Unreadable(`${op} outside an inline image`);
      if (PATH_BUILD.has(op)) pathOpen = true; else if (PATH_END.has(op)) pathOpen = false;
    }
  } catch (e) {
    if (e instanceof Unreadable) return result({ error: e.message });
    throw e;
  }
  return result();
}

// The graphics-state part of scanContent, under its original name (callers read min and end).
export const graphicsStateDepth = scanContent;

// Throws unless the page's content can be read unambiguously, restores every graphics state it saves, ends every
// marked-content sequence it begins and ends outside a path object. Returns the checked bytes.
export function assertBalancedContent(doc, page, index) {
  const bytes = pageContentBytes(doc, page);
  const d = scanContent(bytes);
  const where = `stamp refused: page ${index + 1} content`;
  if (d.error) throw new Error(`${where} cannot be read (${d.error})`);
  if (d.min < 0) throw new Error(`${where} restores a graphics state it never saved (an unmatched Q could hide the specimen marks)`);
  if (d.end !== 0) throw new Error(`${where} leaves ${d.end} graphics state(s) unrestored (an unmatched q could hide the specimen marks)`);
  if (d.markedMin < 0) throw new Error(`${where} ends a marked-content sequence it never began (an unmatched EMC could hide the specimen marks)`);
  if (d.marked !== 0) throw new Error(`${where} leaves ${d.marked} marked-content sequence(s) open (an unclosed BDC or BMC could hide the specimen marks)`);
  if (d.pathOpen) throw new Error(`${where} ends inside a path object (an unpainted path or a pending clip could hide the specimen marks)`);
  return bytes;
}
