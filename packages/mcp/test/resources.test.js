// The documents the server serves are packaged copies of the repository's own; they must not drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { RESOURCE_SOURCES } from '../scripts/sync-resources.js';
import { RENDERERS } from '@claimseed/core';
import { DOCUMENT_TYPES } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('resources/ holds byte-identical copies of the repository documents (npm run sync-resources)', () => {
  assert.deepEqual(fs.readdirSync(path.resolve(here, '../resources')).sort(), Object.keys(RESOURCE_SOURCES).sort());
  for (const [name, src] of Object.entries(RESOURCE_SOURCES)) {
    const copy = fs.readFileSync(path.resolve(here, '../resources', name));
    const orig = fs.readFileSync(path.resolve(here, '../scripts', src));
    assert.ok(copy.equals(orig), `resources/${name} differs from its original; run npm run sync-resources`);
  }
});

test('every renderable type has a listing entry', () => {
  assert.deepEqual(Object.keys(DOCUMENT_TYPES).sort(), Object.keys(RENDERERS).sort());
});
