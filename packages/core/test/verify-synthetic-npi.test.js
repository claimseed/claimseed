// The monthly NPPES check (scripts/verify-synthetic-npi.js --nppes) against a stand-in registry: a real provider with the
// name claimseed prints (first, middle "Specimen", last) in a lexicon state is a finding; one with only the same first
// and last name is a warning; a registry that errs, answers in HTML, without results, with a count that does not match
// its results or with records that lack the names is asked again and, if it never answers, the combination is
// reported as unchecked, never as clear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import path from 'path'; import { fileURLToPath } from 'url';
import { checkNppes } from '../scripts/verify-synthetic-npi.js';
import { syntheticNpi } from '../src/generate/identifiers.js';
import { makeRng } from '../src/generate/rng.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const answer = (status, body) => ({ status, text: async () => body });
const json = (o) => answer(200, JSON.stringify(o));
// a record as the registry writes one (enumeration type, ten-digit number, names in capitals, a mailing address and a
// practice location); the fictional name the tests ask for, a synthetic number
const NPI = syntheticNpi(makeRng('nppes-record'));
const record = (middle, state = 'OH', { first = 'ANN', last = 'ROE' } = {}) => ({ enumeration_type: 'NPI-1', number: NPI,
  basic: middle === null ? { first_name: first, last_name: last } : { first_name: first, middle_name: middle, last_name: last },
  addresses: [{ address_purpose: 'MAILING', state: 'ZZ' }, { address_purpose: 'LOCATION', state }] });
const found = (state, ...middles) => json({ result_count: middles.length, results: middles.map((m) => record(m, state)) });
const params = (url) => Object.fromEntries(new URL(url).searchParams);
const quick = { retries: [], sleep: async () => {} };

test('the printed name (middle name Specimen) in a lexicon state is a finding; the same first and last name only is a warning', async () => {
  const asked = [];
  const reply = { OH: found('OH', 'Specimen'), TN: found('TN', null, 'J'), FL: found('FL', 'specimen.'), PA: found('PA'), NC: found('NC', 'SPECIMENS') };
  const fetchImpl = async (url) => { const p = params(url); asked.push(p); return reply[p.state]; };
  const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH', 'TN', 'FL', 'PA', 'NC'], fetchImpl, ...quick });
  assert.equal(r.checked, 5);
  assert.deepEqual(r.printed.map((m) => m.state), ['OH', 'FL']);
  assert.deepEqual(r.sameName.map((m) => m.state), ['TN', 'NC']);
  assert.deepEqual(r.unchecked, []);
  assert.deepEqual(asked[0], { version: '2.1', enumeration_type: 'NPI-1', first_name: 'Ann', last_name: 'Roe', state: 'OH', limit: '200' });
});

test('a full page is followed to the next one, and a name with more answers than the registry pages through is unchecked', async () => {
  const page = (n, middle = null) => json({ result_count: n, results: Array.from({ length: n }, (_, i) => record(i === n - 1 && middle ? middle : 'Q')) });
  const skips = [];
  let fetchImpl = async (url) => { const s = Number(params(url).skip || 0); skips.push(s); return s === 0 ? page(200) : page(3, 'Specimen'); };
  let r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl, ...quick });
  assert.deepEqual(skips, [0, 200]); assert.equal(r.printed.length, 1, 'the printed name on the second page');
  fetchImpl = async () => page(200);
  r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl, ...quick });
  assert.equal(r.checked, 0); assert.deepEqual(r.unchecked.map((u) => u.why), ['more answers than the registry pages through']);
});

test('errors, HTML pages and answers without results are retried, then reported as unchecked, never as clear', async () => {
  const waits = []; const sleep = async (ms) => { waits.push(ms); };
  const script = { OH: [answer(503, 'busy'), found('OH')], TN: [answer(200, '<html>blocked</html>'), answer(429, ''), json({ Errors: [{ description: 'x' }] })], FL: [], PA: [found('PA', 'Specimen')], NC: [json({ result_count: 2 })] };
  const fetchImpl = async (url) => { const s = params(url).state; if (s === 'FL') throw new TypeError('fetch failed'); return script[s].shift() || json({ result_count: 2 }); };
  const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH', 'TN', 'FL', 'PA', 'NC'], fetchImpl, retries: [1, 2], sleep });
  assert.equal(r.checked, 2); assert.deepEqual(r.printed.map((m) => m.state), ['PA']); assert.deepEqual(r.sameName, []);
  assert.deepEqual(r.unchecked.map((u) => [u.state, u.why]), [['TN', 'the registry answered with an error'], ['FL', 'TypeError fetch failed'], ['NC', 'no result_count or results in the answer']]);
  assert.deepEqual(waits, [1, 1, 2, 1, 2, 1, 2], 'one wait per retry');
});

