// check-synthetic.js must fail on disguised binaries, text-encoded images, out-of-range phones, embedded images and
// real brands, wherever they are in the tree (no path or extension exemptions beyond the brand rule on the denylist
// and its tests), and must refuse an empty tree. This file is itself scanned by every rule except the brand rule, so
// every hostile fixture is assembled at runtime from fragments (J) and never appears literally in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/check-synthetic.js');
const J = (...parts) => parts.join('');
const U = (...cps) => String.fromCodePoint(...cps);   // non-ASCII vectors are built from code points, never written as \u escapes (this file is scanned too)
const D = (s) => s.replace(/_/g, '-');                       // underscores to dashes (keeps this file free of phone-shaped text)
const PDFHDR = J('%PD', 'F-1.4');
const OBJ = J('1 0 ob', 'j << /Type /Catalog >> endob', 'j\ntrailer << /Root 1 0 R >>');
// a PNG-signed buffer with pseudo-random body bytes (a real image is high-entropy; a constant filler is not)
let seed = 12345; const noise = Buffer.from(Array.from({ length: 900 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16 & 0xff));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]), noise]);
const DATA = J('da', 'ta:');
function run(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-chk-'));
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); }
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf-8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr };
}
const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g')).join('\n');

test('disguised binaries fail regardless of extension or directory', () => {
  for (const [name, bytes] of [['output/real.pdf.bak', J(PDFHDR, ' x')], ['docs/x.txt', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])], ['a/b/c/photo', Buffer.from([0xff, 0xd8, 0xff, 0xe0])], ['data/x.heic', Buffer.from('....ftypheic')], ['nul.md', Buffer.from([65, 0, 66])]]) {
    const r = run({ [name]: bytes, 'ok.md': 'fine' });
    assert.equal(r.code, 1, `${name} passed`); assert.match(r.out, /binary file/);
  }
});
test('phones with 19x/20x area codes, data images and brands are caught', () => {
  assert.equal(run({ 'LICENSE': J('call (206) ', D('555_1234')) }).code, 1);
  assert.equal(run({ 'x.svg': J('<svg><image href="', DATA, 'image/png;base64,AAAA"/></svg>') }).code, 1);
  assert.equal(run({ 'NOTICE': J('thanks to Hum', '<b></b>', 'ana') }).code, 1);
  assert.equal(run({ 'ok.md': 'call 614-555-0150 or 1-800-MEDICARE (1-800-633-4227)' }).code, 0);
});
test('disguised PDFs, odd phone spellings, toll-free 555 numbers, vanity numbers and entity-hidden images are caught', () => {
  assert.equal(run({ 'docs/notes.txt': J('%'.repeat(1100), '\n', PDFHDR, '\n', OBJ) }).code, 1, 'PDF with header past offset 1024 passed');
  assert.equal(run({ 'docs/notes.txt': J('%'.repeat(9000), '\n', PDFHDR, '\n', OBJ) }).code, 1, 'PDF with header past offset 8 KB passed');
  assert.equal(run({ 'docs/fixture.txt': J('1 0 ob', 'j\n<< /Type /Page /Parent 2 0 R >>\nendob', 'j\n3 0 ob', 'j\n<< /Type /Catalog >>') }).code, 1, 'headerless PDF objects passed');
  const phones = [J('(206) 555 - ', '1234'), J('206' + U(0x2013) + '555' + U(0x2013), '1234'), J('call 206555', '1234 today'), J('1-800-ACE-', 'PLANS'), J('800-555-', '0150'), J('(888) 555-', '0101'), J('206/555/', '1234'), J('800-MY-', 'PLANS'),
    J('Customer Service: 206555', '1234'), J(U(0xFF12) + U(0xFF10) + U(0xFF16) + '-555-', '1234'), J(U(0x0662) + U(0x0660) + U(0x0666) + '-555-', '1234'), J('312' + U(0x2011) + '555' + U(0x2011), '2187'), J('312' + U(0x2212) + '555' + U(0x2212), '2187'), J('"homePhone": "206555', '1234"'), J('contactNumber = 206555', '1234')];
  for (const ph of phones) assert.equal(run({ 'a.md': `phone ${ph}` }).code, 1, `not caught: ${ph}`);
  assert.equal(run({ 'a.svg': J('<svg><image href="', DATA.replace(':', '&#58;'), '&#105;mage/png;base64,AAAA"/></svg>') }).code, 1);
  assert.equal(run({ 'a.html': J('<img src="', 'data&colon;', 'image/png;base64,', wrap(PNG.toString('base64'), 76), '">') }).code, 1, 'named-entity colon with wrapped base64 passed');
  assert.equal(run({ 'big.svg': J('<sv', 'g>', '<path d="M0 0"/>'.repeat(2000), '</sv', 'g>') }).code, 1);
  assert.equal(run({ 'a.md': J('see aetna', 'medicare.com or HUMANA', 'GOLD') }).code, 1);
});
test('image payloads under other MIME labels, CSS escapes, bare base64, text-image formats and exempt directories are caught', () => {
  const png = PNG.toString('base64');
  for (const uri of [J(DATA, 'text/plain;base64,', png), J(DATA, 'application/octet-stream;base64,', png), J(DATA, ';base64,', png), J(DATA, 'image/png;base64,', png), J(DATA, '\\69mage/png;base64,AAAA'), J(DATA, 'text/css;base64,', 'QUJD'.repeat(200))])
    assert.equal(run({ 'templates/x.html': `<img src="${uri}">` }).code, 1, `not caught: ${uri.slice(0, 40)}`);
  assert.equal(run({ 'data/x.json': JSON.stringify({ logo: png }) }).code, 1, 'bare base64 PNG in JSON passed');
  assert.equal(run({ 'packages/core/scripts/x.js': J('const s = "', DATA, 'image/png;base64,AAAA";') }).code, 1, 'scripts/ exemption');
  assert.equal(run({ 'packages/core/test/x.test.js': J('const s = "', DATA, 'image/png;base64,AAAA";') }).code, 1, 'test/ exemption');
  for (const [name, body] of [['logo.eps', J('%!P', 'S-Adobe-3.0 EPSF-3.0\n0 0 moveto')], ['x.pbm', 'P1\n2 2\n0 1\n1 0\n'], ['x.xpm', J('/* XP', 'M */\nstatic char *x[] = {')], ['x.njk', J('<sv', 'g>', '<path d="M0 0"/>'.repeat(300), '</sv', 'g>')]])
    assert.equal(run({ [name]: body }).code, 1, `not caught: ${name}`);
  assert.equal(run({ 'ok.md': 'The fonts partial inlines each face as data:font/woff2 from the npm package at render time.' }).code, 0, 'prose mention of data:font flagged');
});
test('line-wrapped base64, hex dumps, GIMP PNM, uuencode, ASCII85 and MIME attachments are caught', () => {
  const b64 = PNG.toString('base64');
  assert.equal(run({ 'docs/notes.txt': wrap(b64, 76) }).code, 1, '76-column base64 PNG passed');
  assert.equal(run({ 'docs/notes.txt': wrap(b64, 64) }).code, 1, '64-column base64 PNG passed');
  assert.equal(run({ 'scan.hex': wrap(PNG.toString('hex'), 60) }).code, 1, 'hex dump passed');
  assert.equal(run({ 'scan.hex': PNG.toString('hex').match(/../g).join(' ') }).code, 1, 'spaced hex dump passed');
  assert.equal(run({ 'x.pgm': J('P2\n# CREATOR: GIMP PNM Filter Version 1.1\n1100 400\n255\n', '255 '.repeat(200)) }).code, 1, 'GIMP PGM with a comment passed');
  assert.equal(run({ 'x.xbm': J('#def', 'ine x_width 8\n#def', 'ine x_height 8\nstatic char x_bits[] = {0x00};') }).code, 1, 'XBM passed');
  assert.equal(run({ 'scan.uu': J('beg', 'in 644 scan.png\nM', 'B5!.1PT*&@H', '\nend') }).code, 1, 'uuencode passed');
  assert.equal(run({ 'x.txt': J('<', '~', '!'.repeat(300), '~', '>') }).code, 1, 'ASCII85 stream passed');
  assert.equal(run({ 'sample.eml': J('Content-Type: multipart/mixed; boundary="x"\n--x\nContent-Transfer-', 'Encoding: base64\n\n', wrap(b64, 76)) }).code, 1, 'MIME attachment passed');
  // a long but harmless base64 block (not a file) is still reported: there is no legitimate reason for one in the tree
  assert.equal(run({ 'x.txt': wrap(Buffer.concat([noise, noise]).toString('base64').replace(/[+\/=]/g, 'x'), 76) }).code, 1, 'long base64 block of unknown type passed');
});
test('code-embedded payloads: JSON/JS/YAML/Python/Markdown lists of base64 lines, xxd -i, byte arrays, zlib, quoted-printable, offset XPM', () => {
  const b64 = PNG.toString('base64'); const lines = b64.match(/.{1,76}/g);
  assert.equal(run({ 'fixture.json': JSON.stringify({ scan: lines }, null, 1) }).code, 1, 'JSON array of base64 lines passed');
  assert.equal(run({ 'scan.js': 'export const scan = [\n' + lines.map((l) => `  "${l}",`).join('\n') + '\n].join("");' }).code, 1, 'JS array passed');
  assert.equal(run({ 'fx.py': 'SCAN = (\n' + lines.map((l) => `    '${l}'`).join('\n') + '\n)' }).code, 1, 'Python tuple passed');
  assert.equal(run({ 'fixture.yaml': 'scan:\n' + lines.map((l) => `  - ${l}`).join('\n') }).code, 1, 'YAML list passed');
  assert.equal(run({ 'notes.md': lines.map((l) => `> ${l}`).join('\n') }).code, 1, 'Markdown blockquote passed');
  assert.equal(run({ 'scan.h': 'unsigned char scan[] = {\n' + [...PNG].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ').match(/.{1,72}(, |$)/g).join('\n') + '\n};' }).code, 1, 'xxd -i array passed');
  assert.equal(run({ 'scan.js': 'const b = Uint8Array.from([' + [...PNG].join(',') + ']);' }).code, 1, 'decimal byte array passed');
  const z = zlib.deflateSync(PNG).toString('base64').match(/.{1,76}/g);
  assert.equal(run({ 'notes.txt': z.map((l, i) => (i % 20 === 19 ? l + '\n' : l)).join('\n') }).code, 1, 'zlib+base64 with blank lines passed');
  const qp = [...PNG].map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('').match(/.{1,72}/g).join('=\n');
  assert.equal(run({ 'scan.eml': J('Content-Type: image/png\nContent-Transfer-', 'Encoding: quoted-printable\nContent-Disposition: inline\n\n', qp) }).code, 1, 'quoted-printable passed');
  assert.equal(run({ 'scan.xpm': J('// fixture\n/* XP', 'M */\nstat', 'ic char *x[] = {\n"4 4', ' 2 1",') }).code, 1, 'offset XPM passed');
  const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, b32 = '';
  for (const b of PNG) { val = (val << 8) | b; bits += 8; while (bits >= 5) { b32 += A32[(val >> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) b32 += A32[(val << (5 - bits)) & 31];
  assert.equal(run({ 'scan.b32': wrap(b32, 76) }).code, 1, 'base32 passed');
  assert.equal(run({ 'a.json': J('{"brand": "\\u0041', 'etna"}') }).code, 1, 'JSON \\u escape passed');
  assert.equal(run({ 'a.js': J('const s = "\\x41', 'etna";') }).code, 1, 'JS \\x escape passed');
  assert.equal(run({ 'a.js': J('const s = "Aet', '\\tna";') }).code, 1, 'JS whitespace escape inside a brand passed');
  assert.equal(run({ 'a.json': J('{"phone_number": 206555', '1234}') }).code, 1, 'snake_case phone key passed');
  assert.equal(run({ 'a.txt': J('Ph# 206555', '1234') }).code, 1, 'Ph# passed');
  assert.equal(run({ 'a.txt': J('Call our billing office at any time of the day: 206555', '1234') }).code, 1, 'distant bare phone passed');
  // ordinary prose, numeric tables and a package-lock-style integrity line are not payloads
  assert.equal(run({ 'ok.md': 'The quick brown fox jumps over the lazy dog, and the lazy dog does not mind at all.\n'.repeat(5), 'coverage.json': JSON.stringify({ cps: Array.from({ length: 400 }, (_, i) => 32 + i) }), 'lock.json': '{"integrity": "sha512-' + 'A'.repeat(43) + 'b'.repeat(43) + '=="}' }).code, 0, 'prose or a numeric table flagged as a payload');
});
test('smuggling forms: escaped JSON strings, concatenation, comments, spaced base64, dump offsets, signed bytes, base85, decoded text, chunks, escaped bytes, vector svg', () => {
  const b64 = PNG.toString('base64'); const lines = b64.match(/.{1,76}/g);
  const enc85 = (buf, table) => { let o = ''; for (let i = 0; i < buf.length; i += 4) { const g = buf.subarray(i, i + 4); let v = 0; for (let k = 0; k < 4; k++) v = v * 256 + (k < g.length ? g[k] : 0); const d = []; for (let k = 0; k < 5; k++) { d.unshift(v % 85); v = Math.floor(v / 85); } o += d.slice(0, g.length + 1).map((x) => (table ? table[x] : String.fromCharCode(33 + x))).join(''); } return o; };
  const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
  const brandText = J('Statement for Aet', 'na member. Call 212-', '555-2187 about the balance of 1,250.00 due by March 31.');
  const b64text = Buffer.from(brandText).toString('base64');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + Buffer.from(JSON.stringify({ name: J('Aet', 'na Plan'), email: 'x@example.com', sub: 'spec-user-1' })).toString('base64url') + '.abcDEF123xyz';
  const forms = {
    'fixture.json': JSON.stringify({ attachment: { contentType: 'image/png', data: lines.join('\n') } }),   // json.dumps(encodebytes): \n escapes inside one string
    'concat.js': 'export const SCAN =\n' + lines.map((l) => `  '${l}' +`).join('\n') + "\n  '';\n",
    'concat.py': 'SCAN = (\n' + lines.map((l) => `    "${l}"`).join('\n') + '\n)\n',
    'hash-comments.sh': '# fixture\n' + lines.map((l) => `# ${l}`).join('\n') + '\n',
    'slash-comments.js': '// fixture image\n' + lines.map((l) => `// ${l}`).join('\n') + '\n',
    'trailing-comments.js': 'const A = [\n' + lines.map((l, i) => `  "${l}",  // ${i}`).join('\n') + '\n];\n',
    'spaced.txt': lines.map((l) => l.match(/.{1,4}/g).join(' ')).join('\n') + '\n',
    'xxd.hex': Array.from({ length: Math.ceil(PNG.length / 16) }, (_, i) => `${i.toString(16).padStart(8, '0')}: ${PNG.subarray(i * 16, i * 16 + 16).toString('hex').match(/.{1,4}/g).join(' ')}  ${'.'.repeat(16)}`).join('\n') + '\n',
    'hexdump.txt': Array.from({ length: Math.ceil(PNG.length / 16) }, (_, i) => { const c = PNG.subarray(i * 16, i * 16 + 16); return `${i.toString(16).padStart(8, '0')}  ${(c.subarray(0, 8).toString('hex').match(/../g) || []).join(' ')}  ${(c.subarray(8).toString('hex').match(/../g) || []).join(' ')}  |${'.'.repeat(c.length)}|`; }).join('\n') + '\n',
    'Scan.java': 'class Scan { static final byte[] PNG = {\n' + Array.from(PNG).map((x) => (x > 127 ? x - 256 : x)).join(', ').match(/.{1,90}(?:, |$)/g).map((l) => '  ' + l.trim()).join('\n') + '\n}; }\n',
    'b85.txt': wrap(enc85(PNG, B85), 76) + '\n',
    'a85.txt': wrap(enc85(PNG, null), 76) + '\n',
    'note.txt': 'notes\n' + wrap(b64text, 76) + '\n',                               // base64 of text under 1 KB: decoded and held to the text rules
    'auth.test.js': `const token = '${jwt}';\n`,                                     // a JWT whose payload names a brand
    'text-uri.md': `[notes](${DATA}text/plain;base64,${b64text})\n`,
    'parts.json': JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ part: i, data: Buffer.concat([noise.subarray(i * 100), noise]).subarray(0, 500).toString('base64') }))),   // signature-less chunks of a binary, each under 1 KB, over 2 KB together
    'escaped.js': 'const png = "' + Array.from(PNG.subarray(0, 64)).map((x) => '\\x' + x.toString(16).padStart(2, '0')).join('') + '";\n',
    'escaped.py': 'png = b"' + Array.from(PNG.subarray(0, 48)).map((x) => '\\' + x.toString(8).padStart(3, '0')).join('') + '"\n',
    'glyph.md': J('<sv', 'g viewBox="0 0 10 10"><pa', 'th d="M1 1 L9 9"/></sv', 'g>'),
    'deflate.txt': 'token ' + zlib.deflateRawSync(Buffer.from(brandText.repeat(3))).toString('base64') + '\n',   // raw deflate of text naming a brand
    // further wrappings: spaced every 2, tabs, dot and colon groups, 12-char lines, 15-char array strings, table cells,
    // zero-width characters, decimal bytes with spaces or semicolons, BigInt literals, lower-case base32, base-36, base64 of base64
    'spaced2.txt': lines.map((l) => l.match(/.{1,2}/g).join(' ')).join('\n') + '\n',
    'tabbed2.txt': lines.map((l) => l.match(/.{1,2}/g).join('\t')).join('\n') + '\n',
    'dotted.txt': lines.map((l) => l.match(/.{1,4}/g).join('.')).join('\n') + '\n',
    'colons.txt': lines.map((l) => l.match(/.{1,4}/g).join(':')).join('\n') + '\n',
    'short12.txt': b64.match(/.{1,12}/g).join('\n') + '\n',
    'array15.js': 'export const P = [\n' + b64.match(/.{1,15}/g).map((x) => `  '${x}',`).join('\n') + "\n].join('');\n",
    'table.md': '| part | data |\n|---|---|\n' + b64.match(/.{1,60}/g).map((x, i) => `| ${i} | ${x} |`).join('\n') + '\n',
    'zwsp.txt': lines.map((l) => l.match(/.{1,8}/g).join(U(0x200b))).join('\n') + '\n',
    'od.txt': Array.from({ length: Math.ceil(PNG.length / 24) }, (_, i) => Array.from(PNG.subarray(i * 24, i * 24 + 24)).join(' ')).join('\n') + '\n',
    'semis.txt': Array.from(PNG).join('; ') + '\n',
    'bighex.js': 'export const P = 0x' + PNG.toString('hex') + 'n;\n',
    'bigdec.js': 'export const P = ' + BigInt('0x' + PNG.toString('hex')).toString(10) + 'n;\n',
    'b32lower.txt': wrap((() => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, o = ''; for (const byte of PNG) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { o += A[(val >> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(val << (5 - bits)) & 31]; return o.toLowerCase(); })(), 72) + '\n',
    'b36.txt': wrap(BigInt('0x' + PNG.toString('hex')).toString(36), 76) + '\n',
    'b64b64.txt': wrap(Buffer.from(b64).toString('base64'), 76) + '\n',
    'gz.txt': wrap(zlib.gzipSync(Buffer.from(brandText.repeat(3))).toString('base64'), 76) + '\n',
  };
  for (const [name, body] of Object.entries(forms)) assert.equal(run({ [`src/${name}`]: body }).code, 1, `not caught: ${name}`);
  // signature-less chunks spread over many files, each under the per-file thresholds, add up across the tree
  const spread = {}; for (let i = 0; i < 14; i++) spread[`parts/p${i}.json`] = JSON.stringify({ part: i, data: Buffer.concat([noise.subarray(i * 50), noise]).subarray(0, 900).toString('base64') });
  assert.equal(run(spread).code, 1, 'chunks spread over files passed');
  // legitimate code and data must not trip the density rules
  const ok = {
    'package-lock.json': JSON.stringify({ packages: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0', integrity: 'sha512-' + Buffer.from(String(i).repeat(40)).toString('base64') }])) }, null, 2),
    'ci.yml': 'steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n',
    'prose.md': ('Your plan paid the provider directly and you owe nothing further for this visit today.\n').repeat(40),
    'links.md': Array.from({ length: 30 }, (_, i) => `- https://www.cms.gov/medicare/forms-notices/page-${i}/section?id=${i}`).join('\n') + '\n',
    'style.css': '.a { color: #1a2b3c; } .b { color: #ffeedd; background: #0f0e0d; } .c { border: 1px solid #abcdef; }\n'.repeat(30),
    'code.js': 'const re = /\\n|\\r|\\t/g; const s = "line one\\nline two\\n"; const caps = "THIS IS NOT A BILL 2026";\n'.repeat(20),
    'table.txt': Array.from({ length: 60 }, (_, i) => `${i} Office visit 99213 ${(100 + i).toFixed(2)} ${(20 + i).toFixed(2)}`).join('\n') + '\n',
    'enums.js': Array.from({ length: 40 }, (_, i) => `ENUM_VALUE_${i} = 'SampleTokenAlphaBravoCharlieDeltaEcho${i}X',`).join('\n') + '\n',   // CamelCase identifiers are not base64
  };
  const r = run(ok); assert.equal(r.code, 0, `legitimate text flagged: ${r.out}`);
});

test('short compressed records are caught: gzip, zlib, raw deflate, bzip2, xz, zstd and lz4 of one line, as base64 or hex', () => {
  const line = Buffer.from(J('Member note: the velvet otters ', 'rehearse\n'));
  const forms = {
    gzip: zlib.gzipSync(line), zlib: zlib.deflateSync(line), deflate: zlib.deflateRawSync(line), gzip20: zlib.gzipSync(Buffer.concat(Array(20).fill(line))),
    bzip2: Buffer.concat([Buffer.from(J('BZ', 'h91AY&SY')), noise.subarray(0, 40)]), xz: Buffer.concat([Buffer.from([0xfd]), Buffer.from(J('7z', 'XZ')), Buffer.from([0]), noise.subarray(0, 60)]),
    zstd: Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), noise.subarray(0, 30)]), lz4: Buffer.concat([Buffer.from([0x04, 0x22, 0x4d, 0x18]), noise.subarray(0, 30)]),
  };
  for (const [k, b] of Object.entries(forms)) {
    const r = run({ 'fixtures/record.json': JSON.stringify({ compressed: b.toString('base64') }) });
    assert.equal(r.code, 1, `${k} as base64 passed: ${r.out}`);
  }
  const h = run({ 'fixtures/record.txt': 'blob = ' + forms.gzip.toString('hex') + '\n' }); assert.equal(h.code, 1, `gzip as hex passed: ${h.out}`);
  // controls: hashes and integrity strings are not compressed streams
  const ok = run({ 'a.txt': 'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\nid: AbCdEfGhIjKlMnOpQrStUvWxYz012345\n' }); assert.equal(ok.code, 0, ok.out);
});
test('short compressed records in every framing are caught: base32, separated hex, base32 groups, joined string literals, Brotli and damaged streams', () => {
  const line = Buffer.from(J('Member note: the velvet otters ', 'rehearse\n'));
  const streams = {
    gzip: zlib.gzipSync(line), zlib: zlib.deflateSync(line), deflate: zlib.deflateRawSync(line), brotli: zlib.brotliCompressSync(line),
    bzip2: Buffer.concat([Buffer.from(J('BZ', 'h91AY&SY')), noise.subarray(0, 40)]), xz: Buffer.concat([Buffer.from([0xfd]), Buffer.from(J('7z', 'XZ')), Buffer.from([0]), noise.subarray(0, 60)]),
  };
  const b32 = (b) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0, o = ''; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(v << (5 - bits)) & 31]; return o; };
  const hex = (b, sep) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(sep);
  const groups = (w, n) => w.match(new RegExp(`.{1,${n}}`, 'g')).join(' ');
  const concat = (b) => 'const payload = ' + b.toString('base64').match(/.{1,12}/g).map((x) => JSON.stringify(x)).join(' + ') + ';\n';
  for (const [k, b] of Object.entries(streams)) {
    const forms = {
      base32: { 'fixtures/r.json': JSON.stringify({ compressed: b32(b) }) },
      'colon hex': { 'fixtures/r.json': JSON.stringify({ compressed: hex(b, ':') }) },
      'spaced hex': { 'fixtures/r.txt': hex(b, ' ') + '\n' },
      'base32 groups': { 'fixtures/r.txt': groups(b32(b), 8) + '\n' },
      'joined literals': { 'fixtures/r.js': concat(b) },
    };
    if (k === 'brotli') { forms.base64 = { 'fixtures/r.json': JSON.stringify({ compressed: b.toString('base64') }) }; forms.hex = { 'fixtures/r.txt': hex(b, '') + '\n' }; }
    for (const [f, files] of Object.entries(forms)) { const r = run(files); assert.equal(r.code, 1, `${k} as ${f} passed: ${r.out}`); }
  }
  // a gzip whose trailer is damaged or missing is still a gzip stream
  const gz = streams.gzip;
  for (const [f, b] of Object.entries({ 'bad crc': Buffer.concat([gz.subarray(0, -8), Buffer.alloc(8)]), 'no trailer': gz.subarray(0, -8) })) {
    const r = run({ 'fixtures/r.json': JSON.stringify({ compressed: b.toString('base64') }) }); assert.equal(r.code, 1, `gzip with ${f} passed: ${r.out}`);
  }
  // controls: ordinary concatenation, a colon-separated fingerprint, long capitals, prose
  const ok = run({ 'a.js': "const greeting = 'Hello, ' + name + '!';\nconst p = 'data/' + 'claims' + '/' + 'index.json';\n",
                   'b.txt': 'SHA-256 fingerprint: 3a:7f:91:0c:55:e2:1b:44:9d:6a:0e:7c:12:f3:88:2b:91:0c\nSTATUSPENDINGREVIEW CLAIMSPROCESSEDBY\nThe plan paid this claim on time and you owe nothing.\n' });
  assert.equal(ok.code, 0, ok.out);
});
test('short records in ordinary source and data syntax are caught: bytes literals, signed arrays, uneven groups, assembled constants, underscore hex, cut deflate, Brotli past the budget', () => {
  const line = Buffer.from(J('Member note: the velvet otters ', 'rehearse\n'));
  const streams = { gzip: zlib.gzipSync(line), deflate: zlib.deflateRawSync(line), brotli: zlib.brotliCompressSync(line) };
  const pieces = (b, n = 7) => b.toString('base64').match(new RegExp(`.{1,${n}}`, 'g'));
  for (const [k, b] of Object.entries(streams)) {
    const p = pieces(b); const w = b.toString('base64');
    const forms = {
      'python bytes literals': { 'fixtures/r.py': 'payload = (\n' + p.map((x) => `    b'${x}'\n`).join('') + ')\n' },
      'signed byte array': { 'fixtures/r.js': `const payload = [${[...b].map((x) => (x < 128 ? x : x - 256)).join(',')}];\n` },
      'uneven base64 groups': { 'fixtures/r.json': JSON.stringify({ payload: `${w.slice(0, 5)} ${w.slice(5, 14)} ${w.slice(14)}` }) },
      'variables': { 'fixtures/r.js': p.map((x, i) => `const part${i}="${x}";\n`).join('') + `const payload = ${p.map((_, i) => `part${i}`).join('+')};\n` },
      'concat()': { 'fixtures/r.js': `const payload = "${p[0]}".concat(${p.slice(1).map((x) => JSON.stringify(x)).join(',')});\n` },
      'template': { 'fixtures/r.js': 'const payload = `' + p.map((x) => '${"' + x + '"}').join('') + '`;\n' },
      'underscore hex': { 'fixtures/r.json': JSON.stringify({ payload: [...b].map((x) => x.toString(16).padStart(2, '0')).join('_') }) },
    };
    for (const [f, files] of Object.entries(forms)) { const r = run(files); assert.equal(r.code, 1, `${k} as ${f} passed: ${r.out}`); }
  }
  // a raw deflate record cut short still yields its text; a Brotli stream that decodes past the 1 MiB budget is a payload
  const cut = run({ 'fixtures/r.json': JSON.stringify({ payload: streams.deflate.subarray(0, -1).toString('base64') }) });
  assert.equal(cut.code, 1, `cut raw deflate passed: ${cut.out}`);
  const big = zlib.brotliCompressSync(Buffer.concat(Array(60000).fill(line)));
  for (const enc of ['base64', 'hex']) { const r = run({ 'fixtures/r.json': JSON.stringify({ payload: big.toString(enc) }) }); assert.equal(r.code, 1, `Brotli over the budget as ${enc} passed: ${r.out}`); }
  // controls: a signed byte array that is no stream, constants assembled from identifier strings, bytes literals of text
  const ok = run({ 'a.java': 'byte[] k = {12,-3,44,-128,7,99,-56,1,0,127,-1,64,33};\n',
                   'b.js': 'const a="msn";\nconst b="baseline-clean";\nconst c="claimseed";\nconst key = a+b+c;\nconst s = "type".concat("Scenario","Seed");\n',
                   'c.py': "HEADER = (\n    b'Content-Type: '\n    b'text/plain'\n)\n" });
  assert.equal(ok.code, 0, ok.out);
});
test('compressed UTF-16 / UTF-32 / NUL-padded records, typed arrays, casts, suffixes, u8 literals and wrapped base64 are caught', () => {
  const text = J('Member note: the velvet otters ', 'rehearse\n');
  const le16 = Buffer.from(text, 'utf16le'); const be16 = Buffer.from(le16); be16.swap16();
  const le32 = Buffer.alloc(text.length * 4); [...text].forEach((c, i) => le32.writeUInt32LE(c.codePointAt(0), i * 4));
  const z = Buffer.alloc(50);
  const encodings = { 'UTF-16 with a byte-order mark': Buffer.concat([Buffer.from([0xff, 0xfe]), le16]), 'UTF-16BE': be16, 'UTF-32LE': le32, 'NUL padding': Buffer.concat([z, Buffer.from(text), z]) };
  const codecs = { gzip: zlib.gzipSync, deflate: zlib.deflateRawSync, brotli: zlib.brotliCompressSync };
  for (const [c, f] of Object.entries(codecs)) for (const [e, raw] of Object.entries(encodings)) {
    const r = run({ 'fixtures/r.json': JSON.stringify({ payload: f(raw).toString('base64') }) });
    assert.equal(r.code, 1, `${c} of ${e} text passed: ${r.out}`);
  }
  for (const [c, f] of Object.entries(codecs)) {
    const b = f(Buffer.from(text)); const pad = (n) => Buffer.concat([b, Buffer.alloc((n - (b.length % n)) % n)]);
    const words = (n) => { const p = pad(n); const out = []; for (let i = 0; i < p.length; i += n) out.push('0x' + (n === 2 ? p.readUInt16LE(i) : p.readUInt32LE(i)).toString(16)); return out.join(','); };
    const signed = [...b].map((x) => (x < 128 ? x : x - 256)); const w = b.toString('base64');
    const forms = {
      'Uint16Array': { 'fixtures/r.js': `const payload = Buffer.from(new Uint16Array([${words(2)}]).buffer).subarray(0, ${b.length});\n` },
      'Uint32Array': { 'fixtures/r.js': `const payload = Buffer.from(new Uint32Array([${words(4)}]).buffer).subarray(0, ${b.length});\n` },
      'Java casts': { 'fixtures/R.java': `byte[] payload = {${[...b].map((x) => `(byte)${x}`).join(',')}};\n` },
      'C suffixes': { 'fixtures/r.c': `unsigned char payload[] = {${[...b].map((x) => `0x${x.toString(16).padStart(2, '0')}u`).join(',')}};\n` },
      'signed bytes and spaces': { 'fixtures/r.txt': signed.join(' ') + '\n' },
      'signed bytes and semicolons': { 'fixtures/r.txt': signed.join(';') + '\n' },
      'mixed signed and unsigned bytes': { 'fixtures/r.js': `const payload = new Uint8Array([${[...b].map((x, i) => (i % 2 && x > 127 ? x - 256 : x)).join(',')}]);\n` },
      'u8 literals': { 'fixtures/r.cpp': `auto payload = ${w.match(/.{1,7}/g).map((x) => `u8"${x}"`).join(' ')};\n` },
      'base64 on short lines': { 'fixtures/r.txt': w.match(/.{1,8}/g).join('\n') + '\n' },
    };
    for (const [form, files] of Object.entries(forms)) { const r = run(files); assert.equal(r.code, 1, `${c} as ${form} passed: ${r.out}`); }
  }
  // controls: typed arrays, number tables and word lists that hold no stream
  const ok = run({ 'a.js': 'const colors = new Uint32Array([0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff, 0x808080ff]);\nconst ports = new Uint16Array([8080, 8443, 3000, 5432, 6379, 27017]);\n',
                   'b.txt': '10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120\n5; 15; 25; 35; 45; 55; 65; 75; 85; 95; 105; 115\n',
                   'c.txt': 'Alpha\nBravo\nCharlie\nDelta\nEcho2\nFoxtrot\n' });
  assert.equal(ok.code, 0, ok.out);
});
test('the denylist and its tests are exempt from the brand rule only', () => {
  assert.equal(run({ 'packages/core/test/denylist.test.js': J('const x = "Hum', 'ana";') }).code, 0, 'brand rule applied to the denylist test');
  assert.equal(run({ 'packages/core/test/denylist.test.js': J('call (312) ', D('555_2187')) }).code, 1, 'phone rule skipped on the denylist test');
  assert.equal(run({ 'packages/core/test/check-synthetic.test.js': J('const s = "', DATA, 'image/png;base64,', b64(), '";') }).code, 1, 'payload rule skipped on this test file');
  assert.equal(run({ 'packages/core/scripts/lib/brand-denylist.js': J(PDFHDR, '\n', OBJ) }).code, 1, 'binary rule skipped on the denylist');
});
function b64() { return PNG.toString('base64'); }
test('an empty tree does not pass', () => { assert.equal(run({}).code, 1); });

