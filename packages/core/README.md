# @claimseed/core

`@claimseed/core` renders fully synthetic US medical-billing specimen documents — Medicare Summary Notices,
itemized provider bills and, over time, other notices — as PDFs with a machine-readable ground truth beside each
one. Every value on a page is derived from a seed by a small rules engine (fictional people and facilities,
public fee-schedule amounts, Original Medicare Part B adjudication), and a scenario file decides which error, if
any, is deliberately injected and which public rule it breaks. The output exists to test extractors, bill-review
tools and training pipelines; nothing in it is, or is derived from, a real document.

## CLI


```sh
# what can be rendered
node src/cli.js list                 # every type/scenario
node src/cli.js list msn             # one type

# data + ground truth as JSON on stdout, no browser needed
node src/cli.js generate msn baseline-clean --seed demo

# PDF + <name>.ground-truth.json in DIR
node src/cli.js render msn baseline-clean --seed demo --out ./output
node src/cli.js render itemized-bill balance-billing --seed demo --out ./output
node src/cli.js render ppo-eob baseline-clean --seed demo --out ./output   # also hmo-eob
```

Rendering needs a Chrome or Chromium binary. The engine looks at `$CLAIMSEED_CHROME`, then
`$PUPPETEER_EXECUTABLE_PATH`, then the usual install paths; set `CLAIMSEED_NO_SANDBOX=1` only inside a locked-down
container. Output files are named `<type>_<scenario>_<seed>.pdf` and `<type>_<scenario>_<seed>.ground-truth.json`
(schema: `schemas/ground-truth.schema.json` in the repository — not in the npm package — and validated by the test suite). Same seed, same
scenario, same package version → byte-identical data. Every PDF carries `Subject: synthetic specimen, not a real
document` in its metadata, a specimen band at the foot of every page and a diagonal watermark drawn as shapes
(so text extraction never sees stray letters); the markers are stamped into the finished PDF inside `mergePdfs`,
which every render function goes through, whether it is reached from the CLI or from the library.

## Library

```js
import { generateData, listScenarios, render, RENDERERS } from '@claimseed/core';
listScenarios('msn');                                                             // ['baseline-clean', ...]
const { data, groundTruth } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'demo' });
const out = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'demo', outDir: './out' });  // { pdf, groundTruth, bytes }
```

`RENDERERS[type](data, stock, workDir, { band, title })` is the lower-level entry the CLI and `render()` use; it returns
the path of a finished, stamped PDF inside `workDir`.

```sh
npm test          # unit tests, including one render-free pass over every scenario with many seeds
npm run check     # repo-wide synthetic-data checks (sources present, no real-format NPIs, phones in the fiction block)
```

## Scenario files

A scenario is one JSON file at `scenarios/<type>/<slug>.json`. It describes a *situation*, not a document: the
engine draws the people, providers, codes and amounts from the seed, and the scenario says how many claims, over
which period, and which mutations to apply.

```jsonc
{
  "type": "msn",                        // document type; must have an assembler and a renderer (see below)
  "slug": "lab-coinsurance-charged",    // == the file name
  "status": "published",                // "published" or "engine-test" (engine-test files block a release)
  "description": "One or two sentences a tester reads to know what the specimen exercises.",
  "period": { "start": "2026-03-01", "end": "2026-03-31" },   // claims-processed window; year sets the CMS parameters
  "claimCount": 3,                      // claims on the notice; each claim has 1–5 lines
  "claimShapes": ["LAB"],               // optional: force the specialty/shape of claim i so a mutation lands on the
                                        // right kind of line for ANY seed. Shapes: IM, LAB, CARD, OPH, PT, RAD, DERM, FP
  "referenceSurname": true,             // optional: patient surname "Specimen"
  "deductibleMetBefore": 0,             // optional: Part B deductible already met before the period, in dollars
  "mutations": [                        // applied in order; each produces one ground-truth error
    { "op": "apply-cost-share-to-exempt-line", "args": { "claim": 0, "line": 0, "rate": 0.2 },
      "kind": null, "severity": null, "rule": null, "note": null }   // optional overrides of what the op reports
  ],
  "sources": [                          // REQUIRED, 2–4 entries: where the structure, codes and rule came from.
    { "what": "No deductible or coinsurance on lab fee schedule tests", "source": "SSA §1833(a)(1)(D), https://www.ssa.gov/OP_Home/ssact/title18/1833.htm" }
  ]
}
```