test('an answer whose count does not match its results, or whose records lack what the check reads, is retried and then unchecked', async () => {
  const bad = {
    'a count with no results': { result_count: 1, results: [] },
    'results with a lower count': { result_count: 0, results: [record(null)] },
    'a negative count': { result_count: -1, results: [] },
    'a fractional count': { result_count: 1.5, results: [record(null)] },
    'a count as text': { result_count: '1', results: [record(null)] },
    'a count above the page size': { result_count: 201, results: Array.from({ length: 201 }, () => record(null)) },
    'results that are not a list': { result_count: 1, results: { 0: record(null) } },
    'no results at all': { result_count: 0 },
    'an empty record': { result_count: 1, results: [{}] },
    'a record without basic': { result_count: 1, results: [{ enumeration_type: 'NPI-1', number: NPI }] },
    'an organization record': { result_count: 1, results: [{ ...record(null), enumeration_type: 'NPI-2' }] },
    'a record with no last name': { result_count: 1, results: [{ ...record(null), basic: { first_name: 'X', last_name: ' ' } }] },
    'a record whose middle name is not text': { result_count: 1, results: [{ ...record(null), basic: { first_name: 'X', middle_name: 7, last_name: 'Y' } }] },
    'a record with a short number': { result_count: 1, results: [{ ...record(null), number: '123' }] },
    'null': null, 'a list': [], 'a number': 1,
  };
  for (const [what, body] of Object.entries(bad)) {
    let calls = 0;
    const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl: async () => { calls++; return json(body); }, retries: [1, 2], sleep: async () => {} });
    assert.equal(r.checked, 0, what); assert.deepEqual([r.printed, r.sameName], [[], []], what);
    assert.equal(r.unchecked.length, 1, what); assert.equal(calls, 3, `${what}: asked once and retried twice`);
  }
  // the same answers made consistent are decided as before
  const ok = [[{ result_count: 0, results: [] }, 'clear'], [{ result_count: 1, results: [record('Specimen')] }, 'printed'], [{ result_count: 1, results: [{ ...record(null), basic: { first_name: 'ANN', middle_name: null, last_name: 'ROE' } }] }, 'sameName']];
  for (const [body, what] of ok) {
    const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl: async () => json(body), ...quick });
    assert.equal(r.checked, 1); assert.deepEqual({ printed: r.printed.length, sameName: r.sameName.length }, { printed: what === 'printed' ? 1 : 0, sameName: what === 'sameName' ? 1 : 0 }, what);
  }
});

test('an answer that carries an error, a number that is not one, or records without their addresses are retried and then unchecked', async () => {
  const bad = {
    'an error beside a clear answer': { Errors: [{ description: 'Fictional unavailable result' }], result_count: 0, results: [] },
    'an error beside a match': { Errors: [], result_count: 1, results: [record('Specimen')] },
    'a number in a list': { result_count: 1, results: [{ ...record('Specimen'), number: [NPI] }] },
    'a number in a list of numbers': { result_count: 1, results: [{ ...record('Specimen'), number: [Number(NPI)] }] },
    'a number with nine digits': { result_count: 1, results: [{ ...record('Specimen'), number: 123456789 }] },
    'a fractional number': { result_count: 1, results: [{ ...record('Specimen'), number: Number(NPI) + 0.5 }] },
    'a number as an object': { result_count: 1, results: [{ ...record('Specimen'), number: { toString: () => NPI } }] },
    'no addresses': { result_count: 1, results: [(({ addresses, ...r }) => r)(record('Specimen'))] },
    'addresses that are not a list': { result_count: 1, results: [{ ...record('Specimen'), addresses: { 0: { address_purpose: 'LOCATION', state: 'OH' } } }] },
    'an address whose state is a number': { result_count: 1, results: [{ ...record('Specimen'), addresses: [{ address_purpose: 'LOCATION', state: 39 }] }] },
    'an address whose state is a list': { result_count: 1, results: [{ ...record('Specimen'), addresses: [{ address_purpose: 'LOCATION', state: ['OH'] }] }] },
    'an address that is not an object': { result_count: 1, results: [{ ...record('Specimen'), addresses: ['OH'] }] },
  };
  for (const [what, body] of Object.entries(bad)) {
    let calls = 0;
    const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl: async () => { calls++; return json(body); }, retries: [1, 2], sleep: async () => {} });
    assert.deepEqual([r.checked, r.printed.length, r.sameName.length, r.unchecked.length, calls], [0, 0, 0, 1, 3], what);
  }
  // a number written as a whole number is the registry's other form, and decides as text does
  const r = await checkNppes({ first: ['Ann'], last: ['Roe'], states: ['OH'], fetchImpl: async () => json({ result_count: 1, results: [{ ...record('Specimen'), number: Number(NPI) }] }), ...quick });
  assert.deepEqual([r.checked, r.printed.length], [1, 1]);
});

