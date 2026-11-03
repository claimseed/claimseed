// Default-output guard: with no layout variant, every type prints exactly the HTML it printed before variants existed. The
// hardened HTML of every template part, for every published scenario of all four types at seeds 1-3, is hashed and
// compared with test/fixtures/html-guard.json (recorded at f1fa79b, before any template learned about variants). No
// browser: the render path runs in capture mode. CLAIMSEED_WRITE_HTML_GUARD=1 rewrites the fixture (only on purpose).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { generateData, listScenarios, RENDERERS } from '../src/index.js';
import { printHooks } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures/html-guard.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashes() {
  const out = {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guard-'));
  const quiet = console.log; console.log = () => {};
  try {
    for (const type of Object.keys(RENDERERS)) {
      const stock = JSON.parse(fs.readFileSync(path.join(here, `../data/${type}/stock-content.json`), 'utf-8'));
      for (const scenario of listScenarios(type)) for (const seed of ['1', '2', '3']) {
        const parts = []; printHooks.capture = (html) => parts.push(sha(html));
        try { await RENDERERS[type](generateData({ type, scenario, seed }).data, stock, work, { title: 't', band: 'b' }); } finally { printHooks.capture = null; }
        out[`${type}/${scenario}/${seed}`] = parts;
      }
    }
  } finally { console.log = quiet; fs.rmSync(work, { recursive: true, force: true }); }
  return out;
}

test('with no layout variant, every template part prints the same HTML as before variants (all four types)', async () => {
  const now = await hashes();
  if (process.env.CLAIMSEED_WRITE_HTML_GUARD === '1') fs.writeFileSync(FIXTURE, JSON.stringify({ note: 'sha256 of each hardened template part; recorded at f1fa79b', parts: now }, null, 1) + '\n');
  const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).parts;
  assert.deepEqual(Object.keys(now).sort(), Object.keys(want).sort(), 'the same documents');
  for (const k of Object.keys(want)) assert.deepEqual(now[k], want[k], `${k}: template HTML changed`);
  assert.ok(Object.values(want).flat().length > 300, 'parts hashed');
});
