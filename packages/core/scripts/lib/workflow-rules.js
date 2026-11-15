// workflow-rules.js — the CI and release workflows, checked as text (no YAML library; check-release-ready.js runs it).
// What they must guarantee: the release runs the same test jobs as CI (tests.yml); nothing after the tests can run
// unless every shard and part passed; nothing in tests.yml can be skipped or let a failure pass; every job has a time
// limit; ci-ok fails unless every job before it succeeded.
//
// Two layers. The rules below give a clear message for the likely mistakes, on a YAML subset the files are written in
// (no quoted keys, anchors, tags, merge keys or flow mappings outside `with:`; block scalars for `run:` only; only the
// keys the files use). And each file's SHA-256 is pinned (WORKFLOW_SHA256): a text check cannot foresee every way YAML
// can say the same thing, so any edit to a workflow fails until the pin is changed with it, which makes the edit a
// change to the release tools, reviewed as one.
import crypto from 'crypto';

export const WORKFLOW_SHA256 = Object.freeze({
  'ci.yml': 'c319ece46af9c1785833178ea8231f1fa4361ec2b0e103b51b9d37060ce39624',
  'tests.yml': 'b02f91d511ab0918231e57cfdcae341bd7ea5b1c912cfa7df4d9681b92711abc',
  'release.yml': '1ab734e0d060e0aeba34c3b0a31bbed60c0ea57f2f7878a75c262a56dac9cf76',
});
// the one runner image every job names (see tests.yml)
export const RUNNER = 'ubuntu-24.04';
export const workflowSha256 = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// The lines of a file: comment lines dropped; for structural lines a trailing comment is cut; the content of a
// `run: |` block is kept whole (it is shell) and marked.
export function lexWorkflow(text) {
  const out = []; let block = null;
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    if (block !== null) { if (!raw.trim() || indent > block) { if (raw.trim()) out.push({ n: i + 1, raw, code: raw, indent, content: true }); return; } block = null; }
    if (!raw.trim() || /^\s*#/.test(raw)) return;
    const code = raw.replace(/\s+#[^'"]*$/, '');
    out.push({ n: i + 1, raw, code, indent, content: false });
    // a block's content is indented past its key: past the dash too when the key opens a list item (`- run: |`)
    if (/:\s*[|>][+-]?\s*$/.test(code)) block = indent + (/^\s*- /.test(code) ? 2 : 0);
  });
  return out;
}

// { job: { lines (structural and content), keys (its own, four-space indent) } } for the jobs under `jobs:`
export function workflowJobs(text) {
  const jobs = {}; let inJobs = false; let cur = null;
  for (const l of lexWorkflow(text)) {
    if (!l.content && l.indent === 0) { inJobs = /^jobs:\s*$/.test(l.code); cur = null; continue; }
    if (!inJobs) continue;
    const j = !l.content && l.indent === 2 ? /^ {2}([a-z][\w-]*):\s*$/.exec(l.code) : null;
    if (j) { cur = jobs[j[1]] = { lines: [], keys: {} }; continue; }
    if (!cur) continue;
    cur.lines.push(l);
    const k = !l.content && l.indent === 4 ? /^ {4}([\w-]+):\s*(.*)$/.exec(l.code) : null; if (k) cur.keys[k[1]] = k[2].trim();
  }
  return jobs;
}

const JOB_KEYS = { 'ci.yml': ['runs-on', 'timeout-minutes', 'needs', 'if', 'steps', 'uses'], 'tests.yml': ['runs-on', 'timeout-minutes', 'needs', 'outputs', 'strategy', 'steps'],
  'release.yml': ['runs-on', 'timeout-minutes', 'needs', 'if', 'outputs', 'steps', 'uses', 'environment', 'permissions'] };
