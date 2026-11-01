// The X12 835 written beside a Medicare Summary Notice or a Medicare Advantage EOB (src/x12/remittance.js): every
// clean claim balances, every planted error is caught by its named check at the place the answer key records and
// clean files trigger none, the envelope is valid, an independent X12 reader parses every file and finds the
// markers, the free text, identifiers and segment shapes follow the rules, and the specimen strings match their
// recorded hash.
// No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { X12parser } from 'x12-parser';
import { listScenarios } from '../src/index.js';
import { remittanceFor, buildRemittance, REMITTANCE_TYPES, SPECIMEN_STRINGS, amount } from '../src/x12/remittance.js';
import { check835, checkSpecimen835, parse835 } from '../src/x12/check835.js';
import { generateData } from '../src/generate/index.js';
import { luhnCheckDigit } from '../src/generate/identifiers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../schemas/ground-truth.schema.json'), 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); const validate = ajv.compile(schema);
const SEEDS = Array.from({ length: 20 }, (_, i) => `x12-${i}`);
const CLEAN_NAME = (s) => String(s).toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
// the check each kind of planted error must trip in the 835, by the element the answer key names
const CHECK_FOR = (e) => (e.kind === 'duplicate-charge' ? 'duplicate-service' : /:CLP05$/.test(e.x12Ref || '') ? 'patient-responsibility' : /:CLP0[34]$/.test(e.x12Ref || '') ? 'claim-balance' : null);
const BALANCE = new Set(['service-balance', 'claim-balance', 'patient-responsibility', 'transaction-balance', 'duplicate-service']);
const names = (g) => { const d = g.documents[0]; return [...d.entities.providers.map((p) => CLEAN_NAME(p.name)), ...CLEAN_NAME(d.entities.patient.name).split(' ')]; };

