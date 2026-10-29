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
- Decoys on the MSN and the itemized bill: lines that look wrong but follow the rules, listed in the ground truth's
  `decoys[]` so that flagging one counts as a false alarm.
- `@claimseed/mcp`: an MCP server over stdio with `list_document_types`, `describe_document_type`, `generate_data`,
  `render_document` (page images in the result and an MCP Apps view) and `verify_document`, the ground-truth and
  extractor-output schemas and catalogs as resources, and a `build_test_case` prompt.
- A Docker image (`Dockerfile`) with Chromium, for running the MCP server without installing a browser.
- `examples/`: one document per published scenario, re-rendered and compared in CI on every push.

## Next

- **More MCP tools.**
  - `render_scenario_pair`: two documents of one encounter (for example an MSN and the provider's itemized bill)
    that agree or disagree on purpose, with one ground truth across both.
  - `degrade_document` (next): scan-, fax- and phone-photo-style degradation of a rendered specimen (skew, noise, blur,
    low resolution), recorded in the ground truth's `degradation` field. It takes only files the server rendered
    itself, by the name it returned.
  - Adversarial fixtures (prompt-injection text and other hostile content inside a specimen, for testing an agent's
    defences), only when a call asks for them explicitly.
- **Error injection and decoys on the Medicare Advantage EOBs**, which accept neither today.
- **More layouts**, each with its public model cited in its `LINEAGE.md`: Advance Beneficiary Notice (ABN), Part D
  explanation of benefits, collections notice, pharmacy receipt. Each brings the error kinds marked `planned` in
  `docs/error-taxonomy.md` that need it.
- **Cross-document scenarios** (`bill-vs-eob-mismatch`, `identity-conflict` and the other pair kinds in the taxonomy).
- **A gallery** of rendered examples in the README, hosted with each release (the repository holds no binary files).

## Not planned

- Anything built from a real person's documents, in any form; see `docs/synthetic-data-policy.md`.
- Network access from the renderer or the MCP server.