Mutation ops (`src/generate/mutations.js`) and the error kind each reports:

| op | args | kind |
| --- | --- | --- |
| `duplicate-line` | claim, line | `duplicate-charge` |
| `break-claim-total` | claim, field (`maxYouMayBeBilled`, `amountProviderCharged`, `medicareApprovedAmount`, `amountMedicarePaid`), by | `math-error` (override `kind` to `subtotals-mismatch` on a bill) |
| `apply-cost-share-to-exempt-line` | claim, line, rate | `cost-sharing-error` on a lab line, `preventive-cost-sharing` on a preventive line |
| `reapply-deductible` | claim, line | `deductible-misapplied` |
| `deny-line` | claim, line, note `{ text, rule }` | `coverage-denial` |
| `shift-date` | claim, line, days | `service-date-anomaly` |
| `overprice-line` | claim, line, factor | `fee-schedule-overcharge` |
| `bill-above-approved` | claim, line, mode (`unpaid-balance` or `extra`), by | `assignment-violation` (provider-side documents only) |

Indices are zero-based; `claim` must be below `claimCount`. Line 0 always exists; use `claimShapes` when a
mutation needs a particular kind of line or a line beyond index 0 (for example `DERM` always has two lines).

## Adding a scenario

1. Pick the document type and the error kind from `docs/error-taxonomy.md`. If the kind is new, add a row there
   with the public rule it violates.
2. Write `scenarios/<type>/<slug>.json` as above. Set `claimShapes` so the mutation lands on the intended kind of
   line for every seed, and describe the specimen as a tester would want to read it.
3. Cite 2–4 public sources (CMS manuals and fact sheets, medicare.gov, eCFR, ssa.gov, MLN booklets, NCCI pages)
   and open every URL before you cite it. Do not cite, consult or describe any real statement.
4. Run `npm test` (the catalog test generates every scenario with many seeds) and render it once:
   `node src/cli.js render <type> <slug> --seed test --out /tmp/out`, then read the PDF text.

## Adding a document type

1. Templates: `templates/<type>/*.html` (Nunjucks, extending `base-portrait.html`) and stock text, labels and
   colors in `data/<type>/stock-content.json`. Every sentence of stock content is either verbatim from a public
   federal model document (the CMS sample MSN, 45 CFR 92 Appendices A/B, HHS and CMS pages) or claimseed's own
   wording; `data/SOURCES.md` records which, and `scripts/verify-stock-sources.js` checks it against the snapshots
   in `data/public-sources/`. No real organization's name, logo, colors or boilerplate.
2. Renderer: a `render<Type>(data, stock, outDir)` function in `src/render.js` that paginates and returns the PDF
   path; register it in `RENDERERS` in `src/layouts.js`.
3. Assembler: `src/generate/<type>.js` exporting `assemble<Type>({ rng, beneficiary, adjudicated, period,
   dateOfNotice, year, groundTruthErrors })`, which turns the shared beneficiary and adjudicated claims into the
   exact object the templates read. Keys starting with `_` are neither rendered nor flattened into ground truth;
   `_groundTruth` may override the entities block (providers, identifiers, payer). Register it in `ASSEMBLERS` in
   `src/generate/index.js`. `src/generate/itemized-bill.js` is the smallest worked example.
4. Scenarios: at least a clean control and one error scenario in `scenarios/<type>/`, plus a test in
   `test/generate.test.js` that checks the assembled numbers reconcile.

## Synthetic-data rules

Everything the engine prints comes from `src/generate/lexicon.js` (fictional names, fictional streets, real cities
so addresses format correctly), from format-valid identifiers that cannot be real (NPIs start with 9 and are
Luhn-valid over the 80840 prefix; Medicare numbers carry `S` in position 2, a letter CMS never uses; phones are a
geographic area code plus `555-01xx`; facility tax IDs use the unissued `00-` prefix; web addresses end in the
reserved `.example` domain), and from amounts the rules engine computes from the service catalog and the CMS
annual parameters. Service descriptions are claimseed's plain language, never AMA CPT descriptors; HCPCS Level II
codes are preferred; a service added without a verified public price carries `"verified": false`, a round
illustrative `allowed`, and a `sources` entry saying where a maintainer should look it up. Contributors never
attach, link, paste, or describe from memory any real statement, bill, notice or lab report, never fit anything
to one, and never add a real insurer's, pharmacy's or laboratory's name or branding. See
`docs/synthetic-data-policy.md`; `npm run check` enforces what it can.