const STEP_KEYS = { 'ci.yml': ['uses', 'with', 'run', 'name', 'id', 'env', 'if'], 'tests.yml': ['uses', 'with', 'run', 'name', 'id', 'env'], 'release.yml': ['uses', 'with', 'run', 'name', 'id', 'env', 'working-directory'] };
// the only `if:` lines each file may hold, exactly
const IFS = {
  'ci.yml': ["        if: startsWith(github.ref, 'refs/tags/v')", `        if: "!startsWith(github.ref, 'refs/tags/v')"`, '    if: always()', "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"],
  'tests.yml': [],
  'release.yml': ["    if: contains(fromJSON(needs.gates.outputs.packages), '@claimseed/mcp')", "    if: vars.PUBLISH_IMAGE == 'true'"],
};
// the commands tests.yml runs, job by job, each exactly once
const TESTS_RUNS = {
  plan: ['npm ci', 'node packages/core/scripts/ci-plan.js'],
  test: ['sudo apt-get update && sudo apt-get install -y --no-install-recommends poppler-utils', 'npm ci', 'node packages/core/scripts/test-with-render-log.js --shard "$((INDEX + 1))/$TOTAL"'],
  rendered: ['sudo apt-get update && sudo apt-get install -y --no-install-recommends poppler-utils', 'npm ci', 'node packages/core/scripts/scan-rendered.js --seeds 2 --blind all --part "$((INDEX + 1))/$TOTAL"', 'node packages/core/scripts/examples.js --check --part "$((INDEX + 1))/$TOTAL"'],
};
const TESTS_ENV = { INDEX: '${{ strategy.job-index }}', TOTAL: '${{ strategy.job-total }}', CI: "'true'", CLAIMSEED_CHROME: '/usr/bin/google-chrome' };

