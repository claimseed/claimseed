#!/usr/bin/env node
// check-release-ready.js — refuses a release while any committed price is unverified or any scenario is engine-test only.
import fs from 'fs'; import path from 'path';
import { repoRoot } from './lib/repo-root.js';
const ROOT = repoRoot();
const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/core/reference-data/service-catalog.json'), 'utf-8'));
const unverified = cat.services.filter((s) => !s.verified).map((s) => s.code);
const params = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/core/reference-data/cms-annual-parameters.json'), 'utf-8'));
const unverifiedYears = Object.entries(params.years).filter(([, v]) => !v.verified).map(([y]) => y);
let bad = 0;
if (unverified.length) { console.error(`unverified prices for: ${unverified.join(', ')} — run scripts/fetch-reference-data.js`); bad++; }
if (unverifiedYears.length) { console.error(`unverified annual parameters: ${unverifiedYears.join(', ')}`); bad++; }
for (const type of fs.readdirSync(path.join(ROOT, 'packages/core/scenarios'))) for (const f of fs.readdirSync(path.join(ROOT, 'packages/core/scenarios', type))) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/core/scenarios', type, f), 'utf-8'));
  if (s.status === 'engine-test') { console.error(`engine-test scenario still present: ${type}/${f}`); bad++; }
}
process.exit(bad ? 1 : 0);
