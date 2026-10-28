// render({ browser }) uses the caller's browser for every page, leaves it open, and produces the same bytes as a
// render that launches its own browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { render, launchBrowser, findChrome } from '../src/index.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('a shared browser renders every type, stays open, and gives the same bytes as a private one', { skip, timeout: 240000 }, async () => {
  const browser = await launchBrowser();
  try {
    for (const type of ['msn', 'itemized-bill', 'ppo-eob', 'hmo-eob']) {
      const shared = await render({ type, scenario: 'baseline-clean', seed: 'shared-1', browser });
      assert.ok(browser.connected, `${type}: the shared browser was closed by render()`);
      assert.equal((await browser.pages()).length <= 1, true, `${type}: render() left pages open in the shared browser`);
      const own = await render({ type, scenario: 'baseline-clean', seed: 'shared-1' });
      assert.equal(sha(shared.bytes), sha(own.bytes), `${type}: shared-browser output differs from a private-browser render`);
      assert.equal(shared.groundTruth.documents[0].sha256, sha(shared.bytes));
    }
  } finally { await browser.close(); }
});
