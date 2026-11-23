# Roadmap

This roadmap covers what claimseed does today, what comes next and what stays open. It promises no dates; the order is approximate.

## Licence

claimseed's code is licensed under Apache-2.0 (`LICENSE`). Generated documents and their answer keys, the published
set and the samples are released to the public domain under CC0 1.0 (`NOTICE`). Every version published in this
repository or on npm stays available under these licences; a licence granted with a release cannot be withdrawn from
it.

## Today

- `@claimseed/core`: five document types (`msn`, `itemized-bill`, `ppo-eob`, `hmo-eob`, `commercial-eob`) and the
  provider's statement beside an EOB (`provider-statement`), the rules engine, scenarios with injected errors and
  their ground truth, the CLI and the library API.
- Scoring: `claimseed-core verify` and the library's `scoreExtraction` score an extractor's or bill auditor's report
  against the answer key (fields read, errors found and missed, false alarms); `claimseed-core batch` renders a set
  with a manifest of hashes, and `verify --manifest` scores the whole set.
- Errors and decoys on all five types, the Medicare Advantage EOBs included since 0.5.0 and the commercial EOB since
  0.8.0; decoys are lines that look
  wrong but follow the rules, listed in the ground truth's `decoys[]` so that flagging one counts as a false alarm.
- Layout variants: the itemized bill and both Medicare Advantage EOBs in 12 layouts each (column order, header
  wording, style, continued-table marks), chosen with `--layout-variant` or `layout_variant` and recorded in the
  answer key.
- Scanned-looking copies: `render --degrade` and `batch --degrade` (`scan`, `fax`, `photo`, `low-res`) make an
  image-only copy of a document with seeded skew, blur, noise, thresholding or low resolution, stamped after
  degradation, and record the preset and its settings in the ground truth (`degradation`, `degradationParams`).
- Remittances: `render --also 835` and `batch --also 835` write the X12 835 of the same claims beside a Medicare
  Summary Notice, a Medicare Advantage EOB or a commercial EOB, with each planted error's place in the 835 in the
  answer key; the claims block splits the patient's share into deductible, coinsurance, copay and non-covered.
- `@claimseed/mcp`: an MCP server over stdio with `list_document_types`, `describe_document_type`, `generate_data`,
  `render_document` (page images in the result and an MCP Apps view), `degrade_document` and `verify_document`,
  the ground-truth and extractor-output schemas and catalogs as resources, and a `build_test_case` prompt.
- A Docker image (`Dockerfile`) with Chromium, for running the MCP server without installing a browser.
- `examples/`: one document per published scenario (the commercial EOB's once per insurer), one per layout variant id,
  and a provider's statement beside five of them, re-rendered and compared in CI on every push.
- Blind documents and sets: `render --blind-keys` and `batch --blind-keys` name each document by an opaque id, never
  its scenario, planted errors or seed, write the answer keys to a folder apart from the documents and generate the
  content from a salt drawn for each set (`--blind-salt` makes a set again). Over MCP, `render_blind` renders a
  blind document and `get_answer_key` returns its key.
- The published set "standard": 1,887 blind documents over all 45 published scenarios, with layout variants, degraded
  copies, 835s and 513 provider's statements, made by `batch --set standard`; claimseed 0.8.0's copy and its public
  answer keys are attached to the GitHub release v0.8.0 (0.7.0's, 1,022 documents, to v0.7.0). `verify --manifest`
  counts every document of a set in its headline figures, with `scoredOnly` and breakdowns by type, degradation and
  error kind.
- Provider statements: for one claim of a `ppo-eob`, `hmo-eob` or `commercial-eob`, `render --also bill` and `batch
  --also bill` write the provider's statement (`provider-statement`) in one of six variants (`--bill`), with its own
  answer key; the two keys name each other (`pair`), and on a correct statement the balance due is the member share
  the EOB shows for that claim less Payments Received, the copay paid at the visit or zero. Two error kinds show only
  when the statement is read beside the EOB (`bill-vs-eob-mismatch`, `bill-payment-mismatch`), and `paid-at-visit` is
  a decoy. A batch writes each statement as its own document and lists the pairs in `pairs.jsonl`; over MCP,
  `render_document` and `render_blind` take `also` and `bill`, and `verify_document` takes `document` (`eob` or
  `bill`). Statements have degraded copies (`--degrade` with `--also bill`) and are in the published set since 0.8.0.
- The commercial EOB: `commercial-eob`, an EOB from a fictional self-funded employer plan (PPO or HSA-qualified
  option) administered by one of two fictional insurers with their own names, marks and layouts (`--insurer a|b`, or
  drawn from the seed). It prints the deductible and out-of-pocket totals, the plan's terms, No Surprises Act
  protections and notice, preventive care without cost sharing and appeal rights. Its 11 scenarios plant six error
  kinds (`surprise-balance-bill`, `preventive-cost-sharing`, `emergency-authorization-denial`,
  `in-network-balance-bill`, `math-error` on an accumulator row, `missing-required-section`) and seven decoys; its 835
  has one transaction per payee; its answer key (1.7) adds the plan's facts. The provider's statement beside it comes
  from the provider the EOB names (a hospital, a medical group, an urgent care center, a lab or an ambulance service).

## Next

The order below follows what users ask for, and can change with it.

- **More formats.** Fictional insurers with their own names and marks, EOB layouts that differ in structure (not only
  in style), and bills from more kinds of provider (hospital, physician group, urgent care, lab, ambulance). (Since
  0.8.0 the commercial EOB has two such insurers, whose layouts differ in structure, and the provider's statement
  beside it comes from all five kinds.)
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
