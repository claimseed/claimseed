#!/usr/bin/env node
// check-release-ready.js — refuses a release while any committed price is unverified, any scenario is engine-test only,
// or what ships (the npm package's files, the image's allowlist) misses a layout's data, a data file or a template.
import fs from 'fs'; import path from 'path';
import { repoRoot } from './lib/repo-root.js';
import { isMain as runAsScript } from './lib/is-main.js';
// run as a script (not imported by a test)
const isMain = runAsScript(import.meta.url);
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
// What ships, as a class: every layout's data folder, and every top-level data file the source names, is in the core
// package's `files` and in the image's allowlist (.dockerignore), and every core entry of `files` is in the allowlist.
export function packagingProblems({ files, dockerignore, types, dataFiles }) {
  const allow = new Set(dockerignore.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!packages/core/')).map((l) => l.slice('!packages/core/'.length)));
  const out = [];
  for (const t of types) { if (!files.includes(`data/${t}`)) out.push(`data/${t} is not in the core package's files`); if (!allow.has(`data/${t}`)) out.push(`data/${t} is not in .dockerignore's allowlist`); }
  for (const f of dataFiles) { if (!files.includes(`data/${f}`)) out.push(`data/${f} is not in the core package's files`); if (!allow.has(`data/${f}`)) out.push(`data/${f} is not in .dockerignore's allowlist`); }
  for (const f of files) if (!allow.has(f)) out.push(`${f} ships in the npm package but not in the image (.dockerignore)`);
  return out;
}
// The release workflow: npm publishes by trusted publishing (no token of any kind), and nothing takes the `latest` tag
// (the image's, or npm's dist-tag) except in the `latest)` arm of a case on is-highest-version.js's answer, read in the
// same step from this release's version and every v-tag (`d="$(node .../is-highest-version.js "$v" $(git tag -l 'v[0-9]*'))"
// || exit 1`, then `case "$d" in latest) ... *) exit 1 ;; esac`).
// Every npm publish carries `--tag "$tag"`, so none falls back to npm's default of latest.
const LATEST = [/:\s*['"]?latest\b/g, /=\s*['"]?latest\b/g, /--tag\s+['"]?latest\b/g, /\bdist-tag\s+add\b[^#\n]*\blatest\b/g];
export function releaseWorkflowProblems(text) {
  const out = [];
  for (const [re, what] of [[/NODE_AUTH_TOKEN/, 'NODE_AUTH_TOKEN'], [/_auth(Token)?\b/, 'an npm _auth setting'], [/npmrc|userconfig/i, 'an npm config file'], [/npm_config_\w*(auth|token)/i, 'an npm auth setting'], [/\bsecrets\b(?!\.GITHUB_TOKEN\b)/, 'a secret other than GITHUB_TOKEN']])
    if (re.test(text)) out.push(`release.yml names ${what}; publishing uses trusted publishing only`);
  const lines = text.split('\n');
  const code = (l) => !/^\s*#/.test(l);
  // a step starts at a list item with a key (- name:, - run:, - uses:, ...); a steps: list or a job ends the walk too
  const stepStart = (i) => { let k = i; while (k > 0 && !/^\s*- [\w-]+:/.test(lines[k]) && !/^\s*steps:\s*$/.test(lines[k]) && !/^ {2}[\w-]+:\s*$/.test(lines[k])) k--; return k; };
  lines.forEach((l, i) => {
    if (!code(l)) return;
    if (/\bnpm\b.*\bpublish\b/.test(l) && !/--tag "\$tag"/.test(l)) out.push(`release.yml line ${i + 1}: npm publish without --tag "$tag"`);
    const hits = LATEST.flatMap((re) => [...l.matchAll(re)].map((m) => m.index));
    if (!hits.length) return;
    // the arms of a case on a variable: every hit must sit in a latest) arm (up to its ;;), with a *) exit 1 arm present
    const c = /\bcase "\$(\w+)" in\b/.exec(l);
    // an arm whose whole pattern is latest: right after `in` or after the previous arm's ;; (never hold|latest)
    const arms = []; if (c) for (const m of l.matchAll(/(?:\bin\s+|;;\s*)latest\)/g)) { const e = l.indexOf(';;', m.index + m[0].length); arms.push([m.index + m[0].length, e < 0 ? l.length : e]); }
    const inArm = hits.every((h) => arms.some(([a, b]) => h >= a && h < b));
    const decided = c && /\*\)\s*exit 1\b/.test(l) && lines.slice(stepStart(i), i).some((x) => code(x)
      && new RegExp(`\\b${c[1]}="\\$\\(node \\S*is-highest-version\\.js "(?:\\$v|\\$\\{GITHUB_REF_NAME#v\\})" \\$\\(git tag -l 'v\\[0-9\\]\\*'\\)\\)" \\|\\| exit 1$`).test(x.trim()));
    if (!inArm || !decided) out.push(`release.yml line ${i + 1}: latest is set without is-highest-version.js's answer (a latest) arm of a case on it, read in the same step)`);
  });
  return out;
}
// the top-level data files (packages/core/data/<name>) whose names appear as string literals in the source
export function dataFilesNamed(core) {
  const names = fs.readdirSync(path.join(core, 'data'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const src = walk(path.join(core, 'src')).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
  return names.filter((n) => new RegExp(`['"\`/]${n.replace(/[.]/g, '\\.')}['"\`]`).test(src));
}
if (!isMain) { /* imported by a test: the checks below run only as a script */ } else {
{
  const core = path.join(ROOT, 'packages/core');
  let RENDERERS = {};
  try { ({ RENDERERS } = await import('../src/layouts.js')); } catch (e) { console.error(`the layouts do not load from this checkout: ${String(e.message).split('\n')[0]}`); bad++; }
  const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf-8'));
  for (const m of releaseWorkflowProblems(fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf-8'))) { console.error(m); bad++; }
  for (const m of packagingProblems({ files: pkg.files, dockerignore: fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8'), types: Object.keys(RENDERERS), dataFiles: dataFilesNamed(core) })) { console.error(m); bad++; }
}
// The package as npm would publish it must load, generate every document type and an 835, and print every template
// part (capture mode, no browser) of every type and of one layout variant per varied type: pack it, unpack it beside
// the installed dependencies, and import it from there, so a data file or template left out of `files` fails here.
{
  const { execFileSync } = await import('child_process'); const os = await import('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pack-'));
  try {
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: path.join(ROOT, 'packages/core'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tgz = path.join(tmp, JSON.parse(out)[0].filename);
    execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'package', 'node_modules'), 'dir');
    const script = `const m = await import(${JSON.stringify(path.join(tmp, 'package/src/index.js'))});
const { printHooks } = await import(${JSON.stringify(path.join(tmp, 'package/src/browser.js'))});
const fs = await import('fs'); const os = await import('os'); const path = await import('path');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pack-render-')); console.log = () => {};
printHooks.capture = () => {};
try {
  for (const type of Object.keys(m.RENDERERS)) for (const layoutVariant of [null, m.variantIds(type)[0] || null]) {
    const { data } = m.generateData({ type, scenario: 'baseline-clean', seed: 'pack', layoutVariant });
    const stock = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tmp, 'package/data'))} + '/' + type + '/stock-content.json', 'utf-8'));
    await m.RENDERERS[type](data, stock, work, { title: 't', band: 'b' });
  }
} finally { printHooks.capture = null; fs.rmSync(work, { recursive: true, force: true }); }
for (const type of m.REMITTANCE_TYPES) await m.remittanceFor({ type, scenario: 'baseline-clean', seed: 'pack' });`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { console.error(`the packed @claimseed/core does not load: ${String(e.stderr || e.message).split('\n').find((l) => /Error|ENOENT/.test(l)) || e.message}`); bad++; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
process.exit(bad ? 1 : 0);
}
