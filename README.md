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

## A ready-made test set

The standard set is 1,022 blind documents over all 34 published scenarios: 260 Medicare Summary Notices (13
scenarios x 20 seeds), 250 itemized bills (5 x 50), 256 PPO EOBs (8 x 32) and 256 HMO EOBs (8 x 32). Bills and EOBs
turn through the standard layout and its 12 variants; one document in five is a degraded copy (scan, fax, photo,
low resolution in turn); every notice and EOB has its 835. Layout, preset and 835 turn alike for every scenario, so
none tells the scenario.

claimseed 0.7.0's copy is attached to the GitHub release v0.7.0: `claimseed-0.7.0-standard-documents.zip` unzips to
`claimseed-0.7.0-standard/documents/` (PDFs, 835s, `README.md`, `SHA256SUMS`) and `claimseed-0.7.0-standard-keys.zip`
to `claimseed-0.7.0-standard/keys/` (answer keys, `manifest.jsonl`, `README.md`, `SHA256SUMS` and `set.json`: the
claimseed and Chrome versions, the release's git tree, document count, salt and canary). Give the tool under test only
the documents folder. The 835s sit beside the PDFs there; to score a tool on reading the PDFs alone, give it only the
`.pdf` files:

    # run the tool on every PDF in documents/; write one report per document to reports/<id>.json,
    # in the shape of schemas/extractor-output.schema.json
    npx @claimseed/core verify --manifest claimseed-0.7.0-standard/keys/manifest.jsonl --outputs reports
    # the same content again with claimseed 0.7.0 and the salt in set.json (or any of its keys); PDF bytes can
    # differ by machine and Chrome install, so the SHA-256s in the manifest and SHA256SUMS name the published files
    npx @claimseed/core@0.7.0 batch --set standard --out documents --blind-keys keys --blind-salt SALT

It is a public development set with public keys; every answer key and manifest line carries a canary string with a
fixed GUID (`blind.canary`) so that people who train models can find and leave out claimseed answer keys, and people
who test a model can check whether it has seen them. Please keep the keys out of training data. For a held-out test,
make your own blind set with `batch --blind-keys` (a fresh salt) and keep its keys to yourself.

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

The headline figures of `verify --manifest` (`fields`, `errors`) now count every document: a missing or invalid
report scores as an empty one, and so does a part a report leaves out (fields or errors) once any report gives that
part. Skipping a document never raises field accuracy or error recall; precision counts only what was flagged, so
read it beside recall. `scoredOnly` holds the earlier figures, over the scored reports; `byType`, `byDegradation`
(`clean` or the preset) and `byKind` (expected, found and recall per error kind) break them down.

## Blind documents

For tools that must not see the answers, `render` and `batch` take `--blind-keys KEYDIR`. A blind document is named
by an opaque id (`doc-` and 16 hexadecimal digits): its specimen band, PDF title, file names, page-image markers and
835 carry that id, never the scenario, planted errors or seed. Its answer key (ground truth 1.5, or 1.6 for the two
documents of a pair, blind or not) and a batch's manifest go to KEYDIR, never the documents' folder or one inside
it:

    npx @claimseed/core batch --types msn,itemized-bill --seeds 20 --out ./set --blind-keys ./keys

Content comes from a seed derived from a salt, 128 random bits drawn for each set and recorded in every key, so
nobody can rebuild a document from a guessed scenario and seed and match a printed claim number. `--blind-salt SALT`
(from an earlier set's key) makes the same set again; documents are written in an order drawn from the salt. A
degraded copy is blind too, with its own id and `copyOf` in its key. The band, watermark and metadata still mark
every page as a specimen; only the scenario words are gone. `verify --manifest` scores a blind set exactly as an
open set.

Over MCP, `render_blind` returns the id and page images, never the key, scenario or seed, and `get_answer_key` the key
(see `packages/mcp/README.md`).

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

0.7.0 adds the provider's statement beside a Medicare Advantage EOB: for one claim of a `ppo-eob` or `hmo-eob`,
`--also bill` and `--bill` (`also` and `bill` over MCP) render the statement (`provider-statement`) with its own
answer key, the two keys name each other (`pair`, answer-key version 1.6), and two new error kinds show only when the
statement is read beside the EOB. It also makes the standard set again (attached to the GitHub release v0.7.0), with
two deductible scenarios that can now be decided from the page and decoys that name the line they repeat. 0.6.0 added
blind documents and sets (`--blind-keys` and `--blind-salt`, and the MCP tools `render_blind` and `get_answer_key`),
the published standard set of 1,022 blind documents with its answer keys (0.6.0's copy is attached to the GitHub
release v0.6.0), and set scores that count every document. 0.5.0 added planted errors and decoys on the Medicare
Advantage EOBs (14 new scenarios), layout variants of the itemized bill and both EOBs (`--layout-variant`,
`layout_variant`: 12 ids per type, with the variant recorded in the answer key), and strict MCP arguments (every tool
refuses an argument it does not declare). 0.4.0 added 835 remittances and scanned-looking copies. 0.3.0 added
scoring, batch output with a manifest, and decoys. 0.2.0 added page images in the MCP server's results, an MCP Apps
view and a mode that writes no files. Versions before 1.0 may still change their interfaces. The layouts shipped are
`msn`, `itemized-bill`, `ppo-eob` and `hmo-eob`. Next is a fictional commercial employer-plan EOB with the provider's
statement beside it (deductible, out-of-pocket maximum, copays and coinsurance, No Surprises Act protections,
preventive care without cost sharing) and errors that show only across the two; `docs/roadmap.md` gives the order of
the work after it. `examples/` lists one rendered document per scenario and one per layout variant id. Licensed under
Apache-2.0 (see `LICENSE` and `NOTICE`).

## Acceptable use

Output is for testing software. Do not present a specimen to a beneficiary, patient, payer or agency as a real
document, and do not remove the specimen markers from one you pass on; see `docs/synthetic-data-policy.md`.

## Contributing

See `CONTRIBUTING.md` (synthetic-data rules, review checklist, DCO sign-off) and `SECURITY.md`.
