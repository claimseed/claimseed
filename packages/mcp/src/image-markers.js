// Specimen markers inside page-image files. A page image already shows the specimen band and watermark, because it is
// drawn from the stamped PDF; these markers also say so in the file itself, where image tools and metadata readers
// look: PNG tEXt chunks, and for JPEG an Exif ImageDescription plus a comment segment. Text is ASCII only.
import zlib from 'zlib';
import { BAND_TEXT, SPECIMEN_SUBJECT } from '@claimseed/core';

const ascii = (s) => Buffer.from(String(s).replace(/[^\x20-\x7e]/g, '?'), 'latin1');

// the marker texts for one image; `label` names the document (type / scenario / seed)
export function markerTexts(label) {
  return { Title: 'claimseed synthetic specimen', Description: BAND_TEXT, Disclaimer: SPECIMEN_SUBJECT, Software: 'claimseed', ...(label ? { Comment: label } : {}) };
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}

// a PNG with one tEXt chunk per marker, placed right after IHDR
export function markPng(png, label) {
  if (png.length < 33 || png.toString('latin1', 1, 4) !== 'PNG' || png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG');
  const chunks = Object.entries(markerTexts(label)).map(([k, v]) => pngChunk('tEXt', Buffer.concat([ascii(k), Buffer.from([0]), ascii(v)])));
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}

// Exif (big-endian TIFF, one IFD) with ImageDescription and Software
function exifSegment(description, software) {
  const strs = [[0x010e, Buffer.concat([ascii(description), Buffer.from([0])])], [0x0131, Buffer.concat([ascii(software), Buffer.from([0])])]];
  const ifdLen = 2 + strs.length * 12 + 4; let dataAt = 8 + ifdLen;
  const tiff = Buffer.alloc(dataAt + strs.reduce((n, [, b]) => n + b.length, 0));
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(strs.length, 8);
  strs.forEach(([tag, b], i) => {
    const e = 10 + i * 12;
    tiff.writeUInt16BE(tag, e); tiff.writeUInt16BE(2, e + 2); tiff.writeUInt32BE(b.length, e + 4); tiff.writeUInt32BE(dataAt, e + 8);
    b.copy(tiff, dataAt); dataAt += b.length;
  });
  tiff.writeUInt32BE(0, 10 + strs.length * 12);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
function commentSegment(text) {
  const body = ascii(text).subarray(0, 65000);
  const head = Buffer.from([0xff, 0xfe, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// a JPEG with an Exif segment and a comment segment, placed after SOI and any JFIF APP0 segment
export function markJpeg(jpeg, label) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  const t = markerTexts(label);
  const marks = Buffer.concat([exifSegment(t.Description, t.Software), commentSegment(`${t.Description} | ${t.Disclaimer}${label ? ` | ${label}` : ''}`)]);
  return Buffer.concat([jpeg.subarray(0, at), marks, jpeg.subarray(at)]);
}

// base64 in, base64 out
export function markImage(mimeType, base64, label) {
  const buf = Buffer.from(base64, 'base64');
  return (mimeType === 'image/png' ? markPng(buf, label) : markJpeg(buf, label)).toString('base64');
}
