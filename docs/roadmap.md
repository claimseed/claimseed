# Roadmap

What claimseed does today, what comes next, and what stays open. Dates are not promised; order roughly is.

## Licence

claimseed is licensed under Apache-2.0 (`LICENSE`). Every version published in this repository or on npm stays
available under that licence; a licence granted with a release cannot be withdrawn from it.

## Today

- `@claimseed/core`: four layouts (`msn`, `itemized-bill`, `ppo-eob`, `hmo-eob`), the rules engine, scenarios with
  injected errors and their ground truth, the CLI and the library API.
- Scoring: `claimseed-core verify` and the library's `scoreExtraction` score an extractor's or bill auditor's report
  against the answer key (fields read, errors found and missed, false alarms); `claimseed-core batch` renders a set
  with a manifest of hashes, and `verify --manifest` scores the whole set.
- Errors and decoys on all four layouts, the Medicare Advantage EOBs included since 0.5.0; decoys are lines that look
  wrong but follow the rules, listed in the ground truth's `decoys[]` so that flagging one counts as a false alarm.
- Layout variants: the itemized bill and both Medicare Advantage EOBs in 12 layouts each (column order, header
  wording, style, continued-table marks), chosen with `--layout-variant` or `layout_variant` and recorded in the
  answer key.
- Scanned-looking copies: `render --degrade` and `batch --degrade` (`scan`, `fax`, `photo`, `low-res`) make an
  image-only copy of a document with seeded skew, blur, noise, thresholding or low resolution, stamped after
  degradation, and record the preset and its settings in the ground truth (`degradation`, `degradationParams`).
- Remittances: `render --also 835` and `batch --also 835` write the X12 835 of the same claims beside a Medicare
  Summary Notice or a Medicare Advantage EOB, with each planted error's place in the 835 in the answer key; the
  claims block splits the patient's share into deductible, coinsurance, copay and non-covered.
- `@claimseed/mcp`: an MCP server over stdio with `list_document_types`, `describe_document_type`, `generate_data`,
  `render_document` (page images in the result and an MCP Apps view), `degrade_document` and `verify_document`,
  the ground-truth and extractor-output schemas and catalogs as resources, and a `build_test_case` prompt.
- A Docker image (`Dockerfile`) with Chromium, for running the MCP server without installing a browser.
- `examples/`: one document per published scenario and one per layout variant id, re-rendered and compared in CI on
  every push.
- Blind documents and sets: `render --blind-keys` and `batch --blind-keys` name each document by an opaque id, never
  its scenario, planted errors or seed, write the answer keys to a folder apart from the documents and generate the
  content from a salt drawn for each set (`--blind-salt` makes a set again). Over MCP, `render_blind` renders a
  blind document and `get_answer_key` returns its key.
- The published set "standard": 1,022 blind documents over all 34 published scenarios, with layout variants,
  degraded copies and 835s, made by `batch --set standard`; claimseed 0.6.0's copy and its public answer keys are
  attached to the GitHub release v0.6.0. `verify --manifest` counts every document of a set in its headline figures,
  with `scoredOnly` and breakdowns by type, degradation and error kind.

## Next

The order below follows what users ask for, and can change with it.

- **A bill and the EOB of the same visit.** A fictional commercial employer-plan EOB (deductible, out-of-pocket
  maximum, copays and coinsurance, No Surprises Act protections, preventive care without cost sharing); the
  provider's itemized bill of the same claim beside it and beside both Medicare Advantage EOBs; and errors that show
  only across the two: the bill asks more than the EOB says is owed, charges a line the EOB denied, or credits a
  payment that differs from the EOB's.
- **More formats.** Fictional insurers with their own names and marks, EOB layouts that differ in structure (not
  only in style), and bills from more kinds of provider (hospital, physician group, urgent care, lab, ambulance).
- **Claim forms and claim files.** CMS-1500 and UB-04 forms and 837P and 837I files, with one claim generated as
  its claim form, 837, EOB or Medicare Summary Notice, 835 and provider bill.
- **A wider code catalog and visit templates**, with the coding errors this allows: codes billed apart that belong
  together, units over the limit, modifier errors.
- **A member's year of EOBs**, whose deductible and out-of-pocket totals must add up across documents; also several
  documents in one PDF with pages out of order, and the Part D EOB.
- **Scoring depth.** The remaining error kinds of the taxonomy, more decoys, difficulty tiers, field locations, and
  larger sets.

FHIR ExplanationOfBenefit output is dropped: Synthea and CMS already publish synthetic FHIR claims.

## Not planned

- Anything built from a real person's documents, in any form; see `docs/synthetic-data-policy.md`.
- Network access from the renderer or the MCP server.