function subsetProblems(file, lines) {
  const out = [];
  let inJobs = false; let inSteps = false;
  for (const l of lines) {
    if (/\t/.test(l.raw)) out.push(`${file}: line ${l.n} has a tab`);
    if (l.content) continue;
    const c = l.code;
    if (l.indent === 0) { inJobs = /^jobs:\s*$/.test(c); inSteps = false; }
    if (/^\s*(- )?(["']).*?\2\s*:(\s|$)/.test(c)) out.push(`${file}: line ${l.n} has a quoted key`);
    if (/(^\s*(- )?|:\s+)[&*][\w-]/.test(c) || /^\s*(- )?<<\s*:/.test(c) || /!!/.test(c) || /^\s*\?\s/.test(c)) out.push(`${file}: line ${l.n} uses an anchor, alias, tag, merge key or complex key`);
    const kv = /^\s*(?:- )?([\w-]+):\s*(.*)$/.exec(c);
    if (kv && /^\{/.test(kv[2]) && kv[1] !== 'with') out.push(`${file}: line ${l.n} writes ${kv[1]} as a flow mapping (only with: may)`);
    if (kv && /^[|>]/.test(kv[2]) && kv[1] !== 'run') out.push(`${file}: line ${l.n} writes ${kv[1]} as a block scalar (only run: may)`);
    if (kv && /^[|>]/.test(kv[2]) && !/^[|>][+-]?$/.test(kv[2].trim())) out.push(`${file}: line ${l.n} opens a block scalar with an indentation indicator (only |, > and their - or + forms)`);
    if (kv && /^\[/.test(kv[2]) && !['needs', 'tags'].includes(kv[1])) out.push(`${file}: line ${l.n} writes ${kv[1]} as a flow sequence (only needs: and tags: may)`);
    if (inJobs && l.indent === 2 && !/^ {2}[a-z][\w-]*:$/.test(c)) out.push(`${file}: line ${l.n}: under jobs:, a line at two spaces must be a job name alone`);
    if (inJobs && l.indent === 4) {
      const k = /^ {4}([\w-]+):/.exec(c); inSteps = !!k && k[1] === 'steps';
      if (!k || !JOB_KEYS[file].includes(k[1])) out.push(`${file}: line ${l.n}: ${k ? `the job key ${k[1]}` : 'this line'} is not one this file may use`);
    }
    if (inJobs && inSteps && l.indent >= 6) {
      const s = /^ {6}- ([\w-]+):/.exec(c) || (l.indent === 8 ? /^ {8}([\w-]+):/.exec(c) : null);
      if (s && !STEP_KEYS[file].includes(s[1])) out.push(`${file}: line ${l.n}: the step key ${s[1]} is not one this file may use`);
    }
    for (const bad of ['shell', 'defaults', 'working-directory', 'container', 'services', 'continue-on-error']) if (new RegExp(`^\\s*(- )?${bad}\\s*:`).test(c) && !(file === 'release.yml' && bad === 'working-directory' && inSteps)) out.push(`${file}: line ${l.n} sets ${bad}`);
  }
  return out;
}

// the workflows folder holds these three files only: a fourth workflow would run on its own triggers, unchecked
export const WORKFLOW_FILES = Object.freeze(['ci.yml', 'release.yml', 'tests.yml']);
export const folderProblems = (names) => ([...names].sort().join() === WORKFLOW_FILES.join() ? [] : [`.github/workflows must hold ${WORKFLOW_FILES.join(', ')} only (it holds ${names.length} entries)`]);

export function workflowProblems({ ci, tests, release }) {
  const out = []; const files = { 'ci.yml': ci, 'tests.yml': tests, 'release.yml': release };
  const lex = Object.fromEntries(Object.entries(files).map(([f, t]) => [f, lexWorkflow(t)]));
  for (const [f, t] of Object.entries(files)) if (WORKFLOW_SHA256[f] && workflowSha256(t) !== WORKFLOW_SHA256[f]) out.push(`${f} is not the reviewed file: a workflow change is a change to the release tools; review it and update WORKFLOW_SHA256 in scripts/lib/workflow-rules.js with it`);
  for (const [f, L] of Object.entries(lex)) out.push(...subsetProblems(f, L));
  const T = workflowJobs(tests); const R = workflowJobs(release); const C = workflowJobs(ci);
  for (const [f, L] of Object.entries(lex)) {
    for (const l of L) {
      if (f !== 'ci.yml' && /\b(always|cancelled|failure|success)\s*\(/.test(l.code)) out.push(`${f}: line ${l.n} uses a status function`);
      if (/\|\|\s*true\b/.test(l.code) && !(f === 'ci.yml' && l.code === '      - run: node packages/core/scripts/check-release-ready.js || true')) out.push(`${f}: line ${l.n} ignores a command's failure (|| true)`);
      if (/\bsecrets\s*:\s*inherit\b/.test(l.code)) out.push(`${f}: line ${l.n} passes every secret on (secrets: inherit)`);
      if (!l.content && /^\s*(- )?if\s*:/.test(l.code) && !IFS[f].includes(l.code.replace(/\s+$/, ''))) out.push(`${f}: line ${l.n} has an if: this file may not hold`);
    }
  }
  // tests.yml: called only, read-only, every command once, its index from GitHub
  const tl = lex['tests.yml'].filter((l) => !l.content);
  const on = tl.findIndex((l) => l.indent === 0 && l.code === 'on:'); const onBody = [];
  if (on >= 0) for (const l of tl.slice(on + 1)) { if (l.indent === 0) break; onBody.push(l.code); }
  if (onBody.join('\n') !== '  workflow_call:') out.push('tests.yml: on: must be workflow_call only');
  const perm = tl.findIndex((l) => l.code === 'permissions:');
  if (perm < 0 || tl[perm].indent !== 0 || !tl[perm + 1] || tl[perm + 1].code !== '  contents: read' || (tl[perm + 2] && tl[perm + 2].indent > 0) || tl.filter((l) => /^\s*permissions\s*:/.test(l.code)).length !== 1) out.push('tests.yml: permissions must be contents: read, once, at the top');
  for (const l of lex['tests.yml']) if (/\bsecrets\b|\bid-token\b|\bnpm\b.*\bpublish\b|\bdocker push\b|\bgit push\b/.test(l.code)) out.push(`tests.yml: line ${l.n} names a secret, an id-token or a publish or push`);
  for (const l of lex['tests.yml']) if (/\$\{\{\s*matrix\./.test(l.code)) out.push(`tests.yml: line ${l.n} uses a matrix value (the index comes from strategy.job-index)`);
  if (Object.keys(T).join() !== Object.keys(TESTS_RUNS).join()) out.push(`tests.yml: the jobs must be ${Object.keys(TESTS_RUNS).join(', ')}`);
  for (const [job, runs] of Object.entries(TESTS_RUNS)) {
    const got = (T[job]?.lines || []).filter((l) => !l.content && /^\s*(- )?run:/.test(l.code)).map((l) => l.code.replace(/^\s*(- )?run:\s*/, '').trim());
    if (got.join('\n') !== runs.join('\n')) out.push(`tests.yml: the ${job} job must run exactly: ${runs.join('; ')}`);
    for (const l of T[job]?.lines || []) {
      const e = !l.content && /^ {10}([A-Z_]+):\s*(.*)$/.exec(l.code);
      if (e && TESTS_ENV[e[1]] !== e[2].replace(/\s+#.*$/, '').trim()) out.push(`tests.yml: line ${l.n}: env ${e[1]} is not one the jobs may set, or not its value`);
    }
  }
  for (const [job, list] of [['test', 'shards'], ['rendered', 'parts']]) {
    const L = (T[job]?.lines || []).map((l) => l.code);
    if (!L.some((l) => /^ {6}fail-fast: false\s*$/.test(l))) out.push(`tests.yml: the ${job} job needs fail-fast: false`);
    if (!L.some((l) => new RegExp(`^ {8}\\w+: \\$\\{\\{ fromJSON\\(needs\\.plan\\.outputs\\.${list}\\) \\}\\}\\s*$`).test(l))) out.push(`tests.yml: the ${job} matrix must come from needs.plan.outputs.${list}`);
    const cmds = L.filter((l) => /--(shard|part) "\$\(\(INDEX \+ 1\)\)\/\$TOTAL"/.test(l)).length;
    if (L.filter((l) => /^ {10}INDEX: \$\{\{ strategy\.job-index \}\}\s*$/.test(l)).length !== cmds || L.filter((l) => /^ {10}TOTAL: \$\{\{ strategy\.job-total \}\}\s*$/.test(l)).length !== cmds) out.push(`tests.yml: each ${job} command takes INDEX and TOTAL from strategy.job-index and job-total through env`);
  }
  // the runner: every job that runs steps names one fixed image, so a new image cannot change what the checks read
  for (const [file, jobs] of [['tests.yml', T], ['release.yml', R], ['ci.yml', C]]) for (const [name, j] of Object.entries(jobs)) {
    if (j.keys.uses !== undefined) continue;
    if (j.keys['runs-on'] !== RUNNER) out.push(`${file}: the ${name} job must run on ${RUNNER}`);
  }
  // timeouts: every job that runs steps
  const limit = (file, jobs, max) => { for (const [name, j] of Object.entries(jobs)) { if (j.keys.uses !== undefined) continue; const v = Number(j.keys['timeout-minutes']); const cap = max(name); if (!Number.isSafeInteger(v) || v < 1 || v > cap) out.push(`${file}: the ${name} job needs timeout-minutes of at most ${cap}`); } };
  limit('tests.yml', T, (n) => (n === 'plan' ? 5 : 20));
  limit('release.yml', R, () => 20);
  limit('ci.yml', C, (n) => (n === 'nppes-monthly' ? 30 : n === 'ci-ok' ? 5 : 20));
  // release.yml: tests is tests.yml as it stands; every other job needs gates and tests
  const needsOf = (v) => { if (v === undefined) return []; const m = /^\[(.*)\]$/.exec(v); return (m ? m[1].split(',') : [v]).map((x) => x.trim()).filter(Boolean); };
  if (!R.gates || !R.tests) out.push('release.yml: needs a gates job and a tests job');
  if (R.tests && (R.tests.keys.uses !== './.github/workflows/tests.yml' || Object.keys(R.tests.keys).join() !== 'uses' || R.tests.lines.length !== 1)) out.push('release.yml: the tests job is `uses: ./.github/workflows/tests.yml` and nothing else (no with, secrets or permissions)');
  for (const [name, j] of Object.entries(R)) {
    if (name === 'gates' || name === 'tests') continue;
    const n = needsOf(j.keys.needs);
    if (!n.includes('gates') || !n.includes('tests')) out.push(`release.yml: the ${name} job must need both gates and tests (written inline: needs: [gates, tests, ...])`);
  }
  // ci.yml: tests is tests.yml; ci-ok is exactly the job that fails unless every other job succeeded
  if (!C.tests || C.tests.keys.uses !== './.github/workflows/tests.yml' || Object.keys(C.tests.keys).join() !== 'uses' || C.tests.lines.length !== 1) out.push('ci.yml: the tests job is `uses: ./.github/workflows/tests.yml` and nothing else');
  const gatesHere = Object.keys(C).filter((n) => n !== 'ci-ok' && n !== 'nppes-monthly');
  const v = (n) => n.toUpperCase().replace(/-/g, '_');
  const expected = [`    needs: [${gatesHere.join(', ')}]`, '    if: always()', `    runs-on: ${RUNNER}`, '    timeout-minutes: 5', '    steps:', '      - run: |',
    `          for r in ${gatesHere.map((n) => `"$${v(n)}"`).join(' ')}; do [ "$r" = success ] || { echo "a required job ended: $r"; exit 1; }; done`, '        env:',
    ...gatesHere.map((n) => `          ${v(n)}: \${{ needs.${n}.result }}`)];
  if (!C['ci-ok'] || C['ci-ok'].lines.map((l) => l.code.replace(/\s+$/, '')).join('\n') !== expected.join('\n')) out.push(`ci.yml: ci-ok must be exactly the job that needs ${gatesHere.join(', ')}, runs always, and fails unless each result is success`);
  return out;
}
