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

From npm (Node.js 22.13 or later):

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
scenarios test for false alarms; some scenarios of every type also plant decoys, lines that look like errors but
follow the rules (the same service on two dates, a charge far above the approved amount, a copay cut short where
the member reaches the out-of-pocket maximum), and flagging one counts as a false alarm.
Agents can score one document at a time with the MCP tool `verify_document`.

## Scanned-looking copies

Extractors meet scans, faxes and phone photos, not only clean PDFs. A degraded copy keeps the document's answer key:

    npx @claimseed/core render msn combined-three-errors --seed demo --out ./out --degrade fax
    npx @claimseed/core batch --types msn,itemized-bill --seeds 20 --degrade scan --out ./set

The presets are `scan`, `fax`, `photo` and `low-res`. `render --degrade` writes an image-only PDF, one image per page
and the answer key; `batch --degrade` writes the PDFs and answer keys of a set, with its manifest. The answer key holds
the settings the seed chose (rotation, resolution, noise and the rest) in `degradationParams`. The specimen band and
watermark are drawn on top of the degraded pages, never through the degradation (a fax also prints the watermark as a
dot pattern that survives black and white), and every image file carries the specimen markers. Agents can ask for a
copy with the MCP tool `degrade_document`.

## Remittance files (835)

A Medicare Summary Notice or a Medicare Advantage EOB can come with the X12 835 remittance of the same claims, for
testing software that reads payments rather than paper:

    npx @claimseed/core render msn combined-three-errors --seed demo --out ./out --also 835
    npx @claimseed/core batch --types msn,ppo-eob,hmo-eob --seeds 20 --also 835 --out ./set

Each `.835` is a 005010X221A1 file marked as test data (`ISA15` is `T`, and the sender and receiver IDs, the payer and
the contact say specimen or test), with no bank data. The answer key lists it beside the PDF, and every planted error that shows in the 835
names its place there (`x12Ref`): a wrong claim total breaks the claim's balance or its patient-responsibility total, and a
duplicate is a repeated service line. Agents ask for it with `also: "835"` on the MCP tool `render_document`. See the
core README for what the files contain and what they leave out.

## Layout variants

An extractor tested on one layout may have learned the layout rather than the document. The itemized bill and both
Medicare Advantage EOBs therefore come in 12 layout variants each (`b01`-`b12`, `p01`-`p12`, `h01`-`h12`): an id
fixes the column order, the header and title wording, the font, density and colors, and how a table continued on
the next page is marked. The data, every amount and every required item stay as they are, and the answer key
differs only in naming the variant, the page count and the PDF's hash:

    npx @claimseed/core render ppo-eob combined-three-errors --seed demo --layout-variant p07 --out ./out
    npx @claimseed/core render hmo-eob baseline-clean --seed demo --layout-variant all --out ./out
    npx @claimseed/core batch --types itemized-bill,ppo-eob,hmo-eob --seeds 20 --layout-variant seeded --out ./set

`all` (render and batch) writes one document per id. `seeded` picks an id from the seed alone, so for one seed the
three types take the same position in their lists (`b04`, `p04` and `h04` together); give explicit ids to spread
layouts across types. Files are named `<type>_<scenario>_<seed>.<id>.pdf`, and the answer key records the variant
(`documents[0].layout` is `ppo-eob.p07`, with the details in `documents[0].layoutVariant`; ground truth 1.4). The
option works with `--degrade` and `--also 835` (the 835 is the same as the standard document's). The Medicare
Summary Notice has one national format and takes no variant. Agents pass `layout_variant` to the MCP tools; the
ids and what each fixes are listed in `packages/core/data/<type>/variants.json`.

## How claimseed compares

- [Synthea](https://github.com/synthetichealth/synthea) simulates synthetic patient populations and exports their
  records, claims included, as FHIR, C-CDA and CSV. It models care, not printed billing documents.
- CMS's [Blue Button 2.0 API](https://bluebutton.cms.gov/api-documentation/) offers developers a sandbox of
  synthetic Medicare enrollee data, served as FHIR resources.
- claimseed prints the documents a patient or a bill reviewer actually reads (Medicare Summary Notices, itemized
  bills, Medicare Advantage EOBs) with CPT/HCPCS codes, amounts from public fee schedules, planted errors and decoys,
  and an answer key for each. It does not model clinical histories; use Synthea beside it for those.

## Status

0.5.0 adds planted errors and decoys on the Medicare Advantage EOBs (14 new scenarios), layout variants of the
itemized bill and both EOBs (`--layout-variant`, `layout_variant`: 12 ids per type, with the variant recorded in the
answer key), and strict MCP arguments (every tool refuses an argument it does not declare). 0.4.0 added 835
remittances and scanned-looking copies; 0.3.0 scoring, batch output with a manifest, and decoys; 0.2.0 page images
in the MCP server's results, an MCP Apps view and a mode that writes no files. Versions before 1.0 may still change
their interfaces. The layouts shipped are `msn`, `itemized-bill`, `ppo-eob` and `hmo-eob`; next is a commercial
(non-Medicare) health plan EOB, then more (ABN, Part D EOB, collections notice, pharmacy receipt); see
`docs/roadmap.md`. `examples/` lists one rendered document per scenario and one per layout variant id. Licensed
under Apache-2.0 (see `LICENSE` and `NOTICE`).

## Acceptable use

Output is for testing software. Do not present a specimen to a beneficiary, patient, payer or agency as a real
document, and do not remove the specimen markers from one you pass on; see `docs/synthetic-data-policy.md`.

## Contributing

See `CONTRIBUTING.md` (synthetic-data rules, review checklist, DCO sign-off) and `SECURITY.md`.
