// examples-check.js — the comparison examples.js --check makes, apart from rendering, so it can be tested on its own.
//   examples   every planned example (scripts/lib/rendered-plan.js), in order
//   results    the examples rendered in this run (all of them, or one part's share)
//   recorded   the manifest's entries; readmeNow the README as it stands; readme(entries) the README they make
//   whole      true when results hold every example (then the README is built from them, as before parts existed)
// Returns one message per difference. When every part of a split check returns none, the whole check would too: every
// part compares the manifest's keys with the whole plan and the README with the manifest, and each part compares its
// own results with their entries, every field.
export const exampleKey = (e) => `${e.type}/${e.scenario}/${e.seed}${e.layoutVariant ? `.${e.layoutVariant}` : ''}`;
export function compareExamples({ examples, results, recorded, readmeNow, readme, whole }) {
  const bad = []; const byKey = new Map(recorded.map((e) => [exampleKey(e), e]));
  const planned = new Set(examples.map(exampleKey));
  for (const k of planned) if (!byKey.has(k)) bad.push(`${k}: not in the manifest`);
  for (const k of byKey.keys()) if (!planned.has(k)) bad.push(`${k}: in the manifest but no longer published`);
  const show = (v) => { const t = JSON.stringify(v ?? null); return t.length > 80 ? `${t.slice(0, 77)}...` : t; };
  for (const r of results) {
    const w = byKey.get(exampleKey(r)); if (!w) continue;
    for (const f of [...new Set([...Object.keys(w), ...Object.keys(r)])].sort()) if (JSON.stringify(w[f] ?? null) !== JSON.stringify(r[f] ?? null)) bad.push(`${exampleKey(r)}: ${f} ${show(w[f])} -> ${show(r[f])}`);
  }
  if (readmeNow !== readme(whole ? results : recorded)) bad.push('examples/README.md is out of date');
  return bad;
}
