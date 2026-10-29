# claimseed

Seeded, fully synthetic U.S. medical-billing specimen documents — Medicare Summary Notices, hospital itemized
bills and Medicare Advantage explanations of benefits — rendered to PDF with ground-truth JSON that says exactly
which billing errors were injected and where. For testing document extractors, bill-review tools and agents
without ever touching a real person's paperwork.

- Every name, identifier, address, phone number and amount is generated from a seed. Nothing in this repository
  is, or is derived from, a real document; see `docs/synthetic-data-policy.md`.
- Every rendered page says so: a specimen band (text, in the foot margin), a diagonal watermark (drawn as shapes, so it
  never leaks letters into text extraction) and PDF metadata, stamped into the finished PDF by the renderer itself —
  no CLI flag, library call or data object switches them off.
- Same seed, same document: all content is derived from the seed, fonts are bundled and PDF metadata is fixed, so two renders on the same Chrome build (Linux, as in CI) are byte-identical; other platforms produce the same content, with bytes that may differ by Chrome version.

## Quick start

From npm (Node.js 20 or later; the MCP server needs 22.13 or later):

    npx @claimseed/core list
    npx @claimseed/core render msn combined-three-errors --seed demo --out ./out
    npx @claimseed/core generate itemized-bill balance-billing --seed demo > demo.json

Rendering needs a Chrome or Chromium binary (`CLAIMSEED_CHROME=/path/to/chrome`, or an install in a usual place);
`generate` does not. Run these from any folder outside a checkout of this repository: inside one, npx takes the
repository's own copy of the package, which needs `npm ci` first (see "From a checkout" below).

As a library (`npm install @claimseed/core`, ESM):

    import { generateData, render } from '@claimseed/core';
    const { data, groundTruth } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'demo' });
    const { pdf, groundTruth: gt } = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'demo', outDir: './out' });

As an MCP server for agents (`@claimseed/mcp`, stdio). Rendered documents come back as page images that chat
clients show in the conversation (directly, or in an MCP Apps view with the injected errors beside the pages), and
no file is saved:

    npx -y @claimseed/mcp

or, to also keep each PDF and its ground truth, with a folder it writes into and nowhere else:

    npx -y @claimseed/mcp --workspace ./claimseed-out

or with the published container image, Chromium included:

    docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
      --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" ghcr.io/claimseed/claimseed-mcp

The server is also listed in the MCP registry as `io.github.claimseed/claimseed`. See `packages/mcp/README.md` for
the tools, the client configuration and the limits.

From a checkout of this repository:

    npm ci
    cd packages/core
    node src/cli.js list
    node src/cli.js render msn combined-three-errors --seed demo --out ./out

and `docker build -t claimseed-mcp .` at the repository root builds the same image as the published one.

See `packages/core/README.md` for the engine, `docs/error-taxonomy.md` for the error kinds a scenario can inject,
and `schemas/ground-truth.schema.json` for the ground-truth format.

## Scoring an extractor

Render a set, run your extractor or bill auditor on the PDFs, and score its reports against the answer keys:

    npx @claimseed/core batch --types msn,itemized-bill --seeds 20 --out ./set
    # write one report per document to ./reports/<pdf name>.json, in the shape of schemas/extractor-output.schema.json
    npx @claimseed/core verify --manifest ./set/manifest.jsonl --outputs ./reports

The score gives field accuracy, error recall and precision, false alarms and the paths read wrong or missed. Clean
scenarios test for false alarms; some scenarios also plant decoys, lines that look like errors but follow the rules
(the same service on two dates, a charge far above the approved amount), and flagging one counts as a false alarm.
Agents can score one document at a time with the MCP tool `verify_document`.

## How claimseed compares

- [Synthea](https://github.com/synthetichealth/synthea) simulates synthetic patient populations and exports their
  records, claims included, as FHIR, C-CDA and CSV. It models care, not printed billing documents.
- CMS's [Blue Button 2.0 API](https://bluebutton.cms.gov/api-documentation/) offers developers a sandbox of
  synthetic Medicare enrollee data, served as FHIR resources.
- claimseed prints the documents a patient or a bill reviewer actually reads (Medicare Summary Notices, itemized
  bills, Medicare Advantage EOBs) with CPT/HCPCS codes, amounts from public fee schedules, planted errors and decoys,
  and an answer key for each. It does not model clinical histories; use Synthea beside it for those.

## Status

0.3.0 adds scoring (`verify`, `verify_document`), batch output with a manifest, and decoys; 0.2.0 added page
images of every rendered document in the MCP server's results, an MCP Apps view, and a mode that writes no files.
Versions before 1.0 may still change their interfaces. The layouts shipped are
`msn`, `itemized-bill`, `ppo-eob` and `hmo-eob`; more are planned (ABN, Part D EOB, collections notice, pharmacy
receipt); see `docs/roadmap.md`. `examples/` lists one rendered document per scenario. Licensed under Apache-2.0
(see `LICENSE` and `NOTICE`).

## Acceptable use

Output is for testing software. Do not present a specimen to a beneficiary, patient, payer or agency as a real
document, and do not remove the specimen markers from one you pass on; see `docs/synthetic-data-policy.md`.

## Contributing

See `CONTRIBUTING.md` (synthetic-data rules, review checklist, DCO sign-off) and `SECURITY.md`.
