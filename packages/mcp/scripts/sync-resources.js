#!/usr/bin/env node
// Copy the repository documents the server serves as resources into resources/ (they ship in the npm package; the
// repository copies are the originals). test/resources.test.js fails while the copies differ.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const RESOURCE_SOURCES = {
  'ground-truth.schema.json': '../../../schemas/ground-truth.schema.json',
  'extractor-output.schema.json': '../../../schemas/extractor-output.schema.json',
  'error-taxonomy.md': '../../../docs/error-taxonomy.md',
  'synthetic-data-policy.md': '../../../docs/synthetic-data-policy.md',
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, src] of Object.entries(RESOURCE_SOURCES)) {
    fs.copyFileSync(path.resolve(here, src), path.resolve(here, '../resources', name));
    console.log(`resources/${name} <- ${path.relative(path.resolve(here, '../../..'), path.resolve(here, src))}`);
  }
}
