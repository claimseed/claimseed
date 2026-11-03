# @claimseed/core

`@claimseed/core` renders fully synthetic US medical-billing specimen documents (Medicare Summary Notices,
itemized provider bills, Medicare Advantage explanations of benefits and, over time, other notices) as PDFs with a
machine-readable ground truth beside each one. Every value on a page is derived from a seed by a small rules engine
(fictional people and facilities, public fee-schedule amounts, Original Medicare Part B adjudication or a fictional
Medicare Advantage plan's), and a scenario file decides which error, if any, is deliberately injected and which
public rule it breaks. The output exists to test extractors, bill-review tools and training pipelines; nothing in
it is, or is derived from, a real document.

## CLI


```sh
# what can be rendered
node src/cli.js list                 # every type/scenario
node src/cli.js list msn             # one type

# data + ground truth as JSON on stdout, no browser needed
node src/cli.js generate msn baseline-clean --seed demo

# PDF + <name>.ground-truth.json in DIR
node src/cli.js render msn baseline-clean --seed demo --out ./output
node src/cli.js render msn baseline-clean --seed demo --out ./output --degrade scan   # also fax, photo, low-res
node src/cli.js render msn baseline-clean --seed demo --out ./output --also 835       # also the X12 835 of the same claims
node src/cli.js render itemized-bill balance-billing --seed demo --out ./output
node src/cli.js render ppo-eob baseline-clean --seed demo --out ./output   # also hmo-eob
node src/cli.js render ppo-eob baseline-clean --seed demo --out ./output --layout-variant p07   # also seeded, all; not msn

# a set: PDFs, answer keys and manifest.jsonl (SHA-256 of each file, the degradation preset or null, claimseed and Chrome versions) in a new DIR;
# with --also 835 (types msn, ppo-eob and hmo-eob only), each document also gets its .835, listed in the manifest with its SHA-256
node src/cli.js batch --types msn,itemized-bill --seeds 50 --out ./set          # --scenarios all|S1,S2  --seed-prefix P  --degrade PRESET
node src/cli.js batch --types ppo-eob,hmo-eob --seeds 20 --layout-variant seeded --out ./set   # or an id, or all; never with msn

# score an extractor's report (see "Scoring an extractor" below)
node src/cli.js verify --manifest ./set/manifest.jsonl --outputs ./reports     # one <pdf name>.json per document
node src/cli.js verify --answer-key ./set/X.ground-truth.json --output report.json
node src/cli.js verify msn duplicate-office-visit --seed demo --output report.json   # rebuilds the key from the seed
node src/cli.js verify ppo-eob duplicate-visit --seed demo --layout-variant p07 --output report.json   # a variant's key
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
import { generateData, listScenarios, render, RENDERERS, scoreExtraction, verifyFromSeed, renderBatch } from '@claimseed/core';
listScenarios('msn');                                                             // ['baseline-clean', ...]
const { data, groundTruth } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'demo' });
const out = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'demo', outDir: './out' });  // { pdf, groundTruth, bytes }
const score = scoreExtraction(groundTruth, { fields: { /* path: value */ }, errors: [ /* { kind, fieldRef } */ ] });
await renderBatch({ types: ['msn'], scenarios: 'all', seeds: 20, outDir: './set' });                 // { count, manifest }
await render({ type: 'ppo-eob', scenario: 'baseline-clean', seed: 'demo', outDir: './out', layoutVariant: 'p07' });  // or 'seeded'
```

`RENDERERS[type](data, stock, workDir, { band, title })` is the lower-level entry the CLI and `render()` use; it returns
the path of a finished, stamped PDF inside `workDir`.

```sh
npm test          # unit tests, including one render-free pass over every scenario with many seeds
npm run check     # repo-wide synthetic-data checks (sources present, no real-format NPIs, phones in the fiction block)
```

## Degraded copies

`--degrade scan|fax|photo|low-res` (on `render` and `batch`) and `renderDegraded({ type, scenario, seed, preset, outDir })`
make a scanned-looking copy of a document:

| Preset | What it does |
| --- | --- |
| `scan` | 200 dpi; off-white paper, a turn under 1 degree and a small shift, softening, grain and dust; JPEG |
| `fax` | 200 dpi black and white after a threshold, standard (half vertical resolution) or fine, a turn, speckle and line streaks, the watermark printed again as a dot pattern; PNG |
| `photo` | 150 dpi; the page on a table, the far edge narrower, a turn of up to 4 degrees, uneven light, blur and grain; JPEG |
| `low-res` | 60 to 90 dpi, heavy JPEG compression |

Any other preset, or an empty value such as `--degrade ''`, is refused with exit code 2 before anything is rendered or
written, and the error message does not repeat the value. Every option of the command line refuses an empty value the
same way. An unknown option, the `--name=value` form, an option given twice and an extra argument are refused too.

Each page of the stamped PDF is drawn with PDF.js in an isolated page of the browser (`src/pdf-raster.js`), degraded
there with settings from the seed, and put back together as an image-only PDF. That PDF is then stamped like every
other claimseed PDF, so the band, the watermark and the specimen metadata sit on top of the degraded pages. Page images
are drawn from the stamped PDF and carry the file markers. `render --degrade` writes `<type>_<scenario>_<seed>_<preset>.pdf`,
its `.ground-truth.json` and `_p<N>.jpg` (`.png` for a fax); `batch --degrade` writes the PDF and answer key of each
document, without page images. The answer key keeps the document's fields and errors and
records `degradation` and `degradationParams` (ground truth 1.2 and later). The same seed always gives the same settings; the
pictures match within a small pixel tolerance on one Chrome build.

## The claims block

Beside `documents[0].fields` (every printed value), the answer key's `claims` block is the adjudication the document
was assembled from: one entry per claim, and per line the code, units, date, charged, allowed, approved, paid and
what the patient may be billed, after any planted errors. From ground truth 1.3 each line also splits the patient's
share into `toDeductible`, `coinsurance`, `copay` and `nonCovered` (a denied service the patient agreed to pay for),
which add up to `patientMayBeBilled` to the cent; Part B lines have no copay. `deductibleMetBefore` is the deductible
already met before the document's claims. On the Medicare Summary Notice the printed deductible met is
`deductibleMetBefore` plus the lines' deductible, capped at the annual deductible (a scenario that applies the
deductible again after it was met shows the extra on the lines, above the cap); on the PPO EOB it is
`deductibleMetBefore` plus the lines' deductible; the itemized bill prints the lines' deductible as deductible
applied; the HMO plan has no deductible. The split is derived from the adjudication: it changes no printed value and
no field.

