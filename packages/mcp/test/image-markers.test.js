// The specimen markers written into page-image files (src/image-markers.js), checked with independent readers. The
// browser tests in preview.test.js check that marked images still decode and show the band and watermark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'zlib';
import { BAND_TEXT, SPECIMEN_SUBJECT } from '@claimseed/core';
import { markPng, markJpeg, markImage } from '../src/image-markers.js';
import { readPng, readJpeg, readMarkers } from './markers-read.js';

function whitePng(w = 4, h = 4) {
  const chunk = (type, data) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(t) >>> 0); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
// the segment skeleton of a baseline JPEG (SOI, JFIF APP0, a stand-in quantisation table, SOS, EOI); enough to check
// where the markers go, not an image to decode
function jpegSkeleton() {
  const seg = (m, body) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xdb, Buffer.alloc(65)), seg(0xda, Buffer.alloc(10)), Buffer.from([0xff, 0xd9])]);
}

test('a marked PNG keeps a valid chunk sequence and carries the specimen text', () => {
  const png = markPng(whitePng(), 'msn / baseline-clean / seed m1');
  const { chunks, text } = readPng(png);
  assert.equal(chunks[0], 'IHDR'); assert.equal(chunks.at(-1), 'IEND');
  assert.ok(chunks.indexOf('tEXt') < chunks.indexOf('IDAT'), 'text before the image data');
  assert.equal(text.Description, BAND_TEXT);
  assert.equal(text.Disclaimer, SPECIMEN_SUBJECT);
  assert.equal(text.Title, 'claimseed synthetic specimen');
  assert.equal(text.Comment, 'msn / baseline-clean / seed m1');
  assert.throws(() => markPng(Buffer.from('not an image')), /not a PNG/);
});

test('a marked JPEG carries an Exif description and a comment after the JFIF header, before the scan', () => {
  const jpg = markJpeg(jpegSkeleton(), 'hmo-eob / baseline-clean / seed m2');
  const { segments, exif, comments } = readJpeg(jpg);
  assert.deepEqual(segments, [0xe0, 0xe1, 0xfe, 0xdb, 0xda]);
  assert.equal(exif[0x010e], BAND_TEXT);
  assert.equal(exif[0x0131], 'claimseed');
  assert.match(comments[0], /SYNTHETIC SPECIMEN/); assert.match(comments[0], /hmo-eob \/ baseline-clean \/ seed m2/);
  assert.throws(() => markJpeg(Buffer.from('nope')), /not a JPEG/);
});

test('markers stay ASCII, so a label cannot smuggle bytes into the file', () => {
  const b64 = markImage('image/png', whitePng().toString('base64'), 'msn / x / seed \u0007é\n');
  assert.equal(readMarkers('image/png', b64).label, 'msn / x / seed ???');
});
