#!/usr/bin/env node
// fetch-reference-data.js — populate verified allowed amounts in reference-data/service-catalog.json from
// the public CMS files, on YOUR machine. CMS gates the Physician Fee Schedule RVU file behind an AMA CPT
// license notice; by running this you accept that notice yourself. Nothing is redistributed by claimseed
// except the handful of per-code national amounts the catalog already lists, with the source recorded.
//
//   node scripts/fetch-reference-data.js --year 2026 \
//        --rvu https://www.cms.gov/files/zip/rvu26a-updated-12-29-2025.zip \
//        --clfs <26CLABQ1 zip url from https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory-fee-schedule-clfs/files>
//
// MPFS national amount = (work RVU × work GPCI + PE RVU × PE GPCI + MP RVU × MP GPCI) × conversion factor;
// with GPCIs of 1.0 this is the "national" figure. CLFS amounts are national by construction. ASP amounts
// (vaccines) come from the quarterly ASP file; this script leaves ASP codes for manual entry with a citation.
import fs from 'fs'; import path from 'path'; import os from 'os'; import { execFileSync } from 'child_process';
const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const year = arg('year', '2026'); const rvuUrl = arg('rvu'); const clfsUrl = arg('clfs');
if (!rvuUrl || !clfsUrl) { console.error('usage: --year Y --rvu <zip url> --clfs <zip url>'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claimseed-ref-'));
function fetchZip(url, name) {
  if (!/^https:\/\/www\.cms\.gov\//.test(url)) throw new Error('only https://www.cms.gov/ URLs are accepted');
  const p = path.join(tmp, name);
  execFileSync('curl', ['-sS', '-L', '--max-redirs', '2', '--proto', '=https', '-o', p, url]);
  execFileSync('unzip', ['-o', '-q', p, '-d', path.join(tmp, name + '.d')]);
  return path.join(tmp, name + '.d');
}
function findFile(dir, re) { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) { const r = findFile(p, re); if (r) return r; } else if (re.test(f)) return p; } return null; }
function parseCsv(p) { return fs.readFileSync(p, 'latin1').split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim())); }
const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'reference-data/service-catalog.json'), 'utf-8'));
// --- MPFS: PPRRVU csv (national RVUs) ---
const rvuDir = fetchZip(rvuUrl, 'rvu');
const rvuCsv = findFile(rvuDir, /^PPRRVU.*\.csv$/i); if (!rvuCsv) throw new Error('PPRRVU csv not found in RVU zip');
const rows = parseCsv(rvuCsv);
const hdrIdx = rows.findIndex((r) => r.some((c) => /^HCPCS$/i.test(c)));
const hdr = rows[hdrIdx].map((c) => c.toUpperCase());
const col = (re) => hdr.findIndex((c) => re.test(c));
const iCode = col(/^HCPCS$/), iMod = col(/^MOD/), iWork = col(/WORK RVU/), iPE = col(/NON-?FACILITY PE RVU|NON-?FAC PE RVU/), iMP = col(/^MP RVU/), iCF = col(/CONV(ERSION)? FACTOR/);
let cf = null; for (const r of rows.slice(hdrIdx + 1)) { if (r[iCF] && +r[iCF] > 0) { cf = +r[iCF]; break; } }
if (!cf) throw new Error('conversion factor not found; pass --cf');
const mpfs = {}; for (const r of rows.slice(hdrIdx + 1)) if (r[iCode] && !r[iMod]) mpfs[r[iCode]] = (+r[iWork] + +r[iPE] + +r[iMP]) * cf;
// --- CLFS ---
const clfsDir = fetchZip(clfsUrl, 'clfs');
const clfsFile = findFile(clfsDir, /\.(csv|txt)$/i); const clfs = {};
for (const r of parseCsv(clfsFile)) { if (/^\d{5}$/.test(r[0]) && /^\d+(\.\d+)?$/.test(r[1] || '')) clfs[r[0]] = +r[1]; }
let n = 0;
for (const s of cat.services) {
  let v = null, src = null;
  if (s.feeSchedule === 'MPFS' && mpfs[s.code] != null) { v = mpfs[s.code]; src = `MPFS ${year} national (RVUs × CF ${cf}), ${rvuUrl}`; }
  if (s.feeSchedule === 'CLFS' && clfs[s.code] != null) { v = clfs[s.code]; src = `CLFS ${year}, ${clfsUrl}`; }
  if (v != null) { s.allowed = Math.round(v * 100) / 100; s.verified = true; s.source = src; n++; }
}
cat.year = +year; cat.priceSource = n === cat.services.length ? 'cms-public-files' : 'partially-verified';
fs.writeFileSync(path.join(ROOT, 'reference-data/service-catalog.json'), JSON.stringify(cat, null, 2) + '\n');
console.log(`verified ${n} of ${cat.services.length} prices; remaining (ASP) need manual entry with citation`);
