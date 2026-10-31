// Readers for the specimen markers in page-image files, written independently of src/image-markers.js so the tests
// check the file format, not the writer's own idea of it.
import zlib from 'zlib';

// PNG: every chunk in order with its CRC checked, and the tEXt keyword/value pairs
export function readPng(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  const chunks = []; const text = {};
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 4, at + 8 + len), crc = buf.readUInt32BE(at + 8 + len);
    if ((zlib.crc32(body) >>> 0) !== crc) throw new Error(`bad CRC in ${type}`);
    chunks.push(type);
    if (type === 'tEXt') { const d = buf.subarray(at + 8, at + 8 + len); const z = d.indexOf(0); text[d.toString('latin1', 0, z)] = d.toString('latin1', z + 1); }
    at += 12 + len;
  }
  return { chunks, text };
}

// JPEG: the segments before the scan, the Exif IFD0 ASCII tags and the comment segments
export function readJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const segments = []; const exif = {}; const comments = [];
  for (let at = 2; at < buf.length;) {
    if (buf[at] !== 0xff) throw new Error(`no marker at ${at}`);
    const m = buf[at + 1]; segments.push(m);
    if (m === 0xda || m === 0xd9) break;
    const len = buf.readUInt16BE(at + 2), body = buf.subarray(at + 4, at + 2 + len);
    if (m === 0xfe) comments.push(body.toString('latin1'));
    if (m === 0xe1 && body.toString('latin1', 0, 6) === 'Exif\0\0') {
      const t = body.subarray(6), be = t.toString('latin1', 0, 2) === 'MM';
      const u16 = (o) => (be ? t.readUInt16BE(o) : t.readUInt16LE(o)), u32 = (o) => (be ? t.readUInt32BE(o) : t.readUInt32LE(o));
      const ifd = u32(4), n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (type === 2) { const off = count > 4 ? u32(e + 8) : e + 8; exif[tag] = t.toString('latin1', off, off + count).replace(/\0$/, ''); }
      }
    }
    at += 2 + len;
  }
  return { segments, exif, comments };
}

export function readMarkers(mimeType, base64) {
  const buf = Buffer.from(base64, 'base64');
  if (mimeType === 'image/png') { const { text } = readPng(buf); return { description: text.Description, disclaimer: text.Disclaimer, label: text.Comment }; }
  const { exif, comments } = readJpeg(buf);
  return { description: exif[0x010e], software: exif[0x0131], comment: comments.join(' ') };
}
