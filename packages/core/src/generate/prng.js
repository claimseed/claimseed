// prng.js — seeded, platform-stable pseudo-random helpers. mulberry32 is a small 32-bit generator using only
// integer and float operations that behave identically everywhere; deriveSeed folds strings into a uint32 via FNV-1a.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(prng, mean = 0, sigma = 1) {
  let u1 = prng(); while (u1 <= Number.EPSILON) u1 = prng();
  const u2 = prng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * sigma + mean;
}
export function deriveSeed(...parts) {
  let h = 0x811c9dc5;
  const str = parts.join('\u001f');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
