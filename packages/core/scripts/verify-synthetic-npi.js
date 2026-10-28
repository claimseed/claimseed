#!/usr/bin/env node
// verify-synthetic-npi.js — two checks on everything the generator can produce and everything committed:
//   offline (default): every NPI is 10 digits, Luhn-valid with the 80840 prefix, and starts with 9 — the
//     digit NPPES never issues, so no synthetic NPI can belong to a real provider.
//   --nppes: additionally query the public NPPES registry for each individual provider NAME + STATE the
//     lexicon can produce, and fail if a real provider of that name practices in that state. Run this
//     monthly (CI cron) and whenever lexicon.js changes. Reference: https://npiregistry.cms.hhs.gov/api/
import fs from 'fs'; import path from 'path';
import { isSyntheticNpi } from '../src/generate/identifiers.js';
import { PROVIDER_FIRST, PROVIDER_LAST, PLACES } from '../src/generate/lexicon.js';
const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '../../..'));
const problems = [];
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', '.git', 'output'].includes(e.name)) continue; const p = path.join(dir, e.name); e.isDirectory() ? walk(p, fn) : fn(p); } }
walk(ROOT, (p) => {
  if (!/\.(json|md|html|js)$/.test(p)) return;
  const t = fs.readFileSync(p, 'utf-8');
  for (const m of t.matchAll(/"npi"\s*:\s*"(\d+)"/gi)) if (!isSyntheticNpi(m[1])) problems.push(`${path.relative(ROOT, p)}: NPI ${m[1]} is not a synthetic (9-prefixed, Luhn-valid) NPI`);
});
if (process.argv.includes('--nppes')) {
  const states = [...new Set(PLACES.map((p) => p.state))];
  let checked = 0;
  for (const first of PROVIDER_FIRST) for (const last of PROVIDER_LAST) for (const state of states) {
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&first_name=${first}&last_name=${last}&state=${state}&limit=1`;
    const r = await fetch(url); const j = await r.json(); checked++;
    if (j.result_count > 0) problems.push(`NPPES has a real provider named ${first} ${last} in ${state} — change the lexicon`);
  }
  console.log(`nppes: checked ${checked} name/state combinations`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('verify-synthetic-npi: ok');
