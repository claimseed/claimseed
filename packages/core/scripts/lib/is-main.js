// Is the module at `url` the script node was started with (and not a module a test imports)? node finds its script
// the way require does: the path as given or with an extension added, then through any symlink. The same lookup is
// done here and both sides compared as real paths, so a script started by a path without its extension, through a
// symlinked folder (/tmp on macOS) or from a folder whose name has a space runs; it never exits quietly as if
// imported.
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module'; import { fileURLToPath } from 'url';
export function isMain(url) {
  const arg = process.argv[1]; if (!arg) return false;
  let started; try { started = createRequire(url).resolve(path.resolve(arg)); } catch { return false; }
  return fs.realpathSync(started) === fs.realpathSync(fileURLToPath(url));
}
