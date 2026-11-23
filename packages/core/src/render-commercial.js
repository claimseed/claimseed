// render-commercial.js — the commercial employer-plan EOB (generate/commercial-eob.js) in its insurer's layout family:
//   a  portrait: page 1 with the summary box, the plan's terms and the year's totals; one claim per page; a back page.
//   b  landscape: one statement table of every claim with the summary and the year's totals in a side panel on page 1,
//      continued as needed; a back page with the plan's terms.
// The printed words come from data/commercial-eob/stock-content.json; the colours and mark the insurer's
// (data/commercial-eob/insurers.json). Every page is planned before printing and each part's page count checked, so
// nothing can overflow onto a page the plan did not count.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { env, launchBrowser, mergePdfs, templateContext, stampMeta, DATA_DIR } from './render.js';
import { hardenHtml, printPage } from './print.js';
import { INSURERS, printedFields } from './generate/commercial-eob.js';

const FONTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'itemized-bill', 'stock-content.json'), 'utf-8')).fonts;
const fill = (text, vars) => String(text).replace(/\{([A-Za-z]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
async function pdfPageCount(p) { return (await PDFDocument.load(fs.readFileSync(p), { updateMetadata: false })).getPageCount(); }

// Statement table pages for family b, in points of the landscape page: page 1 below the header, later pages below a
// slim header; a claim block costs its facts, its table head, its lines, its totals and its notes.
const B_PAGE = { first: 330, next: 470, facts: 64, head: 22, totals: 12, note: 20 };
// a line's height: the service column wraps at about 16 characters a line, 9pt each
const lineCost = (l) => 5 + 9 * Math.max(1, Math.ceil(String(l.service).length / 16));
export function planTable(claims) {
  const pages = [[]]; let left = B_PAGE.first;
  const open = () => { pages.push([]); left = B_PAGE.next; };
  for (const claim of claims) {
    let start = 0;
    while (start < claim.lineItems.length) {
      const fixed = B_PAGE.facts + B_PAGE.head;
      if (left < fixed + lineCost(claim.lineItems[start]) && pages.at(-1).length) open();
      let n = 0; let used = fixed;
      while (start + n < claim.lineItems.length) {
        const isLast = start + n === claim.lineItems.length - 1;
        const need = lineCost(claim.lineItems[start + n]) + (isLast ? B_PAGE.totals + claim.notes.length * B_PAGE.note : 0);
        if (used + need > left && n > 0) break;
        used += need; n++;
      }
      pages.at(-1).push({ claim, lines: claim.lineItems.slice(start, start + n), last: start + n === claim.lineItems.length });
      left -= used; start += n;
      if (start < claim.lineItems.length) open();
    }
  }
  return pages;
}

// What the templates read beside the data: the insurer's mark and palette, the stock sentences with their
// placeholders filled, each accumulator row's label, each claim's notes, and the remarks this EOB uses.
export function commercialView(data, text) {
  const ins = INSURERS.insurers.find((i) => i.id === data._insurerId);
  const vars = { insurer: ins.name, sponsor: data.plan.sponsor, plan: data.plan.name, option: data.plan.option, phone: data.plan.phone, days: data.appealDays };
  // the notes, the plan's terms and the accumulator labels as the answer key's fields record them (printedFields)
  const printed = printedFields(data, text);
  const claims = data.claims.map((c, i) => ({ ...c, notes: printed.claims[i].notes, heading: fill(text.claim.headingA, { n: i + 1, m: data.claims.length }), placeKind: c.provider.kind === 'clinician' ? 'office' : c.provider.kind }));
  const used = new Set(data.claims.flatMap((c) => c.lineItems.map((l) => l.remark).filter(Boolean)));
  if (data.accumulators.some((r) => r.kind === 'outOfPocket')) used.add('XO');
  return {
    ...data, claims, _mark: ins.mark,
    _t: { selfFunded: fill(text.plan.selfFunded, vars), memberServices: fill(text.plan.memberServices, vars), howToAppeal: fill(text.appeal.howToAppeal, vars), memberServicesHelp: fill(text.appeal.memberServicesHelp, vars) },
    terms: printed.terms, sections: printed.sections, accumulators: data.accumulators.map((r, i) => ({ ...r, label: printed.accumulators[i].label })),
    _remarksUsed: text.remarks.filter((r) => used.has(r.code)),
  };
}

export async function renderCommercialEob(data, text, outputDir, opts = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pages-'));
  try {
    const ins = INSURERS.insurers.find((i) => i.id === data._insurerId);
    const stock = { ...text, fonts: FONTS, colors: { text: ins.palette.text, primary: ins.palette.primary, accent: ins.palette.accent, panelBg: ins.palette.panelBg } };
    const view = commercialView(data, text);
    const family = ins.id;   // the insurer decides the layout family
    let template; let expect;
    if (family === 'a') { template = 'commercial-eob/a.html'; expect = 1 + view.claims.length + 1; }
    else { view.tablePages = planTable(view.claims); template = 'commercial-eob/b.html'; expect = view.tablePages.length + 1; }
    const ownBrowser = !opts.browser;
    const browser = opts.browser || await launchBrowser();
    const part = path.join(work, '.commercial-1.pdf');
    try {
      await printPage(browser, hardenHtml(env.render(template, templateContext({}, stock, { _d: view }))), part, { landscape: family === 'b' });
    } finally { if (ownBrowser) await browser.close(); }
    const got = await pdfPageCount(part);
    if (got !== expect) throw new Error(`${template}: rendered ${got} page(s), planned ${expect}`);
    const finalPdf = path.join(outputDir, 'commercial-eob.pdf');
    await mergePdfs([part], finalPdf, { ...stampMeta(opts), expectedPages: expect });
    return finalPdf;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
