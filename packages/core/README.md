# @claimseed/core

`@claimseed/core` renders synthetic US medical-billing specimen documents (Medicare Summary Notices, itemized provider
bills, EOBs from fictional Medicare Advantage plans and a fictional self-funded employer plan, and the provider's
statement for one EOB claim) as PDFs, each with machine-readable ground truth, and on request a notice's or EOB's X12
835. A rules engine generates the names, identifiers, addresses, fictional phone numbers, dates, services and amounts
from a seed (fictional people and facilities, public fee-schedule amounts, and Original Medicare Part B adjudication,
a fictional Medicare Advantage plan's, or a fictional employer plan's, priced at 2026 Medicare amounts times published
average commercial price ratios). The standard wording, the federal help lines the documents print and the fictional
insurers' names are fixed. A scenario file decides which error, if any, is injected and which public rule it breaks.
It is for testing extractors, bill-review tools and training pipelines; nothing in it is, or is derived from, a real
document. The code is licensed under Apache-2.0, and the documents and answer keys it generates are released to the
public domain under CC0 1.0. Sample documents with their answer keys are in
[`claimseed-0.8.0-samples.zip`](https://github.com/claimseed/claimseed/releases/download/v0.8.0/claimseed-0.8.0-samples.zip),
attached to the GitHub release v0.8.0.

## CLI

The commands below run as `npx @claimseed/core <command>` from any folder outside a checkout of this repository, with
Node.js 22.13 or later. In a checkout, after `npm ci`, `node src/cli.js <command>` in `packages/core` runs the same
commands.

```sh
# what can be rendered
npx @claimseed/core list                 # every type/scenario
npx @claimseed/core list msn             # one type

# data + ground truth as JSON on stdout, no browser needed
npx @claimseed/core generate msn baseline-clean --seed demo

# PDF + <name>.ground-truth.json in DIR
npx @claimseed/core render msn baseline-clean --seed demo --out ./output
npx @claimseed/core render msn baseline-clean --seed demo --out ./output --degrade scan   # also fax, photo, low-res
npx @claimseed/core render msn baseline-clean --seed demo --out ./output --also 835       # also the X12 835 of the same claims
npx @claimseed/core render itemized-bill balance-billing --seed demo --out ./output
npx @claimseed/core render ppo-eob baseline-clean --seed demo --out ./output   # also hmo-eob
npx @claimseed/core render commercial-eob baseline-clean --seed demo --out ./output --insurer a   # or b; left out: from the seed
npx @claimseed/core render ppo-eob baseline-clean --seed demo --out ./output --layout-variant p07   # not msn or commercial-eob
# also a provider's statement for one claim, with a balance due above the EOB's member share (.bill.pdf and its key)
npx @claimseed/core render ppo-eob baseline-clean --seed demo --out ./output --also bill --bill over-owed

# a set: PDFs, answer keys and manifest.jsonl (SHA-256 of each file, the degradation preset or null, claimseed and Chrome versions) in a new DIR;
# with --also 835 (msn, ppo-eob, hmo-eob and commercial-eob), each document also gets its .835, listed in the manifest with its SHA-256
npx @claimseed/core batch --types msn,itemized-bill --seeds 50 --out ./set          # --scenarios all|S1,S2  --seed-prefix P  --degrade PRESET
npx @claimseed/core batch --types ppo-eob,hmo-eob --seeds 20 --layout-variant seeded --out ./set   # or an id, or all; never with msn or commercial-eob
# blind: documents named by an opaque id, never the scenario, errors or seed; answer keys (and a batch's manifest) in a folder apart
npx @claimseed/core render msn baseline-clean --seed demo --out ./output --blind-keys ./keys   # not ./output or a folder inside it
npx @claimseed/core batch --types msn,itemized-bill --seeds 50 --out ./set --blind-keys ./keys
npx @claimseed/core batch --types msn,itemized-bill --seeds 50 --out ./set --blind-keys ./keys --blind-salt SALT   # a key's salt: the same set
# plus a provider's statement per EOB as its own blind document (over-owed where allowed, else clean); see pairs.jsonl
npx @claimseed/core batch --types ppo-eob,hmo-eob --seeds 20 --out ./set --blind-keys ./keys --also bill --bill over-owed
# the published set "standard": 1,887 blind documents fixed by its file (no type, scenario, seed, degrade, 835, statement or layout options)
npx @claimseed/core batch --set standard --out ./documents --blind-keys ./keys   # --blind-salt SALT (from set.json): the same content again

# score an extractor's report (see "Scoring an extractor" below)
npx @claimseed/core verify --manifest ./set/manifest.jsonl --outputs ./reports     # one per PDF, named as the PDF with .json for .pdf
npx @claimseed/core verify --answer-key ./set/X.ground-truth.json --output report.json
npx @claimseed/core verify msn duplicate-office-visit --seed demo --output report.json   # rebuilds the key from the seed
npx @claimseed/core verify ppo-eob duplicate-visit --seed demo --layout-variant p07 --output report.json   # a variant's key
```

Rendering needs a Chrome or Chromium binary. The engine looks at `$CLAIMSEED_CHROME`, then
`$PUPPETEER_EXECUTABLE_PATH`, then the usual install paths; set `CLAIMSEED_NO_SANDBOX=1` only inside a locked-down
container. Output files are named `<type>_<scenario>_<seed>.pdf` and `<type>_<scenario>_<seed>.ground-truth.json`
(schema: `schemas/ground-truth.schema.json` in the repository — not in the npm package — and validated by the test suite). Same seed, same
scenario, same package version → byte-identical data. Every PDF carries `Subject: synthetic specimen, not a real
document` in its metadata, a specimen band at the foot of every page and a diagonal watermark drawn as shapes
(so text extraction never sees stray letters); the markers are stamped into the finished PDF inside `mergePdfs`,
which every render function goes through, whether it is reached from the CLI or from the library.

`render` (with or without `--degrade`), the library's `render()` and `renderDegraded()`, and the rendering MCP tools
refuse a seed that ends, in any letter case, in a suffix claimseed adds to that type's file names, because its files
could take another document's names: `_scan`, `_fax`, `_photo` or `_low-res` for every type; `.bill` for `ppo-eob`,
`hmo-eob` and `commercial-eob`; `.a` or `.b` for `commercial-eob`; and `.` plus one of the type's layout variant ids
(such as `.b01` on the itemized bill, `.p07` on the PPO EOB). The refusal repeats nothing typed. `generate` and
`verify` do not check it.

Text read from claimseed's PDFs with `pdftotext` from poppler 26.01.0 in its `-raw` mode can run two words together
where a font's space is narrow, as in some headings and before one-letter words. The default and `-layout` modes of
poppler 26.01.0, and poppler 25.03.0 and earlier, read the same PDFs with their spaces.

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
| `low-res` | 75 to 90 dpi, heavy JPEG compression |

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
per id. The Medicare Summary Notice has one national format and takes no variant. The commercial EOB takes none
either: any value for it (`seeded` and `all` included) is refused, also in a batch that includes it; its insurer sets
its layout (see "The commercial EOB (`commercial-eob`)" below).

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

## The commercial EOB (`commercial-eob`)

`commercial-eob` is an explanation of benefits from a fictional self-funded employer health plan for one patient (the
subscriber, a spouse or a child) on self-only or family coverage, under the plan option "Standard PPO Option" or "HSA
Qualified Option" (an HSA-qualified high-deductible design whose deductible and out-of-pocket maximum count in- and
out-of-network care together). One of four fictional employers (plan sponsors) pays the claims; a fictional insurer
processes them. Each visit is one claim per billing provider: the facility, and each clinician, lab, ambulance service
or urgent care center. The scenario sets the plan option and coverage tier, or else the seed does. A service's
in-network rate is its 2026 Medicare national amount times the average commercial-to-Medicare price ratio for its
setting (2.23 hospital, 1.29 physician; January 2022 CBO report); the provider's charge is that rate times a seeded
markup. Cost sharing is figured on the allowed amount; preventive care on the plan's list costs nothing in network.

