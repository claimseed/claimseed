// What ships, checked as a class (scripts/check-release-ready.js): every layout's data folder and every top-level data
// file the source names is in the core package's files and in the image's allowlist, and the image holds everything
// the package ships. A planted gap of each kind fails; the repository as it stands passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path'; import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { packagingProblems, dataFilesNamed } from '../scripts/check-release-ready.js';
import { RENDERERS } from '../src/layouts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf-8'));
const dockerignore = fs.readFileSync(path.join(core, '../../.dockerignore'), 'utf-8');
const types = Object.keys(RENDERERS);

test('the core package and the image hold every layout\'s data and every data file the source names', () => {
  const dataFiles = dataFilesNamed(core);
  assert.ok(dataFiles.includes('layout-variants.json') && dataFiles.includes('ma-operations.json'), `data files named in src: ${dataFiles}`);
  assert.deepEqual(packagingProblems({ files: pkg.files, dockerignore, types, dataFiles }), []);
});

test('a layout folder, a data file or a shipped entry left out of either list is reported', () => {
  const dataFiles = dataFilesNamed(core);
  const without = (list, x) => list.filter((f) => f !== x);
  const plants = [
    [{ files: without(pkg.files, 'data/hmo-eob') }, /data\/hmo-eob is not in the core package's files/],
    [{ dockerignore: dockerignore.replace('!packages/core/data/itemized-bill\n', '') }, /data\/itemized-bill is not in \.dockerignore's allowlist/],
    [{ files: without(pkg.files, 'data/layout-variants.json') }, /data\/layout-variants\.json is not in the core package's files/],
    [{ dockerignore: dockerignore.replace('!packages/core/data/layout-variants.json\n', '') }, /data\/layout-variants\.json is not in \.dockerignore's allowlist/],
    [{ files: [...pkg.files, 'docs'] }, /docs ships in the npm package but not in the image/],
    [{ types: [...types, 'part-d-eob'] }, /data\/part-d-eob is not in the core package's files/],
  ];
  for (const [change, msg] of plants) {
    const p = packagingProblems({ files: pkg.files, dockerignore, types, dataFiles, ...change });
    assert.ok(p.some((m) => msg.test(m)), `${msg}: ${p.join('; ')}`);
  }
});

test('latest moves only to the highest release: is-highest-version on planted tag lists', async () => {
  const { isHighest } = await import('../scripts/is-highest-version.js');
  const tags = ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.3.1', 'v0.4.0'];
  assert.equal(isHighest('0.5.0', [...tags, 'v0.5.0']), true, 'a new highest release');
  assert.equal(isHighest('0.4.1', [...tags, 'v0.5.0', 'v0.4.1']), false, 'a patch on an older line');
  assert.equal(isHighest('0.4.0', tags), true, 'a re-run of the highest');
  assert.equal(isHighest('0.6.0-rc.1', [...tags, 'v0.6.0-rc.1']), false, 'a pre-release');
  assert.equal(isHighest('0.4.1-rc.1', [...tags, 'v0.5.0', 'v0.4.1-rc.1']), false, 'an older pre-release with a higher release present');
  assert.equal(isHighest('0.5.0', [...tags, 'v0.6.0-rc.1']), true, 'a higher pre-release does not count');
  assert.equal(isHighest('0.5.0', [...tags, 'v0.5.0+build.7']), true, 'build metadata: the same version, not a higher one');
  assert.equal(isHighest('0.4.1', [...tags, 'v0.5.0+build.7']), false, 'build metadata: a higher release still counts');
  assert.equal(isHighest('0.10.0', [...tags, 'v0.9.0']), true, 'numeric, not text, order');
  assert.equal(isHighest('0.9.0', [...tags, 'v0.10.0']), false);
  assert.equal(isHighest('1.0.0', ['v0.99.99']), true);
  for (const [v, t] of [['0.5', []], ['v0.5.0', []], ['0.5.0', ['0.4.0']], ['0.5.0', ['v0.4']], ['0.5.0', ['vfoo']]]) assert.throws(() => isHighest(v, t), undefined, `${v} ${t}`);
});

test('is-highest-version reads semver strictly, and reads every tag before it decides', async () => {
  const { isHighest, parse } = await import('../scripts/is-highest-version.js');
  // what semver 2.0.0 allows, including the forms that look odd
  for (const v of ['0.0.0', '1.0.0-0', '1.0.0-0a', '1.0.0-rc.1', '1.0.0-x-y.7.z', '1.0.0--', '1.0.0+001', '1.0.0-alpha+build.1.2', '9007199254740991.0.0']) assert.ok(parse(v), v);
  // and what it does not: leading zeros, empty identifiers, characters outside the set, numbers past exact integers
  const bad = ['01.0.0', '0.01.0', '0.0.01', '0.6.0-01', '0.6.0-rc.01', '0.6.0-00', '0.6.0-', '0.6.0-..', '0.6.0-rc.', '0.6.0-.rc', '0.6.0-rc..1',
    '0.6.0+', '0.6.0+a..b', '0.6.0+.a', '0.6.0-rc_1', '0.6.0 ', ' 0.6.0', '0.6.0\n', '99999999999999999999.0.0', '9007199254740992.0.0', '0.6', '0.6.0.1', ''];
  for (const v of bad) {
    assert.equal(parse(v), null, JSON.stringify(v));
    assert.throws(() => isHighest(v, []), /is not semver/, `version ${JSON.stringify(v)}`);
    assert.throws(() => isHighest('0.5.0', [`v${v}`]), /is not semver/, `tag v${JSON.stringify(v)}`);
  }
  // a tag that is not semver stops the decision wherever it stands in the list, after a higher release too
  for (const tags of [['v0.6.0', 'v1.0'], ['v1.0', 'v0.6.0'], ['v0.4.0', 'v0.6.0', 'v0.6.0-01'], ['v0.6.0-rc.1', 'vfoo'], ['v2.0.0', 'release']]) {
    assert.throws(() => isHighest('0.5.0', tags), /is not semver|does not start with v/, tags.join(' '));
    assert.throws(() => isHighest('0.5.0-rc.1', tags), /is not semver|does not start with v/, `a pre-release, ${tags.join(' ')}`);
  }
});

test('a script started through a symlinked folder or without its extension runs; none of them exits quietly as if imported', () => {
  const root = path.join(core, '../..');
  // every script that runs only when started decides that with lib/is-main.js, never by comparing the path itself
  const scripts = ['packages/core/scripts', 'packages/mcp/scripts'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  const guarded = scripts.filter((f) => /isMain|argv\[1\]|import\.meta\.main/.test(fs.readFileSync(path.join(root, f), 'utf-8')));
  assert.ok(guarded.length >= 5, guarded.join(' '));
  for (const f of guarded) {
    const src = fs.readFileSync(path.join(root, f), 'utf-8');
    assert.match(src, /from '(\.\/|\.\.\/\.\.\/core\/scripts\/)lib\/is-main\.js'/, `${f} uses lib/is-main.js`);
    assert.doesNotMatch(src, /process\.argv\[1\]|pathToFileURL\(process/, `${f} compares the started path itself`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-link-'));
  try {
    const link = path.join(tmp, 'checkout'); fs.symlinkSync(root, link, 'dir');
    const run = (file, ...args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf-8' });
    let r = run(path.join(link, 'packages/core/scripts/is-highest-version.js'), '0.5.0', 'v0.4.0');
    assert.deepEqual([r.status, r.stdout], [0, 'latest\n'], `through a symlink: ${r.stderr}`);
    r = run(path.join(core, 'scripts/is-highest-version'), '0.5.0', 'v0.6.0');
    assert.deepEqual([r.status, r.stdout], [0, 'hold\n'], `without the extension: ${r.stderr}`);
    r = run(path.join(link, 'packages/core/scripts/is-highest-version'), '0.5');
    assert.equal(r.status, 2, `both: ${r.stdout}`);
    r = run(path.join(link, 'packages/core/scripts/verify-synthetic-npi.js'));
    assert.deepEqual([r.status, r.stdout.trim()], [0, 'verify-synthetic-npi: ok'], `through a symlink: ${r.stderr}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('is-highest-version as the workflow runs it: the answer on stdout with exit 0, exit 2 naming a tag that is not semver', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(core, 'scripts/is-highest-version.js'), ...args], { encoding: 'utf-8' });
  for (const [args, answer] of [[['0.5.0', 'v0.4.0', 'v0.5.0'], 'latest'], [['0.4.1', 'v0.5.0', 'v0.4.1'], 'hold'], [['0.6.0-rc.1', 'v0.5.0'], 'hold'], [['0.5.0'], 'latest']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`); assert.equal(r.stdout, `${answer}\n`, args.join(' '));
  }
  for (const [args, named] of [[['0.5.0', 'v0.4.0', 'v1.0'], '"v1.0" is not semver'], [['0.5.0', 'release-1'], '"release-1" does not start with v'], [['0.5'], 'version "0.5" is not semver'], [[], 'is not semver'],
    [['0.5.0', 'v0.6.0-01'], '"v0.6.0-01" is not semver'], [['0.5.0', 'v0.6.0-..'], '"v0.6.0-.." is not semver'], [['0.5.0', 'v1.0'], '"v1.0" is not semver'],
    [['0.6.0-01', 'v0.5.0'], 'version "0.6.0-01" is not semver'], [['0.6.0-..'], 'version "0.6.0-.." is not semver'], [['0.5.0', 'v0.6.0', 'v1.0'], '"v1.0" is not semver'],
    [['0.5.0', 'v0.6.0', 'v0.7.0-01'], '"v0.7.0-01" is not semver'], [['0.5.0', 'v99999999999999999999.0.0'], 'is not semver']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args}`); assert.equal(r.stdout, '', `${args}: an answer was printed`); assert.ok(r.stderr.includes(named), `${args}: ${r.stderr}`);
  }
});

test('the release workflow: no token, every publish tagged, latest only in a latest) arm on is-highest-version\'s answer (0.4.0\'s workflow fails)', async () => {
  const { releaseWorkflowProblems } = await import('../scripts/check-release-ready.js');
  const now = fs.readFileSync(path.join(core, '../../.github/workflows/release.yml'), 'utf-8');
  assert.deepEqual(releaseWorkflowProblems(now), []);
  const old = releaseWorkflowProblems(fs.readFileSync(path.join(here, 'fixtures/release-0.4.0.yml'), 'utf-8'));
  assert.ok(old.some((m) => /NODE_AUTH_TOKEN/.test(m)) && old.some((m) => /a secret other than GITHUB_TOKEN/.test(m)) && old.filter((m) => /without is-highest-version/.test(m)).length === 3, old.join('; '));
  const unguarded = now.replace(/^.*is-highest-version\.js.*\n/gm, '');
  assert.equal(releaseWorkflowProblems(unguarded).length, 3, 'each latest without its decision');
  const once = (from, to) => { assert.ok(now.includes(from), `plant: ${from}`); return now.replace(from, to); };
  const publish = 'npm stage publish --provenance --access public --tag "$tag"';
  const arm = 'case "$d" in latest) tag=latest ;;';
  const image = 'case "$d" in latest) docker tag claimseed-mcp "$image:latest" && docker push "$image:latest" ;; hold) ;; *) exit 1 ;; esac';
  const plants = [
    [now + '      - uses: docker/build-push-action@0000000000000000000000000000000000000000 # v6\n        with: { push: true, tags: "ghcr.io/o/claimseed-mcp:latest" }\n', /line \d+: latest is set without/, 'a - uses: step after the decision step'],
    [now + '  retag:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm dist-tag add @claimseed/core@0.5.0 latest\n', /line \d+: latest is set without/, 'npm dist-tag add in a new job'],
    [now + '  retag:\n    env:\n      TAG: latest\n', /line \d+: latest is set without/, 'a job-level env'],
    [once(publish, 'npm stage publish --provenance --access public'), /npm publish without --tag "\$tag"/, 'the tag dropped'],
    [once(publish, 'npm stage publish --provenance --access public --tag=latest'), /latest is set without/, '--tag=latest outside the arm'],
    [once(publish, 'npm stage publish --provenance --access public --tag "latest"'), /latest is set without/, '--tag "latest"'],
    [once(arm, 'tag=latest; case "$d" in latest) ;;'), /latest is set without/, 'latest set before the case'],
    [once(image, image.replace('case "$d"', 'case "$v"')), /latest is set without/, 'a case on another variable'],
    [once(image, image.replace('*) exit 1 ;; ', '*) ;; ')), /latest is set without/, 'no *) exit 1 arm'],
    [now.replace(/\)" \|\| exit 1/g, ')"'), /latest is set without/, 'the decision without || exit 1'],
    [once('environment: npm', 'environment: npm\n    env: { NODE_AUTH_TOKEN: x }'), /names NODE_AUTH_TOKEN/, 'env: NODE_AUTH_TOKEN'],
    [once('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GITHUB_TOKEN: ${{ secrets.NPM_TOKEN }}'), /a secret other than GITHUB_TOKEN/, 'secrets.NPM_TOKEN'],
    [once('      - run: npm install -g npm@11.21.0\n', '      - run: npm install -g npm@11.21.0\n      - run: echo "//registry.npmjs.org/:_authToken=x" >> ~/.npmrc\n'), /names an npm _auth setting/, 'an _authToken line'],
    [once('      - run: npm install -g npm@11.21.0\n', '      - run: npm install -g npm@11.21.0\n      - run: npm config set //registry.npmjs.org/:_auth abc\n'), /names an npm _auth setting/, 'an _auth line'],
    [once(publish, publish + ' --userconfig ./publish.rc'), /names an npm config file/, '--userconfig'],
    [once(image, image.replace('case "$d" in latest)', 'case "$d" in hold|latest)')), /latest is set without/, 'latest inside an alternation arm'],
    [once(image, image.replace('hold) ;;', '*|latest) docker push "$image:latest" ;; hold) ;;')), /latest is set without/, 'a second, alternation arm'],
    [now.replace(/is-highest-version\.js "\$v"/g, 'is-highest-version.js 99.0.0'), /latest is set without/, 'the decision on a fixed version'],
    [now.replace(/ \$\(git tag -l 'v\[0-9\]\*'\)\)"/g, ')"'), /latest is set without/, 'the decision without the tags'],
    [once('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', "GITHUB_TOKEN: ${{ secrets['NPM_TOKEN'] }}"), /a secret other than GITHUB_TOKEN/, 'secrets[...]'],
    [once('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          ALL: ${{ toJSON(secrets) }}'), /a secret other than GITHUB_TOKEN/, 'toJSON(secrets)'],
    [once('environment: npm', 'environment: npm\n    env: { NPM_CONFIG__AUTH: x }'), /names an npm auth setting/, 'NPM_CONFIG__AUTH'],
  ];
  for (const [text, msg, what] of plants) {
    const p = releaseWorkflowProblems(text);
    assert.ok(p.some((m) => msg.test(m)), `${what}: ${p.join('; ') || 'nothing reported'}`);
  }
});
