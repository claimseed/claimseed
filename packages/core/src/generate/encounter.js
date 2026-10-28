// encounter.js — a month of Part B services for one beneficiary, drawn from the service catalog
// with category weights. Dates are relative to the processing period; nothing is copied from any document.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pickWeighted, intBetween, shuffle } from './rng.js';
import { makeProvider } from './entities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../reference-data/service-catalog.json'), 'utf-8'));
const byCode = Object.fromEntries(CATALOG.services.map((s) => [s.code, s]));
export function service(code) { const s = byCode[code]; if (!s) throw new Error(`unknown service code ${code}`); return s; }

const CLAIM_SHAPES = [
  { specialty: 'IM', lines: [['visit'], ['lab', 'lab', 'lab', '36415']], weight: 5 },
  { specialty: 'LAB', lines: [['lab', 'lab', '36415'], ['lab', 'lab', 'lab', 'lab', '36415']], weight: 4 },
  { specialty: 'CARD', lines: [['visit', '93000']], weight: 2 },
  { specialty: 'OPH', lines: [['92014']], weight: 2 },
  { specialty: 'PT', lines: [['97110'], ['97110']], weight: 2 },
  { specialty: 'RAD', lines: [['71046']], weight: 1 },
  { specialty: 'DERM', lines: [['visit', '11102']], weight: 1 },
  { specialty: 'FP', lines: [['G0439', 'G0444']], weight: 2 },
];
// Pick a service for a slot. A slot is either a literal code or a category; a category pick never repeats a code
// already on the same claim (`taken`), so a clean claim never contains an accidental duplicate line.
function pickService(rng, slot, taken = new Set()) {
  if (byCode[slot]) return byCode[slot];
  let pool = CATALOG.services.filter((s) => s.category === slot && !['36415'].includes(s.code) && !taken.has(s.code));
  if (!pool.length) pool = CATALOG.services.filter((s) => s.category === slot && !['36415'].includes(s.code));
  if (!pool.length) throw new Error(`service catalog has no services in category ${slot}`);
  return pickWeighted(rng, pool, (s) => s.weight);
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

export const CLAIM_SHAPE_NAMES = CLAIM_SHAPES.map((s) => s.specialty);

/**
 * Build claims for a processing period. opts: { claimCount, periodStart, periodEnd, claimShapes }
 * claimShapes (optional): array of CLAIM_SHAPES specialty codes, by claim index. A scenario uses it to
 * guarantee what kind of line a mutation will land on for ANY seed (e.g. ['LAB'] makes claim 0 a lab claim
 * whose every line is a CLFS test, ['FP'] makes line 0 a $0 preventive service). Entries may be null.
 * Claim i keeps index i in the output; dates are assigned in ascending order by index (see below).
 */
export function makeEncounters(rng, place, opts) {
  const start = new Date(opts.periodStart + 'T00:00:00Z');
  const end = new Date(opts.periodEnd + 'T00:00:00Z');
  const span = Math.round((end - start) / 86400000);
  const n = opts.claimCount ?? intBetween(rng, 2, 4);
  const shapes = shuffle(rng, CLAIM_SHAPES);
  const forced = opts.claimShapes || [];
  const claims = [];
  for (let i = 0; i < n; i++) {
    let shape;
    if (forced[i]) {
      shape = CLAIM_SHAPES.find((s) => s.specialty === forced[i]);
      if (!shape) throw new Error(`unknown claim shape ${forced[i]} (known: ${CLAIM_SHAPE_NAMES.join(', ')})`);
    } else {
      shape = pickWeighted(rng, shapes, (s) => s.weight);
    }
    const provider = makeProvider(rng, place, shape.specialty);
    const lineSlots = shape.lines[intBetween(rng, 0, shape.lines.length - 1)];
    const dos = isoDate(addDays(start, intBetween(rng, 0, Math.max(0, span - 3))));
    const taken = new Set();
    const lines = lineSlots.map((slot) => {
      const svc = pickService(rng, slot, taken); taken.add(svc.code);
      const units = svc.unitsTypical ? intBetween(rng, svc.unitsTypical[0], svc.unitsTypical[1]) : 1;
      return { code: svc.code, lay: svc.lay, units, dateOfService: dos, allowedEach: svc.allowed, feeSchedule: svc.feeSchedule,
        preventiveNoCostShare: !!svc.preventiveNoCostShare, labNoCostShare: !!svc.labNoCostShare };
    });
    claims.push({ provider, dateOfService: dos, lines });
  }
  // Chronological order WITHOUT reordering claims: the i-th claim keeps its shape and provider and receives
  // the i-th earliest date, so a scenario's claim index always points at the claim it was written for.
  const dates = claims.map((c) => c.dateOfService).sort();
  claims.forEach((c, i) => { c.dateOfService = dates[i]; for (const l of c.lines) l.dateOfService = dates[i]; });
  return claims;
}
