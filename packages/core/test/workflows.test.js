// The CI and release workflows, read as text (scripts/check-release-ready.js, workflowProblems): the release runs the
// same tests.yml CI runs; nothing after the tests can run unless every shard and part passed; nothing in tests.yml can
// be skipped or let a failure pass; every job has a time limit; ci-ok fails unless every job succeeded. Each rule is
// shown to fail on a planted change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
import { workflowProblems, workflowJobs, folderProblems } from '../scripts/check-release-ready.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = (f) => fs.readFileSync(path.join(here, '../../../.github/workflows', f), 'utf-8');
const real = { ci: wf('ci.yml'), tests: wf('tests.yml'), release: wf('release.yml') };
const sub = (text, from, to) => { assert.ok(text.includes(from), `anchor moved: ${from.slice(0, 60)}`); return text.replace(from, to); };

test('the shipped workflows pass every rule', () => {
  assert.deepEqual(workflowProblems(real), []);
  assert.deepEqual(Object.keys(workflowJobs(real.tests)), ['plan', 'test', 'rendered']);
  assert.deepEqual(Object.keys(workflowJobs(real.release)), ['gates', 'tests', 'publish-core', 'publish-mcp', 'image']);
});

test('each rule fails on a planted change', () => {
  const shard = '        run: node packages/core/scripts/test-with-render-log.js --shard "$((INDEX + 1))/$TOTAL"';
  const examples = '        run: node packages/core/scripts/examples.js --check --part "$((INDEX + 1))/$TOTAL"';
  const plants = [
    // the pin: any edit, however it is written, changes the file
    ['tests', (t) => t.replace('jobs:\n', '# a comment is an edit too\njobs:\n'), /^tests\.yml is not the reviewed file/],
    // release.yml: every job after the tests needs gates and tests, and nothing runs past a failure
    ['release', (t) => sub(t, '  publish-core:\n    needs: [gates, tests]', '  publish-core:\n    needs: [gates]'), /the publish-core job must need both gates and tests/],
    ['release', (t) => sub(t, "    needs: [gates, tests]\n    if: vars.PUBLISH_IMAGE", "    needs: gates\n    if: vars.PUBLISH_IMAGE"), /the image job must need both gates and tests/],
    ['release', (t) => sub(t, "    needs: [gates, tests]\n    if: vars.PUBLISH_IMAGE", "    needs:\n      - gates\n      - tests\n    if: vars.PUBLISH_IMAGE"), /the image job must need both gates and tests \(written inline/],
    ['release', (t) => sub(t, "    if: vars.PUBLISH_IMAGE == 'true'", "    if: always() && vars.PUBLISH_IMAGE == 'true'"), /release\.yml: line \d+ uses a status function/],
    ['release', (t) => sub(t, '  publish-core:\n    needs: [gates, tests]\n', '  publish-core:\n    needs: [gates, tests]\n    if: "!success()"\n'), /release\.yml: line \d+ uses a status function/],
    ['release', (t) => sub(t, '  publish-core:\n    needs: [gates, tests]\n', "  publish-core:\n    needs: [gates, tests]\n    if: github.ref != ''\n"), /release\.yml: line \d+ has an if: this file may not hold/],
    ['release', (t) => sub(t, '    uses: ./.github/workflows/tests.yml', '    uses: ./.github/workflows/tests.yml\n    secrets: inherit'), /release\.yml: line \d+ passes every secret on/],
    ['release', (t) => sub(t, '    uses: ./.github/workflows/tests.yml', '    uses: ./.github/workflows/tests.yml\n    permissions:\n      contents: write'), /the tests job is `uses: \.\/\.github\/workflows\/tests\.yml` and nothing else/],
    ['release', (t) => sub(t, '    uses: ./.github/workflows/tests.yml', '    uses: ./.github/workflows/other.yml'), /the tests job is `uses: \.\/\.github\/workflows\/tests\.yml` and nothing else/],
    ['release', (t) => sub(t, '  publish-core:\n    needs: [gates, tests]\n    runs-on: ubuntu-latest\n    timeout-minutes: 20', '  publish-core:\n    needs: [gates, tests]\n    runs-on: ubuntu-latest'), /release\.yml: the publish-core job needs timeout-minutes of at most 20/],
    ['release', (t) => sub(t, '      - run: npm run check\n', '      - run: npm run check || true\n'), /release\.yml: line \d+ ignores a command's failure/],
    ['release', (t) => `${t}  "sneak":\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n`, /release\.yml: line \d+ has a quoted key/],
    ['release', (t) => `${t}  sneak: { runs-on: ubuntu-latest, steps: [ { run: npm publish } ] }\n`, /release\.yml: line \d+: under jobs:, a line at two spaces must be a job name alone/],
    ['release', (t) => sub(t, '  publish-core:\n    needs: [gates, tests]\n', '  publish-core:\n    needs: [gates, tests]\n    continue-on-error: true\n'), /release\.yml: line \d+ sets continue-on-error/],
    // tests.yml: no condition anywhere, every command as written and once, its index from GitHub
    ['tests', (t) => sub(t, '      - name: test shard\n', '      - name: test shard\n        if: false\n'), /tests\.yml: line \d+ has an if: this file may not hold/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: plan\n    "if": false\n'), /tests\.yml: line \d+ has a quoted key/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: plan\n    "continue-on-error": true\n'), /tests\.yml: line \d+ has a quoted key/],
    ['tests', (t) => sub(t, '      - name: test shard\n', '      - name: test shard\n        continue-on-error: true\n'), /tests\.yml: line \d+ sets continue-on-error/],
    ['tests', (t) => sub(t, shard, `${shard} || true`), /tests\.yml: line \d+ ignores a command's failure/],
    ['tests', (t) => sub(t, shard, `${shard}\n      - run: node packages/core/scripts/test-with-render-log.js --shard "$((INDEX + 1))/$TOTAL"`), /tests\.yml: the test job must run exactly:/],
    ['tests', (t) => sub(t, examples, '        run: echo skipped'), /tests\.yml: the rendered job must run exactly:/],
    ['tests', (t) => sub(t, '      - name: test shard\n', '      - run: echo "process.exit(0)" > packages/core/scripts/test-with-render-log.js\n      - name: test shard\n'), /tests\.yml: the test job must run exactly:/],
    ['tests', (t) => sub(t, '      - name: test shard\n', '      - name: test shard\n        shell: "true {0}"\n'), /tests\.yml: line \d+ sets shell/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: plan\n    defaults:\n      run:\n        shell: "true {0}"\n'), /tests\.yml: line \d+: the job key defaults is not one this file may use/],
    ['tests', (t) => sub(t, '          CI: \'true\'\n', "          CI: 'true'\n          NODE_OPTIONS: --import=./x.js\n"), /tests\.yml: line \d+: env NODE_OPTIONS is not one the jobs may set/],
    ['tests', (t) => sub(t, '        shard: ${{ fromJSON(needs.plan.outputs.shards) }}', '        shard: [1, 2, 3]'), /tests\.yml: line \d+ writes shard as a flow sequence/],
    ['tests', (t) => sub(t, '        shard: ${{ fromJSON(needs.plan.outputs.shards) }}', '        shard: ${{ fromJSON(needs.plan.outputs.parts) }}'), /the test matrix must come from needs\.plan\.outputs\.shards/],
    ['tests', (t) => sub(t, '    strategy:\n      fail-fast: false\n      matrix:\n        part:', '    strategy:\n      matrix:\n        part:'), /the rendered job needs fail-fast: false/],
    ['tests', (t) => sub(t, '          INDEX: ${{ strategy.job-index }}\n          TOTAL: ${{ strategy.job-total }}\n          CI:', '          INDEX: ${{ matrix.shard }}\n          TOTAL: ${{ strategy.job-total }}\n          CI:'), /tests\.yml: line \d+ uses a matrix value/],
    ['tests', (t) => sub(t, '          INDEX: ${{ strategy.job-index }}\n          TOTAL: ${{ strategy.job-total }}\n          CI:', '          TOTAL: ${{ strategy.job-total }}\n          CI:'), /each test command takes INDEX and TOTAL from strategy\.job-index and job-total through env/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n    runs-on: ubuntu-latest\n    timeout-minutes: 20', '  test:\n    needs: plan\n    runs-on: ubuntu-latest\n    timeout-minutes: 45'), /tests\.yml: the test job needs timeout-minutes of at most 20/],
    ['tests', (t) => sub(t, '    timeout-minutes: 5\n', ''), /tests\.yml: the plan job needs timeout-minutes of at most 5/],
    ['tests', (t) => sub(t, 'on:\n  workflow_call:\n', 'on:\n  workflow_call:\n  push:\n'), /tests\.yml: on: must be workflow_call only/],
    ['tests', (t) => sub(t, 'permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'), /tests\.yml: permissions must be contents: read, once, at the top/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: plan\n    permissions:\n      id-token: write\n'), /tests\.yml: line \d+ names a secret, an id-token or a publish or push/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: plan\n    container: node:22\n'), /tests\.yml: line \d+ sets container/],
    ['tests', (t) => sub(t, '  test:\n    needs: plan\n', '  test:\n    needs: &n plan\n'), /tests\.yml: line \d+ uses an anchor, alias, tag, merge key or complex key/],
    // ci.yml: tests is tests.yml, ci-ok is exactly the job that fails unless every job succeeded
    ['ci', (t) => sub(t, '    needs: [checks, tests, docker]', '    needs: [checks, tests]'), /ci\.yml: ci-ok must be exactly the job that needs checks, tests, docker/],
    ['ci', (t) => sub(t, '    if: always()\n', ''), /ci-ok must be exactly the job/],
    ['ci', (t) => sub(t, 'for r in "$CHECKS" "$TESTS" "$DOCKER"', 'for r in "$CHECKS" "$DOCKER"'), /ci-ok must be exactly the job/],
    ['ci', (t) => sub(t, '      - run: |\n          for r in', '      - run: |\n          exit 0\n          for r in'), /ci-ok must be exactly the job/],
    ['ci', (t) => sub(t, '          DOCKER: ${{ needs.docker.result }}\n', ''), /ci-ok must be exactly the job/],
    ['ci', (t) => sub(t, '  docker:\n    # the MCP server image: build it and drive it over stdio, without network, as the README tells users to run it\n    runs-on: ubuntu-latest\n', '  docker:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n'), /ci\.yml: line \d+ sets continue-on-error/],
    ['ci', (t) => sub(t, '  docker:\n    # the MCP server image: build it and drive it over stdio, without network, as the README tells users to run it\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n', '  docker:\n    runs-on: ubuntu-latest\n'), /ci\.yml: the docker job needs timeout-minutes of at most 20/],
    ['ci', (t) => sub(t, '    uses: ./.github/workflows/tests.yml', '    uses: ./.github/workflows/tests.yml\n    with:\n      x: 1'), /ci\.yml: the tests job is `uses: \.\/\.github\/workflows\/tests\.yml` and nothing else/],
    ['ci', (t) => sub(t, '  tests:\n    # the test shards and the rendered parts (tests.yml), as release.yml runs them\n    uses: ./.github/workflows/tests.yml', '  tests:\n    uses: ./.github/workflows/other.yml'), /ci\.yml: the tests job is `uses: \.\/\.github\/workflows\/tests\.yml` and nothing else/],
    // the subset: one case per rule
    ['tests', (t) => sub(t, '    timeout-minutes: 5\n', '\ttimeout-minutes: 5\n'), /tests\.yml: line \d+ has a tab/],
    ['tests', (t) => sub(t, '    strategy:\n      fail-fast: false\n      matrix:\n        shard:', '    strategy: { fail-fast: false }\n    xstrategy:\n      matrix:\n        shard:'), /tests\.yml: line \d+ writes strategy as a flow mapping/],
    ['tests', (t) => sub(t, '    timeout-minutes: 5\n', '    timeout-minutes: >\n      5\n'), /tests\.yml: line \d+ writes timeout-minutes as a block scalar/],
    ['tests', (t) => sub(t, '      - name: test shard\n', '      - name: test shard\n        timeout-minutes: 1\n'), /tests\.yml: line \d+: the step key timeout-minutes is not one this file may use/],
    ['tests', (t) => `${t}  extra:\n    needs: plan\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: npm ci\n`, /tests\.yml: the jobs must be plan, test, rendered/],
    ['tests', (t) => sub(t, '          INDEX: ${{ strategy.job-index }}\n          TOTAL: ${{ strategy.job-total }}\n          CLAIMSEED_CHROME: /usr/bin/google-chrome\n      - name: examples', '          TOTAL: ${{ strategy.job-total }}\n          CLAIMSEED_CHROME: /usr/bin/google-chrome\n      - name: examples'), /each rendered command takes INDEX and TOTAL from strategy\.job-index and job-total through env/],
    // a key after a `- run: |` block is a key, not shell
    ['ci', (t) => sub(t, '            --user "$(id -u):$(id -g)" -v "$PWD/out:/work" claimseed-mcp\n', '            --user "$(id -u):$(id -g)" -v "$PWD/out:/work" claimseed-mcp\n        continue-on-error: true\n'), /ci\.yml: line \d+ sets continue-on-error/],
    // a block opened with an indentation indicator is refused (the lexer does not read it as a block), and a key after
    // it is still caught
    ['ci', (t) => sub(t, '      - run: |\n          mkdir -p out\n', '      - run: |2\n          mkdir -p out\n'), /ci\.yml: line \d+ opens a block scalar with an indentation indicator/],
    ['ci', (t) => sub(t, '      - run: |\n          mkdir -p out\n', '      - run: |+2\n          mkdir -p out\n').replace('claimseed-mcp\n  ci-ok:', 'claimseed-mcp\n        continue-on-error: true\n  ci-ok:'), /ci\.yml: line \d+ sets continue-on-error/],
  ];
  for (const [file, plant, re] of plants) {
    const got = workflowProblems({ ...real, [file]: plant(real[file]) });
    assert.ok(got.some((m) => re.test(m)), `${file}: ${re}: ${JSON.stringify(got)}`);
  }
  // the folder holds the three workflows only
  assert.deepEqual(folderProblems(['tests.yml', 'ci.yml', 'release.yml']), []);
  assert.match(folderProblems(['ci.yml', 'release.yml', 'tests.yml', 'sneak.yml'])[0], /must hold ci\.yml, release\.yml, tests\.yml only/);
  assert.deepEqual(folderProblems(fs.readdirSync(path.join(here, '../../../.github/workflows'))), []);
  // a comment that names a forbidden construct is only a comment to the rules (the pin still sees the edit)
  assert.deepEqual(workflowProblems({ ...real, tests: real.tests.replace('jobs:\n', '# no if: and no || true here\njobs:\n') }).filter((m) => !/is not the reviewed file/.test(m)), []);
});
