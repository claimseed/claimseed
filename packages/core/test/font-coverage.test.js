// Every character that can reach a page (templates, stock content, scenarios, lexicon, generator strings) has a
// glyph in the bundled fonts, so nothing renders as a .notdef box; and the bundled font files are the ones the
// coverage table was generated from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cov = JSON.parse(fs.readFileSync(path.join(root, 'fonts/coverage.json'), 'utf-8'));
const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);
const covered = (cp) => Object.values(cov.families).some((r) => inRanges(cp, r));
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }

test('bundled font files match fonts/coverage.json', () => {
  let fsDir = root; for (let k = 0; k < 6 && !fs.existsSync(path.join(fsDir, 'node_modules/@fontsource')); k++) fsDir = path.dirname(fsDir);
  for (const [rel, sha] of Object.entries(cov.files)) {
    const p = path.join(fsDir, 'node_modules/@fontsource', rel);
    assert.ok(fs.existsSync(p), `missing font ${rel}`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), sha, `${rel} changed — rerun scripts/font-coverage.py`);
  }
});
test('every printable character in templates, stock, scenarios and generator strings has a glyph', () => {
  // data/public-sources/ are reference snapshots that are never rendered, so they are not subject to glyph coverage
  const files = [...walk(path.join(root, 'templates')), ...walk(path.join(root, 'data')).filter((f) => !f.includes(`${path.sep}public-sources${path.sep}`)), ...walk(path.join(root, 'scenarios')), ...walk(path.join(root, 'src/generate'))];
  const missing = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || cp === 0x7f) continue;
      if (!covered(cp) && !/\s/.test(ch)) missing.set(ch, path.relative(root, f));
    }
  }
  assert.deepEqual([...missing.entries()], [], 'characters without a bundled glyph (would render as boxes)');
});
