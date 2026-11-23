// Blind documents (src/blind.js): a document, its degraded copy and a whole set that tell a tool reading them nothing
// about what was planted. Every channel is checked from the outside (leak-check.js), and the checker is shown to catch
// a leak planted in each channel. The answer key, written apart, alone rebuilds the document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import zlib from 'zlib';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { render, renderBatch, renderDegraded, launchBrowser, findChrome, finalizePdf, markImage, readManifest, BLIND_STRINGS, BLIND_SALT, BLIND_ID } from '../src/index.js';
import { PAIR_STRINGS } from '../src/generate/provider-statement.js';
import { degradeRendered } from '../src/degrade.js';
import { generateData } from '../src/generate/index.js';
import { blindSalt, blindSeed, blindId, blindOrder, blindCopyId } from '../src/blind.js';
import { planBatch } from '../src/batch.js';
import { leaksIn, tokensOf, filesUnder, pdfStrings, decodedStreams } from './leak-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../src/cli.js');
const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const M = BLIND_STRINGS.messages; const msg = (k, who) => M[k].replace('{who}', who);
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const SEED = 'leakprobe-7x';   // distinctive, so a leaked seed cannot hide among ordinary words
const SALT = '0123456789abcdef0123456789abcdef';
// a tiny white PNG and the segment skeleton of a JPEG, enough to carry markers (as test/image-markers.test.js builds them)
function whitePng(w = 4, h = 4) {
  const chunk = (type, data) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(t) >>> 0); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function jpegSkeleton() {
  const seg = (m, body) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xdb, Buffer.alloc(65)), seg(0xda, Buffer.alloc(10)), Buffer.from([0xff, 0xd9])]);
}
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { if (browser) await browser.close(); });

