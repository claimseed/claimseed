// test-plan.js — how the test suite is split into parallel CI jobs, from what each test file records. No dependencies:
// the CI plan job runs it before anything is installed.
//
// Every workspace (packages/<ws> with a package.json) records, in test/render-budget.json, one entry per test file:
// the stamped PDFs it makes (render, degraded, single; exact, checked on every run) and its seconds on the reference
// machine, run alone (the planning weight). The plan assigns the files to n shards, longest first, each to the
// shard with the least planned time, and takes the smallest n that keeps every shard within SHARD_SECONDS. Files run
// one at a time within a shard, so a shard's planned seconds bound its time. The rendered-output scan and the
// examples check are split the same way into m parts by document count. A file over half of SHARD_SECONDS is split
// in the milestone that finds it, so one file never decides a shard.
import fs from 'fs'; import path from 'path';

export const CAPS = Object.freeze({ render: 600, degraded: 100 });   // both workspaces together
export const SHARD_SECONDS = 600;
export const PART_SECONDS = 600;
export const MAX_JOBS = 12;                                         // per matrix
export const DOC_SECONDS = 5;                                       // one scan or examples document, recorded cost
export const DRIFT = Object.freeze({ factor: 1.5, plus: 10 });     // a file slower than factor x seconds + plus is noted
export const JOB_TIMEOUT_MINUTES = 20;
export const KINDS = Object.freeze(['render', 'degraded', 'single']);

const TEST_NAME = /\.test\.[^/\\]+$/;
const OWN_TEST = /^test\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.js$/;

// the workspaces: folders of packages/ that hold a package.json, sorted
export function workspaces(root) {
  const dir = path.join(root, 'packages');
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json'))).map((e) => e.name).sort();
}

// every test file of every workspace, and every file named like a test that is not where the runner looks
export function testFiles(root) {
  const files = []; const stray = [];
  for (const ws of workspaces(root)) {
    const base = path.join(root, 'packages', ws);
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!TEST_NAME.test(e.name)) continue;
        const rel = path.relative(base, p).split(path.sep).join('/');
        if (OWN_TEST.test(rel) && e.isFile()) files.push({ ws, file: rel.slice('test/'.length) });
        else stray.push(`packages/${ws}/${rel}`);
      }
    };
    walk(base);
  }
  const key = (x) => `${x.ws}/${x.file}`;
  return { files: files.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)), stray: stray.sort() };
}

const whole = (v, min) => Number.isSafeInteger(v) && v >= min;
export const budgetPath = (root, ws) => path.join(root, 'packages', ws, 'test', 'render-budget.json');

// The budget entries of every test file, and every problem with them; nothing is run.
export function loadItems(root) {
  const problems = []; const items = []; const references = new Set();
  const { files, stray } = testFiles(root);
  for (const s of stray) problems.push(`${s}: a test file outside test/*.test.js, which the runner would never run`);
  if (!files.length) problems.push('no test files found');
  for (const ws of workspaces(root)) {
    const mine = files.filter((f) => f.ws === ws).map((f) => f.file);
    const p = budgetPath(root, ws);
    if (!fs.existsSync(p)) { if (mine.length) problems.push(`packages/${ws}: test files but no test/render-budget.json`); continue; }
    let b; try { b = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { problems.push(`packages/${ws}/test/render-budget.json is not JSON`); continue; }
    if (!b || typeof b !== 'object' || !b.files || typeof b.files !== 'object' || Array.isArray(b.files)) { problems.push(`packages/${ws}/test/render-budget.json has no files object`); continue; }
    if (typeof b.reference === 'string' && b.reference) references.add(b.reference); else problems.push(`packages/${ws}/test/render-budget.json names no reference machine`);
    for (const f of mine) if (!Object.prototype.hasOwnProperty.call(b.files, f)) problems.push(`packages/${ws}/test/${f}: no entry in its render-budget.json`);
    for (const [f, e] of Object.entries(b.files)) {
      if (!mine.includes(f)) { problems.push(`packages/${ws}/test/render-budget.json: an entry for ${f.slice(0, 80)}, which is not a test file here`); continue; }
      const keys = e && typeof e === 'object' ? Object.keys(e).sort().join() : '';
      if (keys !== [...KINDS, 'seconds'].sort().join() || !KINDS.every((k) => whole(e[k], 0)) || !whole(e.seconds, 1)) { problems.push(`packages/${ws}/test/${f}: its entry needs whole render, degraded and single counts and whole seconds of at least 1, and nothing else`); continue; }
      items.push({ ws, file: f, render: e.render, degraded: e.degraded, single: e.single, seconds: e.seconds });
    }
  }
  if (references.size > 1) problems.push('the workspaces record different reference machines; record them together');
  const t = totals(items);
  for (const [k, cap] of Object.entries(CAPS)) if (t[k] > cap) problems.push(`${k}: ${t[k]} recorded, over the cap of ${cap}`);
  for (const it of items) if (it.seconds > SHARD_SECONDS) problems.push(`packages/${it.ws}/test/${it.file}: ${it.seconds} s, over a shard's ${SHARD_SECONDS} s; split it`);
  const key = (x) => `${x.ws}/${x.file}`;
  return { items: items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)), problems, reference: [...references][0] || null };
}