## Layout variants

`--layout-variant <id>` (on `generate`, `render`, `batch` and the seed form of `verify`, and with `--degrade`) and
`layoutVariant` (on `generateData`, `render`, `renderDegraded`, `verifyFromSeed` and `renderBatch`) print the same
document in another layout. The itemized bill, the PPO EOB and the HMO EOB each publish a closed list of 12 ids
(`b01`-`b12`, `p01`-`p12`, `h01`-`h12`) in `data/<type>/variants.json`. An id fixes four things: the column order;
a set of header and title wording from `data/<type>/labels.json` (`base` is the standard wording, `alt-a` and
`alt-b` the others); a style (font, density and palette); and how a table continued on the next page is marked
(`repeat` prints the claim or department-group header again with a "continued" mark, `marker` prints only a
"continued" line). `seeded` picks an id from the seed alone, not from the type or scenario, so one seed takes the
same position in every type's list (`p04`, `h04` and `b04` together) and a batch over several types is
correlated; pass explicit ids to spread layouts across types. `all` (render and batch only) writes one document
per id. The Medicare Summary Notice has one national format and takes no variant.

A variant never changes the data, any amount, any required item, the order of the EOBs' money columns (amount
billed, approved, plan's share, your share), the bill's charge column (always last), the date and money formats
or the specimen markers. A varied bill prints each line's department code in its department column, where the
standard bill leaves that cell blank under the group header, and its "SPECIMEN" badge gets a light background so
it stays legible on every header color. Files are named `<type>_<scenario>_<seed>.<id>.pdf` (a degraded copy
`<type>_<scenario>_<seed>.<id>_<preset>.pdf`), and a batch manifest line carries `layoutVariant`.