### Insurers and layouts

Each insurer has its own mark and colors, and its own layout:

| Insurer | Name | Pages | Layout |
| --- | --- | --- | --- |
| `a` | Fernhollow Health Plans | portrait | Page 1 holds the summary, the plan's terms and the year's deductible and out-of-pocket totals; each claim has a page of its own; a closing page has the remark codes, the No Surprises Act notice when a line is protected, and the appeal rights. |
| `b` | Quillmont Insurance Company | landscape | One table lists every claim, with the summary and the year's totals in a side panel on page 1, continued on as many pages as it needs; a closing page has the plan's terms, the remark codes, the notice and the appeal rights. |

Choose one with `--insurer a|b` on `generate`, `render` (also with `--degrade`) and `verify`; with `insurer` on
`render()`, `renderDegraded()` and `verifyFromSeed()`; or with `overrides: { insurer }` on `generateData()`. Left out,
the insurer is drawn from the seed in a stream of its own, so naming one changes nothing else: the same seed gives the
same claims, amounts, errors and decoys under either insurer.

```sh
npx @claimseed/core render commercial-eob surprise-balance-bill --seed demo --out ./output --insurer b --also 835,bill
npx @claimseed/core generate commercial-eob baseline-clean --seed demo --insurer a
```

```js
await render({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'demo', outDir: './out', insurer: 'a' });
generateData({ type: 'commercial-eob', scenario: 'baseline-clean', seed: 'demo', overrides: { insurer: 'a' } });
```

