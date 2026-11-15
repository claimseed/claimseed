// verify-stock-sources.js, continued from verify-stock-sources.test.js (split so neither file holds half a CI shard):
// a lifted sentence in a scenario note or generator code, text printed side by side, and the reviewed-original list
// it writes and prunes. Like the first file, every case runs the script on a scratch copy of the data tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '..');
const SCRIPT = path.join(core, 'scripts/verify-stock-sources.js');

function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vss-'));
  for (const d of ['data', 'scenarios', 'src', 'templates', 'reference-data', 'scripts', 'fonts']) if (fs.existsSync(path.join(core, d))) fs.cpSync(path.join(core, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(core, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(core, '../../node_modules'), path.join(dir, 'node_modules'));   // the rendered-text pass drives the real render path (capture mode, no browser)
  return dir;
}
// the copy's own script, so the rendered-text pass runs on the copy; a planted copy is judged without the layout variants
// (they add run time, not coverage of the plant), the shipped tree with them
const run = (dir) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), ...(dir === core ? [] : ['--variants', 'none'])], { encoding: 'utf-8', cwd: dir });

test('verify-stock-sources fails on a lifted sentence in a scenario note and in generator code', () => {
  const lifted = 'Your plan paid this claim under the terms of your evidence of coverage document.';
  let dir = scratchCopy();
  const sc = fs.readdirSync(path.join(dir, 'scenarios/msn')).find((f) => f.endsWith('.json'));
  const sp = path.join(dir, 'scenarios/msn', sc); const s = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  s.description = lifted; fs.writeFileSync(sp, JSON.stringify(s));
  let r = run(dir); assert.equal(r.status, 1, 'scenario description not checked'); fs.rmSync(dir, { recursive: true, force: true });
  dir = scratchCopy();
  const gp = path.join(dir, 'src/generate/msn.js');
  fs.appendFileSync(gp, `\nexport const LIFTED = '${lifted}';\n`);
  r = run(dir); assert.equal(r.status, 1, 'generator string literal not checked'); fs.rmSync(dir, { recursive: true, force: true });
  // literals with semicolons, parentheses or ${} placeholders, multi-line template literals, other generator files,
  // the stock `logo` key and template text nodes are all checked too
  for (const [file, text] of [['src/generate/mutations.js', `const t = 'Your plan paid this claim; it was processed (on time) under the evidence of coverage document.';`],
    ['src/generate/encounter.js', 'const t = `You pay ${pct}% of the plan-approved amount for this service after any deductible applies here.`;'],
    ['src/generate/rules.js', 'const t = `Your plan paid this claim under\n  the terms of your evidence of coverage document.`;'],
    ['templates/msn/page2-tips.html', '<p>Your plan paid this claim under the terms of your evidence of coverage document.</p>']]) {
    dir = scratchCopy(); fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.appendFileSync(path.join(dir, file), '\n' + text + '\n');
    r = run(dir); assert.equal(r.status, 1, `lifted sentence not checked in ${file}`); fs.rmSync(dir, { recursive: true, force: true });
  }
  dir = scratchCopy();
  const sp2 = path.join(dir, 'data/msn/stock-content.json'); const st = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
  st.logo.subtext = lifted; fs.writeFileSync(sp2, JSON.stringify(st));
  r = run(dir); assert.equal(r.status, 1, 'stock logo key not checked'); fs.rmSync(dir, { recursive: true, force: true });
});

