#!/usr/bin/env node
// claimseed engine CLI (installed as claimseed-core)
//   claimseed-core list [type]
//   claimseed-core generate <type> <scenario> --seed S          -> JSON on stdout (data + groundTruth)
//   claimseed-core render <type> <scenario> --seed S --out DIR  -> PDF + <name>.ground-truth.json
//   claimseed-core batch --types T1,T2 [--scenarios all|S1,S2] [--seeds N] [--seed-prefix P] --out DIR
//                                                              -> PDFs, answer keys and manifest.jsonl in DIR
//   claimseed-core verify --answer-key FILE --output FILE      -> score one extractor output (JSON on stdout)
//   claimseed-core verify <type> <scenario> --seed S --output FILE   (answer key rebuilt from the seed)
//   claimseed-core verify --manifest DIR/manifest.jsonl --outputs DIR2
//                                                              -> score <name>.json in DIR2 for every document
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { generateData, listScenarios } from './generate/index.js';
import { readRegularFile } from './safe-read.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`--${name} needs a value`); process.exit(2); }
  return v;
}
function mustMatch(v, re, what) { if (!re.test(String(v))) { console.error(`${what} must match ${re}`); process.exit(2); } }
const MAX_JSON = 10 * 2 ** 20;
const why = (e) => (e.code === 'NOT_REGULAR' ? 'not a regular file (a link, a folder or a special file)' : e.code === 'TOO_LARGE' ? `over ${MAX_JSON / 2 ** 20} MB`
  : e.code === 'ENOENT' ? 'missing' : `unreadable (${e.code || 'error'})`);
// a file named on the command line: links are followed (it is the caller's own path), special files and big files refused
function readJson(file, what) {
  let bytes;
  try { bytes = readRegularFile(file, MAX_JSON, { follow: true }); } catch (e) { console.error(`${what} is ${why(e)}`); process.exit(2); }
  try { return JSON.parse(bytes.toString('utf-8')); } catch { console.error(`${what} is not valid JSON`); process.exit(2); }
}
// one report of a set: named by the manifest, so a link is not followed; an unreadable report is listed as invalid,
// like one of the wrong shape, and the rest of the set is scored. Only a report that is not there counts as missing
// (a file holding JSON null is a report of the wrong shape).
const MISSING = Symbol('missing report');
function readReport(file) {
  let bytes;
  try { bytes = readRegularFile(file, MAX_JSON); } catch (e) { if (e.code === 'ENOENT') return MISSING; throw Object.assign(new Error(`extractor output: ${why(e)}`), { code: 'EXTRACTOR_OUTPUT' }); }
  try { return JSON.parse(bytes.toString('utf-8')); } catch { throw Object.assign(new Error('extractor output: not valid JSON'), { code: 'EXTRACTOR_OUTPUT' }); }
}
const total = (rs, part, key) => rs.reduce((n, r) => n + (r[part]?.[key] || 0), 0);
const ratio = (n, d) => (d ? Math.round((n / d) * 10000) / 10000 : null);
const [cmd, type, scenario] = args;