test('a provider with the asked first and last name counts wherever the registry finds the state: mailing address or any practice location', async () => {
  const ask = async (results, state = 'OH') => checkNppes({ first: ['Xanthe'], last: ['Veldorin'], states: [state], fetchImpl: async () => json({ result_count: results.length, results }), ...quick });
  const person = (first, middle, last, addresses, practiceLocations) => ({ ...record(middle, 'OH', { first, last }), addresses, ...(practiceLocations ? { practiceLocations } : {}) });
  const at = (purpose, state) => ({ address_purpose: purpose, state });
  const decide = (r) => ({ checked: r.checked, printed: r.printed.length, sameName: r.sameName.length, unchecked: r.unchecked.length });
  // another person with the printed middle name, a similar first name, another surname: not this name
  assert.deepEqual(decide(await ask([person('QUIRIN', 'SPECIMEN', 'ZELVANE', [at('LOCATION', 'OH')])])), { checked: 1, printed: 0, sameName: 0, unchecked: 0 });
  assert.deepEqual(decide(await ask([person('XANTHA', 'SPECIMEN', 'VELDORIN', [at('LOCATION', 'OH')]), person('XANTHE', 'SPECIMEN', 'VELDORINE', [at('LOCATION', 'OH')])])), { checked: 1, printed: 0, sameName: 0, unchecked: 0 });
  // the name in the state by its mailing address, its practice location, or a secondary practice location: it counts
  for (const [addresses, more] of [[[at('MAILING', 'OH'), at('LOCATION', 'TN')]], [[at('MAILING', 'TN'), at('LOCATION', 'OH')]], [[at('MAILING', 'TN'), at('LOCATION', 'TN')], [at('LOCATION', 'OH')]]])
    assert.deepEqual(decide(await ask([person('XANTHE', 'SPECIMEN', 'VELDORIN', addresses, more)])), { checked: 1, printed: 1, sameName: 0, unchecked: 0 }, JSON.stringify([addresses, more]));
  // the name with no address in the asked state contradicts the question: unchecked, never clear
  assert.deepEqual(decide(await ask([person('XANTHE', 'SPECIMEN', 'VELDORIN', [at('MAILING', 'TN'), at('LOCATION', 'TN')], [at('LOCATION', 'FL')])])), { checked: 0, printed: 0, sameName: 0, unchecked: 1 });
  // whatever its case or a final period, the name decides; other records beside it do not hide it
  assert.deepEqual(decide(await ask([person('QUIRIN', 'SPECIMEN', 'ZELVANE', [at('LOCATION', 'OH')]), person('xanthe', 'Specimen.', 'Veldorin.', [at('LOCATION', 'OH')])])), { checked: 1, printed: 1, sameName: 0, unchecked: 0 });
  assert.deepEqual(decide(await ask([person('QUIRIN', 'SPECIMEN', 'ZELVANE', [at('LOCATION', 'OH')]), person(' XANTHE ', 'J', 'VELDORIN', [at('LOCATION', 'OH')])])), { checked: 1, printed: 0, sameName: 1, unchecked: 0 });
  // secondary practice locations, when present, are a list of addresses whose state is text
  for (const practiceLocations of [{ 0: at('LOCATION', 'OH') }, [at('LOCATION', 7)], ['OH']])
    assert.deepEqual(decide(await ask([person('XANTHE', 'SPECIMEN', 'VELDORIN', [at('LOCATION', 'OH')], practiceLocations)])), { checked: 0, printed: 0, sameName: 0, unchecked: 1 }, JSON.stringify(practiceLocations));
  // an address abroad may have no state (absent, null or empty): it is in no state, and the rest of the record decides
  const abroad = [{ address_purpose: 'MAILING' }, { address_purpose: 'MAILING', state: null }, at('MAILING', '')];
  for (const a of abroad) {
    assert.deepEqual(decide(await ask([person('XANTHE', 'SPECIMEN', 'VELDORIN', [a, at('LOCATION', 'OH')])])), { checked: 1, printed: 1, sameName: 0, unchecked: 0 }, JSON.stringify(a));
    assert.deepEqual(decide(await ask([person('XANTHE', 'J', 'VELDORIN', [at('MAILING', 'OH')], [a])])), { checked: 1, printed: 0, sameName: 1, unchecked: 0 }, JSON.stringify(a));
    assert.deepEqual(decide(await ask([person('QUIRIN', 'SPECIMEN', 'ZELVANE', [a, at('LOCATION', 'OH')])])), { checked: 1, printed: 0, sameName: 0, unchecked: 0 }, JSON.stringify(a));
    // the asked name whose only addresses are abroad is not in the state: unchecked, never clear
    assert.deepEqual(decide(await ask([person('XANTHE', 'SPECIMEN', 'VELDORIN', [a], [a])])), { checked: 0, printed: 0, sameName: 0, unchecked: 1 }, JSON.stringify(a));
  }
});

test('offline, the committed tree holds only synthetic NPIs', () => {
  const r = spawnSync(process.execPath, [path.join(here, '../scripts/verify-synthetic-npi.js')], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /verify-synthetic-npi: ok/);
});
