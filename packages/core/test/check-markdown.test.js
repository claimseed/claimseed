// The Markdown structure check (scripts/check-markdown.js): each way a re-flowed line broke a table or a command block
// is caught, the well-formed shapes pass, and the repository passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { markdownProblems, cellCount, COMMANDS } from '../scripts/check-markdown.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/check-markdown.js');
const lines = (t) => markdownProblems(t).map((p) => `${p.line} ${p.rule}`);

test('a table row broken across lines is caught, on its first line and on each line after it', () => {
  const t = ['| Tool | What it does |', '| --- | --- |', '| `a` | one, two', 'and three. |', '| `b` | four |', ''].join('\n');
  assert.deepEqual(lines(t), ['3 table', '4 table']);
});

test('a row with a cell missing is caught; pipes in code spans and escaped pipes are not cells', () => {
  const t = ['| kind | status | What | Rule |', '| --- | --- | --- | --- |', '| `x` | What is wrong | rule |',
    '| `a|b` | planned | a \\| b | `c || d` |', ''].join('\n');
  assert.deepEqual(lines(t), ['3 table']);
  assert.equal(cellCount('| `a|b` | x \\| y |'), 3);
});

test('a command block with a command run into the comment before it is caught (fence and indented)', () => {
  const fence = ['```sh', 'node src/cli.js render ppo-eob x --seed d --out o   # also hmo-eob node src/cli.js render',
    'commercial-eob baseline-clean --seed demo --out ./output --insurer a', 'node src/cli.js batch --out ./set   # or an id, or all;',
    'never with msn', '```'].join('\n');
  assert.deepEqual(lines(fence), ['2 command', '3 command', '5 command']);
  const indented = ['Text:', '', '    npx @claimseed/core list', '    render msn combined-three-errors --seed demo', ''].join('\n');
  assert.deepEqual(lines(indented), ['4 command']);
  // npx with options before the package, as the MCP quick start writes it
  const options = ['```sh', 'npx -y @claimseed/mcp   # or, saving files: npx -y @claimseed/mcp --workspace specimens', '```', '',
    '```sh', 'npx @claimseed/core list   # then npx --yes -p x @claimseed/core render', '```'].join('\n');
  assert.deepEqual(lines(options), ['2 command', '6 command']);
});

test('well-formed blocks pass: comments, continuations, blank lines, a code block that holds no command', () => {
  const t = ['```sh', '# a comment', 'npm test          # unit tests', '', 'docker run -i --rm \\', '  --user 1 image', '```', '',
    'Library:', '', '    import { render } from "@claimseed/core";', '    const x = 1;', '', '```js', 'whatever();', '```', ''].join('\n');
  assert.deepEqual(lines(t), []);
  assert.ok(COMMANDS.includes('mkdir') && COMMANDS.includes('npx'));
});

test('the repository passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
