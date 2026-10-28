// Limits on rendering: how many renders run at once, how many may wait, how long one may take, and the one shared
// browser they all use.

// At most `concurrency` jobs run at once and at most `maxQueue` wait; a job that cannot even wait is refused at
// once, and a waiting job whose request is cancelled leaves the queue.
export function createGate({ concurrency = 2, maxQueue = 4 } = {}) {
  let running = 0; const queue = [];
  const next = () => {
    while (running < concurrency && queue.length) { const w = queue.shift(); if (!w.dropped) { running++; w.go(); } }
  };
  return {
    get running() { return running; },
    get waiting() { return queue.filter((w) => !w.dropped).length; },
    async run(fn, signal) {
      if (signal?.aborted) throw new Error('request cancelled');
      if (running >= concurrency) {
        if (queue.filter((w) => !w.dropped).length >= maxQueue) throw new Error(`busy: ${running} renders running and ${maxQueue} waiting; try again shortly`);
        await new Promise((resolve, reject) => {
          const w = { go: resolve, dropped: false };
          queue.push(w);
          signal?.addEventListener('abort', () => { if (!w.dropped && queue.includes(w)) { w.dropped = true; reject(new Error('request cancelled')); } }, { once: true });
        });
      } else running++;
      try { return await fn(); } finally { running--; next(); }
    },
  };
}

// Resolve with the job, or reject after `ms` and run `onTimeout` (which stops the work: here, closing the browser).
// Once the limit has passed, the outcome is the timeout, even if stopping the work makes the job fail first.
export function withTimeout(job, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve().then(onTimeout).catch(() => {}).finally(() => reject(new Error(`render timed out after ${ms} ms`)));
    }, ms);
    job.then((v) => { if (!timedOut) { clearTimeout(timer); resolve(v); } },
      (e) => { if (!timedOut) { clearTimeout(timer); reject(e); } });   // a failure after the limit is absorbed here
  });
}

// One browser for the whole process, launched on first use and closed after `idleMs` without renders. kill() closes
// it at once (on a timeout or at shutdown); renders still using it then fail, and the next render launches a new
// one. `generation` changes on every kill, so a render can tell that it was cut short by someone else's timeout.
export function createBrowserPool({ launch, idleMs = 60000 }) {
  let current = null; let users = 0; let idle = null; let generation = 0;
  async function close(p) {
    const b = await p.catch(() => null);
    if (!b) return;
    await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000).unref())]);
    try { const proc = b.process?.(); if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch {}
  }
  const pool = {
    get generation() { return generation; },
    get open() { return current !== null; },
    async acquire() {
      clearTimeout(idle); idle = null; users++;
      if (!current) {
        const p = launch();
        current = p;
        p.then((b) => b.on?.('disconnected', () => { if (current === p) current = null; }), () => { if (current === p) current = null; });
      }
      try { return await current; } catch (e) { users--; throw e; }
    },
    release() {
      users = Math.max(0, users - 1);
      if (users === 0 && current) { clearTimeout(idle); idle = setTimeout(() => { if (users === 0) pool.kill(); }, idleMs); idle.unref(); }
    },
    async kill() {
      generation++;
      clearTimeout(idle); idle = null;
      const p = current; current = null;
      if (p) await close(p);
    },
  };
  return pool;
}
