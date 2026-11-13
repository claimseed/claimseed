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
- [ ] If your change adds or removes stamped PDFs, or adds, removes or renames a test file, edit that file's entry in
  the workspace's `test/render-budget.json` by hand (a new test file gets a new entry), then refresh the recorded
  seconds with `node packages/core/scripts/test-with-render-log.js --record`, which runs every test file and never
  changes counts. `npm test` fails when a file's counts differ from its entry, when a test file has no entry, or when
  an entry names a file that no longer exists. A test file over 600 recorded seconds is refused and one over 300
  should be split into two files, and across both workspaces the budgets must stay within 600 rendered documents and
  100 degraded copies.
- [ ] A change to a standard layout's HTML is recorded on purpose in `packages/core/test/fixtures/html-guard.json` (run
  the core tests with `CLAIMSEED_WRITE_HTML_GUARD=1`); variant wording lives in `data/<type>/labels.json` and, like
  all printed text, must be public or a reviewed original
- [ ] Commits are signed off
