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

## Next

- **A commercial health plan EOB** (0.6.0): an explanation of benefits from a fictional non-Medicare health plan.
- **More MCP tools.**
  - `render_scenario_pair`: two documents of one encounter (for example an MSN and the provider's itemized bill)
    that agree or disagree on purpose, with one ground truth across both.
  - Adversarial fixtures (prompt-injection text and other hostile content inside a specimen, for testing an agent's
    defences), only when a call asks for them explicitly.
- **More layouts**, each with its public model cited in its `LINEAGE.md`: Advance Beneficiary Notice (ABN), Part D
  explanation of benefits, collections notice, pharmacy receipt. Each brings the error kinds marked `planned` in
  `docs/error-taxonomy.md` that need it.
- **Cross-document scenarios** (`bill-vs-eob-mismatch`, `identity-conflict` and the other pair kinds in the taxonomy).
- **A gallery** of rendered examples in the README, hosted with each release (the repository holds no binary files).
- **837 claims**, decided after the 835: they need data the generator does not hold (diagnosis codes, place of service,
  birth date and sex, modifiers). An 835 for the itemized bill would come with that work.

FHIR ExplanationOfBenefit output is dropped: Synthea and CMS already publish synthetic FHIR claims.

## Not planned

- Anything built from a real person's documents, in any form; see `docs/synthetic-data-policy.md`.
- Network access from the renderer or the MCP server.
