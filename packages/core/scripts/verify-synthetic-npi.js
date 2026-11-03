#!/usr/bin/env node
// verify-synthetic-npi.js — two checks on everything the generator can produce and everything committed:
//   offline (default): every NPI is 10 digits, Luhn-valid with the 80840 prefix, and starts with 9 — the
//     digit NPPES never issues, so no synthetic NPI can belong to a real provider.
//   --nppes: additionally ask the public NPPES registry, for each provider first and last name the lexicon can produce
//     and each state it places a provider in, whether a real individual provider there has the name as claimseed prints
//     it: first name, the sentinel middle name "Specimen" (src/generate/entities.js providerName) and last name. That
//     fails the check. A real provider with only the same first and last name is counted as a warning: the printed name
//     differs from theirs by the middle name. --list names the warned pairs (a local run; CI prints the count only).
//     Run monthly (CI cron) and whenever lexicon.js changes. Reference: https://npiregistry.cms.hhs.gov/api/
// Exit status: 0 no problem (warnings allowed); 1 a problem (a non-synthetic NPI, or a real provider with the printed
// name in that state); 3 the registry could not answer for some combinations after retries (nothing is decided for
// those; run it again).
import fs from 'fs'; import path from 'path';
import { isSyntheticNpi } from '../src/generate/identifiers.js';
import { PROVIDER_FIRST, PROVIDER_LAST, PLACES } from '../src/generate/lexicon.js';
import { fileURLToPath } from 'url';
import { isMain as runAsScript } from './lib/is-main.js';
// run as a script (not imported by a test)
const isMain = runAsScript(import.meta.url);

export const NPPES_API = 'https://npiregistry.cms.hhs.gov/api/';
export const SENTINEL_MIDDLE = 'SPECIMEN';
const PAGE = 200; const MAX_SKIP = 1000;   // the registry's page size and deepest offset
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
// a ten-digit NPI, written as text or as a number (never a list or another value turned into text)
const isNumber10 = (n) => (typeof n === 'string' && /^[0-9]{10}$/.test(n)) || (Number.isSafeInteger(n) && n >= 1e9 && n < 1e10);
// an address as the check reads it: its state, when it has one, is text (an address abroad may have none, and is in no
// state)
const isAddress = (a) => isObject(a) && (a.state === undefined || a.state === null || typeof a.state === 'string');
// an individual provider's record with the names and the addresses the check reads
const isRecord = (x) => isObject(x) && x.enumeration_type === 'NPI-1' && isNumber10(x.number)
  && isObject(x.basic) && nonEmpty(x.basic.first_name) && nonEmpty(x.basic.last_name)
  && (x.basic.middle_name === undefined || x.basic.middle_name === null || typeof x.basic.middle_name === 'string')
  && Array.isArray(x.addresses) && x.addresses.every(isAddress)
  && (x.practiceLocations === undefined || (Array.isArray(x.practiceLocations) && x.practiceLocations.every(isAddress)));
// why a parsed answer cannot be used ('' when it can)
export function answerProblem(j) {
  if (isObject(j) && 'Errors' in j) return 'the registry answered with an error';
  if (!isObject(j) || !('result_count' in j) || !Array.isArray(j.results)) return 'no result_count or results in the answer';
  if (!Number.isSafeInteger(j.result_count) || j.result_count < 0 || j.result_count > PAGE || j.result_count !== j.results.length) return 'a result_count that is not the number of results';
  if (!j.results.every(isRecord)) return 'a result that is not an individual provider record with a first and last name and its addresses';
  return '';
}

/** Ask the registry once per first name, last name and state (paging when a page is full). An answer counts only when
 *  it is HTTP 200 with a JSON object as the registry writes one: result_count a whole number from 0 to the page size
 *  and equal to the number of results on the page, and each result an individual provider's record (enumeration
 *  type NPI-1, a ten-digit number as text or a number, a non-empty first and last name, a middle name that is text
 *  when present, and a list of addresses, with secondary practice locations a list too when present, each address's
 *  state text when it has one). Anything else (a network error, another status, an
 *  HTML page, an answer that carries Errors, a count that does not match its results, a record without the names or
 *  addresses) is retried after each delay in `retries` and, if it never answers, the
 *  combination is reported as unchecked, never as clear. Only records with the asked first and last name count, and
 *  each must have the asked state in its mailing address or a practice location. Returns { checked, printed, sameName, unchecked }: printed = such a provider with
 *  the printed name (middle name Specimen), sameName = first and last name only. */
