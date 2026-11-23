// Every string of data/pair.json is read by the code, so none sits unused (and unreviewed) in the package. Each section
// is read through its own accessors, written out here, and only in the files where pair.json's object is in scope: a
// key name met anywhere else (another strings file, a template given other labels) does not count. The commercial
// statement's titles are read by the statement kind, so their keys must be exactly the kinds the code maps payees to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { PAIR_STRINGS, STATEMENT_KIND } from '../src/generate/provider-statement.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf-8');
// the files that hold pair.json's object (or the labels it is rendered with)
const SRC = ['src/generate/provider-statement.js', 'src/generate/index.js', 'src/index.js', 'src/batch.js', 'src/cli.js', 'src/verify.js', '../mcp/src/server.js'].map(read).join('\n');
const STATEMENT = read('templates/provider-statement/statement.html') + read('src/render.js');
const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACCESSORS = {
  labels: (k) => [[STATEMENT, `\\blabels\\.${esc(k)}\\b`]],
  messages: (k) => [[SRC, `\\b(?:pairMessage|refuse)\\(\\s*'${esc(k)}'`], [SRC, `\\bPAIR_STRINGS\\.messages\\.${esc(k)}\\b`]],
  rules: (k) => [[SRC, `\\b(?:RULES|rules)\\.${esc(k)}\\b`]],
  commercialRules: (k) => [[SRC, `\\b(?:RULES|commercialRules)\\.${esc(k)}\\b`]],
  mcp: (k) => [[SRC, `\\bPAIR_TEXT\\.${esc(k)}\\b`]],
  // the schema's descriptions are copied into schemas/ground-truth.schema.json, which a test holds to these strings
  schema: (k) => [[read('test/blind.test.js'), `\\bschema\\.${esc(k)}\\b`]],
};

test('every string of data/pair.json is read where pair.json is in scope', () => {
  const unused = [];
  for (const [section, value] of Object.entries(PAIR_STRINGS)) {
    if (section === 'note') continue;
    if (section === 'commercialStatement') {
      assert.deepEqual(Object.keys(value.titles).sort(), [...new Set(Object.values(STATEMENT_KIND))].sort(), 'the titles are the statement kinds');
      assert.deepEqual(Object.keys(value).sort(), ['groupWord', 'titles']);
      if (!/\bcommercialStatement\.groupWord\b/.test(SRC)) unused.push('commercialStatement.groupWord');
      continue;
    }
    assert.ok(ACCESSORS[section], `no accessor written for section ${section}`);
    for (const key of Object.keys(value)) if (!ACCESSORS[section](key).some(([text, re]) => new RegExp(re).test(text))) unused.push(`${section}.${key}`);
  }
  assert.deepEqual(unused, []);
});
