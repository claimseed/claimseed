# Contributing to claimseed

Thank you for helping. Three rules carry more weight than the rest.

## 1. Nothing real, ever
claimseed renders synthetic specimens. Do not contribute, attach, link or paste any real medical
document, real claim, real patient, provider or member information — not even redacted, not even your own.
CI fails any pull request that adds a PDF, image, font or any other binary file — under any name, in any directory;
example documents are rendered by CI from a seed and attached to releases, never committed. Every scenario
must cite the public source its codes, amounts and error type came from (`sources` field); CI rejects
scenarios without one. See `docs/synthetic-data-policy.md`.

## 2. Nothing branded
Layouts are original designs in the style of a document *family* (MA PPO EOB, Part D EOB, hospital
itemized bill). Do not add a real insurer's, pharmacy's or lab's name, logo, colors, phone number,
address or boilerplate. Government forms (CMS, CFPB) are the exception: they are public domain and
are reproduced faithfully.

## 3. Sign your work (DCO)
Every commit carries a `Signed-off-by:` line (`git commit -s`) certifying the
[Developer Certificate of Origin](https://developercertificate.org/). No CLA.

## Checklist for a pull request
- [ ] No binary files at all (the one bundled fallback font is the only exception); examples are rendered from seeds by CI
- [ ] No real names, identifiers, phone numbers outside `555-01xx` with a geographic area code, NPIs outside the `9` prefix
- [ ] New scenario has `sources`; new layout has a `LINEAGE.md` saying what public document it follows
- [ ] `npm test` and `npm run check` pass
- [ ] A test that adds renders updates its workspace's `test/render-budget.json` (`npm test` counts the stamped PDFs it
  makes and fails on a mismatch; both workspaces together stay within 300 documents and 50 degraded copies)
- [ ] A change to a standard layout's HTML is recorded on purpose in `packages/core/test/fixtures/html-guard.json` (run
  the core tests with `CLAIMSEED_WRITE_HTML_GUARD=1`); variant wording lives in `data/<type>/labels.json` and, like
  all printed text, must be public or a reviewed original
- [ ] Commits are signed off
