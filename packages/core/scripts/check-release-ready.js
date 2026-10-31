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
// The package as npm would publish it must load and generate every document type and an 835: pack it, unpack it
// beside the installed dependencies, and import it from there, so a data file left out of `files` fails here.
{
  const { execFileSync } = await import('child_process'); const os = await import('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pack-'));
  try {
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: path.join(ROOT, 'packages/core'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tgz = path.join(tmp, JSON.parse(out)[0].filename);
    execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'package', 'node_modules'), 'dir');
    const script = `const m = await import(${JSON.stringify(path.join(tmp, 'package/src/index.js'))});
for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) m.generateData({ type, scenario: 'baseline-clean', seed: 'pack' });
for (const type of m.REMITTANCE_TYPES) await m.remittanceFor({ type, scenario: 'baseline-clean', seed: 'pack' });`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { console.error(`the packed @claimseed/core does not load: ${String(e.stderr || e.message).split('\n').find((l) => /Error|ENOENT/.test(l)) || e.message}`); bad++; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
process.exit(bad ? 1 : 0);
