// Locate the claimseed repository root (the directory holding the workspace package.json) by walking up from this
// file. The repository checks (check-synthetic, check-release-ready) scan the whole repository, so they refuse to run
// from an installed copy of the package, where the parent directories are node_modules, not the repository.
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
export function repoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let k = 0; k < 8; k++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try { const j = JSON.parse(fs.readFileSync(pj, 'utf-8')); if (Array.isArray(j.workspaces) && j.name === 'claimseed-monorepo') return dir; } catch { /* not it */ }
    }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  console.error('this check scans the claimseed repository; run it from a checkout, not from an installed package');
  process.exit(2);
}
