# claimseed

Seeded, fully synthetic U.S. medical-billing specimen documents (Medicare Summary Notices, hospital itemized bills,
explanations of benefits from fictional Medicare Advantage plans and from a fictional employer health plan, and the
provider's statement for one claim of an EOB) rendered to PDF with ground-truth JSON that says exactly which billing
errors were injected and where. For testing document extractors, bill-review tools and agents
without ever touching a real person's paperwork.

- Names, identifiers, addresses, fictional phone numbers, dates, services and amounts are generated from a seed; the
  standard wording (public federal model text and claimseed's own sentences), the federal help lines a document prints
  and the fictional insurers' names are fixed. Nothing in this repository is, or is derived from, a real document; see
  `docs/synthetic-data-policy.md`.
- Every rendered page says so: a specimen band (text, in the foot margin), a diagonal watermark (drawn as shapes, so
  it never leaks letters into text extraction) and PDF metadata, stamped into the finished PDF by the renderer itself;
  no CLI flag, library call or data object switches them off.
- Same seed, same document: the output depends only on the type, scenario, seed, options and claimseed version, fonts
  are bundled and PDF metadata is fixed, so two renders on the same Chrome build (Linux, as in CI) are byte-identical;
  other platforms produce the same content, with bytes that may differ by Chrome version. A degraded copy is the
  exception: its pixels, and so its bytes, can differ slightly between two renders, even on one build.

## Sample documents

[`claimseed-0.8.0-samples.zip`](https://github.com/claimseed/claimseed/releases/download/v0.8.0/claimseed-0.8.0-samples.zip)
(about 3.4 MB, on the GitHub release v0.8.0) holds open documents that claimseed 0.8.0 rendered with seed
`example`, each with its answer key: a Medicare Summary Notice with three planted errors and a scanned-looking copy, a
hospital itemized bill, a Medicare Advantage PPO EOB and two commercial EOBs. The notice and the three EOBs come with
their 835s, two of the EOBs with a provider's statement, and `report-example.json` is a report to score. For the full
list of examples, see `examples/`.

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

As an MCP server for agents (`@claimseed/mcp`, stdio). Each command below starts the server for an MCP client, which
runs it from its configuration; run by hand in a terminal, the server prints one line saying whether it saves files,
then waits for a client. Rendered documents come back as page images that chat clients show in the conversation
(directly, or in an MCP Apps view with the expected findings beside the pages), and no file is saved:

    npx -y @claimseed/mcp

or, to also keep each PDF and its ground truth, with a folder it writes into and nowhere else, which must exist first
(the server refuses to start without it):

    mkdir -p claimseed-out
    npx -y @claimseed/mcp --workspace ./claimseed-out

or with the published container image, Chromium included:

    mkdir -p claimseed-out
    docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
      --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" ghcr.io/claimseed/claimseed-mcp

The server is also listed in the MCP registry as `io.github.claimseed/claimseed`. See `packages/mcp/README.md` for the
tools, the client configuration and the limits.

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

    npx @claimseed/core batch --types msn,itemized-bill --seeds 1 --out ./set --blind-keys ./keys
    # write one report per PDF to ./reports, named as the PDF with .json in place of .pdf, in the shape of schemas/extractor-output.schema.json
    npx @claimseed/core verify --manifest ./keys/manifest.jsonl --outputs ./reports

With `--seeds 1` it renders 18 documents, one per scenario (13 MSN scenarios and 5 itemized bill scenarios); a larger
`--seeds` gives a larger set.

The recipe is blind because an open document prints its type, scenario and seed in its specimen band and file names,
where a tool under test could read the answer; `--blind-keys` names each document by an opaque id and writes the
answer keys and the manifest to `./keys`.

The score gives field accuracy, error recall and precision, false alarms and the paths read wrong or missed. Clean
scenarios test for false alarms; some scenarios of every type also plant decoys, lines that look like errors but
follow the rules (the same service on two dates, a charge far above the approved amount, a copay cut short where the
member reaches the out-of-pocket maximum), and flagging one counts as a false alarm. Agents can score one document at
a time with the MCP tool `verify_document`.

The headline figures of `verify --manifest` (`fields`, `errors`) now count every document: a missing or invalid report
scores as an empty one, and so does a part a report leaves out (fields or errors) once any report gives that part.
Skipping a document never raises field accuracy or error recall; precision counts only what was flagged, so read it
beside recall. `scoredOnly` holds the earlier figures, over the scored reports; `byType`, `byDegradation` (`clean` or
the preset) and `byKind` (expected, found and recall per error kind) break them down. Besides planted errors, `errors`
counts the correct denials an answer key lists at severity `info`; `errors.excludingInfo` gives the same figures
without them, for billing and notice errors alone.

## A ready-made test set

The standard set is 1,887 blind documents over all 45 published scenarios: 260 Medicare Summary Notices (13 scenarios
x 20 seeds), 250 itemized bills (5 x 50), 256 PPO and 256 HMO EOBs (8 x 32 each), 352 commercial EOBs (11 x 32) and
513 provider's statements beside them (152 PPO, 152 HMO, 209 commercial). Bills and Medicare Advantage EOBs turn
through the standard layout and its 12 variants; a commercial EOB's own seed picks its insurer, and so its layout,
each insurer on at least 40% of them. Every fifth seed is a degraded copy (scan, fax, photo, low resolution in turn),
as is the statement beside one, with the same preset: 426 in all, 162 of them statements. A statement goes beside each
EOB with an even seed number and each degraded EOB; its variant (a planted error, the decoy, both or none) is set by the
salt under quotas and shows only in the pair's two answer keys, the statement's and the EOB's. Notices and EOBs have
their 835s (1,124); bills and statements have none. Which documents get a layout variant, a degraded preset, an 835 and
a statement depends only on the seed number (set-1, set-2, ...), the same way in every scenario, so none of these tells
a document's scenario.

claimseed 0.8.0's copy is attached to the [GitHub release
v0.8.0](https://github.com/claimseed/claimseed/releases/tag/v0.8.0):
[`claimseed-0.8.0-standard-documents.zip`](https://github.com/claimseed/claimseed/releases/download/v0.8.0/claimseed-0.8.0-standard-documents.zip)
(about 455 MB) unzips to `claimseed-0.8.0-standard/documents/` (PDFs, 835s, `pairs.jsonl`, `README.md`, `SHA256SUMS`)
and
[`claimseed-0.8.0-standard-keys.zip`](https://github.com/claimseed/claimseed/releases/download/v0.8.0/claimseed-0.8.0-standard-keys.zip)
(about 7.7 MB) to `claimseed-0.8.0-standard/keys/` (answer keys, `manifest.jsonl`, `README.md`, `SHA256SUMS` and
`set.json`: the claimseed and Chrome versions, the release's git tree, document count, salt and canary). 0.7.0's copy
(1,022 documents, no commercial EOBs or statements) stays on v0.7.0; another version's salt makes a different set
under 0.8.0, or is refused. Give the tool under test only the documents folder; a tool that checks a statement against
its EOB also needs the `pairs.jsonl` there, which pairs them by id only. The 835s sit there too; to score a tool on
reading the PDFs alone, give it only the `.pdf` files:

    # run the tool on every PDF in documents/; write one report per PDF to reports/, named as the PDF with .json for .pdf,
    # in the shape of schemas/extractor-output.schema.json
    npx @claimseed/core@0.8.0 verify --manifest claimseed-0.8.0-standard/keys/manifest.jsonl --outputs reports
    # the same content again with claimseed 0.8.0 and the salt in set.json (or any of its keys); PDF bytes can
    # differ by machine and Chrome install, so the SHA-256s in the manifest and SHA256SUMS name the published files
    npx @claimseed/core@0.8.0 batch --set standard --out documents --blind-keys keys --blind-salt SALT

It is a public development set with public keys; every answer key and manifest line carries a canary string with a
fixed GUID (`blind.canary`) so that people who train models can find and leave out claimseed answer keys, and people
who test a model can check whether it has seen them. Please keep the keys out of training data. For a held-out test,
make your own blind set with `batch --blind-keys` (a fresh salt) and keep its keys to yourself.

## Blind documents

For tools that must not see the answers, `render` and `batch` take `--blind-keys KEYDIR`. A blind document is named
by an opaque id (`doc-` and 16 hexadecimal digits): its specimen band, PDF title, file names, page-image markers and
835 carry that id, never the scenario, planted errors or seed. Its answer key (ground truth 1.5; 1.6 for either document of a Medicare Advantage pair and for a provider's statement;
1.7 for a commercial EOB, blind or not) and a batch's manifest go to KEYDIR, never the documents' folder or one inside
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

A Medicare Summary Notice, a Medicare Advantage EOB or a commercial EOB can come with the X12 835 remittance of the
same claims, for testing software that reads payments rather than paper:

    npx @claimseed/core render msn combined-three-errors --seed demo --out ./out --also 835
    npx @claimseed/core batch --types msn,ppo-eob,hmo-eob,commercial-eob --seeds 20 --also 835 --out ./set

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
option works with `--degrade` and `--also 835` (the 835 is the same as the standard document's). The Medicare Summary Notice has one national format and takes no variant. The commercial EOB takes none either: its
insurer (`--insurer a` or `--insurer b`, or drawn from the seed) prints it in one of two layouts, portrait (`a`) or
landscape (`b`). Agents pass `layout_variant` to the MCP tools; the
ids and what each fixes are listed in `packages/core/data/<type>/variants.json`.

## How claimseed compares

- [Synthea](https://github.com/synthetichealth/synthea) simulates synthetic patient populations and exports their
  records, claims included, as FHIR, C-CDA and CSV. It models care, not printed billing documents.
- CMS's [Blue Button 2.0 API](https://bluebutton.cms.gov/api-documentation/) offers developers a sandbox of
  synthetic Medicare enrollee data, served as FHIR resources.
- claimseed prints the documents a patient or a bill reviewer actually reads (Medicare Summary Notices, itemized
  bills, Medicare Advantage and commercial employer-plan EOBs, and the provider's statement beside an EOB) with
  CPT/HCPCS codes, amounts from public fee schedules, planted errors and decoys, and an answer key for each. It does
  not model clinical histories; use Synthea beside it for those.

## Limits

- The layouts are claimseed's own and imitate no real plan's, insurer's or provider's documents; the Medicare Summary
  Notice follows the public CMS model notice.
- There are no 837 claim files, no claim forms (CMS-1500, UB-04) and no Medicaid plans.
- Answer keys locate values by JSON field path and line reference (`documents[0].fields`, `claims[0].lines[1]`), never
  by page coordinates or bounding boxes.
- Identifiers are format-valid but cannot be real: NPIs start with 9, Medicare numbers carry `S` in position 2,
  generated phone numbers are in the fictional `555-01xx` range and tax IDs start with `00`. Software that validates
  real identifiers rejects them.
- Amounts come from 2026 public Medicare fee schedules; the commercial EOB's are those amounts times published average
  commercial price ratios.
- Nobody outside the project has validated claimseed, and versions before 1.0 may still change their interfaces.

## Status

0.8.0 adds `commercial-eob`, the EOB of a fictional self-funded employer plan (PPO or HSA-qualified) run by fictional
insurer `a` (portrait) or `b` (landscape), chosen by `--insurer` (`insurer` in the library and over MCP) or the seed.
Its 11 scenarios plant six error kinds and seven decoys; it has an 835; its answer key (1.7) adds the plan's facts
(`plan`). Its provider's statement (`--also bill`) comes from a provider on the EOB (hospital, medical group, urgent
care, lab or ambulance), titled by kind. Statements have degraded copies (`--degrade` with `--also bill`). The
standard set is remade: 1,887 blind documents, with commercial EOBs and 513 statements (GitHub release v0.8.0). Seeds
ending in a file-name suffix (`.bill`, `.a`, `.b`, a layout variant id, `_scan`, `_fax`, `_photo`, `_low-res`) are
refused. Tests hold the lighter watermark (7% opacity, was 14%) and the band to contrast and reach floors on every
type and preset.

0.7.0 added statements beside Medicare Advantage EOBs (`--also bill`, `--bill`; key 1.6) and remade the standard set.
0.6.0 added blind documents and sets (`--blind-keys`, `--blind-salt`, `render_blind`, `get_answer_key`), the published
standard set and whole-set scores. 0.5.0 added Medicare Advantage EOB errors and decoys, layout variants and strict
MCP arguments. 0.4.0 added 835 remittances and scanned-looking copies. 0.3.0 added scoring, batch manifests and
decoys. 0.2.0 added MCP page images, an MCP Apps view and a no-files mode. Versions before 1.0 may still change their
interfaces. The types shipped are `msn`, `itemized-bill`, `ppo-eob`, `hmo-eob` and `commercial-eob`, with
`provider-statement` beside each EOB type. `docs/roadmap.md` gives what comes next. `examples/` lists one document per
scenario (per insurer for the commercial EOB) and per layout variant id, plus five provider's statements. The code is
licensed under Apache-2.0 (`LICENSE`); generated documents and their answer keys, the published set and the samples
are released to the public domain under CC0 1.0 (`NOTICE`).

## Acceptable use

Output is for testing software. Do not present a specimen to a beneficiary, patient, payer or agency as a real
document, and do not remove the specimen markers from one you pass on; see `docs/synthetic-data-policy.md`.

## Contributing

See `CONTRIBUTING.md` (synthetic-data rules, review checklist, DCO sign-off) and `SECURITY.md`. To report a bug, a
wrong rule or a confusing doc, open a GitHub issue on this repository with the type, scenario, seed and claimseed
version, enough to make the document again. Report a vulnerability as `SECURITY.md` describes, never in an issue.
Never attach, paste or describe a real medical document, bill or notice, not even redacted.
