// set.js — published sets: a set file (data/sets/<name>.json) fixes every document of a blind set, its scenario,
// seed, layout, degraded copy and 835, so `batch --set NAME` with the salt recorded in its answer keys makes the same
// set again. Layout and preset turn with the seed number, the same for every scenario of a type, so neither says
// anything about the scenario.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { listScenarios, generateData, generatePair } from './generate/index.js';
import { blindSeed, blindOrder, blindSalt } from './blind.js';
import { BILL_VARIANTS, PAIRED_TYPES, PAIR_STRINGS } from './generate/provider-statement.js';
import { RENDERERS } from './layouts.js';
import { variantIds } from './variants.js';
import { PRESETS } from './presets.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
export const SET_STRINGS = JSON.parse(fs.readFileSync(path.join(DATA, 'set.json'), 'utf-8'));
export const SET_NAMES = Object.freeze(['standard']);
const MAX_SET = 10000;
const SEED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SetError extends Error { constructor(message) { super(message); this.code = 'SET'; } }
export const setMessage = (key, who = 'batch') => SET_STRINGS.messages[key].replace('{who}', who).replace('{names}', SET_NAMES.join(', '));

// The canary sentence every answer key of the set carries.
export const canaryOf = (spec) => SET_STRINGS.canary.replace('{guid}', spec.canaryGuid);

// A set file, read and checked whole: anything outside the shape below is refused (a published file, so a refusal is
// a packaging fault, and the message names no value).
export function checkSet(spec) {
  const bad = (what) => { throw new Error(`set file: ${what}`); };
  const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  if (!plain(spec)) bad('not an object');
  const keys = ['note', 'name', 'canaryGuid', 'seedPrefix', 'types', 'degradeEvery', 'presets', 'remittance', 'statements', 'floors'];
  for (const k of Object.keys(spec)) if (!keys.includes(k)) bad('unknown key');
  if (typeof spec.name !== 'string' || !SET_NAMES.includes(spec.name)) bad('name is not a published set');
  if (typeof spec.canaryGuid !== 'string' || !GUID.test(spec.canaryGuid)) bad('canaryGuid is not a GUID');
  if (typeof spec.seedPrefix !== 'string' || !SEED.test(`${spec.seedPrefix}-${MAX_SET}`)) bad('seedPrefix is not a seed prefix');
  if (!Array.isArray(spec.types) || !spec.types.length) bad('types is empty');
  const seen = new Set();
  for (const t of spec.types) {
    if (!plain(t) || Object.keys(t).some((k) => k !== 'type' && k !== 'seeds')) bad('a type entry has other keys');
    if (typeof t.type !== 'string' || !Object.hasOwn(RENDERERS, t.type) || seen.has(t.type)) bad('a type is unknown or repeated');
    if (!Number.isSafeInteger(t.seeds) || t.seeds < 1) bad('seeds is not a whole number of at least 1');
    seen.add(t.type);
  }
  if (!Number.isSafeInteger(spec.degradeEvery) || spec.degradeEvery < 2) bad('degradeEvery is not a whole number of at least 2');
  if (!Array.isArray(spec.presets) || !spec.presets.length || spec.presets.some((p) => !PRESETS.includes(p)) || new Set(spec.presets).size !== spec.presets.length) bad('presets are unknown or repeated');
  if (typeof spec.remittance !== 'boolean') bad('remittance is not true or false');
  const exact = (o, ks) => plain(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k));
  if (spec.statements !== undefined) {
    if (!exact(spec.statements, ['every']) || !Number.isSafeInteger(spec.statements.every) || spec.statements.every < 1) bad('statements is not { every }');
    if (!spec.types.some((t) => PAIRED_TYPES.includes(t.type))) bad('statements without a paired type');
  }
  if (spec.floors !== undefined) {
    if (!exact(spec.floors, FLOOR_KEYS)) bad('floors has other keys or misses one');
    for (const k of FLOOR_KEYS) {
      const v = spec.floors[k];
      if (k === 'insurerShare' ? !(typeof v === 'number' && v > 0 && v < 1) : !(Number.isSafeInteger(v) && v >= 1)) bad('a floor is out of range');
    }
  }
  return spec;
}

// The floors a set is held to (checked before anything is rendered): each error kind and decoy of a type's scenarios;
// on the statements of each paired type, each statement error kind and the paid-at-visit decoy (counted over the keys
// that carry them), clean statements and each variant; each commercial statement kind; each insurer's share.
const FLOOR_KEYS = ['errorKind', 'decoy', 'statementKind', 'statementClean', 'statementVariant', 'statementProvider', 'insurerShare'];

