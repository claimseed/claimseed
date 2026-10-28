// scan-rendered.js judges the text a rendered PDF actually prints, by geometry: words are grouped into the lines they
// print on, and two pieces that are each fine alone but print side by side as one unreviewed sentence are reported.
// The geometric rule is exercised on word boxes directly (no browser), and end to end on scratch copies of the tree
// whose HMO cover prints a sentence split over positioned boxes, columns or grid cells. All text here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { assembledLines, loadVerifiedSentences, loadPublic, loadOriginal, norm } from '../scripts/lib/provenance.js';
import { findChrome } from '../src/browser.js';

const core = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// word boxes in PDF points: a run of words starting at x on the baseline y (8 pt type, 4.6 pt per character)
const run = (x, y, text) => { const out = []; for (const t of text.split(' ')) { out.push({ x0: x, y0: y - 11, x1: x + t.length * 4.6, y1: y, t }); x += t.length * 4.6 + 2.3; } return out; };
test('printed lines: side-by-side pieces are judged as the line they print on; columns, values and reviewed text are not', () => {
  const grams = new Set(); for (const s of loadVerifiedSentences(core)) { const w = s.split(' '); for (let i = 0; i + 5 <= w.length; i++) grams.add(w.slice(i, i + 5).join(' ')); }
  const verified = loadPublic(core) + ' \n ' + [...loadOriginal(core)].join(' \n ');
  const judge = (words, values = [], fields = []) => assembledLines([words], { grams, verified, values: new Set(values.map((v) => norm(v))), fields: new Set(fields.map((v) => norm(v))) }).map((f) => f.text);
  // two short pieces with a wide gap between them, and with an ordinary word space
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(190, 290, 'to another person')]), ['we mailed your refund to another person']);
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(136, 290, 'to another person')]), ['we mailed your refund to another person']);
  // punctuation printed between them separates nothing
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(150, 290, '|'), ...run(190, 290, 'to another person')]), ['we mailed your refund to another person']);
  // the same pieces stacked on two lines of one block are one sentence carried over the line end
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(40, 302, 'to another person')]), ['we mailed your refund to another person']);
  // ... but two labels stacked, a line that closes its sentence, a line set apart, or one far below are not carried
  assert.deepEqual(judge([...run(40, 290, 'Questions about your claims'), ...run(40, 302, 'Call member services today')]), []);
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund.'), ...run(40, 302, 'to another person')]), []);
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(160, 302, 'to another person')]), []);
  assert.deepEqual(judge([...run(40, 290, 'We mailed your refund'), ...run(40, 340, 'to another person')]), []);
  // a table row on its own (its header and the next row too far away to line up with): a cell that holds one of the
  // document's data fields is a cell, whatever lines up with it ("Full eye exam, returning patient | YES")
  const far = [...run(40, 100, 'Service'), ...run(260, 100, 'Approved?'), ...run(40, 240, 'Full eye exam, returning patient'), ...run(260, 240, 'YES')];
  assert.deepEqual(judge(far, [], ['Full eye exam, returning patient', 'Drawing blood from a vein']), []);
  assert.deepEqual(judge(far), ['full eye exam returning patient yes'], 'without the data field the row is one assembled line');
  // ... but template text in two cells is one sentence, even when another row far below lines up with its cells
  const split = [...run(40, 100, 'We mailed your refund'), ...run(260, 100, 'to another person'), ...run(40, 240, 'Account details'), ...run(260, 240, 'Payment details')];
  assert.deepEqual(judge(split, [], ['Full eye exam, returning patient']), ['we mailed your refund to another person']);
  // a table header whose cells line up with the row below it: each cell starts a column
  const header = [...run(40, 200, 'Service you received'), ...run(200, 200, 'Plan approved'), ...run(300, 200, 'Plan paid'), ...run(400, 200, 'Notes')];
  const row = [...run(40, 214, 'Office visit'), ...run(200, 214, '$20.00'), ...run(300, 214, '$10.00'), ...run(400, 214, 'K1')];
  assert.deepEqual(judge([...header, ...row]), []);
  assert.deepEqual(judge(header).length, 1, 'without the aligned row the header is one assembled line');
  // the document's own values and numbers separate pieces; a reviewed sentence wrapped over two lines is covered on both
  assert.deepEqual(judge([...run(40, 290, 'Member name Rose Young Member since 2019 Plan Tessara')], ['Rose Young']), []);
  assert.deepEqual(judge([...run(40, 290, 'Thank you for being a member of'), ...run(40, 302, 'Tessara. Please look it over and keep it with your health records.')]), []);
});

function scratchCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scan-'));
  for (const d of ['data', 'scenarios', 'src', 'templates', 'reference-data', 'scripts', 'fonts']) if (fs.existsSync(path.join(core, d))) fs.cpSync(path.join(core, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(core, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(core, '../../node_modules'), path.join(dir, 'node_modules'));
  return dir;
}
function scanCover(html, stockAdd) {
  const d = scratchCopy(); const tp = path.join(d, 'templates/hmo-eob/page-cover.html'); const t = fs.readFileSync(tp, 'utf-8');
  assert.ok(t.includes('{{ stock.cover.intro }}'), 'template anchor moved');
  fs.writeFileSync(tp, t.replace('{{ stock.cover.intro }}', html));
  if (stockAdd) { const sp = path.join(d, 'data/hmo-eob/stock-content.json'); const st = JSON.parse(fs.readFileSync(sp, 'utf-8')); Object.assign(st.cover, stockAdd); fs.writeFileSync(sp, JSON.stringify(st)); }
  try { return spawnSync(process.execPath, [path.join(d, 'scripts/scan-rendered.js'), '--seeds', '1', '--type', 'hmo-eob'], { encoding: 'utf-8', cwd: d }); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
}
test('scan-rendered reports a sentence printed side by side from positioned boxes, columns and grid cells', { skip: !findChrome() && !process.env.CI && 'no Chrome (set CLAIMSEED_CHROME); never skipped in CI' }, () => {
  const [a, b] = ['We mailed your refund', 'to another person'];
  for (const [what, html, stockAdd] of [
    // stock pieces are blanked by the text-stream check; only the printed line shows the sentence
    ['positioned boxes filled from stock keys', '<div style="position:relative;height:16px"><div style="position:absolute;left:0;top:0">{{ stock.cover.csPieceA }}</div><div style="position:absolute;left:200px;top:0">{{ stock.cover.csPieceB }}</div></div>', { csPieceA: a, csPieceB: b }],
    ['two columns', `<div style="columns:2;column-gap:0;width:400px"><div>${a}</div><div>${b}</div></div>`],
    ['nested grid cells', `<div style="display:grid;grid-template-columns:200px 200px"><section><div>${a}</div></section><section><div>${b}</div></section></div>`],
    // a positioned box of two lines: the reader of the template sees two lines, the page prints the sentence on one
    ['a two-line positioned box beside another', `<div style="position:relative;height:30px"><div style="position:absolute;left:0;top:0">${a}</div><div style="position:absolute;left:200px;top:0"><div>${b}</div><div>Rose</div></div></div>`],
  ]) {
    const r = scanCover(html, stockAdd);
    assert.equal(r.status, 1, `${what} passed: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /printed line on page 1 assembles text neither public nor reviewed original: "we mailed your refund to another person"/, `${what}: ${r.stderr}`);
  }
  // control from the real cover: complete reviewed sentences side by side in two columns print as two columns
  const ok = scanCover('<div style="columns:2;column-gap:12pt"><div>{{ stock.cover.intro }}</div><div>{{ stock.cover.notABillText }}</div></div>');
  assert.equal(ok.status, 0, `reviewed sentences in two columns refused: ${ok.stdout}${ok.stderr}`);
});