The answer key of a varied document is ground truth 1.4: `documents[0].layout` is `<type>.<id>` (for example
`ppo-eob.p07`) and `documents[0].layoutVariant` records `{ id, columns, labels, style, breaks }`. Nothing else
differs from the key of the standard document with the same seed except the page count and the PDF's hash, and
the 835 is identical. With no variant the output is byte for byte what 0.4.0 printed and the key stays at 1.3.
An unknown id, an id of another type, an empty or over-long value, `seeded` or `all` on the MSN, `all` outside
`render` and `batch`, a batch that mixes the MSN with `seeded` or `all`, and the option given twice are refused
(exit code 2 on the command line, an error from the library) with a message that does not repeat the value.

## X12 835 remittances

`--also 835` (on `render` and `batch`) and `render({ ..., also: '835' })` write the X12 005010X221A1 835 of a Medicare
Summary Notice or a Medicare Advantage EOB from the same claims (`src/x12/remittance.js`); `remittanceFor({ type,
scenario, seed })` returns it as `{ text, groundTruth }` without writing anything. The itemized bill has none: it prints no per-line payer amounts, and an institutional
remittance needs data it does not carry.

- **What the file holds.** One interchange and one functional group; one transaction per payee (grouped by NPI). The
  payment record is remittance information only (`BPR01` `I`) for a fictional check (`BPR04` `CHK`), or `H`/`NON`/$0 for a
  transaction whose claims pay nothing, with no routing or account numbers (`BPR05` to `BPR15` empty). Per claim a `CLP`
  (status 1, or 4 when every line is denied; claim filing indicator `MB` for the MSN, `16` for the Medicare Advantage
  EOBs), the patient (`NM1*QC`), and per line an `SVC`, its date, its adjustments and the approved amount (`AMT*B6`).
- **Adjustments.** Code values only, never their descriptions: CO-45 for the charge above the approved amount; PR-1, PR-2
  and PR-3 for the deductible, coinsurance and copay from the claims block; a line denied as not medically necessary is
  adjusted in full under CARC 50 with group PR when the notice says the patient may be billed, CO when it says the
  patient owes nothing. The duplicate scenarios bill a service twice; a payer handling them correctly would deny the
  repeat as OA-18 (this is the expected handling the errors describe, not something the file shows). Code values are
  X12's (x12.org/codes); claimseed uses the values only.
