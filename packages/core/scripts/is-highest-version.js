#!/usr/bin/env node
// is-highest-version.js — may a release move the `latest` tag? Prints `latest` when VERSION is a release (no
// pre-release part) and no released tag in the list is higher by semver, `hold` otherwise (a pre-release, or an older
// line patched after a newer one), and exits 0; the decision is read from stdout, so a script that fails to run (any
// non-zero exit) can never pass for either answer. Exits 2 on a version or tag that is not semver, naming the tag.
//   node packages/core/scripts/is-highest-version.js 0.5.0 $(git tag -l 'v[0-9]*')
// Tags are read as v<semver>; pre-release tags (v1.0.0-rc.1) never count as released. The tags that exist decide, not
// what was published: a stray or failed higher tag holds latest until it is deleted. Semver is read strictly (2.0.0):
// no leading zeros in a number or a numeric pre-release identifier, no empty identifier, numbers no larger than a
// script can hold exactly. Every tag is read before anything is decided, so one that is not semver always stops it.
import { isMain as runAsScript } from './lib/is-main.js';
// run as a script (not imported by a test)
const isMain = runAsScript(import.meta.url);
const NUM = '0|[1-9][0-9]*'; const PRE_ID = `(?:${NUM}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`; const BUILD_ID = '[0-9A-Za-z-]+';
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`);
export function parse(v) {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: m[4] || null };
}
const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
/** true when `version` is a release and no released tag is higher; throws on input that is not semver */
export function isHighest(version, tags) {
  const v = parse(version); if (!v) throw new Error(`version ${JSON.stringify(String(version).slice(0, 64))} is not semver`);
  const read = tags.map((t) => {
    if (!/^v/.test(t)) throw new Error(`tag ${JSON.stringify(String(t).slice(0, 64))} does not start with v`);
    const p = parse(t.slice(1)); if (!p) throw new Error(`tag ${JSON.stringify(t.slice(0, 64))} is not semver`);
    return p;
  });
  return !v.pre && !read.some((p) => !p.pre && cmp(p, v) > 0);
}
if (isMain) {
  const [version, ...tags] = process.argv.slice(2);
  try { console.log(isHighest(version, tags) ? 'latest' : 'hold'); } catch (e) { console.error(`is-highest-version: ${e.message}`); process.exit(2); }
}
