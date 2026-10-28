# SOURCES — provenance of printed text

Every sentence of printed stock text is either **V** (verbatim from a public source listed below, with only bracketed
placeholders filled or the noted mechanical change) or **O** (original claimseed wording). `scripts/verify-stock-sources.js`
checks every sentence of six or more words in the stock files, scenario text, generator and render modules and
template text nodes against the snapshots in `data/public-sources/` (sentence-by-sentence substring match after
normalization) and against `data/original-sentences.json`, the reviewed list of original sentences; CI fails on any
sentence in neither.

## Sources
- **[MSN]** CMS, "What is in your Medicare Summary Notice? Part B" (sample Part B MSN with callouts), public domain:
  https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/Sample-Part-B-Medicare-Summary-Notice.pdf
- **[APPX-A]** 45 CFR Part 92, Appendix A (eCFR, point in time 2019-01-01):
  https://www.ecfr.gov/on/2019-01-01/title-45/subtitle-A/subchapter-A/part-92/appendix-Appendix%20A%20to%20Part%2092
- **[APPX-B]** 45 CFR Part 92, Appendix B (eCFR, point in time 2019-01-01):
  https://www.ecfr.gov/on/2019-01-01/title-45/subtitle-A/subchapter-A/part-92/appendix-Appendix%20B%20to%20Part%2092
- **[OCR-2024]** HHS OCR Sample Nondiscrimination Policy (2024 Section 1557 rule):
  https://www.hhs.gov/sites/default/files/1557-sample-nondiscrimination-policy.pdf
- **[HC-GOV]** CMS, HealthCare.gov "Other Language Resources" (language-assistance sentences in 15 languages, public domain):
  https://www.healthcare.gov/language-resource/