test('the specimen strings file matches its recorded hash, the writer uses it as written, and its strings carry no X12 delimiter', () => {
  const file = path.join(here, '../data/x12/specimen-strings.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), '04fc2d12a25e16905ab348637326c1387b974ba9a71113d0e1055d3f6b8b6d1c');
  const { notes, ...strings } = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(Object.fromEntries(Object.entries(SPECIMEN_STRINGS).filter(([k]) => k !== 'notes')), strings, 'the writer uses the file as written');
  for (const v of JSON.stringify(strings).match(/"[^"]*"/g)) assert.doesNotMatch(v, /[*^>~:|]/, v);
  assert.ok(notes.length > 0);
});

test('amounts are written from integer cents without trailing zeros', () => {
  assert.deepEqual([0, 5, 50, 100, 2000, 13561, 2712, -150].map(amount), ['0', '0.05', '0.5', '1', '20', '135.61', '27.12', '-1.5']);
});

test('every 835 of every scenario: valid envelope, balanced claims unless an error is planted, each error caught where the answer key says, markers and identifiers as the rules require', async () => {
  let files = 0, claims = 0, errorsCaught = 0;
  for (const type of REMITTANCE_TYPES) for (const scenario of listScenarios(type)) for (const seed of SEEDS) {
    const { text, groundTruth: g } = await remittanceFor({ type, scenario, seed });
    const where = `${type}/${scenario}/${seed}`; files++;
    assert.ok(validate(g), `${where}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
    const { findings, transactions } = check835(text);
    assert.deepEqual(findings.filter((f) => !BALANCE.has(f.check)), [], `${where}: envelope or payment`);
    // every planted error that the 835 carries is caught by its check at its element; nothing else is flagged
    const expected = g.errors.map((e) => ({ check: CHECK_FOR(e), ref: e.x12Ref })).filter((x) => x.check);
    const balance = findings.filter((f) => BALANCE.has(f.check));
    for (const x of expected) assert.ok(balance.some((f) => f.check === x.check && f.ref === x.ref), `${where}: ${x.check} not found at ${x.ref}; found ${JSON.stringify(balance)}`);
    // and nothing else: each planted error gives exactly its own finding, a clean claim none
    const key = (f) => `${f.check}@${f.ref}`;
    assert.deepEqual(balance.map(key).sort(), expected.map(key).sort(), `${where}: findings differ from the planted errors`);
    errorsCaught += expected.length;
    // the answer key's 835 entry matches the file
    const d = g.documents[1]; assert.equal(d.type, 'x12-835'); assert.equal(d.sha256, crypto.createHash('sha256').update(text).digest('hex'));
    assert.deepEqual(d.transactions.map((t) => [t.controlNumber, t.handlingCode, t.paymentMethod, Math.round(t.paymentAmount * 100)]), transactions.map((t) => [t.st02, t.handling, t.method, t.payment]));
    assert.deepEqual(checkSpecimen835(text, { names: names(g) }), [], `${where}: specimen rules`);
    claims += transactions.reduce((n, t) => n + t.claims, 0);
  }
  assert.ok(files >= 300 && claims > 800 && errorsCaught > 50, `${files} files, ${claims} claims, ${errorsCaught} errors`);
});

test('an independent X12 reader parses every file and finds the test flag, the specimen contact and a payment record without bank data', async () => {
  for (const type of REMITTANCE_TYPES) for (const scenario of listScenarios(type)) {
    const { text } = await remittanceFor({ type, scenario, seed: 'x12-reader' });
    const segs = await new Promise((resolve, reject) => { const out = []; const p = new X12parser(); p.on('data', (s) => out.push(s)); p.on('error', reject); p.on('end', () => resolve(out)); Readable.from([text]).pipe(p); });
    const where = `${type}/${scenario}`;
    const isa = segs.find((s) => s.name === 'ISA'); assert.equal(isa['15'], 'T', where);
    assert.equal(segs.filter((s) => s.name === 'ST').length, segs.filter((s) => s.name === 'SE').length, where);
    for (const per of segs.filter((s) => s.name === 'PER')) { assert.equal(per['2'], SPECIMEN_STRINGS.technicalContactName, where); assert.equal(per['4'], SPECIMEN_STRINGS.technicalContactPhone, where); }
    for (const bpr of segs.filter((s) => s.name === 'BPR')) {
      for (let k = 5; k <= 15; k++) assert.ok(!bpr[String(k)], `${where}: BPR${String(k).padStart(2, '0')} carries a value`);
      assert.ok((bpr['1'] === 'I' && bpr['4'] === 'CHK') || (bpr['1'] === 'H' && bpr['4'] === 'NON'), where);
    }
    assert.ok(segs.filter((s) => s.name === 'N1' && s['1'] === 'PR').every((s) => /SPECIMEN/.test(s['2'])), where);
  }
});

test('the same request gives the same file, and the document itself does not change', async () => {
  const a = await remittanceFor({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'same' });
  const b = await remittanceFor({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'same' });
  assert.equal(a.text, b.text);
  const g = generateData({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'same' });
  assert.deepEqual(a.groundTruth.documents[0], g.groundTruth.documents[0], 'documents[0] untouched');
  assert.notEqual((await remittanceFor({ type: 'msn', scenario: 'duplicate-office-visit', seed: 'other' })).text, a.text);
});

test('the specimen checks refuse real-format identifiers and free text off the allow-list (negative tests)', async () => {
  const { text, groundTruth: g } = await remittanceFor({ type: 'ppo-eob', scenario: 'baseline-clean', seed: 'neg' });
  const ok = (t) => checkSpecimen835(t, { names: names(g) });
  assert.deepEqual(ok(text), []);
  const npi = g.documents[0].entities.providers[0].npi;
  // real-format values are computed here, so no such literal exists in the repository: an NPI with the first digit 1
  // and a valid check digit, and a Medicare number in the real format with no excluded letter
  const realNpi = ((body) => body + luhnCheckDigit('80840' + body))(['1', ...'23456789'].join(''));
  const realMbi = ['1', 'A', 'C', '2', 'C', 'C', '3', 'D', 'E', '4', '5'].join('');
  assert.ok(ok(text.replace(`*XX*${npi}~`, `*XX*${realNpi}~`)).some((p) => /NPI/.test(p)));
  assert.ok(ok(text.replace(/REF\*TJ\*00(\d{7})~/, 'REF*TJ*12$1~')).some((p) => /tax ID/.test(p)));
  assert.ok(ok(text.replace(/TRN\*1\*CS([0-9]+)\*/, 'TRN*1*$1*')).some((p) => /check number/.test(p)));
  assert.ok(ok(text.replace(/\*MI\*SPEC(\d{8})~/, `*MI*${realMbi}~`)).some((p) => /patient ID/.test(p)), 'a real-format Medicare number');
  assert.ok(ok(text.replace(/TRN\*1\*(CS[0-9]+)\*100/, 'TRN*1*$1*112')).some((p) => /payer tax ID/.test(p)));
  assert.ok(ok(text.replace(/N1\*PR\*([^*]+)\*XV\*CS/, 'N1*PR*$1*XV*')).some((p) => /payer ID/.test(p)));
  assert.ok(ok(text.replace(/CLP\*CS([0-9]{10})\*/, 'CLP*$1*')).some((p) => /CLP01/.test(p) || /patient control/.test(p)));
  assert.ok(ok(text.replace(/(CLP\*[^~]*\*16\*)CS([0-9]{10})~/, '$1$2~')).some((p) => /CLP07|payer claim/.test(p)));
  assert.ok(ok(text.replace(/NM1\*QC\*1\*[^*]+\*/, 'NM1*QC*1*SOMEONE*')).some((p) => /patient name/.test(p)));
  assert.ok(ok(text.replace(/GS\*HP\*[^*]+\*/, 'GS*HP*REALSENDER*')).some((p) => /GS sender/.test(p)));
  assert.ok(ok(text.replace(/CAS\*CO\*45\*/, 'CAS*CO*253*')).some((p) => /CAS02/.test(p)), 'a code outside the shipped set');
  assert.ok(ok(text.replace(/N1\*PE\*[^*]+\*/, 'N1*PE*SOME REAL CLINIC*')).some((p) => /allow-list/.test(p)));
  assert.ok(ok(text.replace('*T*>~', '*P*>~')).some((p) => /ISA15/.test(p)));
  assert.ok(ok(text.replace(/CLP\*CS(\d{10})\*/, 'CLP*CS$1*1*NOTE TEXT*')).some((p) => /free text/.test(p)));
});

test('no 835 for the itemized bill', () => {
  const generated = generateData({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'x' });
  assert.throws(() => buildRemittance({ type: 'itemized-bill', scenario: 'baseline-clean', seed: 'x', generated }), /no 835 for itemized-bill/);
});

test('parse835 reads only claimseed delimiters', () => {
  assert.deepEqual(parse835('ST*835*0001~\nSE*2*0001~'), [['ST', '835', '0001'], ['SE', '2', '0001']]);
});

// change one element of a file and expect the named check at the named place
const mutate = (text, re, repl) => { const out = text.replace(re, repl); assert.notEqual(out, text, `${re} matched nothing`); return out; };
const has = (text, check, ref) => check835(text).findings.some((f) => f.check === check && (ref === undefined || f.ref === ref));

test('each check fires on the change it guards against (negative tests on a clean file)', async () => {
  const { text } = await remittanceFor({ type: 'msn', scenario: 'baseline-clean', seed: 'neg-2' });
  assert.deepEqual(check835(text).findings, []);
  assert.ok(has(mutate(text, /(CLP\*CS[0-9]{10}\*1\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'claim-balance', '0001:CLP1:CLP03'));
  assert.ok(has(mutate(text, /(CLP\*CS[0-9]{10}\*1\*[0-9.]+\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'claim-balance', '0001:CLP1:CLP04'));
  assert.ok(has(mutate(text, /(CLP\*CS[0-9]{10}\*1\*[0-9.]+\*[0-9.]+\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'patient-responsibility', '0001:CLP1:CLP05'));
  assert.ok(has(mutate(text, /(SVC\*HC>[0-9A-Z]+\*[0-9.]+\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'service-balance', '0001:CLP1:SVC1'));
  assert.ok(has(mutate(text, /(CAS\*CO\*45\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'service-balance'));
  assert.ok(has(mutate(text, /(BPR\*I\*)([0-9.]+)/, (m, a, v) => a + (Number(v) + 1).toFixed(2)), 'transaction-balance'));
  assert.ok(has(mutate(text, /SE\*([0-9]+)\*0001/, (m, n) => `SE*${Number(n) + 1}*0001`), 'envelope'));
  assert.ok(has(mutate(text, /IEA\*1\*([0-9]{9})/, 'IEA*1*123456789'), 'envelope', 'ISA13/IEA02'));
  assert.ok(has(mutate(text, /GE\*([0-9]+)\*([0-9]+)~/, (m, n, c) => `GE*${n}*${Number(c) + 1}~`), 'envelope', 'GS/GE'));
  assert.ok(has(mutate(text, /GE\*([0-9]+)\*/, (m, n) => `GE*${Number(n) + 1}*`), 'envelope', 'GE01'));
  assert.ok(has(mutate(text, 'ISA*00*          *', 'ISA*00*         *'), 'envelope', 'ISA: not 106 characters'));
  assert.ok(has(mutate(text, '*T*>~', '*P*>~'), 'envelope', 'ISA15 is not T'));
  assert.ok(has(mutate(text, 'ST*835*0001~', 'ST*835*0001*005010X221A1~'), 'envelope', '0001:ST'));
  assert.ok(has(mutate(text, /BPR\*I\*([0-9.]+)\*C\*CHK\*/, 'BPR*I*$1*C*CHK*01*'), 'payment'));
  // the transactions' frames: every ST closed by its SE before the next ST or the GE, and the file terminated
  const lastSt = text.match(/ST\*835\*([0-9]+)~/g).pop().split('*')[2].replace('~', '');
  assert.ok(has(mutate(text, /\nSE\*[0-9]+\*0001~\n/, '\n'), 'envelope', '0001:SE'), 'the first transaction has no SE');
  assert.ok(has(mutate(text, /\nSE\*[0-9]+\*[0-9]+~\n(GE\*)/, '\n$1'), 'envelope', `${lastSt}:SE`), 'the last transaction has no SE');
  assert.ok(has(mutate(text, /(ST\*835\*0001~\n)/, 'ST*835*0009~\n$1'), 'envelope', '0009:SE'), 'a transaction opened inside another');
  assert.ok(has(mutate(text, /~\n$/, ''), 'envelope', 'ISA/IEA'), 'no final segment terminator');
  assert.ok(has(mutate(text, /(LX\*1~)/, '$1~'), 'envelope', 'ISA/IEA'), 'an empty segment');
  assert.ok(has(mutate(text, /(LX\*1~\n)/, '$1\n~\n'), 'envelope', 'ISA/IEA'), 'a blank line as a segment');
});

test("the specimen checks hold the file to the writer's segments, element counts, fixed values and order (negative tests)", async () => {
  const { text, groundTruth: g } = await remittanceFor({ type: 'msn', scenario: 'baseline-clean', seed: 'shape' });
  const ok = (t) => checkSpecimen835(t, { names: names(g) });
  assert.deepEqual(ok(text), []);
  const cases = [
    ['a second address line', /N3\*([^~]+)~/, 'N3*$1*FICTIONAL ADDRESS LINE~', 'N3 has an unexpected number of elements'],
    ['another state', /N4\*([^*]+)\*KS\*/, 'N4*$1*ZZ*', 'N402 does not hold its fixed value'],
    ['another ZIP code', /(N4\*[^*]+\*KS\*)00001~/, '$100002~', 'N403 does not hold its fixed value'],
    ['a second contact number', /(PER\*[^~]+)~/, '$1*TE*7855550199~', 'PER has an unexpected number of elements'],
    ['a contact qualifier other than TE', /(PER\*BL\*[^*]+\*)TE\*/, '$1EM*', 'PER03 does not hold its fixed value'],
    ['an empty charge', /(SVC\*HC>[0-9A-Z]{5})\*[0-9.]+\*/, '$1**', 'SVC02 is empty'],
    ['an empty charged total', /(CLP\*CS[0-9]{10}\*[14])\*[0-9.]+\*/, '$1**', 'CLP03 is empty'],
    ['no payer name segment', /N1\*PR\*[^~]+~\n/, '', "a transaction's segments are missing, extra or out of order"],
    ['no service date', /(SVC\*[^~]+~\n)DTM\*472\*[0-9]+~\n/, '$1', "a transaction's segments are missing, extra or out of order"],
    ['a segment the writer never writes', /(LX\*1~\n)/, '$1NTE*ADD*FICTIONAL NOTE~\n', 'file holds a segment the writer never writes'],
    ['an adjustment with no amount', /CAS\*CO\*45\*[0-9.]+~/, 'CAS*CO*45*~', 'CAS03 is empty'],
    ['an adjustment with a stray element', /(CAS\*CO\*45\*[0-9.]+)~/, '$1**1~', 'CAS has an unexpected number of elements'],
    ['another sender qualifier', 'ZZ*CLAIMSEEDTESTPY', '01*CLAIMSEEDTESTPY', 'ISA05 does not hold its fixed value'],
    ['another version', /GS\*HP\*([^~]+)\*005010X221A1~/, 'GS*HP*$1*005010X222A1~', 'GS08 does not hold its fixed value'],
    ['a payee qualifier other than XX', /(N1\*PE\*[^*]+\*)XX\*/, '$1FI*', 'N103 does not hold its fixed value'],
    ['an empty patient last name', /NM1\*QC\*1\*[^*]+\*/, 'NM1*QC*1**', 'NM103 is empty'],
    ['text in the interchange date', /^(ISA(?:\*[^*]*){8}\*)[0-9]{6}\*/, '$1CANARY*', 'ISA09 holds free text or an unexpected value'],
    ['text in the group date', /(GS\*HP\*[^*]+\*[^*]+\*)[0-9]{8}\*/, '$1CANARYXX*', 'GS04 holds free text or an unexpected value'],
    ['an empty allowed amount', /AMT\*B6\*[0-9.]+~/, 'AMT*B6*~', 'AMT02 is empty'],
    ['an adjustment with no group code', /CAS\*CO\*45\*/, 'CAS**45*', 'CAS01 is empty'],
    ['no trailer for the first transaction', /\nSE\*[0-9]+\*[0-9]+~\n/, '\n', "a transaction's segments are missing, extra or out of order"],
    ['no trailer for the last transaction', /\nSE\*[0-9]+\*[0-9]+~\n(GE\*)/, '\n$1', "a transaction's segments are missing, extra or out of order"],
    ['a transaction opened inside another', /(ST\*835\*0001~\n)/, 'ST*835*0009~\n$1', "a transaction's segments are missing, extra or out of order"],
    ['no final segment terminator', /~\n$/, '', 'file ends without a segment terminator'],
    ['an empty segment', /(LX\*1~)/, '$1~', "a transaction's segments are missing, extra or out of order"],
    ['a blank line as a segment', /(LX\*1~\n)/, '$1\n~\n', "a transaction's segments are missing, extra or out of order"],
    ['text after the last terminator', /~\n$/, '~\nFICTIONAL TRAILER', 'file ends without a segment terminator'],
    ['text in the group control number, matched in the GE', /(GS\*HP\*(?:[^*]+\*){4})([0-9]+)(\*X\*[^~]+~[\s\S]*GE\*[0-9]+\*)\2~/, '$1CANARY$3CANARY~', 'GS06 holds free text or an unexpected value'],
  ];
  for (const [what, re, repl, message] of cases) assert.ok(ok(mutate(text, re, repl)).includes(message), `${what}: ${JSON.stringify(ok(text.replace(re, repl)))}`);
});

test('a claim whose totals match its lines but whose own adjustments do not close the claim is reported once, at the claim', async () => {
  const { text } = await remittanceFor({ type: 'msn', scenario: 'baseline-clean', seed: 'claim-cas' });
  // one claim-level adjustment the totals do not account for (and the transaction's segment count kept right)
  const bad = mutate(mutate(text, /(NM1\*QC\*[^~]+~\n)/, '$1CAS*CO*45*1~\n'), /SE\*([0-9]+)\*0001/, (m, n) => `SE*${Number(n) + 1}*0001`);
  assert.deepEqual(check835(bad).findings, [{ check: 'claim-balance', ref: '0001:CLP1:CAS' }]);
});

test('a wrong charged or paid total fails the claim balance at the element the answer key names', async () => {
  for (const [field, element] of [['amountProviderCharged', 'CLP03'], ['amountMedicarePaid', 'CLP04'], ['maxYouMayBeBilled', 'CLP05']]) {
    const generated = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'totals', overrides: { mutations: [{ op: 'break-claim-total', args: { claim: 0, field, by: 10 }, kind: 'math-error', severity: 'high' }] } });
    const { text, groundTruth: g } = await remittanceFor({ type: 'msn', scenario: 'baseline-clean', seed: 'totals', generated });
    const e = g.errors[0]; assert.equal(e.x12Ref, `0001:CLP1:${element}`, field);
    // exactly one finding, at that element: a wrong charged total does not also report the paid total
    assert.deepEqual(check835(text).findings, [{ check: element === 'CLP05' ? 'patient-responsibility' : 'claim-balance', ref: e.x12Ref }], field);
  }
});

test('two claims of one payee share a transaction, and the file still balances', async () => {
  const generated = JSON.parse(JSON.stringify(generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'payee' })));
  generated.data._dateOfNotice = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'payee' }).data._dateOfNotice;
  const ps = generated.groundTruth.documents[0].entities.providers; assert.ok(ps.length >= 2);
  ps[1] = { ...ps[0] };   // the second claim's provider is the first's
  const { text, document } = buildRemittance({ type: 'msn', scenario: 'baseline-clean', seed: 'payee', generated });
  assert.deepEqual(check835(text).findings, []);
  assert.equal(document.transactions.length, ps.length - 1);
  assert.match(text, /LX\*1~\nCLP\*[^~]+~[\s\S]*?CLP\*[^~]+~[\s\S]*?SE\*[0-9]+\*0001~/, 'two CLP loops in transaction 0001');
});

test('every service in the catalog has the five-character code an SVC01 carries after HC', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(here, '../reference-data/service-catalog.json'), 'utf-8'));
  assert.ok(catalog.services.length > 0);
  for (const s of catalog.services) assert.match(s.code, /^[0-9A-Z]{5}$/, `${s.code}: a code the 835's SVC01 (HC>code) cannot carry`);
});
