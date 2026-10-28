// The workspace rules: server-chosen names, exclusive creation, no link followed, and quota clean-up that only ever
// deletes the server's own unchanged outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { openWorkspace, LEDGER } from '../src/workspace.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-ws-'));
const blob = (n, fill = 'a') => Buffer.alloc(n, fill);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const outputs = (dir) => fs.readdirSync(dir).filter((f) => f !== LEDGER).sort();

test('outputs get fresh server-chosen names inside the workspace and are listed in the ledger', () => {
  const dir = tmp(); const ws = openWorkspace(dir);
  const a = ws.save('msn_baseline-clean_s1', [{ ext: 'pdf', bytes: blob(300) }, { ext: 'ground-truth.json', bytes: blob(250, 'b') }]);
  const b = ws.save('msn_baseline-clean_s1', [{ ext: 'pdf', bytes: blob(300) }]);
  assert.notEqual(a.base, b.base);
  for (const p of Object.values(a.paths)) assert.equal(path.dirname(p), fs.realpathSync(dir));
  assert.match(path.basename(a.paths.pdf), /^msn_baseline-clean_s1_[0-9a-f]{12}\.pdf$/);
  assert.deepEqual(ws.usage(), { files: 3, bytes: 850 });
});

test('a stem that is not type_scenario_seed is refused before anything is written', () => {
  const dir = tmp(); const ws = openWorkspace(dir);
  for (const stem of ['../escape', 'a/b_c_d', 'msn_x', 'MSN_x_y']) assert.throws(() => ws.save(stem, [{ ext: 'pdf', bytes: blob(300) }]), /unexpected output name/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('over the quota, the oldest outputs go first, and only files still exactly as the server wrote them', () => {
  const dir = tmp(); const ws = openWorkspace(dir, { quotaBytes: 1000 });
  fs.writeFileSync(path.join(dir, 'my-notes.txt'), 'the user\'s own file');
  const first = ws.save('msn_baseline-clean_a', [{ ext: 'pdf', bytes: blob(400) }]);
  const second = ws.save('msn_baseline-clean_b', [{ ext: 'pdf', bytes: blob(400) }]);
  fs.appendFileSync(second.paths.pdf, ' edited by the user');   // no longer the server's bytes
  const third = ws.save('msn_baseline-clean_c', [{ ext: 'pdf', bytes: blob(400) }]);   // 1200 > 1000: evict the oldest
  assert.equal(fs.existsSync(first.paths.pdf), false, 'the oldest unchanged output was not removed');
  assert.equal(fs.existsSync(second.paths.pdf), true);
  const fourth = ws.save('msn_baseline-clean_d', [{ ext: 'pdf', bytes: blob(400) }]);   // evicts "second" from the ledger, but keeps the edited file
  assert.equal(fs.existsSync(second.paths.pdf), true, 'an output the user changed was deleted');
  assert.equal(fs.readFileSync(path.join(dir, 'my-notes.txt'), 'utf-8'), 'the user\'s own file');
  assert.ok(fs.existsSync(third.paths.pdf) && fs.existsSync(fourth.paths.pdf));
  assert.throws(() => ws.save('msn_baseline-clean_e', [{ ext: 'pdf', bytes: blob(1001) }]), /larger than the workspace quota/);
});

test('the file-count limit evicts the same way', () => {
  const dir = tmp(); const ws = openWorkspace(dir, { maxFiles: 3 });
  const saved = [1, 2, 3, 4, 5].map((i) => ws.save(`msn_baseline-clean_n${i}`, [{ ext: 'pdf', bytes: blob(300 + i) }]));
  assert.equal(outputs(dir).length, 3);
  assert.ok(!fs.existsSync(saved[0].paths.pdf) && !fs.existsSync(saved[1].paths.pdf) && fs.existsSync(saved[4].paths.pdf));
});

test('a planted ledger cannot make the server delete a file it did not write', () => {
  const dir = tmp(); const outside = tmp();
  const victim = path.join(dir, 'report.pdf'); fs.writeFileSync(victim, blob(500, 'r'));
  const victim2 = path.join(outside, 'msn_baseline-clean_x_000000000000.pdf'); fs.writeFileSync(victim2, blob(500, 'r'));
  const entries = [
    { name: 'report.pdf', bytes: 500, sha256: sha(blob(500, 'r')), at: 1 },
    { name: `../${path.basename(outside)}/msn_baseline-clean_x_000000000000.pdf`, bytes: 500, sha256: sha(blob(500, 'r')), at: 2 },
  ];
  fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ files: entries }));
  const ws = openWorkspace(dir, { quotaBytes: 600 });
  ws.save('msn_baseline-clean_y', [{ ext: 'pdf', bytes: blob(500) }]);
  assert.ok(fs.existsSync(victim) && fs.existsSync(victim2));
});

test('links are never followed: a linked ledger is ignored and replaced, and the workspace cannot be swapped for a link', () => {
  const dir = tmp(); const outside = tmp();
  const target = path.join(outside, 'precious.json'); fs.writeFileSync(target, '{"keep":true}');
  fs.symlinkSync(target, path.join(dir, LEDGER));
  const ws = openWorkspace(dir);
  ws.save('msn_baseline-clean_l', [{ ext: 'pdf', bytes: blob(300) }]);
  assert.equal(fs.readFileSync(target, 'utf-8'), '{"keep":true}', 'the write went through the link');
  assert.equal(fs.lstatSync(path.join(dir, LEDGER)).isSymbolicLink(), false);
  // move the workspace away and put a link to another folder in its place
  const real = fs.realpathSync(dir);
  fs.renameSync(real, real + '-moved'); fs.symlinkSync(outside, real);
  assert.throws(() => ws.save('msn_baseline-clean_m', [{ ext: 'pdf', bytes: blob(300) }]), /moved or replaced by a link/);
  assert.deepEqual(fs.readdirSync(outside), ['precious.json']);
});

test('the filesystem root and the home folder are refused as workspaces; a missing folder or a file too', () => {
  assert.throws(() => openWorkspace('/'), /refusing/);
  assert.throws(() => openWorkspace(os.homedir()), /refusing/);
  assert.throws(() => openWorkspace(path.join(tmp(), 'missing')), /does not exist/);
  const f = path.join(tmp(), 'f'); fs.writeFileSync(f, 'x');
  assert.throws(() => openWorkspace(f), /not a folder/);
  assert.throws(() => openWorkspace(''), /no workspace folder/);
});
