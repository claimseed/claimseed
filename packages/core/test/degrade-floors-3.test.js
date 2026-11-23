// Every degraded preset of the commercial EOB, both insurers: the markers on every page and file, the watermark above its floors (test/degrade-floors.js).
import { test, before, after } from 'node:test';
import { launchBrowser, findChrome } from '../src/index.js';
import { degradedFloors } from './degrade-floors.js';

const skip = !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI';
let browser;
before(async () => { if (!skip) browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test('every preset of the commercial EOB, both insurers: the band and the watermark on top of every degraded page, above their floors on the page and its image, and the markers on every file', { skip, timeout: 600000 }, async () => {
  await degradedFloors(browser, [['commercial-eob', 'baseline-clean', { insurer: 'a' }], ['commercial-eob', 'baseline-clean', { insurer: 'b' }]]);
});
