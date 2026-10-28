#!/usr/bin/env node
// claimseed engine CLI
//   claimseed list [type]
//   claimseed generate <type> <scenario> --seed S          -> JSON on stdout (data + groundTruth)
//   claimseed render <type> <scenario> --seed S --out DIR  -> PDF + <name>.ground-truth.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateData, listScenarios } from './generate/index.js';

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
  console.error('usage: claimseed list [type] | generate <type> <scenario> --seed S | render <type> <scenario> --seed S --out DIR');
  process.exit(2);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