export async function checkNppes({ first, last, states, fetchImpl = fetch, retries = [2000, 5000, 15000], sleep = sleepMs, log = () => {} }) {
  const printed = []; const sameName = []; const unchecked = []; let checked = 0;
  const ask = async (url) => {
    let why = '';
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      if (attempt) await sleep(retries[attempt - 1]);
      try {
        const r = await fetchImpl(url);
        if (r.status !== 200) { why = `HTTP ${r.status}`; continue; }
        const j = JSON.parse(await r.text());
        why = answerProblem(j);
        if (!why) return { results: j.results };
      } catch (e) { why = e instanceof SyntaxError ? 'an answer that is not JSON' : `${e.name || 'error'} ${String(e.message).slice(0, 80)}`; }
    }
    return { why };
  };
  for (const f of first) for (const l of last) for (const state of states) {
    const base = `${NPPES_API}?version=2.1&enumeration_type=NPI-1&first_name=${encodeURIComponent(f)}&last_name=${encodeURIComponent(l)}&state=${state}&limit=${PAGE}`;
    const found = []; let why = '';
    for (let skip = 0; ; skip += PAGE) {
      const a = await ask(skip ? `${base}&skip=${skip}` : base);
      if (a.why) { why = a.why; break; }
      found.push(...a.results);
      if (a.results.length < PAGE) break;
      if (skip + PAGE > MAX_SKIP) { why = 'more answers than the registry pages through'; break; }
    }
    if (why) { unchecked.push({ first: f, last: l, state, why }); continue; }
    // a provider with this first and last name counts (the registry also answers with similar first names, which are
    // not the name claimseed prints); asked without an address purpose, the registry matches the state against the
    // mailing address or any practice location, so such a provider has the state in one of them, and one that does not
    // is an answer that contradicts itself: the combination is unchecked, never taken as clear
    const norm = (v) => (typeof v === 'string' ? v : '').trim().toUpperCase().replace(/\.$/, '');
    const theirs = found.filter((x) => norm(x.basic.first_name) === norm(f) && norm(x.basic.last_name) === norm(l));
    if (theirs.some((x) => ![...x.addresses, ...(x.practiceLocations || [])].some((a) => a.state === state))) { unchecked.push({ first: f, last: l, state, why: 'a provider of this name with no address in the state' }); continue; }
    checked++;
    if (theirs.some((x) => norm(x.basic.middle_name) === SENTINEL_MIDDLE)) printed.push({ first: f, last: l, state });
    else if (theirs.length) sameName.push({ first: f, last: l, state });
    if ((checked + unchecked.length) % 500 === 0) log(`nppes: ${checked + unchecked.length} asked`);
  }
  return { checked, printed, sameName, unchecked };
}

function offlineProblems(root) {
  const problems = [];
  const walk = (dir, fn) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', '.git', 'output'].includes(e.name)) continue; const p = path.join(dir, e.name); e.isDirectory() ? walk(p, fn) : fn(p); } };
  walk(root, (p) => {
    if (!/\.(json|md|html|js)$/.test(p)) return;
    const t = fs.readFileSync(p, 'utf-8');
    for (const m of t.matchAll(/"npi"\s*:\s*"(\d+)"/gi)) if (!isSyntheticNpi(m[1])) problems.push(`${path.relative(root, p)}: NPI ${m[1]} is not a synthetic (9-prefixed, Luhn-valid) NPI`);
  });
  return problems;
}

async function main() {
  const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  const problems = offlineProblems(root);
  let unchecked = [];
  if (process.argv.includes('--nppes')) {
    const states = [...new Set(PLACES.map((p) => p.state))];
    const r = await checkNppes({ first: PROVIDER_FIRST, last: PROVIDER_LAST, states, log: (m) => console.log(m) });
    console.log(`nppes: checked ${r.checked} name/state combinations: ${r.printed.length} with a real provider of the printed name, ${r.sameName.length} with a real provider of the same first and last name only (warning), ${r.unchecked.length} unanswered`);
    if (r.sameName.length && process.argv.includes('--list')) for (const m of r.sameName) console.log(`  warning: ${m.first} ${m.last} in ${m.state}`);
    for (const m of r.printed) problems.push(`NPPES has a real provider named ${m.first} Specimen ${m.last} in ${m.state}, the name claimseed prints — change the lexicon`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `NPPES: ${r.checked} name/state combinations checked; ${r.printed.length} printed-name matches; ${r.sameName.length} first-and-last-name matches (warning only; run with --list locally to name them); ${r.unchecked.length} unanswered.\n`);
    unchecked = r.unchecked;
  }
  if (problems.length) console.error(problems.join('\n'));
  if (unchecked.length) {
    console.error(`nppes: the registry did not answer for ${unchecked.length} combination(s) after retries; nothing is decided for them. First: ${unchecked.slice(0, 5).map((u) => `${u.first} ${u.last} ${u.state} (${u.why})`).join('; ')}`);
  }
  if (problems.length) process.exit(1);
  if (unchecked.length) process.exit(3);
  console.log('verify-synthetic-npi: ok');
}
if (isMain) await main();
