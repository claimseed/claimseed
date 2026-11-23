// The CI plan (scripts/lib/test-plan.js), the runner that charges every stamped PDF to its test file
// (scripts/test-with-render-log.js), and the split of the rendered checks into parts (scripts/lib/rendered-plan.js,
// scripts/lib/examples-check.js). The runner is exercised on scratch repositories of tiny test files; nothing here
// starts a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as P from '../scripts/lib/test-plan.js';
import { runFiles, budgetText, deadlineOf, tapSummary, referenceOf, fileProblems, readTimings, timingsOf } from '../scripts/test-with-render-log.js';
import { scanJobs, exampleJobs, CI_SCAN, ciPartCount, scanDocs } from '../scripts/lib/rendered-plan.js';
import { compareExamples, exampleKey } from '../scripts/lib/examples-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const quiet = { write: () => {} };
const RENDER = "import { appendFileSync as stamp } from 'fs'; stamp(process.env.CLAIMSEED_RENDER_LOG, 'render\\n');";
const RENDER_TWICE = `${RENDER} stamp(process.env.CLAIMSEED_RENDER_LOG, 'render\\n');`;
const ok = (body = '') => `import { test } from 'node:test';\n${body}\ntest('t', () => {});\n`;

// A scratch repository: a root package.json the runner recognises, the runner's scripts, and workspaces of tiny test
// files with their budgets. spec: { ws: { 'name.test.js': { body, render, degraded, single, seconds } } }
function scratchRepo(spec, { reference = referenceOf(), extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plan-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'claimseed-monorepo', private: true, type: 'module', workspaces: ['packages/*'] }));
  const scripts = path.join(root, 'packages/core/scripts'); fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(core, 'scripts/test-with-render-log.js'), path.join(scripts, 'test-with-render-log.js'));
  for (const f of ['repo-root.js', 'is-main.js', 'test-plan.js']) fs.copyFileSync(path.join(core, 'scripts/lib', f), path.join(scripts, 'lib', f));
  for (const [ws, files] of Object.entries(spec)) {
    const d = path.join(root, 'packages', ws); fs.mkdirSync(path.join(d, 'test'), { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: ws, type: 'module' }));
    const entries = {};
    for (const [name, f] of Object.entries(files)) {
      fs.writeFileSync(path.join(d, 'test', name), f.body ?? ok());
      entries[name] = { render: f.render ?? 0, degraded: f.degraded ?? 0, single: f.single ?? 0, seconds: f.seconds ?? 1 };
    }
    fs.writeFileSync(path.join(d, 'test/render-budget.json'), budgetText({ note: 'scratch', reference, files: entries }));
  }
  for (const [rel, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
}
const cli = (root, ...args) => spawnSync(process.execPath, [path.join(root, 'packages/core/scripts/test-with-render-log.js'), ...args], { cwd: root, encoding: 'utf-8', env: { ...process.env, CI: '' } });
const item = (file, seconds, ws = 'core') => ({ ws, file, render: 0, degraded: 0, single: 0, seconds });

test('the plan\'s constants are the reviewed ones', () => {
  assert.deepEqual({ ...P.CAPS }, { render: 600, degraded: 100 });
  assert.deepEqual([P.SHARD_SECONDS, P.PART_SECONDS, P.MAX_JOBS, P.DOC_SECONDS, P.JOB_TIMEOUT_MINUTES], [600, 600, 12, 5, 20]);
  assert.deepEqual({ ...P.DRIFT }, { factor: 1.5, plus: 10 });
  assert.equal(deadlineOf(1), 120); assert.equal(deadlineOf(100), 400); assert.equal(deadlineOf(500), 900, 'never past 1.5 shards');
  assert.equal(P.tooSlow(160, 100), false); assert.equal(P.tooSlow(161, 100), true);
  assert.equal(P.shardTooLate(900), false); assert.equal(P.shardTooLate(901), true, 'a shard over 1.5 x 600 s');
  assert.equal(P.partTooSlow(750, 100), false); assert.equal(P.partTooSlow(751, 100), true, 'a part over 1.5 x 5 s a document');
});

test('the same budget gives the same plan; every file is in exactly one shard; the count is the smallest that fits', () => {
  const items = Array.from({ length: 30 }, (_, k) => item(`f${String(k).padStart(2, '0')}.test.js`, 10 + ((k * 37) % 190)));
  for (let n = 1; n <= P.MAX_JOBS; n++) {
    const a = P.planShards(items, n); const b = P.planShards([...items].reverse(), n);
    assert.deepEqual(a.map((s) => s.items.map((x) => x.file)), b.map((s) => s.items.map((x) => x.file)), `n=${n}: order of the input does not matter`);
    const all = a.flatMap((s) => s.items.map((x) => x.file)).sort();
    assert.deepEqual(all, items.map((x) => x.file).sort(), `n=${n}: each file exactly once`);
    for (const s of a) assert.equal(s.seconds, s.items.reduce((t, x) => t + x.seconds, 0));
  }
  const n = P.shardCount(items);
  assert.ok(P.planShards(items, n).every((s) => s.seconds <= P.SHARD_SECONDS));
  assert.ok(n === 1 || P.planShards(items, n - 1).some((s) => s.seconds > P.SHARD_SECONDS), 'n - 1 does not fit');
  assert.throws(() => P.shardCount([item('big.test.js', P.SHARD_SECONDS + 1)]), /big\.test\.js alone is over a shard/);
  assert.throws(() => P.shardCount(Array.from({ length: 13 }, (_, k) => item(`x${k}.test.js`, P.SHARD_SECONDS))), /more than 12 shards/);
  assert.throws(() => P.planShards(items, 0));
});

test('i/n is whole numbers with 1 <= i <= n, and parts take every document exactly once', () => {
  assert.deepEqual(P.parseIndex('2/3'), { i: 2, n: 3 });
  for (const bad of ['0/3', '4/3', '1/0', '01/3', '1/03', '-1/3', '1.5/3', '1/3 ', ' 1/3', '1/3/4', '', 'a/b', '1000/1000', null, 3]) assert.equal(P.parseIndex(bad), null, String(bad));
  const scan = scanJobs(CI_SCAN); const ex = exampleJobs();
  assert.equal(new Set(scan.map((j) => JSON.stringify(j))).size, scan.length, 'the scan lists no document twice');
  for (let m = 1; m <= 5; m++) for (const list of [scan, ex]) {
    const parts = Array.from({ length: m }, (_, k) => P.partOf(list, k + 1, m));
    assert.deepEqual(parts.flat().map((j) => JSON.stringify(j)).sort(), list.map((j) => JSON.stringify(j)).sort(), `m=${m}: the union is the list`);
    assert.equal(parts.flat().length, list.length, `m=${m}: no document twice`);
  }
  const m = ciPartCount();
  const docs = scanDocs(scan); assert.ok(docs > scan.length, 'statement jobs count twice');
  assert.equal(m, P.partCount(docs, ex.length));
  assert.ok((Math.ceil(docs / m) + Math.ceil(ex.length / m)) * P.DOC_SECONDS <= P.PART_SECONDS, 'each part, on its actual share, within budget');
  assert.ok(m === 1 || (Math.ceil(docs / (m - 1)) + Math.ceil(ex.length / (m - 1))) * P.DOC_SECONDS > P.PART_SECONDS, 'm - 1 does not fit');
  assert.throws(() => P.partCount(0, 5)); assert.throws(() => P.partCount(5000, 5000), /more than 12 parts/);
});

test('the budget must name exactly the test files on disk, with whole counts, within the caps', () => {
  const good = scratchRepo({ core: { 'a.test.js': {}, 'b.test.js': { seconds: 3 } }, mcp: { 'c.test.js': {} } });
  try {
    const r = P.loadItems(good); assert.deepEqual(r.problems, []); assert.deepEqual(r.items.map((x) => `${x.ws}/${x.file}`), ['core/a.test.js', 'core/b.test.js', 'mcp/c.test.js']);
    const bud = path.join(good, 'packages/core/test/render-budget.json'); const orig = fs.readFileSync(bud, 'utf-8');
    const plant = (edit, re, what) => { const b = JSON.parse(orig); edit(b); fs.writeFileSync(bud, JSON.stringify(b)); assert.ok(P.loadItems(good).problems.some((p) => re.test(p)), `${what}: ${P.loadItems(good).problems}`); fs.writeFileSync(bud, orig); };
    plant((b) => { delete b.files['a.test.js']; }, /a\.test\.js: no entry/, 'a missing entry');
    plant((b) => { b.files['gone.test.js'] = { render: 0, degraded: 0, single: 0, seconds: 1 }; }, /an entry for gone\.test\.js/, 'an extra entry');
    plant((b) => { b.files['a.test.js'].render = 1.5; }, /needs whole/, 'a fraction');
    plant((b) => { b.files['a.test.js'].render = -1; }, /needs whole/, 'a negative count');
    plant((b) => { b.files['a.test.js'].seconds = 0; }, /needs whole/, 'zero seconds');
    plant((b) => { b.files['a.test.js'].extra = 1; }, /needs whole/, 'an unknown key');
    plant((b) => { b.files['a.test.js'].render = P.CAPS.render + 1; }, /render: \d+ recorded, over the cap of 600/, 'renders over the cap');
    plant((b) => { b.files['a.test.js'].degraded = P.CAPS.degraded + 1; }, /degraded: \d+ recorded, over the cap of 100/, 'degraded copies over the cap');
    plant((b) => { b.files['a.test.js'].seconds = P.SHARD_SECONDS + 1; }, /over a shard's 600 s; split it/, 'a file over a shard');
    plant((b) => { b.reference = 'another machine'; }, /different reference machines/, 'two references');
    for (const stray of ['packages/core/test/sub/x.test.js', 'packages/core/x.test.js', 'packages/mcp/test/y.test.mjs']) {
      fs.mkdirSync(path.dirname(path.join(good, stray)), { recursive: true }); fs.writeFileSync(path.join(good, stray), ok());
      assert.ok(P.loadItems(good).problems.some((p) => p.startsWith(`${stray}: a test file outside test/*.test.js`)), stray);
      fs.rmSync(path.join(good, stray));
    }
    assert.deepEqual(P.loadItems(good).problems, []);
  } finally { fs.rmSync(good, { recursive: true, force: true }); }
  const empty = scratchRepo({ core: {} });
  try { assert.ok(P.loadItems(empty).problems.includes('no test files found')); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('each file\'s stamped PDFs are charged to it, subprocesses included, and a difference, failure, hang, drift or skip is named', async () => {
  const sub = "import { spawnSync } from 'child_process'; spawnSync(process.execPath, ['-e', \"require('fs').appendFileSync(process.env.CLAIMSEED_RENDER_LOG, 'degraded\\\\n')\"], { stdio: 'inherit' });";
  const root = scratchRepo({ core: {
    'exact.test.js': { body: ok(RENDER), render: 1 },
    'extra.test.js': { body: ok(RENDER_TWICE), render: 1 },
    'fewer.test.js': { body: ok(), render: 1 },
    'child.test.js': { body: ok(sub), degraded: 1 },
    'fails.test.js': { body: "import { test } from 'node:test';\ntest('t', () => { throw new Error('planted'); });\n" },
    'hangs.test.js': { body: "console.log('started, then waits');\nawait new Promise(() => setInterval(() => {}, 1000));\n" },
    'skips.test.js': { body: "import { test } from 'node:test';\ntest('t', { skip: 'planted' }, () => {});\n" },
    'cwd.test.js': { body: "import { test } from 'node:test'; import assert from 'node:assert';\ntest('cwd', () => assert.ok(process.cwd().endsWith('/packages/core')));\n" },
  } });
  try {
    const { items } = P.loadItems(root);
    const output = []; const out = { write: (d) => output.push(String(d)) };
    const results = await runFiles(root, items, { strict: true, out, err: quiet, deadlineFor: () => 3 });
    const by = Object.fromEntries(results.map((r) => [r.file, r]));
    assert.deepEqual(by['exact.test.js'].problems, []); assert.deepEqual(by['cwd.test.js'].problems, [], 'the file runs in its workspace');
    assert.deepEqual(by['child.test.js'].counts, { render: 0, degraded: 1, single: 0 }); assert.deepEqual(by['child.test.js'].problems, [], 'a subprocess\'s PDF is the file\'s');
    assert.ok(by['extra.test.js'].problems.includes('render: 2 made, 1 recorded in test/render-budget.json'));
    assert.ok(by['fewer.test.js'].problems.includes('render: 0 made, 1 recorded in test/render-budget.json'));
    assert.ok(by['fails.test.js'].problems.some((p) => /^failed/.test(p)), 'a failing file with matching counts fails');
    assert.ok(by['hangs.test.js'].problems.includes('killed at its deadline of 3 s'));
    assert.ok(output.join('').includes('started, then waits'), 'a hung file\'s output is shown');
    assert.ok(output.join('').includes('== packages/core/test/hangs.test.js (recorded'), 'a start line names each file');
    assert.ok(by['skips.test.js'].problems.includes('1 test(s) skipped'), 'a skip fails in CI');
    const lax = await runFiles(root, items.filter((x) => x.file === 'skips.test.js' || x.file === 'exact.test.js'), { strict: false, out: quiet, err: quiet, slow: () => true });
    assert.deepEqual(lax.map((r) => r.problems), [[], []], 'outside CI a skip and a slow file are notes');
    assert.ok(lax[0].notes.length && lax[1].notes.length);
    const strict = await runFiles(root, items.filter((x) => x.file === 'exact.test.js'), { strict: true, out: quiet, err: quiet, slow: () => true });
    assert.deepEqual(strict[0].problems, [], 'in CI too a slow file is only a note');
    assert.ok(strict[0].notes.some((p) => /over its drift allowance/.test(p)), 'the note names the allowance');
    assert.deepEqual(tapSummary('# tests 3\n# pass 2\n# fail 1\n# skipped 0\n'), { tests: 3, pass: 2, fail: 1, cancelled: null, skipped: 0, todo: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the command line: every shard runs each file exactly once, a wrong count is refused, --record writes only seconds', () => {
  const ran = (name) => `import fs from 'fs'; fs.appendFileSync(process.env.RAN_LOG, '${name}\\n');`;
  const spec = { core: {}, mcp: {} };
  for (let k = 0; k < 9; k++) spec[k % 3 ? 'core' : 'mcp'][`f${k}.test.js`] = { body: ok(ran(`f${k}`)), seconds: 150 + 40 * k };
  const root = scratchRepo(spec);
  const log = path.join(root, 'ran.txt');
  try {
    const plan = cli(root, '--plan'); assert.equal(plan.status, 0, plan.stderr);
    const n = (plan.stdout.match(/^shard \d+\/(\d+):/m) || [])[1]; assert.ok(Number(n) > 1, plan.stdout);
    for (let i = 1; i <= Number(n); i++) { const r = spawnSync(process.execPath, [path.join(root, 'packages/core/scripts/test-with-render-log.js'), '--shard', `${i}/${n}`], { cwd: root, encoding: 'utf-8', env: { ...process.env, CI: '', RAN_LOG: log } }); assert.equal(r.status, 0, r.stdout + r.stderr); }
    assert.deepEqual(fs.readFileSync(log, 'utf-8').trim().split('\n').sort(), Array.from({ length: 9 }, (_, k) => `f${k}`).sort(), 'each file once across the shards');
    for (const [args, re] of [[['--shard', `1/${Number(n) + 1}`], /the plan has \d+ shard\(s\), not/], [['--shard', '0/2'], /--shard takes i\/n/], [['--shard'], /--shard takes i\/n/], [['--nope'], /usage:/]]) {
      const r = cli(root, ...args); assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, re);
    }
    // --record: refuses on a count difference, and leaves the budget as it was
    const bud = path.join(root, 'packages/core/test/render-budget.json'); const before = fs.readFileSync(bud, 'utf-8');
    fs.writeFileSync(path.join(root, 'packages/core/test/f1.test.js'), ok(`${ran('f1')}\n${RENDER}`));
    let r = spawnSync(process.execPath, [path.join(root, 'packages/core/scripts/test-with-render-log.js'), '--record'], { cwd: root, encoding: 'utf-8', env: { ...process.env, CI: '', RAN_LOG: log } });
    assert.equal(r.status, 1); assert.match(r.stderr, /not recorded: fix these first/); assert.match(r.stderr, /core\/f1\.test\.js: render: 1 made, 0 recorded/); assert.equal(fs.readFileSync(bud, 'utf-8'), before);
    fs.writeFileSync(path.join(root, 'packages/core/test/f1.test.js'), ok(ran('f1')));
    // then writes seconds only, and only where they moved by more than 20% and 5 s
    r = spawnSync(process.execPath, [path.join(root, 'packages/core/scripts/test-with-render-log.js'), '--record'], { cwd: root, encoding: 'utf-8', env: { ...process.env, CI: '', RAN_LOG: log } });
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(bud, 'utf-8'));
    for (const e of Object.values(after.files)) { assert.ok(e.seconds >= 1 && e.seconds < 10, 'every planted 150 s and more moved'); assert.equal(e.render, 0); }
    // another machine's reference needs --new-reference; with it every weight is rewritten
    const other = JSON.parse(fs.readFileSync(bud, 'utf-8')); other.reference = 'another machine'; other.files['f1.test.js'].seconds = 2;
    fs.writeFileSync(bud, budgetText(other));
    const mb = path.join(root, 'packages/mcp/test/render-budget.json'); const om = JSON.parse(fs.readFileSync(mb, 'utf-8')); om.reference = 'another machine'; fs.writeFileSync(mb, budgetText(om));
    const timings = path.join(root, 't.json');
    fs.writeFileSync(timings, JSON.stringify({ reference: 'runner X', timings: Object.fromEntries(P.loadItems(root).items.map((x) => [`${x.ws}/${x.file}`, { seconds: 7, ok: true }])) }));
    r = cli(root, '--record', '--from', timings); assert.equal(r.status, 2); assert.match(r.stderr, /recorded on another machine/);
    r = cli(root, '--record', '--from', timings, '--new-reference'); assert.equal(r.status, 0, r.stderr);
    const nb = JSON.parse(fs.readFileSync(bud, 'utf-8')); assert.equal(nb.reference, 'runner X'); assert.ok(Object.values(nb.files).every((e) => e.seconds === 7), 'every weight from the timings');
    // the timings must cover every file exactly once
    const part = JSON.parse(fs.readFileSync(timings, 'utf-8')); delete part.timings['core/f1.test.js']; fs.writeFileSync(timings, JSON.stringify(part));
    r = cli(root, '--record', '--from', timings, '--new-reference'); assert.equal(r.status, 2); assert.match(r.stderr, /cover every test file exactly once/);
    // the static checks run before anything: a stray test file stops --all
    fs.mkdirSync(path.join(root, 'packages/core/test/sub')); fs.writeFileSync(path.join(root, 'packages/core/test/sub/x.test.js'), ok());
    r = cli(root, '--all'); assert.equal(r.status, 2); assert.match(r.stderr, /a test file outside test\/\*\.test\.js/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the examples check, split into parts, together equals the whole check', () => {
  const examples = [{ type: 'msn', scenario: 'a', seed: 'example' }, { type: 'msn', scenario: 'b', seed: 'example' }, { type: 'ppo-eob', scenario: 'a', seed: 'example', layoutVariant: 'p01' }, { type: 'ppo-eob', scenario: 'b', seed: 'example' },
    { type: 'commercial-eob', scenario: 'c', seed: 'example', insurer: 'a' }, { type: 'commercial-eob', scenario: 'c', seed: 'example', insurer: 'b' }];
  const resultOf = (e) => ({ ...e, file: `${exampleKey(e)}.pdf`, pages: 2, errors: [], decoys: [], textSha256: 't', groundTruthSha256: 'g', remittanceSha256: null });
  const recorded = examples.map(resultOf);
  const readme = (rs) => rs.map((r) => `${exampleKey(r)} ${r.pages}`).join('\n');
  const check = (results, opts = {}) => compareExamples({ examples, results, recorded: opts.recorded || recorded, readmeNow: opts.readmeNow ?? readme(recorded), readme, whole: opts.whole ?? false });
  assert.deepEqual(compareExamples({ examples, results: recorded, recorded, readmeNow: readme(recorded), readme, whole: true }), []);
  for (let m = 1; m <= 4; m++) for (let i = 1; i <= m; i++) assert.deepEqual(check(P.partOf(examples, i, m).map(resultOf)), [], `part ${i}/${m}`);
  // a changed document fails only the part that renders it
  const changed = (e) => (e.scenario === 'b' && e.type === 'msn' ? { ...resultOf(e), textSha256: 'other' } : resultOf(e));
  const failing = [1, 2].filter((i) => check(P.partOf(examples, i, 2).map(changed)).length);
  assert.deepEqual(failing, [2]);
  assert.ok(check([changed(examples[1])])[0].startsWith('msn/b/example: textSha256 "t" -> "other"'));
  assert.ok(check([{ ...resultOf(examples[0]), errors: ['duplicate-charge'] }]).some((x) => /errors/.test(x)), 'every field is compared');
  // every part checks the manifest's keys against the whole plan and the README against the manifest
  assert.ok(check([], { recorded: recorded.slice(1) }).includes('msn/a/example: not in the manifest'));
  assert.ok(check([], { recorded: [...recorded, resultOf({ type: 'msn', scenario: 'old', seed: 'example' })] }).includes('msn/old/example: in the manifest but no longer published'));
  assert.ok(check([], { readmeNow: 'stale' }).includes('examples/README.md is out of date'));
  // one example per insurer: each is compared with its own record, and a change to one insurer's names that one only
  const insurerB = (e) => (e.insurer === 'b' ? { ...resultOf(e), textSha256: 'other' } : resultOf(e));
  assert.deepEqual(check(examples.map(insurerB)), ['commercial-eob/c/example.b: textSha256 "t" -> "other"']);
  assert.ok(check([], { recorded: [...recorded, recorded[0]] }).includes('msn/a/example: two examples share this key'));
});

test('the rendered checks refuse a part that is not the plan\'s, before rendering anything', () => {
  const m = ciPartCount();
  const run = (script, args) => spawnSync(process.execPath, [path.join(core, 'scripts', script), ...args], { encoding: 'utf-8', timeout: 60000 });
  for (const [script, args, re] of [
    ['scan-rendered.js', ['--seeds', '2', '--blind', 'all', '--part', `1/${m + 1}`], new RegExp(`the plan has ${m} part\\(s\\), not ${m + 1}`)],
    ['scan-rendered.js', ['--seeds', '2', '--blind', 'all', '--part', '0/2'], /--part takes i\/m/],
    ['scan-rendered.js', ['--seeds', '1', '--blind', 'all', '--part', `1/${m}`], /--part runs with CI's options only/],
    ['scan-rendered.js', ['--seeds', '2', '--blind', 'all', '--type', 'msn', '--part', `1/${m}`], /--part runs with CI's options only/],
    ['scan-rendered.js', ['--seeds', '2', '--part', `1/${m}`], /--part runs with CI's options only/],
    ['examples.js', ['--check', '--part', `${m + 1}/${m}`], /--part takes i\/m/],
    ['examples.js', ['--check', '--part', `1/${m + 1}`], new RegExp(`the plan has ${m} part\\(s\\), not ${m + 1}`)],
    ['examples.js', ['--update', '--part', `1/${m}`], /--part runs with --check only/],
  ]) {
    const r = run(script, args);
    assert.equal(r.status, 2, `${script} ${args.join(' ')}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, re); assert.equal(r.stdout, '');
  }
});

test('a file\'s problems: each way it can end, and which are notes outside CI', () => {
  const entry = { render: 1, degraded: 0, single: 0, seconds: 10 };
  const clean = { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const base = { entry, status: 0, timedOut: false, counts: { render: 1, degraded: 0, single: 0 }, summary: clean, seconds: 5, late: false, strict: true, deadline: 120 };
  assert.deepEqual(fileProblems(base), { problems: [], notes: [] });
  assert.deepEqual(fileProblems({ ...base, status: 1 }).problems, ['failed (exit 1)']);
  assert.deepEqual(fileProblems({ ...base, timedOut: true, status: 'SIGKILL', summary: { ...clean, tests: null } }).problems, ['killed at its deadline of 120 s'], 'a kill is named, not hidden by the missing summary');
  assert.deepEqual(fileProblems({ ...base, counts: { render: 2, degraded: 0, single: 0 } }).problems, ['render: 2 made, 1 recorded in test/render-budget.json']);
  assert.deepEqual(fileProblems({ ...base, summary: { ...clean, tests: null } }).problems, ['no test summary in its output'], 'a run that printed no summary fails, whatever its exit');
  assert.deepEqual(fileProblems({ ...base, late: true }), { problems: [], notes: ['5.0 s, over its drift allowance of 25 s (recorded 10 s)'] }, 'drift is a note, even in CI');
  assert.deepEqual(fileProblems({ ...base, summary: { ...clean, skipped: 1 } }).problems, ['1 test(s) skipped']);
  const lax = fileProblems({ ...base, strict: false, late: true, summary: { ...clean, skipped: 1 } });
  assert.deepEqual(lax.problems, []); assert.equal(lax.notes.length, 2);
});

test('timings for --record --from: one machine, every file once, passing runs only, a short reference', () => {
  const items = [{ ws: 'core', file: 'a.test.js' }, { ws: 'mcp', file: 'b.test.js' }];
  const t = (reference, timings) => JSON.stringify({ reference, timings });
  const a = { 'core/a.test.js': { seconds: 5, ok: true } }; const b = { 'mcp/b.test.js': { seconds: 9, ok: true } };
  assert.deepEqual(readTimings([t('m', a), t('m', b)], items), { measured: { 'core/a.test.js': 5, 'mcp/b.test.js': 9 }, reference: 'm' });
  for (const [texts, re] of [
    [[t('m', a), t('n', b)], /different machines/],
    [[t('m', a), t('m', a), t('m', b)], /core\/a\.test\.js is in more than one timings file/],
    [[t('m', a)], /cover every test file exactly once/],
    [[t('m', a), t('m', { 'mcp/b.test.js': { seconds: 9, ok: false } })], /mcp\/b\.test\.js: not a passing run/],
    [[t('m', a), t('m', { 'mcp/b.test.js': { seconds: 0, ok: true } })], /not a passing run with whole seconds/],
    [[t('m', a), t('m', { 'mcp/b.test.js': 9 })], /not a passing run/],
    [[t(undefined, a), t(undefined, b)], /a reference of 1 to 120 characters/],
    [[t('x'.repeat(121), a), t('x'.repeat(121), b)], /a reference of 1 to 120 characters/],
    [[t({ o: 1 }, a), t({ o: 1 }, b)], /a reference of 1 to 120 characters/],
    [['not json'], /not JSON/],
  ]) assert.throws(() => readTimings(texts, items), re);
  const ran = timingsOf([{ ws: 'core', file: 'a.test.js', measured: 4.2, problems: [] }, { ws: 'mcp', file: 'b.test.js', measured: 0.1, problems: ['failed (exit 1)'] }]);
  assert.deepEqual(ran.timings, { 'core/a.test.js': { seconds: 5, ok: true }, 'mcp/b.test.js': { seconds: 1, ok: false } });
});

test('at a file\'s deadline its whole process tree is killed, a descendant in a process group of its own included', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tree-')), 'survived');
  const body = `import { spawn } from 'child_process';
const k = spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 6000)", ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' });
console.log('spawned', k.pid);
await new Promise(() => setInterval(() => {}, 1000));
`;
  const root = scratchRepo({ core: { 'tree.test.js': { body } } });
  try {
    const { items } = P.loadItems(root);
    const [r] = await runFiles(root, items, { strict: true, out: quiet, err: quiet, deadlineFor: () => 2 });
    assert.ok(r.problems.includes('killed at its deadline of 2 s'));
    await new Promise((res) => setTimeout(res, 6000));
    assert.equal(fs.existsSync(marker), false, 'the detached grandchild was killed with the file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(marker), { recursive: true, force: true }); }
});
