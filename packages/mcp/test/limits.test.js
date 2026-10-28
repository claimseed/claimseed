// Concurrency, queueing, cancellation, time limits and the shared browser's life cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createGate, withTimeout, createBrowserPool } from '../src/limits.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('at most `concurrency` jobs run; at most `maxQueue` wait; the rest are refused at once', async () => {
  const gate = createGate({ concurrency: 2, maxQueue: 1 });
  let now = 0; let peak = 0;
  const job = () => gate.run(async () => { now++; peak = Math.max(peak, now); await sleep(50); now--; return 'ok'; });
  const accepted = [job(), job(), job()];
  await assert.rejects(job(), /busy: 2 renders running and 1 waiting/);
  assert.deepEqual(await Promise.all(accepted), ['ok', 'ok', 'ok']);
  assert.equal(peak, 2);
  assert.equal(await job(), 'ok', 'the gate did not recover');
});

test('a cancelled request leaves the queue without running', async () => {
  const gate = createGate({ concurrency: 1, maxQueue: 2 });
  let ran = 0;
  const first = gate.run(async () => { await sleep(50); });
  const ac = new AbortController();
  const queued = gate.run(async () => { ran++; }, ac.signal);
  ac.abort();
  await assert.rejects(queued, /request cancelled/);
  await first; await sleep(10);
  assert.equal(ran, 0);
  assert.equal(gate.waiting, 0);
});

test('withTimeout rejects after the limit and stops the work; a late failure is not left unhandled', async () => {
  let stopped = false; let rejectLate;
  const job = new Promise((_, rej) => { rejectLate = rej; });
  await assert.rejects(withTimeout(job, 30, () => { stopped = true; }), /timed out after 30 ms/);
  assert.equal(stopped, true);
  rejectLate(new Error('target closed'));   // would crash the process if unhandled
  await sleep(10);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, () => {}), 7);
});

function fakeLauncher() {
  const launched = [];
  const launch = async () => {
    const b = new EventEmitter(); b.closed = false;
    b.close = async () => { b.closed = true; b.emit('disconnected'); };
    b.process = () => null;
    launched.push(b); return b;
  };
  return { launch, launched };
}

test('one browser is shared, replaced after kill(), and closed after an idle period', async () => {
  const { launch, launched } = fakeLauncher();
  const pool = createBrowserPool({ launch, idleMs: 40 });
  const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
  assert.equal(a, b); assert.equal(launched.length, 1);
  const gen = pool.generation;
  await pool.kill();
  assert.ok(a.closed); assert.equal(pool.generation, gen + 1);
  pool.release(); pool.release();
  const c = await pool.acquire();
  assert.notEqual(c, a); assert.equal(launched.length, 2);
  pool.release();
  await sleep(80);
  assert.ok(c.closed, 'the idle browser was not closed'); assert.equal(pool.open, false);
});

test('a browser that dies is replaced on the next render; a failed launch is reported and retried', async () => {
  const { launch, launched } = fakeLauncher();
  let fail = true;
  const pool = createBrowserPool({ launch: async () => { if (fail) { fail = false; throw new Error('No Chrome/Chromium found'); } return launch(); }, idleMs: 1000 });
  await assert.rejects(pool.acquire(), /No Chrome/);
  const a = await pool.acquire();
  a.emit('disconnected');   // crashed
  pool.release();
  const b = await pool.acquire();
  assert.notEqual(a, b); assert.equal(launched.length, 2);
  pool.release(); await pool.kill();
});
