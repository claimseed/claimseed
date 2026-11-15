#!/usr/bin/env node
// test-with-render-log.js — run the test suite one file at a time, charging every stamped PDF to the file that made it.
//   node packages/core/scripts/test-with-render-log.js --all          every test file of every workspace (npm test)
//   node ../core/scripts/test-with-render-log.js <workspace>           one workspace's files (its npm test)
//   node packages/core/scripts/test-with-render-log.js --shard i/n     shard i of the plan's n shards (CI)
//   node packages/core/scripts/test-with-render-log.js --plan          print the plan (shards, their files and seconds)
//   node packages/core/scripts/test-with-render-log.js --record [--new-reference] [--from FILE...]
//        rewrite each file's recorded seconds, from this run or from the timings a run wrote (--timings-out FILE)
// Every stamped PDF appends one line to CLAIMSEED_RENDER_LOG (src/render.js: "render" from mergePdfs, "degraded" or
// "single" from finalizePdf); each file runs as its own `node --test` with its own log, which its subprocesses inherit.
// A file fails the run when it fails, when its counts differ from its entry in test/render-budget.json (more or
// fewer), when it runs past its deadline (it is killed with every process it started), and, in CI or with --shard,
// when it skips a test. A file slower than its drift allowance is only noted. The static checks
// (scripts/lib/test-plan.js) run first.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn, spawnSync } from 'child_process';
import { repoRoot } from './lib/repo-root.js';
import { isMain as runAsScript } from './lib/is-main.js';
import * as P from './lib/test-plan.js';

export const CAPS = P.CAPS;
export const logDir = (root = repoRoot()) => path.join(root, '.tmp-render-log');
export const runLogFile = (label, root = repoRoot()) => path.join(logDir(root), `run-${label}-${process.pid}-${Date.now()}.txt`);
export function countLog(text) {
  const n = { render: 0, degraded: 0, single: 0 };
  for (const line of String(text).split('\n')) { if (!line) continue; if (!(line in n)) throw new Error(`render log: unknown line kind "${line.slice(0, 20)}"`); n[line]++; }
  return n;
}
// a file's counts against its entry: [] when they match, otherwise one message per kind
export function checkCounts(counts, entry) {
  return P.KINDS.filter((k) => counts[k] !== entry[k]).map((k) => `${k}: ${counts[k]} made, ${entry[k]} recorded in test/render-budget.json`);
}
export function checkCaps(total) {
  return Object.entries(CAPS).filter(([k, cap]) => total[k] > cap).map(([k, cap]) => `${k}: ${total[k]} over the cap of ${cap}`);
}
// the machine a run's seconds come from: CPU count and model, and Node's major version
export function referenceOf() {
  const cpus = os.cpus(); return `${cpus.length} x ${(cpus[0]?.model || 'unknown cpu').trim().replace(/\s+/g, ' ')}, node ${process.versions.node.split('.')[0]}`;
}
// a file's deadline in seconds: four times its recorded seconds, at least 120, at most 1.5 shards
export const deadlineOf = (seconds) => Math.min(Math.max(120, 4 * seconds), 1.5 * P.SHARD_SECONDS);
// the summary node's TAP reporter prints last: # tests, # pass, # fail, # cancelled, # skipped, # todo
export function tapSummary(text) {
  const out = {}; for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) { const all = [...String(text).matchAll(new RegExp(`^# ${k} (\\d+)$`, 'gm'))]; out[k] = all.length ? Number(all.at(-1)[1]) : null; }
  return out;
}

