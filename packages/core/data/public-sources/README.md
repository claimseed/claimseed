# Public-source snapshots

Text of the public federal documents that claimseed's stock content quotes, captured verbatim (page text or
pdf.js extraction) on the date in each file's first line, with the source URL. They are the reference for
`scripts/verify-stock-sources.js`, which checks that every sentence of six or more words in the stock files,
scenario notes and generator strings is either present here or listed in `data/original-sentences.json`.
All four are works of the United States Government (CMS, HHS) and not subject to copyright. Edits are confined to
redactions marked in square brackets and listed in each file's first line: in the sample MSN, a real Medigap
insurer's name, the sample's provider name/phone/practice/address, the sample beneficiary's name, and two CPT-style
service descriptions (descriptor text is AMA-copyrighted material inside a government document, and is not reused).
These snapshots are reference material for the provenance check; they are never rendered and are not part of the npm package.

| File | Source |
| --- | --- |
| cms-sample-part-b-msn-hhs.txt | https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/Sample-Part-B-Medicare-Summary-Notice.pdf |
| hhs-1557-appendices-and-sample-policy.txt | 45 CFR 92 App. A and B (eCFR, 2019-01-01 point in time) and https://www.hhs.gov/sites/default/files/1557-sample-nondiscrimination-policy.pdf |
| cms-healthcare-gov-language-resources.txt | https://www.healthcare.gov/language-resource/ |
| cms-medicare-gov-talk-to-someone.txt | https://www.medicare.gov/talk-to-someone |
