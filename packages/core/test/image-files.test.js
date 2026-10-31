// The container image is built from an allowlist (.dockerignore) that must hold what each npm package ships: a path
// in a package's "files" that the allowlist leaves out is missing from the image, and the server there fails to load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('the image allowlist holds every path the core and mcp packages ship', () => {
  const allowed = new Set(fs.readFileSync(path.join(root, '.dockerignore'), 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!')).map((l) => l.slice(1).replace(/\/$/, '')));
  for (const pkg of ['core', 'mcp']) {
    const files = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf-8')).files;
    assert.ok(files.length > 0);
    for (const f of [...files, 'package.json']) assert.ok(allowed.has(`packages/${pkg}/${f.replace(/\/$/, '')}`), `packages/${pkg}/${f} is published but not in .dockerignore's allowlist`);
  }
});