## packages/core/data/msn/stock-content.json
| Key(s) | Status |
| --- | --- |
| Every section heading and column heading (dashboard, tips, claims, notes, appeals pages) | **V [MSN]** — each is a heading of the sample notice |
| `logo.*`, `page1.tagline`, short labels absent from the sample (`noticeForLabel`, `medicareNumberLabel`, `dateOfNoticeLabel`, `claimsProcessedLabel`, `servicesApproved*`, `totalYouMayBeBilledLabel`, `page3.referredByLabel`, `claimNumberLabel`, `page4.getMoreDetailsTitle`, `appealFormTitle`), `mailingAddress` (fictional) | **O** / plain labels |
| `mailingAddressTitle` | **V [MSN]** (step 7 wording) |
| `page1.deductibleStatusText` | **V [MSN]** |
| `page1.deductibleStatusLine` | **V [MSN]** with the amounts and year as placeholders |
| `page1.beInformedText` | **V [MSN]** (all four sentences) |
| `page1.languageLine` | Spanish sentences and the Chinese line with 1-800-MEDICARE: **V [MSN]** page 1 (Chinese: extraction spaces removed, fullwidth punctuation used where the extraction showed spaced ASCII); English sentences: **V [MSN]** callout 7 ("Help in Your Language") |
| `page2.howToCheckItems` (3) | **V [MSN]** |
| `page2.howToReportFraudText` | **V [MSN]** first three sentences (the "$4.2 billion" sentence, the HHS-OIG hotline and the P.O. Box are not printed) |
| `page2.howToGetHelpItems` | **V [MSN]** ("1-800-MEDICARE (1-800-633-4227)"; "TTY 1-877-486-2048 (for hearing impaired)"; the SHIP sentence without the sample's placeholder number) |
| `page2.preventiveServicesText` | sentence 1 **V [MSN]**; sentence 2 **V [MSN]** with its bullet list run into the sentence; the MyMedicare.gov bullet is not printed |
| `page2.messages` (4) | **V [MSN]** |
| `page3.introParagraph` | **V [MSN]** |
| `page3.definitions[*].definition` (5) | **V [MSN]** |
| `page4.getMoreDetailsText` | **V [MSN]** (both paragraphs) |
| `page4.disagreeTitle` | **V [MSN]** |
| `page4.disagreeText` | "Appeals must be filed in writing." and "Our claims office must receive your appeal within 120 days from the date you get this notice." **V [MSN]**; "Use the form below." **O** (the sample's "Use the form to the right." adapted to this layout) |
| `page4.appealInstructions[0]` | **V [MSN]** ("We must receive your appeal by: {appealDeadline}", date as placeholder) |
| `page4.needHelpText`, `page4.needHelpItems` | **V [MSN]** |
| `page4.findOutMoreText` | **V [MSN]** |
| `page4.fileAppealIntro` | **V [MSN]** ("Follow these steps:") |
| `page4.fileAppealInstructions` | steps 1, 2, 4, 5, 6, 7 **V [MSN]**; step 3 is the sample's step 3 with its three-line list run into one sentence |
| `page4.appealFormFields` | **O** / labels (shortened from the sample's step-3 fields) |

## packages/core/data/ppo-eob/stock-content.json (Corvane)
| Key(s) | Status |
| --- | --- |
| `notices.nondiscrimination`, `notices.nondiscriminationServices`, `notices.nondiscriminationAfter`, `notices.grievance` | **V [APPX-A]**, the entire notice in order; "[Name of covered entity]" -> {legalName}; "[Name of Civil Rights Coordinator]" -> "our Civil Rights Coordinator at 614-555-0153 (TTY 711)"; the bracketed coordinator contact fields -> the fictional coordinator's details; "[Name and Title…] is available to help you" -> "the Civil Rights Coordinator is available to help you". The OCR portal URL, OCR mailing address, 1-800-368-1019 and 800-537-7697 (TDD), and the complaint-forms URL are printed as in Appendix A (the 2019 text; the HMO layout prints the 2024 sample's current URLs) |
| `notices.taglines[English]` | **V [APPX-B]**: the tagline's statement capitalised as a sentence, plus the call line |
| `notices.taglines` Español, 中文, Tiếng Việt, 한국어, Tagalog, Français, Português, Deutsch, Italiano | **V [HC-GOV]**: the first sentence of each language's entry, verbatim, followed by a short "call {phone}" line that reuses that page's own call wording where it has one. Languages the bundled fonts cannot display are not included |
| `notices.specimenNote` | **O** |
| `cover.intro` last sentence, `cover.deductibleMetText`, `claims.intro` second sentence, `info.disagree[1]`, `info.disagree[2]`, `info.denied[0]` | **O** |
| All other PPO strings, payer identity, phones, addresses and `.example` sites | **O** |

## packages/core/data/hmo-eob/stock-content.json (Tessara)
| Key(s) | Status |
| --- | --- |
| `notices.nondiscrimination`, `notices.nondiscriminationServices` | **V [OCR-2024]**, "[Name of covered entity]" -> {legalName}; the bracketed optional sex-characteristics clause, the religious-exemption paragraph, the "[if applicable: …]" items and the drafting note on the 92.101(a)(2) enumeration are not printed |
| `notices.nondiscriminationAfter[1]` | **V [OCR-2024]** "For additional assistance, you may also contact [Section 1557 Coordinator]" filled with the fictional coordinator |
| `notices.nondiscriminationAfter[0]` | **O** (in place of the sample's "please refer to [titles of procedures]" sentence) |
| `notices.grievance[0]`, `grievance[1]` first sentence, `grievance[2]` | **V [OCR-2024]** (item 2's "Electronically:" / "Via mail:" lines joined into one paragraph); the rest of `grievance[1]` **O**, filling "[Insert covered entity's relevant grievance information.]" |
| `notices.taglines` | as for PPO (English **V [APPX-B]**, others **V [HC-GOV]**) |
| `notices.specimenNote`, `cover.notABillText` second sentence, `claims.intro` second sentence, `info.questions[2]`, `info.questions[3]`, `info.denied[0]` | **O** |

## packages/core/data/itemized-bill/stock-content.json
All disclaimers, labels and the observation-notice text — **O**.

## packages/core/reference-data/service-catalog.json (`lay` fields)
All descriptions — **O** plain-language descriptions, never AMA CPT descriptor text (see NOTICE and the policy's "Codes and descriptions").

## packages/core/scenarios/
- `msn/denied-not-reasonable-necessary.json` note text — sentences 1–2 **V [MSN]** note A ("This service was denied. The information provided does not support the need for this service or item."); the remaining sentences **O** ("reasonable and necessary" is the statutory term).
- Every scenario `description` — **O**.

## Text printed from code and templates
- `src/generate/itemized-bill.js` (financial-assistance sentence, payment-option lines, service-date range, admission wording), `src/generate/ma-eob.js` (note texts), `src/generate/msn.js` (line-note texts other than the denial note) — **O**.
- `src/generate/msn.js` denial fallback note — **V [MSN]** ("This service was denied.").
- `src/render.js` specimen band and PDF subject, `templates/msn/page3-claims.html` specimen header line, `templates/itemized-bill/*` fixed labels — **O**.
- `templates/{msn,ppo-eob,hmo-eob}/LINEAGE.md` describe each layout's public model.
