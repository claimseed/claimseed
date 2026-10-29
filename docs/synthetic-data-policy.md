# Synthetic data policy

claimseed renders specimens that look like real medical-billing paperwork and contain no real person, provider,
plan or claim. This policy is binding on maintainers and contributors; CI enforces the parts it can.

## The standard
**No value in this repository may be traceable to a real document**, and nothing in it may be *derived* from one —
not a name, not an amount, not a date, not the pattern of services on a page. Swapping the name on a real statement
does not make it synthetic: the physicians, dates and charges still identify a person.

## How values are made
| Value | Rule |
| --- | --- |
| Patient and provider names | From the curated lists in `src/generate/lexicon.js`. One reference patient keeps the surname "Specimen". Individual-provider names are checked against the public NPPES registry by name and state (`verify-synthetic-npi.js --nppes`). |
| Addresses | Real city, state and ZIP so the format is right; street names from a fictional list. |
| Phone numbers | Geographic area code + `555-01xx`, the only 555 block reserved for fiction. Never toll-free. The only exceptions are the public federal lines the CMS model notices themselves print: 1-800-MEDICARE and its TTY, Social Security and its TTY, and the HHS Office for Civil Rights voice and TDD lines, portal URL and mailing address exactly as printed in the public nondiscrimination-notice texts the layouts quote (45 CFR 92 Appendix A for the PPO layout; the HHS 2024 sample policy for the HMO layout). No other real organization's contact details appear in any rendered document or stock file. The repository also keeps verbatim snapshots of the public-domain federal source documents (`packages/core/data/public-sources/`) as the reference for the stock-text provenance check; they contain whatever federal contact lines those documents print, are never rendered, and are not part of the npm package. |
| NPIs | 10 digits, Luhn-valid over the 80840 prefix, first digit **9**. NPPES issues only NPIs starting with 1 (2 is reserved), so a 9-prefixed NPI can never collide. |
| Medicare numbers (MBI) | 11 characters in the CMS shape with **S** in position 2 — a letter CMS never uses — so a specimen MBI is recognizable and can never be real. Strict MBI validators will reject it by design. |
| Member IDs, claim numbers, account numbers | Generated from the seed. |
| Dates | Relative to the scenario's processing period. |
| Amounts | Computed by the rules engine from catalog allowed amounts (public CMS fee schedules, cited per code) and a seeded provider markup. |
| Service mix | From `reference-data/service-catalog.json` with editorial weights, to be fitted to public CMS utilization aggregates — never to any document. |
| Error scenarios | Each cites the public rule it violates (`docs/error-taxonomy.md`) and the public source of its structure (`sources[]`, required). |

## What contributors must never do
- Attach, link, paste or "describe from memory" any real statement, bill, notice or lab report — redacted or not, yours or not.
- Fit a distribution, a layout, a scenario or a degradation recipe to real documents.
- Add a real insurer's, pharmacy's or laboratory's name, logo, colors, boilerplate, phone number or address.
- Commit a PDF, image or any other binary file (the bundled fallback font is the only exception); example documents are
  rendered from seeds by CI and attached to releases.

## Markers
Every PDF carries `Subject: synthetic specimen, not a real document` in its metadata, a visible SYNTHETIC SPECIMEN
band on every page and a diagonal watermark; they are stamped into the finished PDF by `mergePdfs`, the single exit
point of every render function, so neither the CLI nor the library API can produce a document without them, and
no data object or template can remove them (the test suite proves both). Page images (the MCP server's previews,
since 0.2.0) are drawn from the stamped PDF, so the band and watermark are in their pixels, and each image file
carries the markers as well: PNG `tEXt` chunks, or an Exif ImageDescription and a comment in a JPEG, with the band text
and the Subject line (tests check the pixels and the file markers). Photo- or scan-style degraded output does not
exist yet; when it is added it must carry the same file markers and a burned-in overprint, with a test that the
markers survive degradation.

## Public sources we build from
Printed text: the CMS sample Part B MSN, 45 CFR 92 Appendices A and B, the HHS 2024 sample nondiscrimination policy,
HealthCare.gov's language-assistance sentences and the Medicare.gov contact page (`packages/core/data/public-sources/`
holds the snapshots; `data/SOURCES.md` the sentence-level ledger). Layout structure: the CMS MSN and the CMS Part C EOB
model (42 CFR 422.111(k)). Amounts and parameters: the Medicare Physician Fee Schedule (RVU file and conversion
factor), the Clinical Laboratory Fee Schedule and the annual Part A/B parameters fact sheet. Rules: the Social Security
Act and 42 CFR provisions cited per scenario in `scenarios/*/*.json` and `docs/error-taxonomy.md`. Nothing else is
used; a new source must be public-domain federal material and must be added to this list and to SOURCES.md.

## Codes and descriptions
Service lines carry CPT and HCPCS Level II code numbers with claimseed's own plain-language descriptions. Contributors
must write such descriptions fresh and short (under 70 characters); never paste text from the AMA CPT descriptors, the
AMA Consumer Friendly Descriptors, a hospital or payer price-transparency file, or the service descriptions printed on
a CMS sample notice. See NOTICE for the AMA and NUBC attributions.

## Acceptable use
claimseed output exists to test software. It must not be mailed, e-mailed, shown or given to Medicare beneficiaries,
patients or the public as a genuine notice, bill or statement; must not be submitted to any payer, agency or court;
and the specimen band, watermark and PDF metadata must not be removed from a document that is passed on. Release
assets are named `*-specimen.pdf` so they are not indexed as real notices. Forks that remove the markers are outside
this project.
