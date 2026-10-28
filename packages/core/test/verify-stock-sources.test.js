// verify-stock-sources.js is the provenance gate for printed text: a sentence that is neither in a public-source
// snapshot nor in the reviewed original list must fail the check. These tests run the script against a scratch copy
// of the data tree so the real tree is never touched.
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
const run = (dir) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js')], { encoding: 'utf-8', cwd: dir });   // the copy's own script, so the rendered-text pass runs on the copy

test('verify-stock-sources passes on the shipped tree', () => {
  const r = run(core);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verbatim from public sources/);
});

test('verify-stock-sources fails on a lifted sentence, however it is fragmented', () => {
  const lifted = 'Members who travel outside the service area should carry this card and present it at every visit.';
  for (const variant of [lifted, lifted.replace(/ should carry /, '; should carry ')]) {
    const dir = scratchCopy();
    const p = path.join(dir, 'data/msn/stock-content.json');
    const stock = JSON.parse(fs.readFileSync(p, 'utf-8'));
    stock.page2.messages = [...(stock.page2.messages || []), variant];
    fs.writeFileSync(p, JSON.stringify(stock));
    const r = run(dir);
    assert.equal(r.status, 1, `lifted sentence passed: ${variant}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /neither in a public source nor reviewed as original/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

// a sentence split into five-word pieces that are concatenated in code, split by empty inline elements in
// a template, or listed as short items in a stock array prints whole, so it is judged whole
test('verify-stock-sources judges concatenated, inline-split and array-split sentences as one', () => {
  const lifted = 'Your plan paid this claim under the terms of your evidence of coverage document.';
  const pieces = ['Your plan paid this', 'claim under the terms', 'of your evidence of', 'coverage document.'];
  for (const [file, text, how] of [
    ['src/generate/msn.js', `\nexport const T = ${pieces.map((p) => `'${p}'`).join(' +\n  ')};\n`, "'+' concatenation"],
    ['src/generate/msn.js', `\nexport const T = [${pieces.map((p) => `'${p}'`).join(', ')}].join(' ');\n`, 'array .join'],
    ['templates/msn/page2-tips.html', `\n<p>${pieces.join('<i></i> ')}</p>\n`, 'empty inline elements'],
    ['templates/msn/page2-tips.html', `\n<p>${pieces.join('<span class="x"></span>')}</p>\n`, 'empty spans']]) {
    const dir = scratchCopy(); fs.appendFileSync(path.join(dir, file), text);
    const r = run(dir); assert.equal(r.status, 1, `split sentence passed (${how}): ${r.stdout}${r.stderr}`); fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir = scratchCopy();
  const sp = path.join(dir, 'data/msn/stock-content.json'); const st = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  st.page2.howToCheckItems = pieces; fs.writeFileSync(sp, JSON.stringify(st));
  const r = run(dir); assert.equal(r.status, 1, `split stock array passed: ${r.stdout}${r.stderr}`); fs.rmSync(dir, { recursive: true, force: true });
  // sibling stock keys interpolated side by side in a template print as one sentence: the template text is judged with
  // the stock values substituted
  const d2 = scratchCopy(); const sp2 = path.join(d2, 'data/msn/stock-content.json'); const st2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
  pieces.forEach((pc, i) => { st2.page2[`kx${i}`] = pc; }); fs.writeFileSync(sp2, JSON.stringify(st2));
  fs.appendFileSync(path.join(d2, 'templates/msn/page2-tips.html'), `\n<p>${pieces.map((_, i) => `{{ stock.page2.kx${i} }}`).join(' ')}</p>\n`);
  const r2 = run(d2); assert.equal(r2.status, 1, `sentence spread over sibling stock keys passed: ${r2.stdout}${r2.stderr}`); fs.rmSync(d2, { recursive: true, force: true });
  // the same through a template alias, and as a data-only edit (an object with term + text fields printed side by side):
  // the printed text itself is judged, whatever template mechanism assembled it
  const d3 = scratchCopy(); const sp3 = path.join(d3, 'data/msn/stock-content.json'); const st3 = JSON.parse(fs.readFileSync(sp3, 'utf-8'));
  pieces.forEach((pc, i) => { st3.page2[`kx${i}`] = pc; }); fs.writeFileSync(sp3, JSON.stringify(st3));
  const tp3 = path.join(d3, 'templates/msn/page2-tips.html'); const anchor = '<div class="section-header">{{ stock.page2.howToCheckTitle }}</div>';
  assert.ok(fs.readFileSync(tp3, 'utf-8').includes(anchor), 'template anchor moved');
  fs.writeFileSync(tp3, fs.readFileSync(tp3, 'utf-8').replace(anchor, `{% set q = stock.page2 %}<p>{{ q.kx0 }} {{ q.kx1 }} {{ q.kx2 }} {{ q.kx3 }}</p>${anchor}`));   // inside the page block: a child template's top level is never rendered
  const r3 = run(d3); assert.equal(r3.status, 1, `aliased sibling keys passed: ${r3.stdout}${r3.stderr}`); assert.match(r3.stderr, /rendered page text/); fs.rmSync(d3, { recursive: true, force: true });
  const d4 = scratchCopy(); const sp4 = path.join(d4, 'data/hmo-eob/stock-content.json'); const st4 = JSON.parse(fs.readFileSync(sp4, 'utf-8'));
  st4.info.terms.unshift({ term: pieces[0], text: pieces[1] + ' ' + pieces[2] }); fs.writeFileSync(sp4, JSON.stringify(st4));
  const r4 = run(d4); assert.equal(r4.status, 1, `term/text object pieces passed: ${r4.stdout}${r4.stderr}`); fs.rmSync(d4, { recursive: true, force: true });
  void lifted;
  // bracketed or braced prose is printed text, not a placeholder
  for (const wrap of [(x) => ` [${x}]`, (x) => ` {${x}}`]) {
    const d5 = scratchCopy(); const sp5 = path.join(d5, 'data/hmo-eob/stock-content.json'); const st5 = JSON.parse(fs.readFileSync(sp5, 'utf-8'));
    st5.cover.intro += wrap('The velvet otters rehearse beside the quiet orchard.'); fs.writeFileSync(sp5, JSON.stringify(st5));
    const r5 = run(d5); assert.equal(r5.status, 1, `bracketed prose passed: ${r5.stdout}${r5.stderr}`); fs.rmSync(d5, { recursive: true, force: true });
  }
  // a template prints what its layout prints: braced prose written into the template, and a sentence split across
  // blocks that a style attribute or a CSS rule makes inline-level, are judged whole
  const variants = [
    ['braced template prose', '{The velvet otters rehearse beside the quiet orchard}', ''],
    ['inline-styled blocks', '<div style="display:inline">The velvet otters rehearse</div>\n\n<div style="display:inline">beside the quiet orchard</div>', ''],
    ['blocks made inline by a class rule', '<div class="cs-probe">The velvet otters rehearse</div>\n<div class="cs-probe">beside the quiet orchard</div>', '\n.ts-intro .cs-probe { display: inline-block; }'],
    ['the children of a flex row', '<div class="cs-row"><div>The velvet otters rehearse</div><div>beside the quiet orchard</div></div>', '\n.cs-row { display: flex; gap: 4px; }'],
  ];
  for (const [what, html, css] of variants) {
    const d6 = scratchCopy(); const tp6 = path.join(d6, 'templates/hmo-eob/page-cover.html'); let t6 = fs.readFileSync(tp6, 'utf-8');
    assert.ok(t6.includes('{{ stock.cover.intro }}') && t6.includes('{% block extra_styles %}'), 'template anchor moved');
    t6 = t6.replace('{{ stock.cover.intro }}', html).replace('{% block extra_styles %}', '{% block extra_styles %}' + css); fs.writeFileSync(tp6, t6);
    const r6 = run(d6); assert.equal(r6.status, 1, `${what} passed: ${r6.stdout}${r6.stderr}`); fs.rmSync(d6, { recursive: true, force: true });
  }
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
