# Lineage — msn

Original claimseed layout of a Medicare Summary Notice for Part B, following the public CMS model notice
(public domain): https://www.medicare.gov/basics/forms-publications-mailings/mailings/costs-and-coverage/medicare-summary-notice
and the redesigned MSN described at https://www.cms.gov/outreach-and-education/outreach/partnerships/msn.
Section order (dashboard, how to read this notice, claims detail, how to handle denied claims and appeals), column
headings and note letters follow that model. Most stock text in data/msn/stock-content.json is quoted verbatim from the
CMS sample Part B MSN (https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/Sample-Part-B-Medicare-Summary-Notice.pdf);
the rest is claimseed's own wording.
The HHS seal is never reproduced; the header says "MEDICARE SUMMARY NOTICE (SPECIMEN)" and "Synthetic test
document — not issued by CMS"; the appeal address is a fictional "Specimen Claims Processing Center". The only
real contact details printed are the public federal lines the sample notice itself prints (1-800-MEDICARE and its
TTY, Social Security and its TTY), listed in docs/synthetic-data-policy.md.
Every page carries the claimseed specimen band and watermark and the PDF metadata marker.
