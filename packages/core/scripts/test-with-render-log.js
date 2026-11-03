#!/usr/bin/env node
// test-with-render-log.js — run a workspace's tests while counting every stamped PDF they make, then check the count.
//   node ../core/scripts/test-with-render-log.js <workspace>    run node --test on test/*.test.js in the current folder
//   node packages/core/scripts/test-with-render-log.js --sum     (repository root) check both workspaces' logs together
// Every stamped PDF appends one line to CLAIMSEED_RENDER_LOG (src/render.js: "render" from mergePdfs, "degraded" or
// "single" from finalizePdf); subprocesses inherit the variable and append to the same file, this run's own. Each workspace's counts
// must equal the ones recorded in its test/render-budget.json, so a render the budget does not list fails the run, and
// the two workspaces together must stay within the caps (300 rendered documents, 50 degraded copies).
import fs from 'fs'; import path from 'path'; import { spawnSync } from 'child_process';
import { repoRoot } from './lib/repo-root.js';
import { isMain as runAsScript } from './lib/is-main.js';
// run as a script (not imported by a test)
const isMain = runAsScript(import.meta.url);

export const CAPS = { render: 300, degraded: 50 };
// The log of one run lives in the checkout itself (.tmp-render-log/, ignored by git), never in node_modules: two
// checkouts that share node_modules through a link must not count each other's renders. Each run writes its own log
// file and, when its tests are done, the counts for --sum.
export const logDir = () => path.join(repoRoot(), '.tmp-render-log');
export const runLogFile = (ws) => path.join(logDir(), `run-${ws}-${process.pid}-${Date.now()}.txt`);
export const countsFile = (ws) => path.join(logDir(), `counts-${ws}.json`);
export function countLog(text) {
  const n = { render: 0, degraded: 0, single: 0 };
  for (const line of String(text).split('\n')) { if (!line) continue; if (!(line in n)) throw new Error(`render log: unknown line kind "${line.slice(0, 20)}"`); n[line]++; }
  return n;
}
// The counts against a workspace's recorded budget: [] when they match, otherwise one message per kind.
export function checkCounts(counts, budget) {
  return Object.keys(counts).filter((k) => counts[k] !== budget[k]).map((k) => `${k}: ${counts[k]} made, ${budget[k]} recorded in test/render-budget.json`);
}
export function checkCaps(total) {
  return Object.entries(CAPS).filter(([k, cap]) => total[k] > cap).map(([k, cap]) => `${k}: ${total[k]} over the cap of ${cap}`);
}

const main = () => {
  const arg = process.argv[2];
  if (arg === '--sum') {
    const total = { render: 0, degraded: 0, single: 0 };
    for (const ws of ['core', 'mcp']) {
      const f = countsFile(ws); if (!fs.existsSync(f)) { console.error(`render log: no counts for ${ws}; run npm test in every workspace first`); process.exit(1); }
      const n = JSON.parse(fs.readFileSync(f, 'utf-8')); for (const k of Object.keys(total)) total[k] += n[k];
    }
    const over = checkCaps(total);
    console.log(`render log (core and mcp): ${total.render} rendered documents, ${total.degraded} degraded copies, ${total.single} single pages`);
    if (over.length) { for (const m of over) console.error(`render log: ${m}`); process.exit(1); }
    return;
  }
  if (!['core', 'mcp'].includes(arg)) { console.error('usage: test-with-render-log.js core|mcp|--sum'); process.exit(2); }
  const f = runLogFile(arg); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '', { flag: 'wx' });
  fs.rmSync(countsFile(arg), { force: true });
  const files = fs.readdirSync('test').filter((x) => x.endsWith('.test.js')).sort().map((x) => path.join('test', x));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, CLAIMSEED_RENDER_LOG: f } });
  const counts = countLog(fs.readFileSync(f, 'utf-8')); fs.rmSync(f, { force: true });
  fs.writeFileSync(countsFile(arg), JSON.stringify(counts) + '\n');
  console.log(`render log (${arg}): ${counts.render} rendered documents, ${counts.degraded} degraded copies, ${counts.single} single pages`);
  if (r.status !== 0) process.exit(r.status || 1);
  const budget = JSON.parse(fs.readFileSync('test/render-budget.json', 'utf-8'));
  const bad = [...checkCounts(counts, budget), ...checkCaps(counts)];
  if (bad.length) { for (const m of bad) console.error(`render log: ${m}`); process.exit(1); }
};
if (isMain) main();
