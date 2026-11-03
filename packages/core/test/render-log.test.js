// The render log: every stamped PDF appends a line when CLAIMSEED_RENDER_LOG is set, and the test scripts check the
// counts against test/render-budget.json and the caps (scripts/test-with-render-log.js). No browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs, finalizePdf } from '../src/render.js';
import { countLog, checkCounts, checkCaps, CAPS, logDir, runLogFile, countsFile } from '../scripts/test-with-render-log.js';
import { repoRoot } from '../scripts/lib/repo-root.js';

test('mergePdfs and finalizePdf each append one line to the render log, and nothing without the variable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rlog-'));
  const outer = process.env.CLAIMSEED_RENDER_LOG;
  try {
    const blank = path.join(dir, 'b.pdf'); const doc = await PDFDocument.create(); doc.addPage([612, 792]); fs.writeFileSync(blank, await doc.save());
    const log = path.join(dir, 'log.txt'); process.env.CLAIMSEED_RENDER_LOG = log;
    await mergePdfs([blank], path.join(dir, 'm.pdf'));
    fs.copyFileSync(blank, path.join(dir, 's.pdf')); await finalizePdf(path.join(dir, 's.pdf'));
    fs.copyFileSync(blank, path.join(dir, 'd.pdf')); await finalizePdf(path.join(dir, 'd.pdf'), { degraded: true });
    assert.deepEqual(countLog(fs.readFileSync(log, 'utf-8')), { render: 1, degraded: 1, single: 1 });
    delete process.env.CLAIMSEED_RENDER_LOG; fs.rmSync(log);
    await mergePdfs([blank], path.join(dir, 'm2.pdf'));
    assert.equal(fs.existsSync(log), false, 'no log without the variable');
  } finally {
    if (outer === undefined) delete process.env.CLAIMSEED_RENDER_LOG; else process.env.CLAIMSEED_RENDER_LOG = outer;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a render the budget does not list fails the check, as does a total over the caps or an unknown line', () => {
  const budget = { render: 3, degraded: 1, single: 0 };
  assert.deepEqual(checkCounts(countLog('render\nrender\nrender\ndegraded\n'), budget), []);
  assert.equal(checkCounts(countLog('render\nrender\nrender\nrender\ndegraded\n'), budget).length, 1, 'one planted extra render');
  assert.equal(checkCounts(countLog('render\nrender\ndegraded\n'), budget).length, 1, 'one render fewer');
  assert.deepEqual(checkCaps({ render: CAPS.render, degraded: CAPS.degraded, single: 0 }), []);
  assert.equal(checkCaps({ render: CAPS.render + 1, degraded: 0, single: 0 }).length, 1);
  assert.equal(checkCaps({ render: 0, degraded: CAPS.degraded + 1, single: 0 }).length, 1);
  assert.throws(() => countLog('render\nsomething\n'), /unknown line kind/);
});

test('the log of a run is its own file in the checkout, outside node_modules (a linked node_modules is shared)', () => {
  const d = logDir(); assert.equal(path.dirname(d), repoRoot()); assert.ok(!d.split(path.sep).includes('node_modules'));
  assert.equal(path.dirname(runLogFile('core')), d); assert.match(path.basename(runLogFile('core')), new RegExp(`^run-core-${process.pid}-\\d+\\.txt$`));
  assert.equal(countsFile('mcp'), path.join(d, 'counts-mcp.json'));
  assert.ok(fs.readFileSync(path.join(repoRoot(), '.gitignore'), 'utf-8').split('\n').includes('.tmp-*/'), 'the folder is ignored by git');
});
