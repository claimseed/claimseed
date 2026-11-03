# Lineage — itemized-bill

Original claimseed hospital itemized-statement layout. The element list (statement details, revenue-code groups
with HCPCS line items, insurance summary, payment options, aging summary, financial-assistance notice) is informed
by the HFMA Patient Financial Communications best practices (https://www.hfma.org/patient-financial-communications/)
and the itemized-statement and billing-notice elements described in the Medicare Claims Processing Manual, ch. 1
(provider billing of beneficiaries) and 42 CFR 405.1200 (notices to beneficiaries). It imitates no
hospital's statement; the facility name, address, phone numbers, tax ID and website are generated (fictional-only
lexicon, NNN-555-01xx numbers, .example domains).
Every page carries the claimseed specimen band and watermark and the PDF metadata marker.
This is a synthetic test document, not a bill from any hospital, and its layout variants are claimseed's own designs. No federal model exists for a hospital itemized statement. Every layout variant of this bill keeps all six columns (department code, service date, HCPCS code, quantity, description and charge), the subtotal for each department group and the totals, and always prints the charge column last. Variants change the order of the other five columns, header wording, font, density, color and how a department group continued across pages is marked.