// A published set by name; an unknown name is refused without repeating it.
export function loadSet(name) {
  if (typeof name !== 'string' || !SET_NAMES.includes(name)) throw new SetError(setMessage('setUnknown'));
  return checkSet(JSON.parse(fs.readFileSync(path.join(DATA, 'sets', `${name}.json`), 'utf-8')));
}

// Every document of a set, in plan order: { type, scenario, seed, layoutVariant?, degrade, also }. remittanceTypes
// names the types an 835 is written for.
export function planSet(spec, { remittanceTypes = [], salt = null } = {}) {
  return planWithCounts(spec, { remittanceTypes, salt }).jobs;
}

// The plan and what its documents will hold, from the generator alone (nothing rendered): the counts the floors read.
export function planWithCounts(spec, { remittanceTypes = [], salt = null } = {}) {
  checkSet(spec);
  const count = spec.types.reduce((n, t) => n + listScenarios(t.type).length * t.seeds, 0);
  if (count > MAX_SET) throw new Error(`set file: ${count} documents is over the limit of ${MAX_SET}`);
  const jobs = [];
  for (const { type, seeds } of spec.types) {
    const layouts = [null, ...variantIds(type)];
    for (const scenario of listScenarios(type)) for (let i = 1; i <= seeds; i++) {
      const job = { type, scenario, seed: `${spec.seedPrefix}-${i}` };
      const layoutVariant = layouts[(i - 1) % layouts.length];
      if (layoutVariant !== null) job.layoutVariant = layoutVariant;
      job.degrade = i % spec.degradeEvery === 0 ? spec.presets[(i / spec.degradeEvery - 1) % spec.presets.length] : null;
      job.also = spec.remittance && remittanceTypes.includes(type) ? '835' : null;
      jobs.push(job);
    }
  }
  if (!spec.statements && !spec.floors) return { jobs, counts: null };
  if (typeof salt !== 'string') throw new Error('set file: statements and floors are planned from the salt');
  return withStatements(spec, jobs, salt);
}

const seedIndex = (job) => Number(job.seed.slice(job.seed.lastIndexOf('-') + 1));
const NON_CLEAN = BILL_VARIANTS.filter((v) => v !== 'clean');

// A statement beside every EOB of a paired type whose seed index is a multiple of `every` or that is a degraded copy
// (the seed number alone decides, the same for every scenario). Its variant must apply to the claim it bills, drawn
// from the blind seed, so the variants are assigned per salt and per EOB type, in the salt's order: the first statement
// where denied-line-billed applies (a denied line the patient is held harmless for) stays clean; then each non-clean
// variant in turn, rarest first, takes the next statement it applies to, up to a sixth of the type's statements; the
// rest are clean. Each such EOB job becomes two, its parts, with the variant.
function withStatements(spec, jobs, salt) {
  const counts = { errorKind: {}, decoy: {}, statements: {}, statementProvider: {}, insurer: {}, expected: { errorKind: {}, decoy: {} } };
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const gen = (j) => ({ type: j.type, scenario: j.scenario, seed: blindSeed(salt, j), layoutVariant: j.layoutVariant ?? null });
  const withStatement = (j) => spec.statements && PAIRED_TYPES.includes(j.type) && (seedIndex(j) % spec.statements.every === 0 || j.degrade !== null);
  const variantOf = new Map();
  // the kinds each type's scenarios plant, from one reference render of each (the set's first seed, not blind): a kind
  // the set should hold and does not is then counted as missing, not skipped
  for (const type of [...new Set(jobs.map((j) => j.type))]) {
    const ek = new Set(); const dk = new Set();
    for (const scenario of listScenarios(type)) {
      const { groundTruth } = generateData({ type, scenario, seed: `${spec.seedPrefix}-1` });
      for (const e of groundTruth.errors || []) ek.add(e.kind);
      for (const d of groundTruth.decoys || []) dk.add(d.kind);
    }
    counts.expected.errorKind[type] = [...ek].sort(); counts.expected.decoy[type] = [...dk].sort();
  }
  for (const j of jobs) {
    const { data, groundTruth } = generateData(gen(j));
    counts.errorKind[j.type] ||= {}; counts.decoy[j.type] ||= {};
    for (const e of groundTruth.errors || []) inc(counts.errorKind[j.type], e.kind);
    for (const d of groundTruth.decoys || []) inc(counts.decoy[j.type], d.kind);
    if (j.type === 'commercial-eob') { counts.insurer.total = (counts.insurer.total || 0) + 1; inc(counts.insurer, data._insurerId); }
  }
  for (const type of PAIRED_TYPES) {
    const mine = blindOrder(salt, jobs.filter((j) => j.type === type && withStatement(j)));
    if (!mine.length) continue;
    const applies = new Map(mine.map((j) => [j, BILL_VARIANTS.filter((v) => generatePair({ ...gen(j), bill: v, orClean: true }).statement.groundTruth.pair.variant === v)]));
    const reach = Object.fromEntries(BILL_VARIANTS.map((v) => [v, mine.filter((j) => applies.get(j).includes(v)).length]));
    const quota = Math.floor(mine.length / 6); const n = Object.fromEntries(BILL_VARIANTS.map((v) => [v, 0]));
    const held = mine.find((j) => applies.get(j).includes('denied-line-billed'));
    if (held) { variantOf.set(held, 'clean'); n.clean++; }
    const order = [...NON_CLEAN].sort((a, b) => reach[a] - reach[b] || BILL_VARIANTS.indexOf(a) - BILL_VARIANTS.indexOf(b));
    for (let moved = true; moved;) {
      moved = false;
      for (const v of order) {
        if (n[v] >= quota) continue;
        const j = mine.find((x) => !variantOf.has(x) && applies.get(x).includes(v));
        if (j) { variantOf.set(j, v); n[v]++; moved = true; }
      }
    }
    for (const j of mine) if (!variantOf.has(j)) { variantOf.set(j, 'clean'); n.clean++; }
    const c = counts.statements[type] = { total: mine.length, variant: n, errorKind: {}, decoy: {} };
    for (const j of mine) {
      const st = generatePair({ ...gen(j), bill: variantOf.get(j), orClean: true }).statement.groundTruth;
      for (const e of st.errors || []) inc(c.errorKind, e.kind);
      for (const d of st.decoys || []) inc(c.decoy, d.kind);
      if (type === 'commercial-eob') inc(counts.statementProvider, st.documents[0].fields['metadata.title']);
    }
  }
  const out = [];
  for (const j of jobs) {
    if (!variantOf.has(j)) { out.push(j); continue; }
    const also = [...(j.also ? [j.also] : []), 'bill']; const bill = variantOf.get(j);
    out.push({ ...j, also, bill, part: 'eob' }, { ...j, also, bill, part: 'bill' });
  }
  return { jobs: out, counts };
}