export function totals(items) {
  const t = { render: 0, degraded: 0, single: 0, seconds: 0 };
  for (const it of items) for (const k of Object.keys(t)) t[k] += it[k];
  return t;
}

// Longest first, each to the shard with the least planned seconds (the lowest index on a tie); ties between files
// broken by workspace and name, so the same budget always gives the same plan.
export function planShards(items, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('the shard count must be a whole number of at least 1');
  const order = [...items].sort((a, b) => b.seconds - a.seconds || (`${a.ws}/${a.file}` < `${b.ws}/${b.file}` ? -1 : 1));
  const shards = Array.from({ length: n }, () => ({ items: [], seconds: 0 }));
  for (const it of order) {
    let best = 0; for (let k = 1; k < n; k++) if (shards[k].seconds < shards[best].seconds) best = k;
    shards[best].items.push(it); shards[best].seconds += it.seconds;
  }
  return shards;
}

// The smallest number of shards that keeps every shard within SHARD_SECONDS, up to MAX_JOBS.
export function shardCount(items) {
  for (const it of items) if (it.seconds > SHARD_SECONDS) throw new Error(`packages/${it.ws}/test/${it.file} alone is over a shard's ${SHARD_SECONDS} s; split it`);
  for (let n = 1; n <= MAX_JOBS; n++) if (planShards(items, n).every((s) => s.seconds <= SHARD_SECONDS)) return n;
  throw new Error(`the tests need more than ${MAX_JOBS} shards of ${SHARD_SECONDS} s (${totals(items).seconds} s recorded)`);
}

// The smallest number of parts that keeps every part of the rendered checks (its share of the scan's documents and
// of the examples, each split by index modulo m) within PART_SECONDS, up to MAX_JOBS.
export function partCount(scanDocs, exampleDocs) {
  if (![scanDocs, exampleDocs].every((d) => Number.isSafeInteger(d) && d >= 1)) throw new Error('the rendered checks list no documents');
  for (let m = 1; m <= MAX_JOBS; m++) if ((Math.ceil(scanDocs / m) + Math.ceil(exampleDocs / m)) * DOC_SECONDS <= PART_SECONDS) return m;
  throw new Error(`the rendered checks need more than ${MAX_JOBS} parts of ${PART_SECONDS} s (${scanDocs} + ${exampleDocs} documents)`);
}

// "i/n", whole numbers without signs or leading zeros, 1 <= i <= n; null for anything else
export function parseIndex(s) {
  const m = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const i = Number(m[1]); const n = Number(m[2]);
  return i <= n ? { i, n } : null;
}

// part i of m of an ordered list: the entries whose index is i - 1 modulo m
export const partOf = (list, i, m) => list.filter((_, k) => k % m === i - 1);

// a file slower than its drift allowance
export const tooSlow = (measured, recorded) => measured > recorded * DRIFT.factor + DRIFT.plus;
// a shard over its time allowance, and a rendered part over its documents' allowance
export const shardTooLate = (wall) => wall > SHARD_SECONDS * DRIFT.factor;
export const partTooSlow = (took, docs) => took > docs * DOC_SECONDS * DRIFT.factor;
