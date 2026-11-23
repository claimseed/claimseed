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
// the copy's own script, so the rendered-text pass runs on the copy; a planted copy is judged without the layout variants
// (they add run time, not coverage of the plant), the shipped tree with them
const run = (dir) => spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), ...(dir === core ? [] : ['--variants', 'none'])], { encoding: 'utf-8', cwd: dir });

test('verify-stock-sources passes on the shipped tree, with every layout variant id', () => {
  const r = run(core);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verbatim from public sources/);
  for (const v of ['', 'some']) { const x = spawnSync(process.execPath, [SCRIPT, '--variants', v], { encoding: 'utf-8' }); assert.equal(x.status, 2); assert.equal(x.stderr, '--variants must be all or none\n'); }
});

test('a lifted sentence in a layout-variant label set fails, as a label and as the line a variant prints', () => {
  const lifted = 'Members who travel outside the service area should carry this card';
  const dir = scratchCopy();
  const lp = path.join(dir, 'data/ppo-eob/labels.json'); const l = JSON.parse(fs.readFileSync(lp, 'utf-8'));
  l.sets['alt-b']['claims.title'] = lifted; fs.writeFileSync(lp, JSON.stringify(l));
  let r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--variants', 'none'], { encoding: 'utf-8', cwd: dir });
  assert.equal(r.status, 1, `label set not checked: ${r.stdout}`); assert.match(r.stderr, /data\/ppo-eob\/labels\.json/);
  // a short label and a short template text that print as one line only on a variant's page (the bill's continued-group
  // marker exists in the label sets alone): judged only by the variant renders
  l.sets['alt-b']['claims.title'] = 'Claim details';
  fs.writeFileSync(lp, JSON.stringify(l));
  const bp = path.join(dir, 'data/itemized-bill/labels.json'); const b = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  for (const set of Object.values(b.sets)) set['labels.groupContinuedFrom'] = 'Members who travel outside';
  fs.writeFileSync(bp, JSON.stringify(b));
  const cut = path.join(dir, 'templates/itemized-bill/charges-v.html'); const t = fs.readFileSync(cut, 'utf-8');
  const anchor = '<td colspan="6">{{ stock.labels.groupContinuedFrom }}</td>'; assert.ok(t.includes(anchor), 'template anchor moved');
  fs.writeFileSync(cut, t.replace(anchor, '<td colspan="6">{{ stock.labels.groupContinuedFrom }} the service area should carry</td>'));
  r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--variants', 'none'], { encoding: 'utf-8', cwd: dir });
  assert.equal(r.status, 0, `the control (no variant printed) failed: ${r.stdout}${r.stderr}`);
  r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js')], { encoding: 'utf-8', cwd: dir });
  assert.equal(r.status, 1, `a variant's assembled line passed: ${r.stdout}`);
  assert.match(r.stderr, /members who travel outside the service area should carry/); assert.match(r.stderr, /itemized-bill\.b\d\d \(rendered page text, assembled from short pieces\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lifted sentence in the provider statement\'s labels fails, as a label and as the line the statement prints', () => {
  const lifted = 'Members who travel outside the service area should carry this card';
  const dir = scratchCopy();
  const pp = path.join(dir, 'data/pair.json'); const p = JSON.parse(fs.readFileSync(pp, 'utf-8'));
  p.labels.summaryTitle = lifted; fs.writeFileSync(pp, JSON.stringify(p));
  let r = spawnSync(process.execPath, [path.join(dir, 'scripts/verify-stock-sources.js'), '--variants', 'none', '--no-render'], { encoding: 'utf-8', cwd: dir });
  assert.equal(r.status, 1, `statement labels not checked: ${r.stdout}`); assert.match(r.stderr, /\[data\/pair\.json labels[^\]]*\] members who travel outside/);
  r = run(dir);
  assert.equal(r.status, 1, `statement pages not checked: ${r.stdout}`); assert.match(r.stderr, /statement (clean|over-owed|denied-line-billed|payment-misposted|paid-at-visit|over-owed-with-payment) \(rendered page text\)\] members who travel outside/);
  fs.rmSync(dir, { recursive: true, force: true });
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