// A file's problems from how it ended: a kill at its deadline, a failure, counts that differ from its entry, no test
// summary; in CI or with --shard (strict) also a skipped test, a note otherwise. A run past its drift allowance is
// always a note: the recorded seconds are a plan from one machine, and the deadline is the hard limit.
export function fileProblems({ entry, status, timedOut, counts, summary, seconds, late, strict, deadline }) {
  const problems = []; const notes = [];
  if (timedOut) problems.push(`killed at its deadline of ${deadline} s`);
  else if (status !== 0) problems.push(`failed (exit ${status})`);
  problems.push(...checkCounts(counts, entry));
  if (late) notes.push(`${seconds.toFixed(1)} s, over its drift allowance of ${(entry.seconds * P.DRIFT.factor + P.DRIFT.plus).toFixed(0)} s (recorded ${entry.seconds} s)`);
  if (summary.skipped) (strict ? problems : notes).push(`${summary.skipped} test(s) skipped`);
  if (summary.tests === null && !timedOut) problems.push('no test summary in its output');
  return { problems, notes };
}
// Every process descended from pid (from ps, which Linux and macOS both have), deepest first: a test's Chrome starts
// in a process group of its own, so killing the file's group alone would leave it running.
export function descendants(pid) {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' }); if (r.status !== 0) return [];
  const kids = new Map();
  for (const line of r.stdout.split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); if (m) { const pp = Number(m[2]); if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(Number(m[1])); } }
  const out = []; const walk = (p) => { for (const c of kids.get(p) || []) { walk(c); out.push(c); } }; walk(pid);
  return out;
}
export function killTree(pid) {
  for (const p of descendants(pid)) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

// Run the given files, one at a time, each with its own render log; returns one result per file.
// (deadlineFor and slow are the deadline and drift rules; a test passes shorter ones)
export async function runFiles(root, items, { strict = false, out = process.stdout, err = process.stderr, onChild = () => {}, deadlineFor = deadlineOf, slow = P.tooSlow } = {}) {
  fs.mkdirSync(logDir(root), { recursive: true });
  const results = [];
  for (const it of items) {
    const rel = `packages/${it.ws}/test/${it.file}`;
    out.write(`\n== ${rel} (recorded ${it.seconds} s; render ${it.render}, degraded ${it.degraded}, single ${it.single})\n`);
    const log = runLogFile(`${it.ws}-${it.file.replace(/[^A-Za-z0-9._-]/g, '_')}`, root); fs.writeFileSync(log, '', { flag: 'wx' });
    const started = Date.now(); let tap = ''; let timedOut = false;
    const status = await new Promise((resolve) => {
      // a fresh test run per file: node's own marker of a nested run (set when this runner itself runs inside a test)
      // would make the child skip its file, so it is left out
      const env = { ...process.env, CLAIMSEED_RENDER_LOG: log }; delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', path.join('test', it.file)], { cwd: path.join(root, 'packages', it.ws), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      onChild(child);
      const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, deadlineFor(it.seconds) * 1000);
      child.stdout.on('data', (d) => { tap += d; out.write(d); });
      child.stderr.on('data', (d) => err.write(d));
      child.on('close', (code, signal) => { clearTimeout(timer); killTree(child.pid); resolve(code === null ? (signal || 'killed') : code); });
    });
    const seconds = (Date.now() - started) / 1000;
    const counts = countLog(fs.readFileSync(log, 'utf-8')); fs.rmSync(log, { force: true });
    const summary = tapSummary(tap);
    const { problems, notes } = fileProblems({ entry: it, status, timedOut, counts, summary, seconds, late: slow(seconds, it.seconds), strict, deadline: deadlineFor(it.seconds) });
    results.push({ ...it, recorded: it.seconds, measured: seconds, status, counts, summary, problems, notes });
    out.write(`== ${rel}: ${problems.length ? `FAILED: ${problems.join('; ')}` : 'ok'} (${seconds.toFixed(1)} s)${notes.length ? `; note: ${notes.join('; ')}` : ''}\n`);
  }
  return results;
}

export function report(results, { out = process.stdout } = {}) {
  const t = { files: results.length, failed: 0, tests: 0, pass: 0, fail: 0, skipped: 0, render: 0, degraded: 0, single: 0, seconds: 0 };
  for (const r of results) {
    if (r.problems.length) t.failed++;
    for (const k of ['tests', 'pass', 'fail', 'skipped']) t[k] += r.summary[k] || 0;
    for (const k of P.KINDS) t[k] += r.counts[k];
    t.seconds += r.measured;
  }
  out.write(`\n${'file'.padEnd(52)} ${'status'.padEnd(7)} ${'r/d/s made'.padEnd(12)} ${'recorded'.padEnd(12)} seconds (recorded)\n`);
  for (const r of results) out.write(`${`${r.ws}/${r.file}`.padEnd(52)} ${(r.problems.length ? 'FAILED' : 'ok').padEnd(7)} ${`${r.counts.render}/${r.counts.degraded}/${r.counts.single}`.padEnd(12)} ${`${r.render}/${r.degraded}/${r.single}`.padEnd(12)} ${r.measured.toFixed(1)} (${r.recorded})\n`);
  out.write(`\n${t.files} files, ${t.failed} failed; ${t.tests} tests: ${t.pass} passed, ${t.fail} failed, ${t.skipped} skipped; stamped ${t.render} rendered, ${t.degraded} degraded, ${t.single} single; ${t.seconds.toFixed(0)} s\n`);
  return t;
}

