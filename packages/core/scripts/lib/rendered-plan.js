// rendered-plan.js — the documents the rendered-output scan (scan-rendered.js) and the examples check (examples.js)
// make, in their fixed order, so CI can split them into parts (part i of m takes the documents whose index is i - 1
// modulo m) and plan the parts without rendering anything. Both scripts render exactly these lists.
import { listScenarios, loadScenario, generatePair } from '../../src/generate/index.js';
import { PAIRED_TYPES, BILL_VARIANTS } from '../../src/generate/provider-statement.js';
import { INSURER_IDS } from '../../src/generate/commercial-eob.js';
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
    // a type with statements: every scenario once more with its provider statement (seed scan-s), the variants in turn
    // from the scenario's place, each the first that applies to the claim the statement bills (clean always does)
    if (PAIRED_TYPES.includes(type)) for (const [i, scenario] of scen.entries()) jobs.push({ type, scenario, seed: 'scan-s', id: null, blind: false, bill: statementVariant(type, scenario, i) });
  }
  return jobs;
}
export const STATEMENT_SEED = 'scan-s';
export function statementVariant(type, scenario, i) {
  for (let k = 0; k < BILL_VARIANTS.length; k++) {
    const bill = BILL_VARIANTS[(i + k) % BILL_VARIANTS.length];
    if (generatePair({ type, scenario, seed: STATEMENT_SEED, bill, orClean: true }).statement.groundTruth.pair.variant === bill) return bill;
  }
  return 'clean';
}

// The examples: one per published scenario, then one per layout variant id on the type's published scenarios in turn,
// all with the seed "example".
export const EXAMPLE_SEED = 'example';
export function exampleJobs() {
  const published = (type) => listScenarios(type).filter((s) => loadScenario(type, s).status === 'published');
  const jobs = [];
  // the commercial EOB once per insurer (each insurer has its own layout family); every other type once
  for (const type of Object.keys(RENDERERS)) for (const scenario of published(type)) for (const insurer of type === 'commercial-eob' ? INSURER_IDS : [null]) jobs.push({ type, scenario, seed: EXAMPLE_SEED, ...(insurer ? { insurer } : {}) });
  for (const type of Object.keys(RENDERERS)) variantIds(type).forEach((id, i) => jobs.push({ type, scenario: published(type)[i % published(type).length], seed: EXAMPLE_SEED, layoutVariant: id }));
  // a provider's statement beside five of them: each Medicare Advantage EOB's clean scenario, the commercial EOB's
  // clean scenario for each insurer, and the commercial care-settings scenario (an urgent care center's statement);
  // over-owed where it applies to the claim the statement bills, else clean
  for (const job of jobs) {
    if (job.layoutVariant || !STATEMENT_EXAMPLES.some(([t, sc, ins]) => job.type === t && job.scenario === sc && (job.insurer ?? null) === ins)) continue;
    const g = { type: job.type, scenario: job.scenario, seed: job.seed, ...(job.insurer ? { overrides: { insurer: job.insurer } } : {}) };
    job.bill = generatePair({ ...g, bill: 'over-owed', orClean: true }).statement.groundTruth.pair.variant;
  }
  return jobs;
}
const STATEMENT_EXAMPLES = [['ppo-eob', 'baseline-clean', null], ['hmo-eob', 'baseline-clean', null], ['commercial-eob', 'baseline-clean', 'a'],
  ['commercial-eob', 'baseline-clean', 'b'], ['commercial-eob', 'care-settings-clean', 'a']];

// the number of parts CI splits the rendered checks into
// a job with a statement renders two PDFs, so it counts as two documents in the plan
export const scanDocs = (jobs) => jobs.length + jobs.filter((j) => j.bill).length;
export const ciPartCount = () => partCount(scanDocs(scanJobs(CI_SCAN)), exampleJobs().length);