- **Values.** The document's own: charged, approved, paid and the patient's share as the PDF prints them, so a planted
  error stays where the PDF has it. In the answer key, `documents[1]` is the 835 (`type` `x12-835`, its SHA-256, its
  transactions and the payer), and each error the file carries has `x12Ref`: `<ST02>:CLP<n>:CLP03` (a wrong charged
  total, which fails the claim balance), `CLP04` (paid; claim balance), `CLP05` (the patient total; it then differs
  from the claim's PR adjustments), or `<ST02>:CLP<n>:SVC<n>` for a line (a duplicate is a repeated service line).
- **Markers.** `ISA15` is `T`; the sender and receiver IDs, the payer's name and address and the technical contact
  (name and a 555-01xx phone) come from `data/x12/specimen-strings.json`, written without access to any real
  document, and all say specimen or test. The 835's payer is this specimen payer, not the issuer the PDF prints.
- **Identifiers.** Guaranteed never to be real: NPIs start with 9 (NPIs are issued with a first digit of 1 or 2), tax
  IDs start with 00 (not on the IRS list of prefixes), Medicare numbers carry a letter Medicare never uses. Recognisable
  sentinels only: the claim numbers the PDF prints (13 digits starting with 99 on the MSN, `CS` and 10 digits on the
  Medicare Advantage EOBs), member IDs (`SPEC` and 8 digits), and the patient control numbers, check numbers and payer
  ID (`N1*PR` with the plan ID qualifier `XV`), which start with `CS`. Systems that validate real identifiers may reject
  them.
- **What real Medicare remittances carry and these do not:** the 2% sequestration adjustment (CO-253), remark codes
  and the MIA, MOA and LQ segments, provider-level adjustments (PLB), and bank data. A file with a planted error is
  deliberately non-conformant where the error is.
- **Format.** Delimiters `*` `^` `>` `~`; each segment ends with `~` and a line feed, for reading (translators accept it;
  strip the line feeds for a strict reader). Save the text byte for byte: the answer key holds its SHA-256. The checker
  in `src/x12/check835.js` (`check835`, `checkSpecimen835`) reads these files; it expects a procedure code of five
  characters after `HC`, as every code in `reference-data/service-catalog.json` is.

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
  "decoys": [                           // optional, every type: correct lines that look wrong,
    { "op": "repeat-service-other-date", "args": { "claim": 1, "line": 0, "days": 7 },   // applied after the mutations
      "rule": "the public rule that makes the line correct (required)", "note": "optional" }
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

Decoy ops (same file) plant a line that looks like an error but follows the rules. Each is listed in the ground
truth's `decoys[]` with its kind, place and the rule the scenario cites, never in `errors[]`; an op refuses a line
that carries an error or another decoy.

| op | args | kind | what it does |
| --- | --- | --- | --- |
| `repeat-service-other-date` | claim, line, days | `repeat-service-different-date` | adds the same service `days` later (or earlier, to stay in the period), adjudicated as its own service; refuses preventive services, new-patient visits and HbA1c |
| `charge-far-above-approved` | claim, line, factor (default 4) | `charge-above-approved` | raises only the provider's charge; the approved amount, payment and patient share stay put |

The Medicare Advantage EOBs take operations of their own, named with an `ma-` prefix (`src/generate/ma-mutations.js`):
the errors `ma-duplicate-line`, `ma-shift-date`, `ma-deny-line`, `ma-break-claim-total`,
`ma-cost-share-on-exempt-line`, `ma-reapply-deductible` and `ma-share-after-oop-max`, and the decoys
`ma-repeat-service-other-date`, `ma-approved-below-copay`, `ma-charge-far-above-approved`, `ma-oop-cap-partial-share`
and `ma-partial-deductible`. Such a scenario may set `maPriorOop`, what the member had paid out of pocket before
the period, and, on the PPO, `maDeductibleMetBefore`, the part of it that went to the deductible.
`docs/error-taxonomy.md` gives the kind each op reports and its rule; the MCP resource `catalog://mutations` lists
the ops the published scenarios use, with the kinds they produce and the scenarios that use them.

## Scoring an extractor

`verify` compares an extractor's or bill auditor's report with the answer key. The report is JSON in the shape of
`schemas/extractor-output.schema.json`: `fields` maps answer-key field paths (the keys of
`documents[0].fields`) to the values read, and `errors` lists `{ kind, fieldRef | lineRef }` for each problem
flagged. Either part may be left out.

- Fields: money is compared to the cent and may be printed text (`"$1,234.50"`); dates may be ISO, M/D/YYYY or
  "April 11, 2026"; text ignores case and repeated spaces. The result counts correct, wrong and missing fields and
  lists their paths.
- Errors: a flag finds an error when its kind matches and its place names the same line or total (a field inside
  the line counts; for a duplicate charge, either line of the pair). A second flag on a found error is a repeat,
  not a false alarm. A flag on a decoy is a false alarm and is listed under `decoysFlagged`.
- The report is size-capped (5,000 fields, 1,000 errors, 200-character paths, 1,000-character values) and
  refused if it has any other shape; the result holds counts, rates and answer-key paths only, never the
  report's own text.
- `verify --manifest` scores a whole set against the answer keys saved with it, after checking each key's
  SHA-256 against the manifest, so a set is always graded against the keys it was rendered with. It reads only
  regular files with the names the manifest gives, in the set and report folders: a symbolic link there is not
  followed, and a folder, FIFO or device is listed as an invalid report (or, in place of an answer key, refused).
  Only a report that is not there counts as missing; one that holds JSON `null`, a list or malformed JSON is
  listed as invalid.
- An answer key is checked before scoring: field values must be strings, numbers, booleans or null, error kinds
  and decoy ids lower-case letters, digits and hyphens, and references strings; any other key is refused.
- Dates match in any of the supported forms on either side: a key that prints "March 5, 2026" accepts
  `2026-03-05`, and the reverse.

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
