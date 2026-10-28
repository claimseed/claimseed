// rng.js — one seeded stream per generation, derived from a string seed.
import { mulberry32, deriveSeed } from './prng.js';
export function makeRng(seed, ...salt) { return mulberry32(deriveSeed(String(seed), ...salt)); }
export function pickOne(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function pickWeighted(rng, items, weightOf) {
  const total = items.reduce((s, it) => s + weightOf(it), 0);
  let r = rng() * total;
  for (const it of items) { r -= weightOf(it); if (r <= 0) return it; }
  return items[items.length - 1];
}
export function intBetween(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
export function shuffle(rng, arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