async function main() {
  if (cmd === 'list') {
    if (type) mustMatch(type, SLUG, 'type');
    const types = type ? [type] : fs.readdirSync(path.resolve(__dirname, '../scenarios')).filter((t) => SLUG.test(t));
    for (const t of types) for (const s of listScenarios(t)) console.log(`${t}/${s}`);
    return;
  }
  if (cmd === 'generate' || cmd === 'render') { mustMatch(type, SLUG, 'type'); mustMatch(scenario, SLUG, 'scenario'); mustMatch(flag('seed', 'claimseed'), SEED, 'seed'); }
  if (cmd === 'generate') {
    const out = generateData({ type, scenario, seed: flag('seed', 'claimseed') });
    process.stdout.write(JSON.stringify(out, null, 2)); return;
  }
  if (cmd === 'render') {
    const seed = flag('seed', 'claimseed'); const outDir = path.resolve(flag('out', 'output'));
    const { render } = await import('./index.js');
    const { pdf, bytes } = await render({ type, scenario, seed, outDir });
    console.log(`wrote ${pdf} (${bytes.length} bytes) and ground truth`);
    return;
  }
  if (cmd === 'batch') {
    const { renderBatch } = await import('./batch.js');
    const types = String(flag('types', '')).split(',').filter(Boolean);
    const sc = flag('scenarios', 'all'); const seeds = Number(flag('seeds', '10'));
    const out = flag('out', null); if (!out) { console.error('batch needs --out DIR'); process.exit(2); }
    const r = await renderBatch({ types, scenarios: sc === 'all' ? 'all' : sc.split(',').filter(Boolean), seeds, seedPrefix: flag('seed-prefix', 'batch'), outDir: path.resolve(out),
      onProgress: (n, of) => { if (n === of || n % 10 === 0) console.log(`batch: ${n} of ${of}`); } });
    console.log(`wrote ${r.count} documents and ${r.manifest}`);
    return;
  }
  if (cmd === 'verify') {
    const { scoreExtraction, verifyFromSeed } = await import('./verify.js');
    const manifest = flag('manifest', null);
    if (manifest) {
      const { readManifest } = await import('./batch.js');
      const outputs = flag('outputs', null); if (!outputs) { console.error('verify --manifest needs --outputs DIR'); process.exit(2); }
      const dir = path.dirname(path.resolve(manifest)); const results = []; const invalid = []; let missing = 0;
      for (const e of readManifest(manifest)) {
        // score against the answer key saved with the set, as written: a key edited since, one from another set, or a
        // link or special file in its place is refused. The bytes hashed are the bytes parsed.
        let keyBytes;
        try { keyBytes = readRegularFile(path.join(dir, e.groundTruth), MAX_JSON); }
        catch (err) { console.error(`${e.groundTruth} is ${why(err)}; render the set again`); process.exit(1); }
        if (crypto.createHash('sha256').update(keyBytes).digest('hex') !== e.groundTruthSha256) {
          console.error(`${e.groundTruth} does not match its hash in the manifest; render the set again`); process.exit(1);
        }
        let key; try { key = JSON.parse(keyBytes.toString('utf-8')); } catch { console.error(`${e.groundTruth} is not valid JSON`); process.exit(1); }
        let report;
        try { report = readReport(path.join(path.resolve(outputs), e.pdf.replace(/\.pdf$/, '.json'))); }
        catch (err) { invalid.push({ document: e.pdf, problem: err.message }); continue; }
        if (report === MISSING) { missing++; continue; }
        try { results.push({ document: e.pdf, ...scoreExtraction(key, report) }); }
        catch (err) { if (err.code !== 'EXTRACTOR_OUTPUT') throw err; invalid.push({ document: e.pdf, problem: err.message }); }
      }
      const summary = { documents: results.length + invalid.length + missing, scored: results.length, missingOutputs: missing, invalidOutputs: invalid,
        fields: { expected: total(results, 'fields', 'expected'), correct: total(results, 'fields', 'correct'), accuracy: ratio(total(results, 'fields', 'correct'), total(results, 'fields', 'expected')) },
        errors: { expected: total(results, 'errors', 'expected'), found: total(results, 'errors', 'found'), falseAlarms: total(results, 'errors', 'falseAlarms'),
          decoysFlagged: results.reduce((n, r) => n + (r.errors?.decoysFlagged.length || 0), 0),
          recall: ratio(total(results, 'errors', 'found'), total(results, 'errors', 'expected')),
          precision: ratio(total(results, 'errors', 'found'), total(results, 'errors', 'flagged') - total(results, 'errors', 'repeats')) },
        documentsScored: results };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return;
    }
    const outFile = flag('output', null); if (!outFile) { console.error('verify needs --output FILE'); process.exit(2); }
    const output = readJson(outFile, 'the extractor output');
    const key = flag('answer-key', null);
    let r;
    if (key) r = scoreExtraction(readJson(key, 'the answer key'), output);
    else { mustMatch(type, SLUG, 'type'); mustMatch(scenario, SLUG, 'scenario'); mustMatch(flag('seed', 'claimseed'), SEED, 'seed'); r = verifyFromSeed({ type, scenario, seed: flag('seed', 'claimseed'), output }); }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return;
  }
  console.error('usage: claimseed-core list [type] | generate <type> <scenario> --seed S | render <type> <scenario> --seed S --out DIR\n'
    + '       | batch --types T1,T2 [--scenarios all|S1,S2] [--seeds N] [--seed-prefix P] --out DIR\n'
    + '       | verify (--answer-key FILE | <type> <scenario> --seed S) --output FILE | verify --manifest FILE --outputs DIR');
  process.exit(2);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
