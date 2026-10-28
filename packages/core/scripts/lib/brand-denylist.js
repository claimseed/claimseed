// brand-denylist.js — real organizations that must never appear in the tree or in rendered output: national
// insurers and MA/Part D sponsors, PBMs, pharmacy chains, labs, large hospital systems, every Medicare
// Administrative Contractor and QIO, EHR vendors. Generic terms (medicare, medigap, part d) are not listed.
// Matching is normalization-based so case, spacing, hyphens, HTML entities, tags, zero-width characters and
// fullwidth forms cannot hide a name: long names match as substrings of the squashed text ("unitedhealthcare",
// "blue-cross", "Wal Mart"), short names match as whole words so "hca" does not fire inside "healthcare".
export const BRANDS = [
  // Insurers and Medicare Advantage / Part D sponsors, chosen by rule, not by hand: (a) the parent organizations KFF
  // names in "Medicare Advantage in 2025: Enrollment Update and Key Trends" (UnitedHealth, Humana, CVS Health,
  // Elevance, Kaiser; BCBS affiliates), (b) every publicly traded US health insurer that sponsors MA plans, (c) the
  // consumer brands those parents print on documents. Regional and non-profit plans below ~1M MA enrollees are not
  // enumerated: the generator's lexicon can never produce a real plan name, this list only guards hand-written text.
  'aetna', 'kaiser', 'kaiser permanente', 'unitedhealth', 'united healthcare', 'uhc', 'aarp', 'cigna', 'humana', 'anthem', 'elevance',
  'blue cross', 'blue shield', 'bcbs', 'hcsc', 'health care service corporation', 'wellcare', 'centene', 'molina', 'oscar health', 'alignment health', 'clover health',
  'mutual of omaha', 'highmark', 'healthspring', 'wellpoint', 'allwell', 'ambetter', 'bright health', 'neuehealth', 'railroad medicare', 'alignment healthcare',
  // consumer brands of the parents above (rule c): Elevance, Cigna, CVS, UnitedHealth; and the BCBS affiliates whose
  // names do not contain "Blue Cross"/"Blue Shield"
  'amerigroup', 'simply healthcare', 'healthy blue', 'carelon', 'evernorth', 'accredo', 'oak street health', 'signify health', 'minuteclinic', 'surest', 'rocky mountain health plans',
  'florida blue', 'regence', 'wellmark', 'carefirst', 'excellus', 'horizon blue', 'horizon bcbs', 'independence blue', 'premera', 'capital blue', 'arkansas blue',
  // PBMs / pharmacies / clearinghouses
  'silverscript', 'caremark', 'cvs', 'cvs health', 'walgreens', 'rite aid', 'walmart', 'kroger', 'express scripts', 'optum', 'optumrx',
  'prime therapeutics', 'publix', 'costco', 'amazon pharmacy', 'change healthcare', 'availity',
  // national laboratories
  'labcorp', 'laboratory corporation', 'quest diagnostics', 'bioreference', 'sonic healthcare',
  // Hospital systems: the ten largest US IDNs by net patient revenue per Definitive Healthcare, "Top IDNs by Net
  // Patient Revenue" (accessed 2026-10), plus the two largest publicly traded hospital operators and the two
  // best-known academic brands; no regional selection beyond that rule.
  'hca', 'hca healthcare', 'commonspirit', 'advocate health', 'advocate aurora', 'university of california health', 'uc health', 'providence health', 'providence st joseph',
  'trinity health', 'adventhealth', 'ascension', 'northwell', 'tenet', 'community health systems', 'mayo clinic', 'cleveland clinic',
  // Medicare Administrative Contractors (all jurisdictions) and QIO/BFCC contractors
  'noridian', 'novitas', 'palmetto gba', 'national government services', 'ngs medicare', 'cgs administrators', 'cgs medicare', 'first coast service options', 'wisconsin physicians', 'wps',
  'livanta', 'kepro', 'acentra', 'maximus',
  // EHR / patient portals
  'epic systems', 'mychart', 'cerner', 'oracle health', 'meditech', 'athenahealth', 'allscripts',
];
// Known whole-word false positives that are accepted: "cvs file" (the version-control format), "the kaiser roll",
// "wps file format", "Cerner Street", "novitas research" — none occurs in claimseed text; the short entries stay because
// the real names they guard are printed exactly that way on documents.
// Words that legitimately occur in billing text and must not fire as a brand even though a short entry matches.
const WHOLE_WORD_MAX = 4; // entries this short (squashed: uhc, cvs, hca, epic, aarp, wps ...) match whole words only
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi; // semicolon optional, as browsers tolerate
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '\u00AD', zwsp: '\u200B', zerowidthspace: '\u200B', zwnj: '\u200C', zwj: '\u200D', ensp: ' ', emsp: ' ', thinsp: ' ' };
export function decodeEntities(s) {
  return s.replace(ENTITY, (m, e) => {
    if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; }
    const name = e.toLowerCase();
    if (NAMED[name] !== undefined) return NAMED[name] + (m.endsWith(';') ? '' : '');
    // Legacy entities need no semicolon and browsers take the longest known prefix: "&shyna" is a soft hyphen + "na".
    for (let k = name.length - 1; k >= 2; k--) if (NAMED[name.slice(0, k)] !== undefined) return NAMED[name.slice(0, k)] + e.slice(k) + (m.endsWith(';') ? ';' : '');
    return m;
  });
}
// Normalized words: NFKC, entities decoded, tags removed, zero-width removed, lower-cased, non-alphanumerics -> space.
// Tags are removed in two ways (as a separator and as nothing) so neither "Hum<b></b>ana" nor "<td>Epic</td><td>x" hides a name.
// Cyrillic/Greek letters that look like Latin ones (homoglyphs), folded to their Latin look-alike.
const CONFUSABLES = { '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H', '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0422': 'T', '\u0425': 'X',
  '\u0430': 'a', '\u0441': 'c', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u04BB': 'h', '\u0455': 's',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A7': 'X', '\u03BF': 'o' };