// Positioned boxes, columns and grid or flex cells print blocks side by side. A box or cell whose text is one line is
// joined with its neighbours however deeply that text is nested, so a sentence split over such boxes is judged whole —
// written into the template or spread over stock keys — while complete reviewed sentences side by side still pass.
const SPLIT = ['We mailed your refund', 'to another person'];
const SIDE_BY_SIDE = {
  'absolutely positioned boxes': ([a, b]) => [`<div style="position:relative;height:16px"><div style="position:absolute;left:0;top:0">${a}</div><div style="position:absolute;left:200px;top:0">${b}</div></div>`, ''],
  'positioned boxes set by class rules, nested': ([a, b]) => [`<div class="cs-frame"><div class="cs-box"><p>${a}</p></div><div class="cs-box cs-right"><p>${b}</p></div></div>`, '\n.cs-frame { position: relative; height: 16px; } .cs-box { position: absolute; top: 0; left: 0; } .cs-box.cs-right { left: 200px; }'],
  'two columns': ([a, b]) => [`<div style="columns:2;column-gap:0;width:400px"><div>${a}</div><div>${b}</div></div>`, ''],
  'a column-count rule': ([a, b]) => [`<div class="cs-cols"><div>${a}</div><div>${b}</div></div>`, '\n.cs-cols { column-count: 2; width: 400px; }'],
  'nested grid cells': ([a, b]) => [`<div style="display:grid;grid-template-columns:200px 200px"><section><div>${a}</div></section><section><div>${b}</div></section></div>`, ''],
  'deeply nested flex items': ([a, b]) => [`<div style="display:flex;gap:40px"><div><div><p>${a}</p></div></div><div><div><p>${b}</p></div></div></div>`, ''],
  'display: contents in a flex row': ([a, b]) => [`<div style="display:flex"><section style="display:contents"><div>${a}</div><div>${b}</div></section></div>`, ''],
};
function coverWith(html, css, stockAdd) {
  const d = scratchCopy(); const tp = path.join(d, 'templates/hmo-eob/page-cover.html'); let t = fs.readFileSync(tp, 'utf-8');
  assert.ok(t.includes('{{ stock.cover.intro }}') && t.includes('{% block extra_styles %}'), 'template anchor moved');
  fs.writeFileSync(tp, t.replace('{{ stock.cover.intro }}', html).replace('{% block extra_styles %}', '{% block extra_styles %}' + css));
  if (stockAdd) { const sp = path.join(d, 'data/hmo-eob/stock-content.json'); const st = JSON.parse(fs.readFileSync(sp, 'utf-8')); Object.assign(st.cover, stockAdd); fs.writeFileSync(sp, JSON.stringify(st)); }
  return d;
}
test('verify-stock-sources judges text that positioned boxes, columns and nested grid or flex cells print side by side', () => {
  for (const [what, form] of Object.entries(SIDE_BY_SIDE)) {
    for (const [source, pieces, stockAdd] of [['template text', SPLIT, null], ['stock keys', ['{{ stock.cover.csPieceA }}', '{{ stock.cover.csPieceB }}'], { csPieceA: SPLIT[0], csPieceB: SPLIT[1] }]]) {
      if (source === 'stock keys' && !/absolutely|two columns|nested grid/.test(what)) continue;   // the three reviewed forms, both ways
      const [html, css] = form(pieces); const d = coverWith(html, css, stockAdd);
      const r = run(d); assert.equal(r.status, 1, `${what} (${source}) passed: ${r.stdout}${r.stderr}`); assert.match(r.stderr, /we mailed your refund to another person/);
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
  // controls built from the real cover: a reviewed sentence in a positioned box, and complete reviewed sentences side by
  // side in two columns or two grid cells, pass (a label beside a sentence is judged as part of it, and is refused)
  for (const [what, html] of [['a positioned box', '<div style="position:relative;height:36px"><div style="position:absolute;left:0;top:0;right:0">{{ stock.cover.intro }}</div></div>'],
    ['two columns of reviewed sentences', '<div style="columns:2;column-gap:12pt"><div>{{ stock.cover.intro }}</div><div>{{ stock.cover.notABillText }}</div></div>'],
    ['nested grid cells of reviewed sentences', '<div style="display:grid;grid-template-columns:1fr 1fr"><section><p>{{ stock.cover.intro }}</p></section><section><p>{{ stock.cover.glanceNote }}</p></section></div>']]) {
    const d = coverWith(html, '', null); const r = run(d); assert.equal(r.status, 0, `${what} refused: ${r.stdout}${r.stderr}`); fs.rmSync(d, { recursive: true, force: true });
  }
});

test('--write-original keeps reviewed lines this render does not print; --prune drops and lists them, except those listed as rendered only', () => {
  const dir = scratchCopy();
  try {
    const file = path.join(dir, 'data/original-sentences.json');
    const { sentences: before, renderedOnly } = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const line = 'continued from the page before claim id cs';   // printed only by a variant's capture render (skipped here)
    assert.ok(before.includes(line) && !renderedOnly.includes(line));
    const listed = 'continued from the previous page claim number';   // printed only in a real PDF, read by scan-rendered
    assert.ok(renderedOnly.includes(listed));
    const write = (...extra) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--no-render', '--write-original', ...extra], { encoding: 'utf-8', cwd: dir });
    let r = write();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).sentences, before, 'nothing is dropped without --prune');
    assert.match(r.stdout, /kept that this render does not print/);
    r = write('--prune');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')).sentences;
    assert.ok(!after.includes(line), 'without the render, the rendered-only line is pruned');
    const dropped = r.stdout.split('\n').filter((l) => l.startsWith('dropped: ')).map((l) => l.slice(9));
    assert.ok(dropped.includes(line)); assert.equal(dropped.length, before.length - after.length, 'every dropped line is listed');
    assert.ok(after.includes(listed) && !dropped.includes(listed), 'a rendered-only line stays');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).renderedOnly, renderedOnly, 'the list is kept');
    // a reviewed line nothing prints, not listed as rendered only, fails the check (here: a planted one)
    const f = JSON.parse(fs.readFileSync(path.join(core, 'data/original-sentences.json'), 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...f, sentences: [...f.sentences, 'a reviewed line that nothing prints any more'].sort() }));
    r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--variants', 'all'], { encoding: 'utf-8', cwd: dir });
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, /a reviewed line that nothing prints any more/);
    fs.writeFileSync(file, JSON.stringify({ ...f, renderedOnly: [...f.renderedOnly, 'not a reviewed line'] }));
    r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--no-render'], { encoding: 'utf-8', cwd: dir });
    assert.equal(r.status, 1); assert.match(r.stderr, /renderedOnly lists a line that is not a reviewed original sentence/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