A named insurer adds `.a` or `.b` after the seed in the file names: `commercial-eob_<scenario>_<seed>.a.pdf` with its
`.ground-truth.json` and, with `--also 835`, its `.835` (one file, one transaction per payee); a degraded copy
`commercial-eob_<scenario>_<seed>.a_<preset>.pdf`; the statement `<name>.bill.pdf`, where `<name>` is the EOB's file
name without `.pdf`. A drawn insurer adds nothing.

These are refused with a message that repeats nothing typed: `--insurer` for another type, a value other than `a` or
`b`, and an insurer on a blind render (a blind document's insurer comes from its own seed). `batch` takes no
`--insurer`: each document's insurer comes from its seed. The commercial EOB takes no `--layout-variant`.

### What the page prints

- Header: the insurer's name and mark, a SPECIMEN badge, "Explanation of Benefits", "This is not a bill.", the mailing
  address, patient, member ID, plan, plan option, employer (plan sponsor), group number, date processed, a sentence
  that the employer pays the claims and the insurer processes them, and the member help line.
- Summary: claims, amount billed, amount allowed, plan paid, you may owe.
- "Your share of costs under this option": deductible, coinsurance, copays (primary care, specialist and emergency
  room visits) and out-of-pocket maximum, in and out of network, individual and family; preventive care on the plan's
  list costs $0 in network.
- "Deductible and out-of-pocket totals": each deductible and out-of-pocket row, for the patient and (on family
  coverage) the family, with the amount before this statement, this statement's amount, the year to date ("Met" at the
  limit) and the plan limit.
- Claims: claim number, provider, specialty, network status, place of service, emergency care or not. Lines: date of
  service, service, service code, billed, allowed, plan paid, deductible, copay, coinsurance, not covered, you may
  owe, remark code. Notes: a denial's reason, denial code, plan section and pointer to the appeal section; a line the
  No Surprises Act protects; a signed consent; amounts left out of the out-of-pocket total.
- Closing page: the remark codes used; "Your protections from surprise bills" (the No Surprises Act notice, printed
  only when a line is protected, ending with the federal No Surprises Help Desk, 1-800-985-3059); "Your right to
  appeal" (internal appeal to the insurer within 180 days, independent review, civil action under ERISA section
  502(a)); the diagnosis and treatment codes and any rule used, offered at no cost; help contacts: the plan's member
  services line (a fictional 555-01xx number) and the U.S. Department of Labor, Employee Benefits Security
  Administration, 1-866-444-3272. No language tagline is printed.

### Answer key

The answer key is version 1.7, blind or not, with or without a statement, and adds a top-level `plan` object:

| Field | Holds |
| --- | --- |
| `design` | `ppo` or `hsa` |
| `tier` | `self` or `family` |
| `insurer` | `a` or `b` |
| `sponsor` | the employer (plan sponsor) |
| `before`, `after` | the deductible and out-of-pocket amounts met before and after these claims, per person and per family, in and out of network, in dollars |
| `stateLaw` | always `"none"` |
| `providerNotices` | one No Surprises Act notice per payee of a protected line |

Each claim adds `payee` (its key, NPI, network and kind), `facility` and `emergency`; each line adds the plan's facts:
`network`, `protected`, `recognized`, `qpa`, `balanceBillable`, `preventive` and `denial`. `deductibleMetBefore` is
`null`; `plan.before` holds what was met. `documents[0].fields` are the printed values in the page's words, for
example `terms.deductibleIn`, `accumulators[0].yearToDate`, `claims[0].lineItems[0].youMayOwe`, `claims[0].notes[0]`,
`sections.appeal` and `sections.noSurprises`.

Each error is keyed where the page prints it: a line (`claims[k].lineItems[j]`), a denial note (`claims[k].notes[n]`),
an accumulator row (`accumulators[i]`), or no place (`fieldRef` null) for a missing appeal rights section, with the
expected value from the plan's own adjudication, the printed value and the difference. The plan's own correct denials
(elective care without prior authorization, a visit past the yearly limit) are in `errors[]` as `coverage-denial` with
severity `info`, which a reviewer is expected to surface. See "X12 835 remittances" for its 835 and "Provider
statements (EOB pairs)" for the statement beside it.

### Scenarios

