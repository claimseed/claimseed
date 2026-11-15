// rendered-plan.js — the documents the rendered-output scan (scan-rendered.js) and the examples check (examples.js)
// make, in their fixed order, so CI can split them into parts (part i of m takes the documents whose index is i - 1
// modulo m) and plan the parts without rendering anything. Both scripts render exactly these lists.
import { listScenarios, loadScenario } from '../../src/generate/index.js';
import { RENDERERS } from '../../src/layouts.js';
import { variantIds } from '../../src/variants.js';
import { partCount } from './test-plan.js';

// the options CI runs the scan with; --part is refused with any other
export const CI_SCAN = Object.freeze({ seeds: 2, variants: 'all', blind: 'all' });

// The scan's documents: per type, every scenario for each seed; then every layout variant id once (on the scenarios
// in turn, seed scan-v); then, blind, every scenario and every variant id at least once side by side (seed scan-b).
export function scanJobs({ seeds, variants, blind, only = null }) {
  const jobs = [];
  for (const type of Object.keys(RENDERERS)) {
    if (only && type !== only) continue;
    const scen = listScenarios(type);
    for (const scenario of scen) for (let k = 1; k <= seeds; k++) jobs.push({ type, scenario, seed: `scan-${k}`, id: null, blind: false });
    const ids = variants === 'all' ? variantIds(type) : [];
    for (const [i, id] of ids.entries()) jobs.push({ type, scenario: scen[i % scen.length], seed: 'scan-v', id, blind: false });
    const bids = variantIds(type); const nb = blind === 'all' ? Math.max(scen.length, bids.length) : 0;
    for (let i = 0; i < nb; i++) jobs.push({ type, scenario: scen[i % scen.length], seed: 'scan-b', id: bids.length ? bids[i % bids.length] : null, blind: true });
  }
  return jobs;
}

// The examples: one per published scenario, then one per layout variant id on the type's published scenarios in turn,
// all with the seed "example".
export const EXAMPLE_SEED = 'example';
export function exampleJobs() {
  const published = (type) => listScenarios(type).filter((s) => loadScenario(type, s).status === 'published');
  const jobs = [];
  for (const type of Object.keys(RENDERERS)) for (const scenario of published(type)) jobs.push({ type, scenario, seed: EXAMPLE_SEED });
  for (const type of Object.keys(RENDERERS)) variantIds(type).forEach((id, i) => jobs.push({ type, scenario: published(type)[i % published(type).length], seed: EXAMPLE_SEED, layoutVariant: id }));
  return jobs;
}

// the number of parts CI splits the rendered checks into
export const ciPartCount = () => partCount(scanJobs(CI_SCAN).length, exampleJobs().length);
