// Chrome puts its singleton socket under TMPDIR, which the launcher points into a private folder in the system temp
// folder; a Unix socket path is at most 107 bytes on Linux, so that folder's own path must stay short. A system temp
// folder 50 characters long (longer than macOS's per-user one) must still launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { launchBrowser } from '../src/browser.js';

test('Chrome launches when the system temp folder path is 50 characters long', { skip: process.platform !== 'linux' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-t-'));
  const deep = path.join(base, 'x'.repeat(Math.max(1, 50 - base.length - 1)));
  fs.mkdirSync(deep);
  assert.equal(deep.length, 50);
  const saved = process.env.TMPDIR; process.env.TMPDIR = deep;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage(); await page.setContent('<p>ok</p>');
    assert.equal(await page.$eval('p', (e) => e.textContent), 'ok');
  } finally {
    if (browser) await browser.close();
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
