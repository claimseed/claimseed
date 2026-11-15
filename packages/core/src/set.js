// set.js — published sets: a set file (data/sets/<name>.json) fixes every document of a blind set, its scenario,
// seed, layout, degraded copy and 835, so `batch --set NAME` with the salt recorded in its answer keys makes the same
// set again. Layout and preset turn with the seed number, the same for every scenario of a type, so neither says
// anything about the scenario.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { listScenarios } from './generate/index.js';
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
  const keys = ['note', 'name', 'canaryGuid', 'seedPrefix', 'types', 'degradeEvery', 'presets', 'remittance'];
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
  return spec;
}

// A published set by name; an unknown name is refused without repeating it.
export function loadSet(name) {
  if (typeof name !== 'string' || !SET_NAMES.includes(name)) throw new SetError(setMessage('setUnknown'));
  return checkSet(JSON.parse(fs.readFileSync(path.join(DATA, 'sets', `${name}.json`), 'utf-8')));
}

// Every document of a set, in plan order: { type, scenario, seed, layoutVariant?, degrade, also }. remittanceTypes
// names the types an 835 is written for.
export function planSet(spec, { remittanceTypes = [] } = {}) {
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
  return jobs;
}