// The salt a set is made with and its plan: a salt given (blind { salt }) that misses a floor is refused; with blind
// true, salts are drawn until one meets every floor, at most MAX_DRAWS, and the floors each refused draw missed are
// returned by name (never a salt).
const MAX_DRAWS = 50;
export function drawSalt(spec, blind, { remittanceTypes = [] } = {}) {
  const missed = [];
  for (;;) {
    const salt = blindSalt(blind);
    const plan = planWithCounts(spec, { remittanceTypes, salt });
    const miss = plan.counts ? floorsMissed(spec, plan.counts) : [];
    if (!miss.length) return { salt, plan, draws: missed.length + 1, missed };
    if (blind !== true) throw new SetError(setMessage('setFloors'));
    missed.push(miss);
    if (missed.length >= MAX_DRAWS) throw new SetError(setMessage('setDraws'));
  }
}

// The line the command line prints after a set drawn more than once (n salts in all).
export const drawnMessage = (n) => SET_STRINGS.messages.setDrawn.replace('{who}', 'batch').replace('{n}', String(n));

// The floors the counts miss, by name (never a salt or a value from a document): an empty list passes.
export function floorsMissed(spec, counts) {
  if (!spec.floors) return [];
  const f = spec.floors; const miss = [];
  for (const [type, kinds] of Object.entries(counts.expected.errorKind)) for (const k of kinds) if ((counts.errorKind[type]?.[k] || 0) < f.errorKind) miss.push(`errorKind ${type} ${k}`);
  for (const [type, kinds] of Object.entries(counts.expected.decoy)) for (const k of kinds) if ((counts.decoy[type]?.[k] || 0) < f.decoy) miss.push(`decoy ${type} ${k}`);
  for (const [type, c] of Object.entries(counts.statements)) {
    for (const k of ['bill-vs-eob-mismatch', 'bill-payment-mismatch']) if ((c.errorKind[k] || 0) < f.statementKind) miss.push(`statementKind ${type} ${k}`);
    if ((c.decoy['paid-at-visit'] || 0) < f.statementKind) miss.push(`statementKind ${type} paid-at-visit`);
    if (c.variant.clean < f.statementClean) miss.push(`statementClean ${type}`);
    for (const v of NON_CLEAN) if (c.variant[v] < f.statementVariant) miss.push(`statementVariant ${type} ${v}`);
  }
  if (counts.statements['commercial-eob']) for (const t of Object.values(PAIR_STRINGS.commercialStatement.titles)) if ((counts.statementProvider[t] || 0) < f.statementProvider) miss.push(`statementProvider ${t}`);
  if (counts.insurer.total) for (const k of ['a', 'b']) if ((counts.insurer[k] || 0) < f.insurerShare * counts.insurer.total) miss.push(`insurerShare ${k}`);
  return miss;
}
