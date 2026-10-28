// render-ma.js — the two Medicare Advantage monthly EOB layouts (original claimseed designs):
//   ppo-eob  Corvane (PPO): portrait cover, landscape claim-detail pages, portrait back pages.
//   hmo-eob  Tessara (HMO): portrait throughout.
// Both follow the contents the CMS Part C EOB model and 42 CFR 422.111(k) require (see templates/<type>/LINEAGE.md).
// Pagination is computed before anything is rendered so every page can print "Page X of N"; each partial PDF is
// checked against the page count the paginator planned, so an overflowing page fails loudly instead of shifting
// the numbering.
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { env, launchBrowser, mergePdfs, templateContext, stampMeta } from './render.js';
import { hardenHtml, printPage } from './print.js';
import os from 'os';

const r2 = (x) => Math.round(x * 100) / 100;

// Replace {token} placeholders in every string of the stock tree. Values come from the data's issuer block (which
// the assembler copies from stock.payer) and from stock itself; the result is still autoescaped by Nunjucks.
export function fillTokens(node, vars) {
  if (typeof node === 'string') return node.replace(/\{([A-Za-z]+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  if (Array.isArray(node)) return node.map((n) => fillTokens(n, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTokens(v, vars)]));
  return node;
}

// ------------------------------------------------------------------------------------------------------------
// Claim paginator, shared by both layouts. Costs are in points of vertical space and come from the layout's
// CSS (fixed row heights); `lineCost(line)` lets a layout charge extra for descriptions that wrap.
// Rules:
//   * a claim header is never left at the bottom of a page without at least one of its lines under it;
//   * the claim-total row always travels with the claim's last line, so a total is never alone on a page;
//   * a block is marked continuedFromPrev only when the same claim really did start on the previous page,
//     and continuesNext only when it really does carry over;
//   * every page reserves room for the notes that explain the codes used on that page.
// ------------------------------------------------------------------------------------------------------------
export function paginateClaims(claims, notes, cfg) {
  const noteOrder = notes.map((n) => n.id);
  const pages = [];
  let page; let remaining; let pageNotes;
  const noteReserve = (ids) => (ids.size ? cfg.notesHeaderCost + ids.size * cfg.noteCost : 0);
  const open = () => {
    page = { blocks: [], first: pages.length === 0 };
    pageNotes = new Set();
    remaining = (page.first ? cfg.firstPageCapacity : cfg.pageCapacity) - cfg.continueMarkerCost;
    pages.push(page);
  };
  // Space left once the notes this page would need (including `extraIds`) are reserved.
  const free = (extraIds = []) => remaining - noteReserve(new Set([...pageNotes, ...extraIds]));
  open();
  claims.forEach((claim, ci) => {
    const lines = claim.lineItems;
    const firstNeed = cfg.claimHeaderCost + cfg.tableHeaderCost + cfg.lineCost(lines[0]) + (lines.length === 1 ? cfg.totalsCost : 0);
    if (page.blocks.length && free(lines[0].notes || []) < firstNeed) open();
    let block = { claim, claimIndex: ci, lines: [], continuedFromPrev: false, continuesNext: false, showTotals: false };
    page.blocks.push(block);
    remaining -= cfg.claimHeaderCost + cfg.tableHeaderCost;
    lines.forEach((line, li) => {
      const isLast = li === lines.length - 1;
      const need = cfg.lineCost(line) + (isLast ? cfg.totalsCost : 0);
      if (block.lines.length && free(line.notes || []) < need) {
        block.continuesNext = true;
        open();
        block = { claim, claimIndex: ci, lines: [], continuedFromPrev: true, continuesNext: false, showTotals: false };
        page.blocks.push(block);
        remaining -= cfg.claimHeaderCost + cfg.tableHeaderCost;
      }
      block.lines.push(line);
      for (const id of line.notes || []) pageNotes.add(id);
      remaining -= cfg.lineCost(line);
      page.noteIds = pageNotes;
    });
    block.showTotals = true;
    remaining -= cfg.totalsCost + cfg.blockGap;
  });
  for (const p of pages) {
    const ids = p.noteIds || new Set();
    p.notes = noteOrder.filter((id) => ids.has(id)).map((id) => notes.find((n) => n.id === id));
    const last = p.blocks[p.blocks.length - 1];
    p.continues = !!(last && last.continuesNext);
    p.moreClaimsFollow = p !== pages[pages.length - 1];
    delete p.noteIds;
  }
  return pages;
}

// Rough count of wrapped lines for a text in a column holding about `perLine` characters.
const wrapLines = (text, perLine) => Math.max(1, Math.ceil(String(text || '').length / perLine));

async function pdfPageCount(p) {
  return (await PDFDocument.load(fs.readFileSync(p), { updateMetadata: false })).getPageCount();
}
async function renderPart(browser, template, ctx, outPath, { landscape = false, expectPages }) {
  const html = env.render(template, ctx);
  await printPage(browser, hardenHtml(html), outPath, { landscape });
  const got = await pdfPageCount(outPath);
  if (expectPages != null && got !== expectPages) throw new Error(`${template}: rendered ${got} page(s), paginator planned ${expectPages}`);
  return outPath;
}
const pct = (used, max) => (max > 0 ? Math.max(0, Math.min(100, r2((used / max) * 100))) : 0);

// ============================================================
// PPO (Corvane) — cover portrait, claims landscape, back pages portrait
// ============================================================
// Landscape claims page: 612pt tall; 0.32in top and 0.62in bottom padding (footer + specimen band) and a 54pt
// running header leave 490pt; the notes block is pinned to the bottom of that area.
const PPO_CLAIMS = {
  pageCapacity: 482,
  firstPageCapacity: 482 - 42, // page title + intro on the first claims page
  continueMarkerCost: 14,
  notesHeaderCost: 18, noteCost: 11,
  claimHeaderCost: 34, tableHeaderCost: 23, totalsCost: 17, blockGap: 4,
  lineCost: (l) => 3 + 12 * wrapLines(l.description, 62),
};

export async function renderPpoEob(data, stock, outputDir, opts = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pages-'));   // private page dir, removed in finally (see renderMsn)
  try {
  const issuer = data.metadata.issuer;
  const s = fillTokens(stock, { ...issuer, legalName: issuer.name, planName: data.metadata.planName, fraudPhone: stock.info.fraudPhone });
  const claimPages = paginateClaims(data.claims, data.notes || [], PPO_CLAIMS);
  const firstClaimsPage = 2; const backStart = firstClaimsPage + claimPages.length;
  const pageCount = backStart + 1; // two back pages: backStart, backStart + 1
  data.metadata.pageCount = pageCount;
  claimPages.forEach((p, i) => { p.pageNumber = firstClaimsPage + i; });

  const fs_ = data.financialSummary;
  const view = {
    deductiblePct: pct(fs_.deductibleMet, fs_.deductible), deductibleLeft: r2(Math.max(0, fs_.deductible - fs_.deductibleMet)),
    oopPct: pct(fs_.oopUsed, fs_.oopMax), oopLeft: r2(Math.max(0, fs_.oopMax - fs_.oopUsed)),
    pageCount, backStart,
  };
  const ctx = templateContext(data, s, { view });
  const ownBrowser = !opts.browser;   // a caller-supplied browser (opts.browser) is shared and left open
  const browser = opts.browser || await launchBrowser();
  const parts = [];
  try {
    parts.push(await renderPart(browser, 'ppo-eob/page-cover.html', ctx, path.join(work, '.ppo-1.pdf'), { expectPages: 1 }));
    parts.push(await renderPart(browser, 'ppo-eob/pages-claims.html', { ...ctx, claimPages }, path.join(work, '.ppo-2.pdf'), { landscape: true, expectPages: claimPages.length }));
    parts.push(await renderPart(browser, 'ppo-eob/pages-back.html', ctx, path.join(work, '.ppo-3.pdf'), { expectPages: 2 }));
  } finally { if (ownBrowser) await browser.close(); }
  const finalPdf = path.join(outputDir, 'ppo-eob.pdf');
  await mergePdfs(parts, finalPdf, { ...stampMeta(opts), expectedPages: pageCount });
  return finalPdf;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ============================================================
// HMO (Tessara) — portrait throughout
// ============================================================
// Portrait claims page: the content box runs from 1.08in to 0.7in above the bottom edge (664pt); the running
// header sits above it and the notes block is pinned to its bottom.
const HMO_CLAIMS = {
  pageCapacity: 662,
  firstPageCapacity: 662 - 44,
  continueMarkerCost: 15,
  notesHeaderCost: 20, noteCost: 12,
  claimHeaderCost: 38, tableHeaderCost: 26, totalsCost: 19, blockGap: 6,
  lineCost: (l) => 10 + 11.5 * wrapLines(l.description, 40) + 10.5,
};

export async function renderHmoEob(data, stock, outputDir, opts = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-pages-'));   // private page dir, removed in finally (see renderMsn)
  try {
  const issuer = data.metadata.issuer; const pp = data.metadata.processingPeriod;
  const s = fillTokens(stock, { ...issuer, legalName: issuer.name, planName: data.metadata.planName, fraudPhone: stock.info.fraudPhone, periodStart: pp.start, periodEnd: pp.end });
  const claimPages = paginateClaims(data.claims, data.notes || [], HMO_CLAIMS);
  const firstClaimsPage = 2; const backStart = firstClaimsPage + claimPages.length;
  const pageCount = backStart + 1;
  data.metadata.pageCount = pageCount;
  claimPages.forEach((p, i) => { p.pageNumber = firstClaimsPage + i; });
  const fs_ = data.financialSummary;
  const glance = data.claims.map((c) => ({ providerName: c.providerName, claimNumber: c.claimNumber,
    dates: [...new Set(c.lineItems.map((l) => l.dateOfService))].join(', '), owe: c.claimTotal.maxYouMayBeBilled }));
  const view = { oopPct: pct(fs_.oopUsed, fs_.oopMax), oopLeft: r2(Math.max(0, fs_.oopMax - fs_.oopUsed)), pageCount, backStart, glance };
  const ctx = templateContext(data, s, { view });
  const ownBrowser = !opts.browser;   // a caller-supplied browser (opts.browser) is shared and left open
  const browser = opts.browser || await launchBrowser();
  const parts = [];
  try {
    parts.push(await renderPart(browser, 'hmo-eob/page-cover.html', ctx, path.join(work, '.hmo-1.pdf'), { expectPages: 1 }));
    parts.push(await renderPart(browser, 'hmo-eob/pages-claims.html', { ...ctx, claimPages }, path.join(work, '.hmo-2.pdf'), { expectPages: claimPages.length }));
    parts.push(await renderPart(browser, 'hmo-eob/pages-back.html', ctx, path.join(work, '.hmo-3.pdf'), { expectPages: 2 }));
  } finally { if (ownBrowser) await browser.close(); }
  const finalPdf = path.join(outputDir, 'hmo-eob.pdf');
  await mergePdfs(parts, finalPdf, { ...stampMeta(opts), expectedPages: pageCount });
  return finalPdf;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// Paginator settings per layout (exported for tests and debugging).
export const CLAIM_LAYOUTS = { 'ppo-eob': PPO_CLAIMS, 'hmo-eob': HMO_CLAIMS };