Object.assign(CONFUSABLES, { '\u03B1': 'a', '\u03B9': 'i', '\u03BD': 'v', '\u03BA': 'k', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u', '\u0131': 'i', '\u0251': 'a', '\u0501': 'd', '\u1D00': 'a', '\u1D04': 'c', '\u1D07': 'e', '\u1D0F': 'o', '\u1D18': 'p', '\u1D1B': 't', '\u0261': 'g', '\u01C0': 'l' });
// More look-alikes: the rest of the Cyrillic set, Armenian, Cherokee, Lisu and the phonetic small capitals.
Object.assign(CONFUSABLES, {
  '\u0406': 'I', '\u0407': 'I', '\u0404': 'E', '\u0409': 'Jb', '\u040E': 'Y', '\u0455': 's', '\u04BB': 'h', '\u051B': 'q', '\u051D': 'w', '\u051C': 'W', '\u04CF': 'l', '\u04C0': 'I', '\u0458': 'j', '\u0408': 'J', '\u050D': 'G', '\u0405': 'S', '\u0475': 'v', '\u0474': 'V', '\u0423': 'Y', '\u0443': 'y', '\u0461': 'w', '\u0460': 'W', '\u0493': 'f', '\u04AE': 'Y', '\u0417': '3', '\u04BC': 'E', '\u04BD': 'e', '\u0472': 'O', '\u0473': 'o', '\u0511': 'd', '\u0510': 'D', '\u0503': 'd', '\u04AB': 'c', '\u04AA': 'C',
  '\u0561': 'a', '\u0585': 'o', '\u0578': 'n', '\u057D': 'u', '\u0570': 'h', '\u0581': 'g', '\u0566': 'q', '\u057C': 'n', '\u054F': 'S', '\u053C': 'L', '\u054D': 'U', '\u0555': 'O', '\u0584': 'p', '\u0587': 'u',
  '\u13AA': 'A', '\u13F4': 'B', '\u13DF': 'C', '\u13A0': 'D', '\u13AC': 'E', '\u13C0': 'G', '\u13BB': 'H', '\u13AB': 'J', '\u13E6': 'K', '\u13DE': 'L', '\u13B7': 'M', '\u13AE': 'P', '\u13A1': 'R', '\u13DA': 'S', '\u13A2': 'T', '\u13D9': 'V', '\u13B3': 'W', '\u13C3': 'Z', '\u13CE': 'h', '\u13D2': 'y',
  '\uA4EE': 'A', '\uA4D0': 'B', '\uA4DA': 'C', '\uA4D3': 'D', '\uA4F0': 'E', '\uA4DD': 'F', '\uA4D6': 'G', '\uA4E7': 'H', '\uA4F2': 'I', '\uA4D9': 'J', '\uA4D7': 'K', '\uA4E1': 'L', '\uA4DF': 'M', '\uA4E0': 'N', '\uA4F3': 'O', '\uA4D1': 'P', '\uA4E3': 'R', '\uA4E2': 'S', '\uA4D4': 'T', '\uA4F4': 'U', '\uA4E6': 'V', '\uA4EA': 'W', '\uA4EB': 'X', '\uA4EC': 'Y', '\uA4DC': 'Z',
  '\u0299': 'b', '\uA730': 'f', '\u0262': 'g', '\u029C': 'h', '\u026A': 'i', '\u1D0A': 'j', '\u1D0B': 'k', '\u029F': 'l', '\u1D0D': 'm', '\u0274': 'n', '\u1D29': 'p', '\u0280': 'r', '\uA731': 's', '\u1D1C': 'u', '\u1D20': 'v', '\u1D21': 'w', '\u028F': 'y', '\u1D22': 'z', '\u0237': 'j', '\u0269': 'i', '\u1D8F': 'a',
});
const CONFUSABLE_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');
// invisible or blank-looking characters that are not in Unicode category Cf
const INVISIBLE = /[\u3164\u2800\u115F\u1160\uFFA0\u00A0\u0000-\u001F\u007F]/g;
function normalizeWith(s, tagRepl) {
  let t = decodeEntities(decodeEntities(String(s))); // entities first (so &#x200B; and &shy; become characters), twice for double encoding
  t = t.replace(/<[^>]*>/g, tagRepl);
  t = t.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').replace(ZERO_WIDTH, '').replace(INVISIBLE, ''); // strip combining marks (Aétna), format and invisible characters
  t = t.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c]);
  t = t.replace(/(?<=[a-z])I(?=[a-z])/g, 'l'); // capital I posing as l inside a word (UnitedHeaIthcare)
  t = t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2'); // CamelCase compounds: HumanaChoice, CVSPharmacy
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function normalizeText(s) { return normalizeWith(s, ' '); }
const squash = (s) => s.replace(/\s+/g, '');
const PREFIX_OK = 5; // entries at least this long (squashed) may match at the start of a longer word (unitedhealthcare, aetnamedicare, humanagold, aetna2026)
// Compound words seen in domain names and product names: a leading prefix (my, www, get ...) before the brand, and a
// health-domain suffix after it. A short entry (uhc, cvs, aarp) matches inside a word only with such a suffix.
const COMPOUND_PREFIX = /^(?:my|www|get|go|join|ask|shop|team|e|i|the|visit|portal|member|members)/;
const COMPOUND_SUFFIX = /^(?:medicare|medicaid|pharmacy|health|healthcare|plans?|care|rx|gold|choice|advantage|solutions?|complete|dental|vision|benefits?|member|members|portal|online|connect|direct|now|one|first|plus|select|total|secure|rewards|login|com|net|org|us|\d|[a-z]{2}$)/;   // a trailing state code: bcbsnj, bcbsil
function compoundMatch(e, word) {
  for (const w of [word, word.replace(COMPOUND_PREFIX, '')]) {
    if (!w.startsWith(e.squashed)) continue;
    const rest = w.slice(e.squashed.length);
    if (w !== word && rest === '') return true;                                                 // myaetna, myuhc
    if (rest && (COMPOUND_SUFFIX.test(rest) || (e.squashed.length >= PREFIX_OK && w !== word))) return true;   // myaetna-anything; uhc + medicare...
  }
  return false;
}
const ENTRIES = BRANDS.map((b) => ({ name: b, squashed: squash(normalizeText(b)), words: normalizeText(b) }));
// Squashed text plus the set of offsets where a word starts / ends, so "managed care marketing" cannot match "caremark".
function squashedWithBounds(words) {
  const starts = new Set(), ends = new Set(); let sq = '';
  for (const w of words.split(' ')) { if (!w) continue; starts.add(sq.length); sq += w; ends.add(sq.length); }
  return { sq, starts, ends };
}
function matchesSquashed(e, { sq, starts, ends }) {
  let i = sq.indexOf(e.squashed);
  while (i >= 0) {
    const end = i + e.squashed.length;
    // a match must start at a word start and either end at a word end, or (for names of 5+ letters) sit at the start
    // of one word followed by a known compound suffix (aetnamedicare, humanagold, aetna2026) — never straddle a word
    // boundary ("care marketing" is not caremark) and never a mere inflection ("tenets", "ascensions")
    let inside = true; for (let k = i + 1; k < end; k++) if (starts.has(k)) { inside = false; break; }
    if (starts.has(i) && (ends.has(end) || (e.squashed.length >= PREFIX_OK && inside && COMPOUND_SUFFIX.test(sq.slice(end))))) return true;
    i = sq.indexOf(e.squashed, i + 1);
  }
  return false;
}
// Returns the distinct brand names found in `text`.
export function findBrands(text) {
  const hits = new Set();
  for (const tagRepl of [' ', '']) {
    const words = normalizeWith(text, tagRepl);
    // Also join runs of single letters ("u h c" from "U.H.C.") so initialisms match as words.
    const joined = words.replace(/\b(?:[a-z0-9] )+[a-z0-9]\b/g, (m) => m.replace(/ /g, ''));
    const padded = [' ' + words + ' ', ' ' + joined + ' '];
    const bounds = squashedWithBounds(words);
    const wordList = words.split(' ').filter(Boolean);
    for (const e of ENTRIES) {
      if (e.squashed.length > WHOLE_WORD_MAX ? matchesSquashed(e, bounds) : padded.some((p) => p.includes(' ' + e.words + ' '))) hits.add(e.name);
      else if (wordList.some((w) => compoundMatch(e, w))) hits.add(e.name);
    }
  }
  return [...hits];
}
