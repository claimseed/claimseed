#!/usr/bin/env node
// ci-plan.js — the CI plan job: run the test plan's static checks, then write the shard and part lists CI runs, as
// whole numbers only, to $GITHUB_OUTPUT (or print them):
//   shards=[1,...,n]   n test shards (scripts/lib/test-plan.js, from each test file's recorded seconds)
//   parts=[1,...,m]    m parts of the rendered-output scan and the examples check (scripts/lib/rendered-plan.js)
// Each shard and part refuses to run unless its n or m equals the count computed here, so the matrix cannot drift.
import fs from 'fs';
import { repoRoot } from './lib/repo-root.js';
import { loadItems, shardCount, totals } from './lib/test-plan.js';
import { ciPartCount } from './lib/rendered-plan.js';

const { items, problems } = loadItems(repoRoot());
let n = null; try { n = shardCount(items); } catch (e) { problems.push(e.message); }
let m = null; try { m = ciPartCount(); } catch (e) { problems.push(e.message); }
if (problems.length) { for (const p of problems) console.error(`ci-plan: ${p}`); process.exit(1); }
const list = (k) => JSON.stringify(Array.from({ length: k }, (_, i) => i + 1));
const out = `shards=${list(n)}\nparts=${list(m)}\n`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
const t = totals(items);
console.log(`ci-plan: ${items.length} test files, ${t.seconds} s recorded, ${t.render} rendered and ${t.degraded} degraded; ${n} shard(s), ${m} rendered part(s)`);
process.stdout.write(out);