test('a lockfile integrity digest that happens to spell a short denylisted name passes; the name anywhere else does not', () => {
  const short = J('w', 'ps');
  const digest = J('sha512-', short.toUpperCase(), '/HvHQTYnHisLo9McqBHOJk2FkHO/tlpvldyrnem4aeQp4hai3gythswg6p01oSoTl58rcpiFAjF2br2Ak2A==');
  const lock = (extra) => JSON.stringify({ packages: { 'node_modules/x': { version: '1.0.0', integrity: digest, ...extra } } }, null, 2);
  assert.equal(run({ 'package-lock.json': lock({}) }).code, 0);
  assert.equal(run({ 'package-lock.json': lock({ description: J('billing by ', short) }) }).code, 1, 'the name outside an integrity value passed');
  assert.equal(run({ 'notes.json': lock({}) }).code, 1, 'the exemption reached a file that is not a lockfile');
  assert.equal(run({ 'package-lock.json': lock({ integrity: J('sha512-', short) }) }).code, 1, 'a value too short to be a digest was exempted');
  assert.equal(run({ 'package-lock.json': lock({ integrity: digest.replace('==', 'A==') }) }).code, 1, 'a value one character longer than a digest was exempted');
  assert.equal(run({ 'examples/package-lock.json': lock({}) }).code, 1, 'a lockfile below the root was exempted');
});
