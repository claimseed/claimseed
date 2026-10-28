// text-rules.js — rules applied both to the committed tree (check-synthetic.js) and to rendered text
// (scan-rendered.js), so the two gates cannot drift apart.
// Public federal lines printed on CMS/HHS model documents: 1-800-MEDICARE and TTY, Social Security and TTY, HHS OCR voice and TDD.
export const FEDERAL = new Set(['8006334227', '8774862048', '8007721213', '8003250778', '8003681019', '8005377697']);
// Phone candidates: any separator run (spaces, hyphens, en/em dashes, dots, parentheses) between the groups, plus bare
// 10-digit runs next to call/phone/tel/fax/tty wording and 1-8XX vanity numbers. Toll-free prefixes are never allowed
// (8XX-555-01xx is assignable), so a 555-01xx number must carry a geographic area code.
// foldText: NFKC (fullwidth digits and letters) and every dash-like character (U+2010..2015, U+2212 minus,
// U+FE58/FE63/FF0D, soft hyphen) to '-'; applied before every rule below. The phone rule additionally splits
// CamelCase so "homePhone" reads "home Phone" (the split is not applied to payload detection, where it would break base64 runs).
export function foldText(t) {
  return String(t).normalize('NFKC').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u00AD]/g, '-');
}
const SEP = '[\\s.\\-\u2013\u2014)/]*';
const PHONE_RE = new RegExp('\\(?\\b([2-9]\\d{2})' + SEP + '(\\d{3})' + SEP + '(\\d{4})\\b', 'g');
const BARE_RE = /\b(?:call|ph|phone|tel|telephone|fax|tty|tdd|dial|service|services|hotline|contact|help|support|line|questions|mobile|cell|number|home|work|office|reach|text)\b[^\d]{0,48}\b(1?\d{10})\b/gi;
// 1-8XX followed by seven letters/digits in any grouping with at least three letters among them (a vanity number)
const VANITY_RE = /\b(?:1[ .-]?)?8(?:00|33|44|55|66|77|88)[ .-]?(?:[A-Z0-9][ .-]?){6,10}[A-Z0-9]\b/g;
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);
export function phoneProblems(t, r, out) {
  t = foldText(t).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');   // homePhone, phone_number
  const seen = new Set();
  for (const m of t.matchAll(PHONE_RE)) {
    const digits = m[1] + m[2] + m[3];
    if (/^\d{10}$/.test(m[0])) continue; // bare 10-digit integers in code are not phones (BARE_RE handles prose)
    if (seen.has(digits)) continue; seen.add(digits);
    if (!(/^[2-9]\d{2}55501\d{2}$/.test(digits) && !TOLL_FREE.has(m[1])) && !FEDERAL.has(digits)) out.push(`phone outside geographic 555-01xx: ${m[0].trim()} in ${r}`);
  }
  for (const m of t.matchAll(BARE_RE)) {
    const d = m[1].replace(/^1/, '');
    const before = t.slice(Math.max(0, m.index + m[0].length - m[1].length - 64), m.index + m[0].length - m[1].length);
    if (/\b(?:NPI|account|acct|member|claim|reference|policy|group|ID|TIN|EIN)\b[^\d]{0,60}$/i.test(before)) continue;   // an identifier printed after its label is not a phone (identifier rules judge those)
    if (!seen.has(d) && !(/^[2-9]\d{2}55501\d{2}$/.test(d) && !TOLL_FREE.has(d.slice(0, 3))) && !FEDERAL.has(d)) out.push(`bare phone number ${m[1]} in ${r}`);
  }
  for (const m of t.matchAll(VANITY_RE)) { const an = m[0].replace(/^1?[ .-]?8\d\d[ .-]?/, '').replace(/[ .-]/g, ''); if ((an.match(/[A-Z]/g) || []).length >= 3 && !/^MEDICARE$/.test(an)) out.push(`vanity toll-free number ${m[0]} in ${r}`); }
}

// A real-format Medicare Beneficiary Identifier. Synthetic MBIs carry the letter S, which the CMS alphabet excludes.
export const REAL_MBI = /\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d[AC-HJKMNP-RT-Y]{2}\d{2}\b/g;
// Words that mix Latin letters with letters of a script that has Latin look-alikes (Cyrillic, Greek, Armenian,
// Cherokee, Lisu, Georgian, Coptic). Legitimate text never does this; a homoglyph-disguised brand name always does.
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Lisu}\p{Script=Georgian}\p{Script=Coptic}]/u;
export function mixedScriptWords(t) {
  const out = new Set();
  for (const m of String(t).matchAll(/\p{L}+/gu)) if (/\p{Script=Latin}/u.test(m[0]) && LOOKALIKE.test(m[0])) out.add(m[0]);
  return [...out];
}