test('the blind option, seeds, ids and order are drawn from the salt and refuse anything else without echoing it', () => {
  assert.match(blindSalt(true), BLIND_SALT); assert.notEqual(blindSalt(true), blindSalt(true));
  assert.equal(blindSalt({ salt: SALT }), SALT);
  for (const bad of [false, null, 1, 'x', SALT, { salt: SALT.toUpperCase() }, { salt: SALT.slice(1) }, { salt: SALT, extra: 1 }, [SALT], { toString: () => SALT }])
    assert.throws(() => blindSalt(bad), (e) => e.message === M.blindOption, String(bad));
  const job = { type: 'msn', scenario: 'duplicate-office-visit', seed: SEED, layoutVariant: null };
  assert.match(blindSeed(SALT, job), /^b[0-9a-f]{31}$/); assert.match(blindId(SALT, job), BLIND_ID);
  // every part of the job and the salt change both; neither carries the job's words
  for (const other of [{ ...job, seed: 'other' }, { ...job, scenario: 'baseline-clean' }, { ...job, type: 'itemized-bill' }, { ...job, layoutVariant: 'seeded' }]) {
    assert.notEqual(blindSeed(SALT, other), blindSeed(SALT, job)); assert.notEqual(blindId(SALT, other), blindId(SALT, job));
  }
  assert.notEqual(blindId(SALT.replace('0', '1'), job), blindId(SALT, job));
  assert.notEqual(blindCopyId(SALT, blindId(SALT, job), 'scan'), blindCopyId(SALT, blindId(SALT, job), 'fax'));
  // the order is a permutation of the plan, fixed by the salt, and not the plan's own order
  const jobs = planBatch({ types: ['msn', 'itemized-bill'], seeds: 3 });
  const a = blindOrder(SALT, jobs); const b = blindOrder(SALT, jobs);
  assert.deepEqual(a, b); assert.deepEqual([...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), [...jobs].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
  assert.notDeepEqual(a, jobs);
});

const SCHEMA17 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/commercial-eob/schema.json'), 'utf-8')).schema17;
test('the schema describes the blind record in its reviewed words, in both copies of the schema', () => {
  const S = BLIND_STRINGS.schema;
  for (const file of ['../../../schemas/ground-truth.schema.json', '../../mcp/resources/ground-truth.schema.json']) {
    const sc = JSON.parse(fs.readFileSync(path.join(here, file), 'utf-8'));
    // 1.5's sentence, verbatim, then 1.6's and the one on decoys that repeat a line (in
    // data/pair.json), then 1.7's (data/commercial-eob/schema.json), and nothing after them
    assert.ok(sc.properties.schemaVersion.description.endsWith(` ${S.schema15} ${PAIR_STRINGS.schema.schema16} ${PAIR_STRINGS.schema.schemaDecoyRefs} ${SCHEMA17}`), file);
    assert.equal(sc.properties.blind.description, S.blind, file);
    for (const k of ['id', 'salt', 'seed', 'layoutVariant', 'copyOf']) assert.equal(sc.properties.blind.properties[k].description, S[`blind.${k}`], `${file} blind.${k}`);
  }
});

test('schema 1.5 keeps the variant rules of 1.4 and ties copyOf to a degraded copy', () => {
  const keyOf = (type, scenario, layoutVariant) => {
    const job = { type, scenario, seed: SEED, layoutVariant };
    const g = generateData({ type, scenario, seed: blindSeed(SALT, job), layoutVariant }).groundTruth;
    return { ...g, schemaVersion: '1.5', blind: { id: blindId(SALT, job), salt: SALT, seed: SEED, layoutVariant } };
  };
  const ok = (k, what) => assert.ok(validate(k), `${what}: ${JSON.stringify(validate.errors)}`);
  const bad = (k, what) => assert.equal(validate(k), false, `${what} was accepted`);
  const varied = keyOf('ppo-eob', 'baseline-clean', 'p07'); const plain = keyOf('ppo-eob', 'baseline-clean', null);
  ok(varied, 'a blind variant'); ok(plain, 'a blind document');
  const without = structuredClone(varied); delete without.documents[0].layoutVariant; bad(without, 'a variant layout without its layoutVariant');
  const asked = structuredClone(plain); asked.blind.layoutVariant = 'p07'; bad(asked, 'a variant asked for and not recorded');
  const stray = structuredClone(plain); stray.documents[0].layoutVariant = varied.documents[0].layoutVariant; bad(stray, 'a layoutVariant on the standard layout');
  const open = generateData({ type: 'ppo-eob', scenario: 'baseline-clean', seed: SEED, layoutVariant: 'p07' }).groundTruth; delete open.documents[0].layoutVariant; bad(open, '1.4 without its layoutVariant');
  bad({ ...structuredClone(plain), blind: { ...plain.blind, copyOf: plain.blind.id } }, 'copyOf on a clean document');
  const copy = structuredClone(plain); copy.documents[0].degradation = 'scan'; bad(copy, 'a degraded copy without copyOf');
  copy.blind.copyOf = plain.blind.id; copy.blind.id = blindCopyId(SALT, plain.blind.id, 'scan'); ok(copy, 'a degraded copy naming its document');
});

test('the checker decodes the strings, names and streams of PDF syntax', () => {
  const T = 'duplicate-office-visit'; const has = (texts) => texts.some((t) => t.toLowerCase().includes(T));
  assert.ok(has(pdfStrings(`(${T})`)) && has(pdfStrings(`(a (nested) ${T.toUpperCase()})`)), 'literal, nested and in capitals');
  assert.ok(has(pdfStrings('(\\144uplicate\\055office\\055visit)')), 'octal escapes');
  assert.ok(has(pdfStrings('(duplicate\\\noffice)'.replace('office', '-office-visit'))), 'a line continuation');
  assert.ok(has(pdfStrings(`<${Buffer.from(T).toString('hex').toUpperCase().replace(/(..)/g, '$1 ')}>`)), 'hex with spaces');
  assert.ok(has(pdfStrings(`<FEFF${Buffer.from(T, 'utf16le').swap16().toString('hex')}>`)), 'UTF-16 with a mark');
  assert.ok(has(pdfStrings(`<FFFE${Buffer.from(T, 'utf16le').toString('hex')}>`)), 'UTF-16LE with a mark');
  assert.ok(has(pdfStrings(`<EFBBBF${Buffer.from(T).toString('hex')}>`)), 'UTF-8 with a mark');
  assert.ok(has(pdfStrings(`<<\n/K <${Buffer.from(T, 'utf16le').toString('hex')}> >>`)), 'UTF-16 without a mark, in a dictionary');
  assert.ok(has(pdfStrings('/duplicate#2Doffice#2dvisit')), 'a name with #xx escapes');
  assert.ok(pdfStrings('<64757>').includes('dup'), 'an odd last digit is read as followed by 0');
  assert.ok(!has(pdfStrings(`% (${T})\n(other)`)), 'a comment is not a string');
  assert.ok(has(pdfStrings(`(unclosed ${T}`)), 'a string never closed ends with the text');
  const stream = (body) => Buffer.from(`1 0 obj\n<< >>\nstream\n${body}\nendstream\nendobj\n`, 'latin1');
  assert.ok(has(decodedStreams(stream(`${Buffer.from(T).toString('hex')}>`))), 'ASCIIHex');
  assert.ok(has(decodedStreams(Buffer.concat([Buffer.from('<< >>\nstream\n'), zlib.deflateSync(Buffer.from(`(${T})`)), Buffer.from('\nendstream')]))), 'Flate');
});

test('the checker finds a leak planted in each channel', { skip, timeout: 300000 }, async () => {
  const dir = tmp('cs-leak-plant-');
  try {
    const tokens = ['duplicate-office-visit', SEED];
    // a blind document is clean; the same PDF with a band (as an ordinary render prints it) or a title naming the
    // scenario and seed, or a file name that does, is not
    const blind = await render({ type: 'msn', scenario: 'duplicate-office-visit', seed: SEED, outDir: path.join(dir, 'b'), keysDir: path.join(dir, 'k'), blind: { salt: SALT }, browser });
    assert.deepEqual(leaksIn({ files: [blind.pdf] }, tokens), []);
    const banded = path.join(dir, 'banded.pdf'); fs.copyFileSync(blind.pdf, banded); await finalizePdf(banded, { band: `msn / duplicate-office-visit / seed ${SEED}`, title: 'claimseed specimen' });
    assert.ok(leaksIn({ files: [banded] }, tokens).some((l) => / text$/.test(l.where)), 'planted band text');
    const titled = path.join(dir, 'titled.pdf'); fs.copyFileSync(blind.pdf, titled); await finalizePdf(titled, { title: 'claimseed specimen - duplicate-office-visit' });
    assert.ok(leaksIn({ files: [titled] }, tokens).some((l) => / info$/.test(l.where)), 'planted title');
    // a token only inside a compressed object stream: no text, information, metadata or raw byte shows it
    const { PDFDocument, PDFName, PDFString } = await import('pdf-lib');
    const d = await PDFDocument.load(fs.readFileSync(blind.pdf)); d.catalog.set(PDFName.of('Planted'), PDFString.of('duplicate-office-visit'));
    const hidden = path.join(dir, 'hidden.pdf'); fs.writeFileSync(hidden, await d.save({ useObjectStreams: true }));
    const inHidden = leaksIn({ files: [hidden] }, tokens).map((l) => l.where);
    assert.deepEqual(inHidden, ['hidden.pdf streams', 'hidden.pdf strings'], 'planted in an object stream');
    // the same token in the other forms PDF syntax writes text in, each where only decoding the string, name or stream
    // shows it: a hex string (UTF-16 with a byte-order mark, single bytes, UTF-16 without a mark), a literal with octal
    // escapes or a line continuation (in an object stream), a name with #xx escapes, and streams in ASCIIHex, and in
    // ASCII85 over Flate; and a stream stored with no filter that holds such strings, names or encoded text
    const { PDFHexString } = await import('pdf-lib');
    const T = 'duplicate-office-visit';
    const utf16be = (t) => Buffer.from(t, 'utf16le').swap16().toString('hex');
    const a85 = (b) => { let o = ''; for (let i = 0; i < b.length; i += 4) { const c = b.subarray(i, i + 4); const p = Buffer.concat([c, Buffer.alloc(4 - c.length)]); let n = p.readUInt32BE(0); if (n === 0 && c.length === 4) { o += 'z'; continue; } const g = []; for (let k = 0; k < 5; k++) { g.unshift(String.fromCharCode(33 + (n % 85))); n = Math.floor(n / 85); } o += g.join('').slice(0, c.length + 1); } return `${o}~>`; };
    const planted = async (label, change, { objectStreams = true } = {}) => {
      const doc = await PDFDocument.load(fs.readFileSync(blind.pdf)); change(doc);
      const f = path.join(dir, `${label}.pdf`); fs.writeFileSync(f, await doc.save({ useObjectStreams: objectStreams })); return f;
    };
    const setValue = (v) => (doc) => doc.catalog.set(PDFName.of('Planted'), v);
    const setStream = (bytes, filter) => (doc) => doc.catalog.set(PDFName.of('Planted'), doc.context.register(doc.context.stream(bytes, { Filter: filter })));
    const setStored = (text) => (doc) => doc.catalog.set(PDFName.of('Planted'), doc.context.register(doc.context.stream(Buffer.from(text, 'latin1'), {})));
    const forms = [
      ['hex-utf16', setValue(PDFHexString.fromText(T)), 'strings'],
      ['hex-bytes', setValue(PDFHexString.of(Buffer.from(T).toString('hex'))), 'strings'],
      ['hex-utf16-nomark', setValue(PDFHexString.of(utf16be(T))), 'strings'],
      ['octal', setValue(PDFString.of(T.replace(/[d-]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`))), 'strings'],
      ['continued', setValue(PDFString.of(`${T.slice(0, 9)}\\\n${T.slice(9)}`)), 'strings'],
      ['ascii-hex', setStream(Buffer.from(`${Buffer.from(T).toString('hex')}>`), 'ASCIIHexDecode'), 'streams'],
      ['ascii85-flate', setStream(Buffer.from(a85(zlib.deflateSync(Buffer.from(T)))), ['ASCII85Decode', 'FlateDecode']), 'streams'],
      // a stream stored with no filter: a hex string shown as text, a UTF-16 ActualText, an octal-escaped literal and a
      // name with #xx escapes in it; XMP-style text written with character references; bare UTF-16 under Flate
      ['stored-hex', setStored(`BT <${Buffer.from(T).toString('hex')}> Tj ET`), 'strings'],
      ['stored-actualtext', setStored(`/Span <</ActualText <FEFF${utf16be(T)}>>> BDC EMC`), 'strings'],
      ['stored-octal', setStored(`BT (${T.replace(/[d-]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}) Tj ET`), 'strings'],
      ['stored-name', setStored(`/${T.slice(0, 9)}#2D${T.slice(10, 16)}#2D${T.slice(17)} gs`), 'strings'],
      ['stored-xml-refs', setStored(`<x:xmpmeta><dc:title>&#100;uplicate&#45;office&#x2D;visit</dc:title></x:xmpmeta>`), 'streams'],
      ['flate-utf16', setStream(zlib.deflateSync(Buffer.from(T, 'utf16le')), 'FlateDecode'), 'streams'],
    ];
    for (const [label, change, where] of forms) {
      const f = await planted(label, change); const at = leaksIn({ files: [f] }, tokens).map((l) => l.where);
      assert.ok(at.includes(`${label}.pdf ${where}`), `planted as ${label}: ${at.join(', ')}`);
      assert.ok(at.every((w) => / (streams|strings)$/.test(w)), `planted as ${label}, found only by decoding: ${at.join(', ')}`);
    }
    // a name with #xx escapes, written over a placeholder name of the same length in a file without object streams
    const escaped = `${T.slice(0, 9)}#2D${T.slice(10, 16)}#2D${T.slice(17)}`;
    const nameFile = await planted('name', (doc) => doc.catalog.set(PDFName.of('Z'.repeat(escaped.length)), PDFString.of('x')), { objectStreams: false });
    const raw = fs.readFileSync(nameFile); const at = raw.indexOf(`/${'Z'.repeat(escaped.length)}`); assert.ok(at > 0);
    raw.write(`/${escaped}`, at, 'latin1'); fs.writeFileSync(nameFile, raw);
    assert.deepEqual(leaksIn({ files: [nameFile] }, tokens).map((l) => l.where), ['name.pdf strings'], 'planted as an escaped name');
    const named = path.join(dir, `x_duplicate-office-visit.pdf`); fs.copyFileSync(blind.pdf, named);
    assert.ok(leaksIn({ files: [named] }, tokens).some((l) => /^file name/.test(l.where)), 'planted file name');
    // page images whose markers name the scenario
    const png = path.join(dir, 'p.png'); fs.writeFileSync(png, Buffer.from(markImage('image/png', whitePng().toString('base64'), 'msn / duplicate-office-visit'), 'base64'));
    assert.ok(leaksIn({ files: [png] }, tokens).some((l) => / markers$/.test(l.where)), 'planted PNG marker');
    const jpg = path.join(dir, 'p.jpg'); fs.writeFileSync(jpg, Buffer.from(markImage('image/jpeg', jpegSkeleton().toString('base64'), `seed ${SEED}`), 'base64'));
    assert.ok(leaksIn({ files: [jpg] }, tokens).some((l) => / markers$/.test(l.where)), 'planted JPEG marker');
    // a tool result or an 835 that names them
    assert.equal(leaksIn({ texts: [{ where: 'result', text: JSON.stringify({ uri: 'claimseed://document/msn/duplicate-office-visit/x.pdf' }) }] }, tokens).length, 1);
    assert.equal(leaksIn({ texts: [{ where: '835', text: `NTE*ADD*${SEED.toUpperCase()}~` }] }, tokens).length, 1, 'case does not hide a leak');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a blind document of every type, with its 835 and a layout variant, names its id only; its key, apart, rebuilds it', { skip, timeout: 600000 }, async () => {
  const dir = tmp('cs-blind-');
  try {
    const docs = path.join(dir, 'docs'); const keys = path.join(dir, 'keys');
    const cases = [['msn', 'duplicate-office-visit', null, '835'], ['itemized-bill', 'duplicate-charge', 'b04', null], ['ppo-eob', 'combined-three-errors', 'p07', '835'], ['hmo-eob', 'decoys-oop-cap-partial', null, '835']];
    for (const [type, scenario, layoutVariant, also] of cases) {
      const r = await render({ type, scenario, seed: SEED, outDir: docs, keysDir: keys, blind: { salt: SALT }, layoutVariant, also, browser });
      assert.match(r.id, BLIND_ID);
      assert.equal(r.pdf, path.join(docs, `${r.id}.pdf`)); assert.equal(r.answerKey, path.join(keys, `${r.id}.ground-truth.json`));
      const key = JSON.parse(fs.readFileSync(r.answerKey, 'utf-8'));
      assert.ok(validate(key), JSON.stringify(validate.errors)); assert.equal(key.schemaVersion, '1.5');
      assert.deepEqual(key.blind, { id: r.id, salt: SALT, seed: SEED, layoutVariant });
      assert.ok(key.errors.length + (key.decoys || []).length > 0, `${type}/${scenario} plants something to hide`);
      const files = fs.readdirSync(docs).filter((f) => f.startsWith(r.id)).map((f) => path.join(docs, f));
      assert.deepEqual(files.map((f) => path.basename(f)).sort(), [`${r.id}.pdf`, ...(also ? [`${r.id}.835`] : [])].sort());
      assert.deepEqual(leaksIn({ files }, tokensOf(key)), [], `${type}/${scenario}`);
      // the key alone (salt, seed and variant as asked) gives the same document again: rendered on the type without a
      // variant and on the one with a variant and an 835 (the other two by their data, below)
      if (['msn', 'ppo-eob'].includes(type)) {
        const again = await render({ type, scenario, seed: key.blind.seed, layoutVariant: key.blind.layoutVariant, also, blind: { salt: key.blind.salt }, browser });
        assert.equal(again.id, r.id); assert.ok(again.bytes.equals(fs.readFileSync(r.pdf)), `${type}: rebuilt from its key`);
      }
      const job = { type, scenario, seed: key.blind.seed, layoutVariant: key.blind.layoutVariant };
      assert.equal(blindSeed(key.blind.salt, job), key.seed); assert.equal(blindId(key.blind.salt, job), r.id);
      // the key's values are those its seed generates (rendering adds the page count and nothing else changes)
      const fieldsOf = (seed) => generateData({ type, scenario, seed, layoutVariant }).groundTruth.documents[0].fields;
      const mine = fieldsOf(key.seed);
      assert.deepEqual(Object.fromEntries(Object.keys(mine).map((k) => [k, key.documents[0].fields[k]])), mine, `${type}: the key's data from its seed`);
      // another salt gives another document: nothing printed can be matched by guessing the scenario and seed
      const salt2 = blindSalt(true); const seed2 = blindSeed(salt2, job);
      assert.notEqual(seed2, key.seed); assert.notEqual(blindId(salt2, job), r.id);
      assert.notDeepEqual(fieldsOf(seed2), mine, `${type}: another salt, other values`);
    }
    assert.deepEqual(fs.readdirSync(docs).filter((f) => !/^doc-[0-9a-f]{16}\.(pdf|835)$/.test(f)), [], 'nothing but documents in the documents folder');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a degraded copy of a blind document is blind, with its own id, and its page images name that id only, for every preset', { skip, timeout: 600000 }, async () => {
  const dir = tmp('cs-blind-deg-');
  const job = { type: 'ppo-eob', scenario: 'duplicate-visit', seed: SEED, layoutVariant: null }; const clean = blindId(SALT, job);
  const check = (id, key, preset, files) => {
    assert.equal(id, blindCopyId(SALT, clean, preset)); assert.notEqual(id, clean);
    assert.ok(validate(key), JSON.stringify(validate.errors));
    assert.deepEqual(key.blind, { id, salt: SALT, seed: SEED, layoutVariant: null, copyOf: clean }); assert.equal(key.documents[0].degradation, preset);
    assert.ok(files.some((f) => /_p1\.(png|jpg)$/.test(f)), `${preset}: page images`);
    assert.deepEqual(leaksIn({ files }, tokensOf(key)), [], preset);
  };
  try {
    // the library's files (a scan copy written to the folders) ...
    const r = await renderDegraded({ ...job, preset: 'scan', outDir: path.join(dir, 'docs'), keysDir: path.join(dir, 'keys'), blind: { salt: SALT }, browser });
    check(r.id, JSON.parse(fs.readFileSync(path.join(dir, 'keys', `${r.id}.ground-truth.json`), 'utf-8')), 'scan', filesUnder(path.join(dir, 'docs')).filter((f) => path.basename(f).startsWith(r.id)));
    // ... and every other preset from one clean blind document, as the MCP server makes them (its files written here)
    const one = await render({ ...job, blind: { salt: SALT }, browser });
    for (const preset of ['fax', 'photo', 'low-res']) {
      const d = await degradeRendered(browser, { ...job, preset, clean: one });
      const id = d.groundTruth.blind.id; const files = [path.join(dir, `${id}.pdf`)]; fs.writeFileSync(files[0], d.bytes);
      for (const i of d.images) { const f = path.join(dir, `${id}_p${i.page}.${i.mimeType === 'image/png' ? 'png' : 'jpg'}`); fs.writeFileSync(f, i.data); files.push(f); }
      check(id, d.groundTruth, preset, files);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a blind set: documents in their folder in an order from the salt, keys and manifest apart, scored like any set', { skip, timeout: 600000 }, async () => {
  const dir = tmp('cs-blind-set-'); const docs = path.join(dir, 'docs'); const keys = path.join(dir, 'keys');
  try {
    const r = await renderBatch({ types: ['msn', 'ppo-eob'], scenarios: ['baseline-clean', 'duplicate-office-visit', 'duplicate-visit'], seeds: 1, seedPrefix: SEED, outDir: docs, keysDir: keys, blind: { salt: SALT }, also: '835', browser });
    assert.equal(r.count, 4); assert.equal(r.manifest, path.join(keys, 'manifest.jsonl')); assert.equal(r.salt, SALT);
    assert.deepEqual(fs.readdirSync(docs).filter((f) => !/^doc-[0-9a-f]{16}\.(pdf|835)$/.test(f)), []);
    const lines = readManifest(r.manifest);
    const planned = planBatch({ types: ['msn', 'ppo-eob'], scenarios: ['baseline-clean', 'duplicate-office-visit', 'duplicate-visit'], seeds: 1, seedPrefix: SEED });
    assert.deepEqual(lines.map((l) => `${l.type}/${l.scenario}/${l.seed}`), blindOrder(SALT, planned).map((j) => `${j.type}/${j.scenario}/${j.seed}`));
    for (const l of lines) {
      const key = JSON.parse(fs.readFileSync(path.join(keys, l.groundTruth), 'utf-8'));
      assert.equal(l.id, key.blind.id); assert.equal(l.pdf, `${l.id}.pdf`); assert.ok(validate(key), JSON.stringify(validate.errors));
      assert.deepEqual(leaksIn({ files: [path.join(docs, l.pdf), path.join(docs, `${l.id}.835`)] }, tokensOf(key, [SEED])), [], `${l.type}/${l.scenario}`);
    }
    // a perfect report for each document scores full marks through verify --manifest, from the keys folder
    const outputs = path.join(dir, 'reports'); fs.mkdirSync(outputs);
    for (const l of lines) {
      const key = JSON.parse(fs.readFileSync(path.join(keys, l.groundTruth), 'utf-8'));
      fs.writeFileSync(path.join(outputs, l.pdf.replace(/\.pdf$/, '.json')), JSON.stringify({ fields: key.documents[0].fields, errors: key.errors.map((e) => ({ kind: e.kind, fieldRef: e.fieldRef ?? null, lineRef: e.lineRef ?? null })) }));
    }
    const v = spawnSync(process.execPath, [CLI, 'verify', '--manifest', r.manifest, '--outputs', outputs], { encoding: 'utf-8' });
    assert.equal(v.status, 0, v.stderr); const s = JSON.parse(v.stdout);
    assert.equal(s.scored, 4); assert.equal(s.fields.accuracy, 1); assert.equal(s.errors.found, s.errors.expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('answer keys never share or sit inside the documents folder, and the blind options are refused when they do not fit', { skip, timeout: 300000 }, async () => {
  const dir = tmp('cs-blind-apart-');
  try {
    const docs = path.join(dir, 'docs'); fs.mkdirSync(docs); fs.symlinkSync(docs, path.join(dir, 'alias'));
    for (const keysDir of [docs, path.join(docs, 'keys'), path.join(docs, '..k'), path.join(dir, 'alias'), path.join(dir, 'alias', 'k')]) {
      await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', outDir: docs, keysDir, blind: true, browser }), (e) => e.message === msg('keysApart', 'render'));
      await assert.rejects(renderBatch({ types: ['msn'], seeds: 1, outDir: docs, keysDir, blind: true, browser }), (e) => e.message === msg('keysApart', 'batch'));
      await assert.rejects(renderDegraded({ type: 'msn', scenario: 'baseline-clean', preset: 'scan', outDir: docs, keysDir, blind: true, browser }), (e) => e.message === msg('keysApart', 'degrade'));
    }
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', outDir: docs, blind: true, browser }), (e) => e.message === msg('needKeys', 'render'));
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', outDir: docs, keysDir: path.join(dir, 'k'), browser }), (e) => e.message === msg('keysOnlyBlind', 'render'));
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', keysDir: path.join(dir, 'k'), blind: true, browser }), (e) => e.message === msg('keysOnlyBlind', 'render'));
    await assert.rejects(renderBatch({ types: ['msn'], seeds: 1, outDir: docs, blind: true, browser }), (e) => e.message === msg('needKeys', 'batch'));
    await assert.rejects(renderBatch({ types: ['msn'], seeds: 1, outDir: docs, keysDir: path.join(dir, 'k'), browser }), (e) => e.message === msg('keysOnlyBlind', 'batch'));
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', blind: { salt: 'nope' }, browser }), (e) => e.message === M.blindOption);
    assert.deepEqual(fs.readdirSync(docs), [], 'nothing written by a refused call');
    // a link that resolves only once the documents folder is made (judged by the folders, not their names): refused,
    // and the folders made for the check are gone again
    const later = path.join(dir, 'later'); fs.symlinkSync(path.join(dir, 'new', 'docs'), later);
    await assert.rejects(render({ type: 'msn', scenario: 'baseline-clean', outDir: path.join(dir, 'new', 'docs'), keysDir: path.join(later, 'k'), blind: true, browser }), (e) => e.message === msg('keysApart', 'render'));
    assert.equal(fs.existsSync(path.join(dir, 'new')), false, 'the folders made for the check are taken away');
    // a batch refused before anything is made leaves no documents folder; a link on the keys path that points into a
    // folder not made yet is refused, and leaves nothing behind either
    await assert.rejects(renderBatch({ types: ['msn'], seeds: 1, outDir: path.join(dir, 'fresh', 'docs'), keysDir: path.join(dir, 'fresh', 'docs', 'k'), blind: true, browser }), (e) => e.message === msg('keysApart', 'batch'));
    assert.equal(fs.existsSync(path.join(dir, 'fresh')), false, 'a refused batch made its documents folder');
    const inner = path.join(dir, 'link-inner'); fs.symlinkSync(path.join(dir, 'd4', 'docs', 'inner'), inner);
    for (const run of [() => render({ type: 'msn', scenario: 'baseline-clean', outDir: path.join(dir, 'd4', 'docs'), keysDir: inner, blind: true, browser }),
      () => renderBatch({ types: ['msn'], seeds: 1, outDir: path.join(dir, 'd4', 'docs'), keysDir: inner, blind: true, browser })]) {
      await assert.rejects(run(), (e) => /^(render|batch): answer keys must go in a folder apart/.test(e.message) && !e.message.includes(dir));
      assert.equal(fs.existsSync(path.join(dir, 'd4')), false, 'the folders made for the check are taken away');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the command line makes a blind document with --blind-keys, again with --blind-salt, and refuses the salt alone or malformed without echoing it', { skip, timeout: 300000 }, () => {
  const dir = tmp('cs-blind-cli-');
  try {
    const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf-8' });
    const bad = 'NOT-A-SALT-canary';
    for (const [args, message] of [[['--blind-salt', SALT], BLIND_STRINGS.cli.saltNeedsKeys], [['--blind-keys', path.join(dir, 'k'), '--blind-salt', bad], BLIND_STRINGS.cli.saltFormat]]) {
      const r = run('render', 'msn', 'baseline-clean', '--out', path.join(dir, 'd'), ...args);
      assert.equal(r.status, 2); assert.equal(r.stderr.trim(), message); assert.ok(!r.stderr.includes('canary'));
    }
    const a = run('render', 'msn', 'duplicate-office-visit', '--seed', SEED, '--out', path.join(dir, 'd1'), '--blind-keys', path.join(dir, 'k1'), '--blind-salt', SALT);
    const b = run('render', 'msn', 'duplicate-office-visit', '--seed', SEED, '--out', path.join(dir, 'd2'), '--blind-keys', path.join(dir, 'k2'), '--blind-salt', SALT);
    assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
    const [f1] = fs.readdirSync(path.join(dir, 'd1')); const [f2] = fs.readdirSync(path.join(dir, 'd2'));
    assert.match(f1, /^doc-[0-9a-f]{16}\.pdf$/); assert.equal(f1, f2);
    assert.ok(fs.readFileSync(path.join(dir, 'd1', f1)).equals(fs.readFileSync(path.join(dir, 'd2', f2))), 'the same salt makes the same document');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'k1')), [f1.replace(/\.pdf$/, '.ground-truth.json')]);
    assert.ok(!a.stdout.includes('duplicate') && !a.stdout.includes(SEED));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