// the timings of a run, for --record --from
// (each file's seconds and whether it passed; --record --from takes only passing files)
export const timingsOf = (results) => ({ reference: referenceOf(), timings: Object.fromEntries(results.map((r) => [`${r.ws}/${r.file}`, { seconds: Math.max(1, Math.ceil(r.measured)), ok: r.problems.length === 0 }])) });
// The timings files of a run (one per shard), checked: one machine, a short reference, every test file exactly once,
// each passing with whole seconds. Returns { measured: { 'ws/file': seconds }, reference } or throws.
export function readTimings(texts, items) {
  const measured = {}; const refs = new Set();
  for (const t of texts) {
    let j; try { j = JSON.parse(t); } catch { throw new Error('a timings file is not JSON'); }
    if (!j || typeof j.reference !== 'string' || !j.reference.trim() || j.reference.length > 120 || !j.timings || typeof j.timings !== 'object' || Array.isArray(j.timings)) throw new Error('a timings file needs a reference of 1 to 120 characters and a timings object');
    refs.add(j.reference);
    for (const [k, e] of Object.entries(j.timings)) {
      if (Object.prototype.hasOwnProperty.call(measured, k)) throw new Error(`${k.slice(0, 80)} is in more than one timings file`);
      if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.seconds) || e.seconds < 1 || e.ok !== true) throw new Error(`${k.slice(0, 80)}: not a passing run with whole seconds`);
      measured[k] = e.seconds;
    }
  }
  if (refs.size !== 1) throw new Error('the timings files come from different machines');
  const want = items.map((x) => `${x.ws}/${x.file}`).sort(); const got = Object.keys(measured).sort();
  if (want.join('\n') !== got.join('\n')) throw new Error('the timings files must cover every test file exactly once');
  return { measured, reference: [...refs][0] };
}

// The budget files rewritten with new seconds: every file when the reference changes, otherwise only those whose time
// moved by more than 20% and 5 s. Counts are never rewritten here.
export function recordSeconds(root, measured, reference, { newReference = false } = {}) {
  const changed = [];
  for (const ws of P.workspaces(root)) {
    const p = P.budgetPath(root, ws); if (!fs.existsSync(p)) continue;
    const b = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (b.reference !== reference && !newReference) throw new Error(`packages/${ws}: recorded on another machine ("${String(b.reference).slice(0, 80)}"); --new-reference rewrites every weight from this one`);
    for (const [f, e] of Object.entries(b.files)) {
      const s = measured[`${ws}/${f}`]; if (s === undefined) throw new Error(`no timing for packages/${ws}/test/${f}`);
      if (newReference || Math.abs(s - e.seconds) > Math.max(5, 0.2 * e.seconds)) { if (s !== e.seconds) changed.push(`${ws}/${f}: ${e.seconds} -> ${s} s`); e.seconds = s; }
    }
    b.reference = reference;
    fs.writeFileSync(p, budgetText(b));
  }
  return changed;
}
// one line per file entry, so a change shows as a one-line diff
export function budgetText(b) {
  const entries = Object.keys(b.files).sort().map((f) => `  ${JSON.stringify(f)}: { "render": ${b.files[f].render}, "degraded": ${b.files[f].degraded}, "single": ${b.files[f].single}, "seconds": ${b.files[f].seconds} }`);
  return `{\n "note": ${JSON.stringify(b.note)},\n "reference": ${JSON.stringify(b.reference)},\n "files": {\n${entries.join(',\n')}\n }\n}\n`;
}

function fail(lines, code = 1) { for (const l of [].concat(lines)) console.error(`test plan: ${l}`); process.exit(code); }

