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

From npm (Node.js 20 or later):

    npx @claimseed/core list
    npx @claimseed/core render msn combined-three-errors --seed demo --out ./out
    npx @claimseed/core generate itemized-bill balance-billing --seed demo > demo.json

Rendering needs a Chrome or Chromium binary (`CLAIMSEED_CHROME=/path/to/chrome`, or an install in a usual place);
`generate` does not.

As a library (`npm install @claimseed/core`, ESM):

    import { generateData, render } from '@claimseed/core';
    const { data, groundTruth } = generateData({ type: 'msn', scenario: 'baseline-clean', seed: 'demo' });
    const { pdf, groundTruth: gt } = await render({ type: 'msn', scenario: 'baseline-clean', seed: 'demo', outDir: './out' });

As an MCP server for agents (`@claimseed/mcp`, stdio; it writes only into the folder you give it):

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

## Status

0.1.0 is the first public release; versions before 1.0 may still change their interfaces. The layouts shipped are
`msn`, `itemized-bill`, `ppo-eob` and `hmo-eob`; more are planned (ABN, Part D EOB, collections notice, pharmacy
receipt); see `docs/roadmap.md`. `examples/` lists one rendered document per scenario. Licensed under Apache-2.0
(see `LICENSE` and `NOTICE`).

## Acceptable use

Output is for testing software. Do not present a specimen to a beneficiary, patient, payer or agency as a real
document, and do not remove the specimen markers from one you pass on; see `docs/synthetic-data-policy.md`.

## Contributing

See `CONTRIBUTING.md` (synthetic-data rules, review checklist, DCO sign-off) and `SECURITY.md`.