| Scenario | Errors | Decoys | What it holds |
| --- | --- | --- | --- |
| `accumulator-math-error` | `math-error` | `oop-excludes-non-covered` | PPO, self-only: an in-network office visit, an out-of-network specialist visit; the in-network deductible row's year to date is not the amount before plus this statement's. |
| `baseline-clean` | none | none | Clean control: two in-network claims, an office visit with lab work and an adult preventive visit; the seed picks plan option, coverage tier and insurer. |
| `care-settings-clean` | none | none | Clean control of three in-network visits, one claim per billing provider: urgent care, a hospital outpatient X-ray (hospital charge and radiologist's reading) and lab work. |
| `combined-three-errors` | `preventive-cost-sharing`, `emergency-authorization-denial`, `missing-required-section`; `coverage-denial` (info) | none | Cost sharing on an adult preventive visit, an out-of-network emergency physician denied for no prior authorization, and an acupuncture denial note without its plan section. |
| `decoys-only` | none planted; `coverage-denial` (info) x 2 | `consented-balance`, `ground-ambulance-balance`, `problem-visit-beside-listed`, `out-of-network-balance`, `oop-excludes-non-covered`, `elective-authorization-denial`, `appeal-rights-by-section` | Six visits built to look wrong but correct: consented, ambulance and out-of-network differences, a problem visit beside a $0 screening, and an elective surgery's denial. |
| `denial-missing-content` | `missing-required-section`; `coverage-denial` (info) x 3 | `appeal-rights-by-section` | An elective knee surgery without prior authorization and an acupuncture visit past the yearly limit; one surgery line's denial note gives no plan section. |
| `denial-without-appeal-rights` | `missing-required-section`; `coverage-denial` (info) | none | An office visit and an acupuncture visit correctly denied past the yearly limit; the EOB prints no appeal rights section, which a denial requires. |
| `emergency-authorization-denial` | `emergency-authorization-denial`; `coverage-denial` (info) x 2 | `elective-authorization-denial` | An out-of-network emergency physician's line denied for no prior authorization, which emergency care never needs, beside an elective knee surgery correctly denied. |
| `in-network-balance-bill` | `in-network-balance-bill` | `out-of-network-balance` | Two specialist visits: the in-network one asks for the difference between billed and allowed on top of cost sharing; the out-of-network one correctly owes it. |
| `preventive-cost-sharing` | `preventive-cost-sharing` | `problem-visit-beside-listed` | An adult preventive visit with a flu shot, nothing met before, charged cost sharing; a problem visit beside a $0 HIV screening is correctly cost-shared. |
| `surprise-balance-bill` | `surprise-balance-bill` | `consented-balance`, `ground-ambulance-balance` | In-network hospital surgery by an out-of-network surgeon and anesthesiologist with consent, plus a ground ambulance; anesthesia, whose protection consent cannot waive, is billed the difference. |

The `coverage-denial` entries are the plan's correct denials at severity `info`.

## X12 835 remittances

`--also 835` (on `render` and `batch`) and `render({ ..., also: '835' })` write the X12 005010X221A1 835 of a Medicare
Summary Notice, a Medicare Advantage EOB or a commercial EOB from the same claims (`src/x12/remittance.js`);
`remittanceFor({ type, scenario, seed })` returns it as `{ text, groundTruth }` without writing anything, drawing a
commercial EOB's insurer from the seed. The itemized bill has none: it prints no per-line payer amounts, and an
institutional remittance needs data it does not carry.

- **What the file holds.** One interchange and one functional group; one transaction per payee (grouped by NPI). The
  payment record is remittance information only (`BPR01` `I`) for a fictional check (`BPR04` `CHK`), or `H`/`NON`/$0 for a
  transaction whose claims pay nothing, with no routing or account numbers (`BPR05` to `BPR15` empty). Per claim a
  `CLP` (status 1, or 4 when every line is denied; claim filing indicator `MB` for the MSN, `16` for the Medicare
  Advantage EOBs, `CI` for the commercial EOB), the patient (`NM1*QC`), and per line an `SVC`, its date, its
  adjustments and the approved amount (`AMT*B6`). `SVC01` holds the qualifier `HC` and the procedure code, and on the
  commercial 835 also the modifier the EOB prints with it, as in `HC>71046>26`.
- **Adjustments.** Code values only, never their descriptions: CO-45 for the charge above the approved amount; PR-1, PR-2
  and PR-3 for the deductible, coinsurance and copay from the claims block; a line denied as not medically necessary is
  adjusted in full under CARC 50 with group PR when the notice says the patient may be billed, CO when it says the
  patient owes nothing. The duplicate scenarios bill a service twice; a payer handling them correctly would deny the
  repeat as OA-18 (this is the expected handling the errors describe, not something the file shows). Code values are
  X12's (x12.org/codes); claimseed uses the values only.
- **The commercial EOB's 835.** One transaction per payee, as for every type: each printed claim's billing provider
  (facility, clinician, lab, ambulance service or urgent care center), grouped by NPI. Adjustments are written in the
  code (`commercialAdjustments` in `src/x12/remittance.js`): `CO-45` for the charge above the allowed amount in
  network, on a line the No Surprises Act protects, and on a visit-limit charge's part above the network rate; `PR-45`
  for the difference an unprotected out-of-network provider may bill; `PR-1`, `PR-2` and `PR-3` for deductible,
  coinsurance and copay; `CO-197` for a denial for no prior authorization in network (not billable to the patient),
  `PR-197` out of network; `PR-119` for the patient's share past the yearly visit limit.
  `data/x12/commercial-codes.json` records each code value's public source, and a test holds the code and the table to
  the same codes. `CLP05` is the sum of the claim's PR adjustments. `in-network-balance-bill` (the 835 is right where
  the page bills an in-network balance), `missing-required-section` and an accumulator row's `math-error` (no line)
  have `x12Ref` null; other errors name their service line.
