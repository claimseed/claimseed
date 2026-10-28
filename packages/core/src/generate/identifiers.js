// identifiers.js — format-valid, collision-safe synthetic identifiers.
// NPI: Luhn-valid with the 80840 prefix as NPPES computes it, but the first digit is always 9.
//      NPPES issues only NPIs beginning with 1 (2 is reserved), so a 9-prefixed NPI cannot
//      belong to a real provider. verify-synthetic-npi.js enforces this in CI.
// MBI: 11 characters in the CMS pattern (C A AN N A AN N A A N N), with position 2 fixed to 'S'
//      as the claimseed sentinel so a specimen MBI is recognizable on sight.
// Phone: (geographic area code) 555-01xx — the only 555 range reserved for fiction; never toll-free.

const MBI_LETTERS = 'ACDEFGHJKMNPQRTUVWXY'; // CMS excludes S L O I B Z
const MBI_DIGITS = '0123456789';
function pick(rng, s) { return s[Math.floor(rng() * s.length)]; }

export function luhnCheckDigit(prefixDigits) {
  // standard Luhn over the digit string; returns the check digit
  let sum = 0, dbl = true;
  for (let i = prefixDigits.length - 1; i >= 0; i--) {
    let d = +prefixDigits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10;
}
export function syntheticNpi(rng) {
  let body = '9';
  for (let i = 0; i < 8; i++) body += pick(rng, MBI_DIGITS);
  return body + luhnCheckDigit('80840' + body);
}
export function isSyntheticNpi(npi) {
  return /^9\d{9}$/.test(npi) && luhnCheckDigit('80840' + npi.slice(0, 9)) === +npi[9];
}
export function syntheticMbi(rng) {
  // positions: 1 digit1-9, 2 letter (sentinel S not in CMS alphabet -> we use 'S' deliberately), 3 letter|digit,
  // 4 digit, 5 letter, 6 letter|digit, 7 digit, 8 letter, 9 letter, 10 digit, 11 digit
  const an = () => (rng() < 0.5 ? pick(rng, MBI_LETTERS) : pick(rng, MBI_DIGITS));
  const d = () => pick(rng, MBI_DIGITS);
  const a = () => pick(rng, MBI_LETTERS);
  const p1 = pick(rng, '123456789');
  return p1 + 'S' + an() + d() + a() + an() + d() + a() + a() + d() + d();
}
export function isSyntheticMbi(mbi) { return /^[1-9]S[A-Z0-9]\d[A-Z][A-Z0-9]\d[A-Z]{2}\d{2}$/.test(mbi); }
export function phone555(rng, areaCode) {
  const n = String(Math.floor(rng() * 100)).padStart(2, '0');
  return `${areaCode}-555-01${n}`;
}
export function digits(rng, n) { let s = ''; for (let i = 0; i < n; i++) s += pick(rng, MBI_DIGITS); return s; }
// Claim, account and member numbers all carry a sentinel so a leaked real number can never be mistaken
// for a generated one: MSN-style claim numbers start with 99 (13 digits), MA claim numbers with 'CS',
// member IDs with 'SPEC', account numbers with 99 (10 digits).
export function claimNumber(rng, style = 'msn') {
  if (style === 'msn') return '99' + digits(rng, 11);
  return 'CS' + digits(rng, 10);
}
export function memberId(rng) { return 'SPEC' + digits(rng, 8); }
export function accountNumber(rng) { return '99' + digits(rng, 8); }