async function main() {
  const args = process.argv.slice(2); const root = repoRoot();
  const has = (f) => args.includes(f);
  const valuesAfter = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = []; for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k++) v.push(args[k]); return v; };
  const { items, problems } = P.loadItems(root);
  let n = null; try { n = P.shardCount(items); } catch (e) { problems.push(e.message); }
  if (problems.length) fail(problems, 2);
  const strict = !!process.env.CI || has('--shard');
  if (has('--plan')) { for (const [k, s] of P.planShards(items, n).entries()) console.log(`shard ${k + 1}/${n}: ${s.seconds} s: ${s.items.map((x) => `${x.ws}/${x.file}`).join(' ')}`); return; }
  if (has('--record')) {
    let measured; let reference;
    const from = valuesAfter('--from');
    if (from) {
      if (!from.length) fail('--from needs one or more timings files', 2);
      try { ({ measured, reference } = readTimings(from.map((f) => fs.readFileSync(f, 'utf-8')), items)); } catch (e) { fail(e.code ? 'a timings file could not be read' : e.message, 2); }
    } else {
      const results = await runFiles(root, items, { strict: false }); report(results);
      const bad = results.filter((r) => r.problems.length);
      if (bad.length) fail(['not recorded: fix these first (counts are edited by hand in test/render-budget.json)', ...bad.map((r) => `${r.ws}/${r.file}: ${r.problems.join('; ')}`)]);
      const t = timingsOf(results); reference = t.reference; measured = Object.fromEntries(Object.entries(t.timings).map(([k, e]) => [k, e.seconds]));
    }
    let changed; try { changed = recordSeconds(root, measured, reference, { newReference: has('--new-reference') }); } catch (e) { fail(e.message, 2); }
    console.log(changed.length ? `recorded:\n  ${changed.join('\n  ')}` : 'recorded: no file moved past 20% and 5 s');
    return;
  }
  let run; let label;
  if (has('--shard')) {
    const v = valuesAfter('--shard'); const ix = P.parseIndex(v && v.length === 1 ? v[0] : '');
    if (!ix) fail('--shard takes i/n, whole numbers with 1 <= i <= n', 2);
    if (ix.n !== n) fail(`--shard: the plan has ${n} shard(s), not ${ix.n}; the CI matrix must come from ci-plan.js`, 2);
    const s = P.planShards(items, n)[ix.i - 1]; run = s.items; label = `shard ${ix.i}/${n} (${s.seconds} s planned)`;
  } else if (has('--all')) { run = items; label = 'every test file'; }
  else if (args.length === 1 && P.workspaces(root).includes(args[0])) { run = items.filter((x) => x.ws === args[0]); label = `packages/${args[0]}`; }
  else fail('usage: test-with-render-log.js --all | <workspace> | --shard i/n | --plan | --record [--new-reference] [--from FILE...] [--timings-out FILE]', 2);
  console.log(`test plan: ${label}: ${run.length} file(s)`);
  const started = Date.now();
  const kids = new Set(); const stop = () => { for (const c of kids) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(130); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const results = await runFiles(root, run, { strict, onChild: (c) => { kids.add(c); c.on('close', () => kids.delete(c)); } });
  const t = report(results); const timings = timingsOf(results);
  console.log(`timings: ${JSON.stringify(timings)}`);
  const to = valuesAfter('--timings-out'); if (to && to.length === 1) fs.writeFileSync(to[0], JSON.stringify(timings) + '\n');
  const wall = (Date.now() - started) / 1000; const planned = run.reduce((sum, x) => sum + x.seconds, 0);
  const late = has('--shard') && P.shardTooLate(wall);
  if (has('--shard') && wall > planned) console.log(`test plan: this shard took ${wall.toFixed(0)} s against ${planned} s planned; re-record the weights from this run (--timings-out, then --record --from)`);
  if (late) console.log(`test plan: note: the shard took ${wall.toFixed(0)} s, over ${P.SHARD_SECONDS * P.DRIFT.factor} s; re-record the weights or add a shard`);
  if (t.failed) process.exit(1);
}
const isMain = runAsScript(import.meta.url);
if (isMain) main();