- **Values.** The document's own: charged, approved, paid and the patient's share as the PDF prints them, so a planted
  error stays where the PDF has it. In the answer key, `documents[1]` is the 835 (`type` `x12-835`, its SHA-256, its
  transactions and the payer), and each error the file carries has `x12Ref`: `<ST02>:CLP<n>:CLP03` (a wrong charged
  total, which fails the claim balance), `CLP04` (paid; claim balance), `CLP05` (the patient total; it then differs
  from the claim's PR adjustments), or `<ST02>:CLP<n>:SVC<n>` for a line (a duplicate is a repeated service line).
- **Markers.** `ISA15` is `T`; the sender and receiver IDs, the payer's name and address and the technical contact
  (name and a 555-01xx phone) come from `data/x12/specimen-strings.json`, written without access to any real
  document, and all say specimen or test. For the Medicare types the 835's payer is this specimen payer, not the issuer the PDF prints. For the commercial EOB
the payer (`N1*PR`) is the EOB's fictional insurer, its name in capitals followed by `- SPECIMEN - TEST ONLY`; its
address and technical contact are the specimen strings above.
- **Identifiers.** Guaranteed never to be real: NPIs start with 9 (NPIs are issued with a first digit of 1 or 2), tax
  IDs start with 00 (not on the IRS list of prefixes), Medicare numbers carry a letter Medicare never uses. Recognisable
  sentinels only: the claim numbers the PDF prints (13 digits starting with 99 on the MSN, `CS` and 10 digits on the Medicare Advantage and commercial EOBs), member IDs
(`SPEC` and 8 digits, and on the commercial EOB a two-digit suffix per person: `-01`, `-02`), and the patient control numbers, check numbers and payer
  ID (`N1*PR` with the plan ID qualifier `XV`), which start with `CS`. Systems that validate real identifiers may reject
  them.
- **What real Medicare remittances carry and these do not:** the 2% sequestration adjustment (CO-253), remark codes
  and the MIA, MOA and LQ segments, provider-level adjustments (PLB), and bank data. A file with a planted error is
  deliberately non-conformant where the error is.
- **Format.** Delimiters `*` `^` `>` `~`; each segment ends with `~` and a line feed, for reading (translators accept it;
  strip the line feeds for a strict reader). Save the text byte for byte: the answer key holds its SHA-256. The checker
  in `src/x12/check835.js` (`check835`, `checkSpecimen835`) reads these files; it expects a procedure code of five
  characters after `HC`, as every code in `reference-data/service-catalog.json` and `reference-data/commercial/service-catalog.json` is.

## Provider statements (EOB pairs)

Beside an EOB (`ppo-eob` or `hmo-eob`, claimseed's fictional Medicare Advantage PPO and HMO, or `commercial-eob`, the
fictional employer plan's EOB), claimseed can render the provider's statement for one claim of that EOB: a one-page
patient statement from the provider, of document type `provider-statement`. Which claim it bills is drawn from the
seed, in a stream of its own. The EOB is exactly the same with or without its statement.

The statement lists the claim's lines (date, code, description, units, charge) and an account summary: Total Charges,
Contractual Adjustment, Denied by Your Plan (only when a line was denied), Paid by Your Plan, Payments Received and
Balance Due. On a correct statement the balance due is the member share the EOB shows for that claim less Payments
Received, which is the copay paid at the visit on the `paid-at-visit` decoy and on `over-owed-with-payment`, and zero
otherwise.

### Beside a commercial EOB

The statement bills one printed claim, so one billing provider, and is titled by the payee's kind: "Hospital Patient
Statement" (hospital outpatient department or emergency room), "Medical Group Statement" (a clinician), "Urgent Care
Statement", "Laboratory Statement" or "Ambulance Statement", recorded in the key's `metadata.title`. Beside a Medicare
Advantage EOB it is titled "Patient Statement", with no `metadata.title`.

An organization bills under its name and NPI on the EOB. A clinician bills through a group practice (a drawn name
ending in "Health Associates", with its own NPI), and a "Treating Clinician" row gives the clinician's name and
specialty as on the EOB; the key's providers list the group, then the clinician.

The adjustment row is what the provider writes off, labelled "No Surprises Act Adjustment" when the Act protects a
line of the claim. A claim with an approved, unprotected out-of-network line gets no adjustment row (the difference is
the patient's) and only a `clean` statement. A line denied with nothing owed appears under "Denied by Your Plan, Not
Billed to You". On a correct statement the balance due is the claim's printed "You may owe" less Payments Received.

`denied-line-billed` needs such a line, here an in-network line denied for no prior authorization. Its error entries
cite the commercial rules (an in-network provider accepts the plan's allowed amount as payment in full; on a protected
line, 45 CFR 149.410 and 149.420). None of the EOB's planted errors or decoys passes to the statement. The statement's
key is 1.6, with the claim as the provider bills it and none of the plan's facts; the EOB's stays 1.7. The statement
has one layout under either insurer.

### Variants

The variant is the value of `bill`. It gives the statement its own error or decoy, or none:

- `clean` (the default): no error of its own.
- `over-owed`: the contractual adjustment is too small, so the balance due is more than the EOB's member share. Error
  kind `bill-vs-eob-mismatch`, at the balance due.
- `denied-line-billed`: a line the plan denied is billed to the patient, so the balance due is more than the EOB's
  member share by that line's charge. Error kind `bill-vs-eob-mismatch`.
- `payment-misposted`: Paid by Your Plan differs from what the EOB says the plan paid, and the adjustment moves the
  other way, so the balance due is still right. Error kind `bill-payment-mismatch`, severity low.
- `paid-at-visit`: a decoy. Payments Received shows the copay paid at the visit, so the balance due is less than the
  EOB's member share, and that is correct.
- `over-owed-with-payment`: the `paid-at-visit` decoy and the `over-owed` error on one statement.

A variant applies only where the billed claim allows it; for example, `denied-line-billed` needs a denied line on that
claim. A single render refuses a variant that does not apply. A batch renders that statement clean instead, and its
answer key says which variant it got (`pair.variant`). When the EOB claim a statement bills has a planted math error
in its printed total (the total does not add up from its lines), the statement follows the EOB's lines, which are
right, not the misprinted total. Every statement variant other than `clean`, the decoy `paid-at-visit` included, is
refused for that claim, so only a clean statement can be made for it.

Some statements beside a Medicare Advantage EOB also carry, keyed on their own lines, the errors and decoys that the
EOB has on that claim and that the provider made: a line billed twice, a wrong date of service, a service repeated on
another date, a charge far above the approved amount. A statement beside a commercial EOB carries none, because none
of the commercial EOB's planted errors and decoys is the provider's.

### Options

On the command line, `render` takes `--also bill` (or `--also 835,bill` for the 835 too) and `--bill <variant>`. In
the library, `render()` takes `also: 'bill'` or `also: ['835', 'bill']`, `bill` (the variant) and `billParams`, the
variant's amounts in dollars, given to the cent (for example `by: 9.84` is $9.84): `by` for an error, `amount` for the
decoy. An amount not given is drawn from the seed.

### Files and keys

The statement is written as `<name>.bill.pdf`, with its key in `<name>.bill.ground-truth.json`, beside the EOB's
`<name>.pdf` and key. The statement's key is answer-key version 1.6, and so is a Medicare Advantage EOB's key beside
it; a commercial EOB's key stays 1.7. Both keys carry `pair`: `role` (`eob` or `bill`), `with` (the other document's
file name without `.pdf`, or its blind id), `claim`, `variant` and `params`.

### Blind documents

In blind mode the statement has its own opaque id, drawn from the salt, the EOB's id, the statement variant and its
amounts, so two statements of one EOB with different variants or amounts have different ids. It is written as
`<id>.pdf`, and its key goes to the keys folder.

### Batch

`batch` takes `--also bill` and `--bill <variant>` too. Each statement is written as a document of its own, at its own
place in the order (shuffled by the salt when blind). Each statement has its own manifest line, with type
`provider-statement`, the EOB's scenario and seed, and `pairOf`, the EOB's file name without `.pdf` or its id.
`pairs.jsonl` in the documents folder publishes the pairing: it lists each pair as `{ "eob": ..., "bill": ... }`, with
names or ids only.

### Degraded copies

`render --degrade <preset> --also bill`, `batch --degrade <preset> --also bill` and `renderDegraded()` with
`also: 'bill'` (or `also: ['835', 'bill']`) make a degraded copy of the statement beside the EOB's, with the same
preset. `renderDegraded()` takes `bill` and `billParams` as `render()` does. The statement copy draws its settings
from its own document type, the scenario and the seed, not from the EOB copy. The EOB's copy is `<name>_<preset>.pdf`
and the statement's is `<name>.bill_<preset>.pdf`, where `<name>` is the EOB's file name without `.pdf`. In blind mode
each copy has its own opaque id. Each key records `degradation` and `degradationParams`, and its `pair.with` names the
other copy. A degraded batch has no clean documents, so `pairs.jsonl` lists the two copies of each pair. Over MCP,
`degrade_document` makes no statement, and `render_blind` refuses `bill` with `preset`.

### Scoring

A report on a statement is scored like any document's, against its own key: with `verify --answer-key` or a manifest.
`verifyFromSeed` takes `document: 'bill'` and `bill` (the variant) to rebuild the statement's key, instead of the
EOB's, from the type, scenario and seed.

### Not supported yet

A statement has no layout variants of its own, and nothing can ask for one. The EOB's layout variant, and a commercial
EOB's insurer, apply to the EOB only. The published set "standard" carries statements (see "Blind documents and
published sets"); `batch --set` takes no `--also` or `--bill`, because the set fixes them.

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

A commercial EOB scenario has no `period`, `claimCount` or `claimShapes`. It may set `design` (`ppo` or `hsa`) and
`tier` (`self` or `family`), which are otherwise drawn from the seed; `patient` (`subscriber`, `spouse` or `child`);
`before`, the deductible and out-of-pocket amounts already met, in dollars; and `visitsUsed`, the visits of a
visit-limited service already used this year. `claims` lists one to eight claim shapes (`office-primary`,
`office-specialist`, `preventive-adult`, `preventive-child`, `problem-visit-listed`, `lab`, `imaging`, `emergency`,
`surgery`, `ambulance`, `urgent-care`, `acupuncture`), each a name or an object with options such as `network`,
`facilityNetwork`, `consent` and `priorAuthObtained`. Its operations have a `ce-` prefix
(`src/generate/commercial-operations.js`): the errors `ce-unprotect-line`, `ce-preventive-cost-share`,
`ce-deny-emergency-for-auth`, `ce-in-network-balance-bill`, `ce-accumulator-off` and `ce-drop-denial-element`, and the
decoys `ce-decoy-out-of-network-balance`, `ce-decoy-consented-balance`, `ce-decoy-ambulance-balance`,
`ce-decoy-problem-visit`, `ce-decoy-oop-excludes`, `ce-decoy-elective-denial` and `ce-decoy-appeal-by-section`.
`mutations`, `decoys` and `sources` work as for the other types.

## Blind documents and published sets

For tools that must not see answers, `--blind-keys KEYDIR` (on `render` and `batch`) and `blind: true` with
`keysDir` (on `render` and `renderBatch`) name each document by an opaque id (`doc-` and 16 hexadecimal digits). Its
specimen band, PDF title, file names, page-image markers and 835 carry that id, never the scenario, planted errors
or seed. The specimen markers stay; only the scenario words are gone. Answer keys and a batch's manifest go to
KEYDIR, never the documents' folder or one inside it. A degraded copy is blind too, with its own id.

Content comes from a seed derived from a salt, 128 random bits drawn per set, recorded in every key, so nobody can
rebuild a document from a guessed scenario and seed and match a printed claim number. `--blind-salt SALT` or
`blind: { salt }` (32 lowercase hexadecimal digits from an earlier set's key) makes the same set again; documents
are written in an order drawn from the salt. Keys (ground truth 1.5 for a blind document alone, 1.6 for either document of a Medicare Advantage pair and for every
provider's statement, 1.7 for a commercial EOB) hold a `blind` object: `id`, `salt`, `seed` and `layoutVariant` as asked, `copyOf` on a
degraded copy, `set` and `canary` in a published set (every manifest line carries the canary too). `verify
--manifest` scores a blind set exactly as an open set.

`--set standard` (`set: 'standard'`) makes the published set "standard" of 1,887 blind documents (see the repository
README): its set file's notices, bills and EOBs, the provider's statements beside its PPO, HMO and commercial EOBs,
and the 835s of notices and EOBs. A set is always blind and its file fixes every document, so `--set` takes no
`--types`, `--scenarios`, `--seeds`, `--seed-prefix`, `--degrade`, `--also`, `--bill` or `--layout-variant`.

Floors are checked from the generator before anything is rendered: each error kind and each decoy kind of each type at
least 20 times; on each EOB type's statements, `bill-vs-eob-mismatch`, `bill-payment-mismatch`, the `paid-at-visit`
decoy and clean statements at least 20 times each, other variants at least 5 times; each commercial statement title at
least twice; each insurer on at least 40% of the commercial EOBs. Without `--blind-salt`, up to 50 salts are drawn
until one meets every floor, and the command says how many when it took more than one; a salt given with
`--blind-salt` that misses a floor is refused before anything is made. Its salt, from `set.json` or any key, makes the
same content again; PDF bytes can differ by machine and Chrome install, so the manifest's SHA-256s name the published
files.

```js
await renderBatch({ set: 'standard', outDir: './documents', blind: true, keysDir: './keys' });  // or blind: { salt }
```

## Scoring an extractor

`verify` compares an extractor's or bill auditor's report with the answer key. The report is JSON in the shape of
`schemas/extractor-output.schema.json`: `fields` maps answer-key field paths (the keys of `documents[0].fields`) to
the values read, and `errors` lists `{ kind, fieldRef | lineRef }` for each problem flagged. Either part may be left
out.

For example, this report for `msn combined-three-errors` with seed `example` flags one error:

```json
{"errors":[{"kind":"duplicate-charge","lineRef":"claims[0].lines[1]"}]}
```

Saved as `report.json`, it is scored with:

```sh
npx @claimseed/core verify msn combined-three-errors --seed example --output report.json
```

It finds 1 of the 3 planted errors: the result's `errors` has `found` 1, `expected` 3, `recall` 0.3333, `precision` 1
and `falseAlarms` 0. The two it misses are a `cost-sharing-error` and a `math-error`.

- Fields: money is compared to the cent and may be printed text (`"$1,234.50"`); dates may be ISO, M/D/YYYY or "April
  11, 2026"; text ignores case and repeated spaces. The result counts correct, wrong and missing fields and lists
  their paths.
- Errors: a flag finds an error when its kind matches and its place names the same line or total (a field inside the
  line counts; for a duplicate charge, either line of the pair). A second flag on a found error is a repeat, not a
  false alarm. A flag on a decoy, or on the line a decoy repeats (`relatedLineRef`), is a false alarm and is listed
  under `decoysFlagged`.
- Correct denials: an answer key's `errors[]` also lists the correct denials a reviewer should surface (record the
  denial and the right to appeal) as kind `coverage-denial` at severity `info`, and they count in `errors`. On
  commercial `decoys-only`, `denial-missing-content` and `emergency-authorization-denial` such a denied line is also a
  decoy's line: a `coverage-denial` flag there finds the denial, and a flag of another kind is a false alarm listed
  under `decoysFlagged`. `errors.excludingInfo`, also in a set's headline, `scoredOnly`, `byType` and `byDegradation`,
  gives the figures without the `info` entries; its precision is found over `counted`, which leaves out repeats and
  the flags that found an `info` entry.
- The report is size-capped (5,000 fields, 1,000 errors, 200-character paths, 1,000-character values) and refused if
  it has any other shape; the result holds counts, rates and answer-key paths only, never the report's own text.
- `verify --manifest` scores a whole set against the answer keys saved with it, after checking each key's SHA-256
  against the manifest, so a set is always graded against the keys it was rendered with. It looks for each document's
  report under the PDF's file name with `.json` in place of `.pdf` (for `doc-1a2b....pdf`,
  `reports/doc-1a2b....json`). It reads only regular files with the names the manifest gives, in the set and report
  folders: a symbolic link there is not followed, and a folder, FIFO or device is listed as an invalid report (or, in
  place of an answer key, refused). Only a report that is not there counts as missing; one that holds JSON `null`, a
  list or malformed JSON is listed as invalid.
- Headline figures (`fields`, `errors`) count every document of the set: a missing or invalid report scores as an
  empty one, and so does a part (fields or errors) a report leaves out once any report gives it. Skipping a document
  never raises field accuracy or recall; precision counts only what was flagged, so read it beside recall.
  `scoredOnly` holds the old figures, over scored reports. New breakdowns: `byType`, `byDegradation` (`clean` or the
  preset) and `byKind` (expected, found, recall per kind). `documents`, `scored`, `missingOutputs`, `invalidOutputs`
  and `documentsScored` are unchanged.
- An answer key is checked before scoring: field values must be strings, numbers, booleans or null, error kinds and
  decoy ids lower-case letters, digits and hyphens, and references strings; any other key is refused.
- Dates match in any of the supported forms on either side: a key that prints "March 5, 2026" accepts `2026-03-05`,
  and the reverse.

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
reserved `.example` domain), and from amounts the rules engine computes from the service catalog and the CMS annual parameters, and for the
commercial EOB from `reference-data/commercial` (2026 Medicare national amounts times a published commercial price
ratio, and fictional plan designs within cited federal limits). The commercial EOB's insurers, employers and plan
names, from `data/commercial-eob/insurers.json`, are fictional. Service descriptions are claimseed's plain language, never AMA CPT descriptors; HCPCS Level II
codes are preferred; a service added without a verified public price carries `"verified": false`, a round
illustrative `allowed`, and a `sources` entry saying where a maintainer should look it up. Contributors never
attach, link, paste, or describe from memory any real statement, bill, notice or lab report, never fit anything
to one, and never add a real insurer's, pharmacy's or laboratory's name or branding. See
`docs/synthetic-data-policy.md`; `npm run check` enforces what it can.
