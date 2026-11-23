# Error taxonomy

Every injected error in a claimseed scenario has a `kind` from this list, and every kind cites the public rule it
violates. Every scenario instance (which codes, which amounts, which dates) cites its own public source in the scenario's `sources` field.

**Status column.** `implemented` means the engine has a mutation op that produces this kind today (see `src/generate/mutations.js`, `src/generate/ma-mutations.js`, `src/generate/commercial-operations.js` and the
scenarios); `planned` means the kind is reserved in the taxonomy, with its rule
citation, so that a future scenario or layout can use it, but no code produces it yet. The ground-truth schema accepts
every kind in this table.

Severity is the default; a scenario may override it. "Delta" means the dollar impact to the patient when the error
is present.

## Arithmetic and internal consistency (single document)

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `math-error` | implemented | Line items do not sum to the printed total, or a percentage is miscomputed. A deductible or out-of-pocket row's year to date does not equal the amount before this statement plus this statement's amount; the figures in the answer key are as the plan applied them, and the error's entry gives what is right. | Internal consistency; no external rule needed | EOB, MSN, itemized bill, summary bill, commercial EOB |
| `duplicate-charge` | implemented | The same service, date and code appears twice on one claim or across related claims | CMS Medicare Claims Processing Manual ch. 1 §120 (duplicate claims); NCCI MUE for units | EOB, MSN, itemized bill |
| `subtotals-mismatch` | implemented | Department or category subtotals disagree with the grand total | Internal consistency | Itemized bill, summary bill |
| `negative-adjustment` | planned | A credit line offsets an unrelated claim without explanation | MSN/EOB readability; CMS MSN design standards | MSN, EOB |
| `service-date-anomaly` | implemented | A line's date of service falls outside the statement's processing period, after the notice date, or disagrees with the same claim's date elsewhere on the document | Internal consistency; CMS Claims Processing Manual ch. 1 §70.1 (date of service) | MSN, EOB, itemized bill |
| `phantom-service` | planned | A line for a service not supported by any other document for that date | OIG improper-payment typology ("services not rendered") | Itemized bill vs. EOB/lab report |

## Cost sharing

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `in-network-balance-bill` | implemented | An in-network line bills the member more than the cost sharing and any amount not covered. An in-network line's member amount adds the difference between the billed and allowed amounts to the deductible, copay and coinsurance; the line's figures in the answer key are as the plan applied them, and the error's entry gives what is right. | Uniform Glossary of Coverage and Medical Terms (allowed amount; balance billing), https://www.cms.gov/files/document/uniform-glossary-english-060723.pdf | Commercial EOB |
| `deductible-misapplied` | implemented | Deductible applied twice, at the wrong amount, or after it was already met | Annual Part B deductible (CMS annual notice); plan EOC for MA plans | EOB, MSN |
| `cost-sharing-error` | implemented | Coinsurance or copay outside what the plan or Original Medicare allows for that service | 42 CFR 422.100(f) (MA cost-sharing limits); Part B 20% coinsurance, SSA §1833 | EOB, MSN |
| `oop-max-exceeded` | implemented | A line charges the member a copay or coinsurance after the out-of-pocket maximum was reached, so the year-to-date member share is more than the out-of-pocket amount the cover shows. | In-network out-of-pocket limit, 42 CFR 422.100(f)(4), https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-422/subpart-C/section-422.100; plan's evidence of coverage: once the maximum is reached, the plan pays the full approved amount for covered in-network services | EOB |
| `preventive-cost-sharing` | implemented | A preventive service that must be $0 carries cost sharing. An in-network line whose code is on the plan's list of preventive services charges a deductible, copay or coinsurance; the line's figures in the answer key are as the plan applied them, and the error's entry gives what is right. | SSA §1861(ddd), 42 CFR 410.152(l); ACA §2713 for commercial; 45 CFR 147.130 | MSN, EOB, commercial EOB |
| `preventive-miscoded-as-diagnostic` | planned | Preventive service billed with diagnostic codes or modifiers, triggering cost sharing | CMS Preventive Services chart (MLN006559); screening vs. diagnostic ICD-10 Z-codes | MSN, EOB, lab report |
| `qmb-cost-sharing-violation` | planned | A Qualified Medicare Beneficiary is billed Medicare cost sharing | SSA §1902(n)(3)(B); CMS MLN SE1128 | MSN, itemized bill, collections letter |
| `ira-insulin-cap-not-applied` | planned | Part D insulin fill charged above the monthly cap | Inflation Reduction Act §11406 (SSA §1860D-2(b)(9)) | Part D EOB, pharmacy receipt |
| `lis-copay-not-applied` | planned | Low-Income Subsidy copay tier not applied | 42 CFR 423.782 | Part D EOB, pharmacy receipt |
| `medigap-preventive-copay` | planned | Medigap plan applies a copay to a Medicare-covered preventive service | Medigap standardized plan rules, 42 CFR 403 App. A | Medigap EOB |

## Coding and pricing

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `fee-schedule-overcharge` | implemented | Approved amount exceeds the fee schedule for that code, locality and year | Medicare Physician Fee Schedule (public lookup); CLFS for labs | EOB, MSN |
| `unbundling` | planned | Component codes billed separately where a comprehensive code applies | NCCI Procedure-to-Procedure edits (public quarterly tables) | Itemized bill, EOB |
| `upcoding` | planned | A higher-intensity code than the documented visit supports | CPT E/M guidelines; OIG upcoding reports | Itemized bill, EOB |
| `units-exceed-mue` | planned | Units billed exceed the Medically Unlikely Edit for that code | NCCI MUE tables | Itemized bill |
| `frequency-limit-denial` | planned | A service denied under a national coverage frequency limit | e.g. NCD 190.21 (HbA1c), NCD 210.3 (colorectal screening) | MSN, denial notice, lab report |
| `screening-vs-diagnostic-miscoding` | planned | Ordering diagnosis on the clinical record is a screening code but the claim is billed as diagnostic (or vice versa) | ICD-10-CM Z-code guidelines; CMS screening coverage rules | Lab report vs. MSN/EOB |
| `wrong-place-of-service` | planned | Place-of-service code inconsistent with the facility that billed | CMS POS code set | Itemized bill, EOB |

## Balance billing and payer coordination

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `surprise-balance-bill` | implemented | A line the No Surprises Act protects is billed as unprotected out-of-network care. An out-of-network emergency line, or an out-of-network clinician's line at an in-network facility, owes the difference as if unprotected; the line's figures in the answer key are as the plan applied them, and the error's entry gives what is right. | 45 CFR 149.110, 149.120, 149.410, 149.420, https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149 | Commercial EOB |
| `assignment-violation` | implemented | A participating provider bills more than the Medicare-approved cost sharing | 42 U.S.C. §1395u(b)(3)(B)(ii) | Itemized bill vs. MSN |
| `limiting-charge-violation` | planned | A non-participating provider exceeds 115% of the fee schedule | 42 U.S.C. §1395u(j), (b)(18); CMS MLN "Limiting charge" | Itemized bill vs. MSN |
| `ambulance-surprise-bill` | planned | Out-of-network ground ambulance balance bill | No Surprises Act gap for ground ambulance (Pub. L. 116-260 Div. BB); state balance-billing laws | Ambulance bill vs. EOB |
| `secondary-not-applied` | planned | Medigap/secondary did not process a Medicare crossover; patient billed the secondary's share | CMS crossover (COBA) process; Medigap EOC | Medigap EOB, itemized bill |
| `crossover-window-exceeded` | planned | Secondary EOB missing beyond the usual crossover window | CMS COBA timing | MSN + missing Medigap EOB |
| `msp-order-violation` | planned | Wrong primary payer under Medicare Secondary Payer rules | 42 U.S.C. §1395y(b); 42 CFR 411 | Commercial EOB vs. MSN |
| `cob-discrepancy` | planned | Commercial and Medicare statements disagree on primary amounts | 42 CFR 411; plan COB provisions | Commercial EOB vs. MSN |
| `dunning-on-paid-claim` | planned | Collections escalation on a claim the payer already paid | FDCPA 15 U.S.C. §1692e (false representation of debt); CFPB model validation notice | Collections letter vs. EOB |
| `missing-fdcpa-notice` | planned | Collections letter lacks the required validation information | 12 CFR 1006.34 | Collections letter |

## Notices and denials

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `emergency-authorization-denial` | implemented | Emergency care is denied for lack of prior authorization. An emergency line is denied for having no prior authorization, though a plan may not require it for emergency care; the line's figures in the answer key are as the plan applied them, and the error's entry gives what is right. | 45 CFR 149.110(b)(1), https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149/subpart-B/section-149.110 | Commercial EOB |
| `coverage-denial` | implemented | A line Medicare denied (not reasonable and necessary, not covered) with the patient liable because written notice was given. Not a billing error in itself; a reviewer should surface it as an appealable denial, so the default severity is `info`. On a Medicare Advantage EOB, the plan denies an in-network line and the member owes nothing for it; a denial note flags the line and the back page explains how to appeal. On the commercial EOB, a correct denial recorded at severity info: elective care denied because no prior authorization was obtained, or a line denied because the yearly visit limit was reached. The answer key records the line as the plan applied it, and the entry says why the denial is correct. The answer key lists it in `errors[]` at severity `info`; it counts in error recall, and `errors.excludingInfo` leaves it out. | SSA §1862(a)(1)(A); liability SSA §1879, 42 CFR 411.404; redetermination 42 CFR 405.942; MA: organization determination 42 CFR 422.566(b)(3); denial notice 42 CFR 422.568(d), (e); EOB denied-claim and appeal-rights notice 42 CFR 422.111(k)(3)(iii); reconsideration SSA §1852(g), 42 CFR 422.582; contracted providers may not bill members for the plan's obligation 42 CFR 422.504(g)(1)(i); plan terms, 45 CFR 147.126 (visit limits) for the commercial EOB | MSN, itemized bill, MA EOB, commercial EOB |
| `wrong-appeal-deadline` | planned | Notice states a shorter appeal window than the law allows | 42 CFR 422.582 (MA reconsideration, 65 days); 42 CFR 405.942 (redetermination, 120 days) | Denial notices, MSN |
| `missing-clinical-rationale` | planned | Denial lacks the specific clinical reason required | 42 CFR 422.568(e); CMS-4201-F | CMS-10003 denial notice |
| `wrong-denial-reason-code` | planned | CARC/RARC code contradicts the stated reason | X12 CARC/RARC code lists (public) | Denial notice, EOB |
| `missing-required-section` | implemented | A mandated section of a notice is absent. A denied line's note gives no plan section, or an EOB with a denied line prints no appeal rights section; the line's figures in the answer key are as the plan applied them, and the error's entry gives what is right. | CMS form instructions for the notice (ABN, MOON, NOMNC, CMS-10003); 29 CFR 2560.503-1(g)(1)(ii) and (iv) for the commercial EOB | ABN, MOON, NOMNC, commercial EOB |
| `moon-not-delivered` / `moon-late` | planned | Observation notice missing or delivered outside the 36-hour window | SSA §1866(a)(1)(Y); 42 CFR 489.20(y) | MOON, admission order |
| `nomnc-premature` | planned | Discharge notice delivered less than two days before services end | 42 CFR 405.1200 | NOMNC |
| `observation-vs-inpatient-miscoded` | planned | Stay billed as observation when an inpatient order existed (or vice versa) | Two-midnight rule, 42 CFR 412.3 | UB-04, admission order, MOON |
| `snf-three-day-rule` | planned | SNF claim denied or billed wrongly around the 3-day inpatient qualifying stay | 42 CFR 409.30 | SNF denial letter, UB-04 |
| `pa-expired-refill` | planned | Fill dispensed under an expired prior authorization | 42 CFR 423.578; plan formulary rules | Pharmacy receipt, Rx denial |
| `routine-abn-prohibited` | planned | ABN issued routinely without a specific reason for expected denial | Medicare Claims Processing Manual ch. 30 §40.2.2.C (routine notice prohibition), §50 (ABN) | ABN |

## Cross-document reconciliation (paired scenarios)

| kind | status | What is wrong | Rule / reference | Typical documents |
| --- | --- | --- | --- | --- |
| `bill-vs-eob-mismatch` | implemented | The provider's statement asks for more than the paired EOB says the member owes for that claim: the contractual adjustment is too small, or a line the plan denied is left in the balance instead of being taken off. | Medicare Advantage: [42 CFR 422.504(g)(1)(i)](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-422/subpart-K/section-422.504): an MA organization's contracts must bar its providers from holding an enrollee liable for fees that are the organization's legal obligation. [42 CFR 422.111(k)(1) and (k)(3)(iii)](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-422/subpart-C/section-422.111): the EOB states the enrollee's share of each claim and identifies denied claims. Commercial EOB: an in-network provider accepts the plan's allowed amount as payment in full ([Uniform Glossary of Coverage and Medical Terms](https://www.cms.gov/files/document/uniform-glossary-english-060723.pdf), allowed amount and balance billing); on a line the No Surprises Act protects, the provider may bill only the in-network cost sharing ([45 CFR 149.410, 149.420](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149)); a denial for no prior authorization falls on the in-network provider under the plan's network terms. | Provider statement vs. Medicare Advantage or commercial EOB |
| `bill-payment-mismatch` | implemented | The plan payment the provider's statement credits differs from the plan payment on the paired EOB for that claim. The balance due is still right. | [42 CFR 422.111(k)(1)](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-422/subpart-C/section-422.111): the EOB states, for each claim, the provider's billed amount, the total the plan approved, the plan's share and the enrollee's share. The commercial EOB prints the plan paid amount of each claim, and the statement must credit that amount exactly. | Provider statement vs. Medicare Advantage or commercial EOB |
| `phantom-charge-vs-record` | planned | Bill line with no corresponding entry in the clinical record | OIG typology | Itemized bill + lab report |
| `receipt-vs-eob-copay` | planned | Pharmacy receipt copay differs from the Part D EOB | Plan formulary tier; 42 CFR 423.104 | Pharmacy receipt + Part D EOB |
| `identity-conflict` | planned | Two documents in a bundle belong to different members | Internal consistency | Any pair |

## Decoys: correct lines that look like errors

A scenario may plant decoys beside its errors, or on a notice with none: lines that look wrong but follow the rules.
Each one is listed in the ground truth's `decoys[]` with its kind, its place on the page and the public rule that makes
it correct (the scenario must cite one); it is never in `errors[]`. A report that flags a decoy line, under any error
kind, counts as a false alarm in `verify_document` and `claimseed-core verify`, which also list its id under
`decoysFlagged`. A decoy that repeats a service on another date also names the line it repeats (`relatedLineRef` and
`relatedFieldRef`), and a flag on either line counts as flagging the decoy; two flags of the same kind on the two lines
count as one false alarm and a repeat, and a flag that matches a planted error by kind and line still finds that error
first.

| kind | status | What it looks like | Why it is correct | Rule / reference | Wrongly reported as |
| --- | --- | --- | --- | --- | --- |
| `repeat-service-different-date` | implemented | The same code and charge appear twice on one claim, on two dates in the period | Two services, each billed once: a duplicate repeats the same service on the same date. The repeat is adjudicated as its own service: coinsurance on its approved amount, and only what is left of the year's deductible. Preventive services, new-patient visits and tests with a frequency limit are never repeated, because a repeat of those in the period would be an error | Duplicate payments are those for the same beneficiary, code and service date by the same provider: CMS Recovery Audit topic 0091, https://www.cms.gov/research-statistics-data-and-systems/monitoring-programs/medicare-ffs-compliance-programs/recovery-audit-program/approved-rac-topics-items/0091-exact-duplicate-claims; MUEs count units for the same beneficiary on the same date of service, https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues | `duplicate-charge` |
| `charge-above-approved` | implemented | The amount the provider charged is several times the Medicare-approved amount | The charge is the provider's own price, not what Medicare pays. On an assigned claim the provider accepts the approved amount as payment in full and may collect only the deductible and coinsurance, so Medicare's payment and the patient's share are figured on the approved amount however high the charge | https://www.medicare.gov/basics/costs/medicare-costs/provider-accept-Medicare; SSA §1842(b)(3)(B)(ii), https://www.ssa.gov/OP_Home/ssact/title18/1842.htm | `fee-schedule-overcharge` (which is about the approved amount, not the charge) or `assignment-violation` (which needs the patient to be billed more than the approved share) |
| `approved-below-copay` | implemented | The member pays less than the category copay and the plan pays $0 for the line. | Under the plan's stated design (evidence of coverage), the copay never exceeds the plan-approved amount, so the member pays the approved amount and the plan pays nothing. | Plan's stated design (evidence of coverage): when the plan-approved amount is less than the copay, the member pays the approved amount and the plan pays $0 | cost-sharing-error (the member's share does not match the category copay, and the plan pays nothing) |
| `oop-cap-partial-share` | implemented | One line charges only part of its usual copay or coinsurance, and later lines charge the member nothing. | The member reached the in-network out-of-pocket maximum on that line (42 CFR 422.100(f)(4) and the plan's evidence of coverage), so the member pays only up to the maximum and the plan pays the rest. | In-network out-of-pocket limit, 42 CFR 422.100(f)(4), https://www.law.cornell.edu/cfr/text/42/422.100; plan's evidence of coverage: the member pays only up to the maximum, the plan pays the rest | cost-sharing-error (the line charges less than its usual copay or coinsurance, and later lines charge nothing) |
| `partial-deductible` | implemented | A PPO coinsurance line charges the member more than 20% of its plan-approved amount. | Under the plan's stated design (evidence of coverage, note C1), the line first takes the rest of the year's in-network deductible and then 20% of the remaining approved amount. | Plan's stated design (evidence of coverage, note C1): the rest of the year's in-network deductible is paid first, then 20% coinsurance on the remaining approved amount | deductible-misapplied (the share is above 20% of the approved amount, so the deductible looks charged again) |
| `paid-at-visit` | implemented | The provider's statement asks for less than the member share on the paired EOB, and it credits a payment the patient made at the visit, such as a copay. | A payment the patient made at the visit is credited against what the patient owes, so the balance due is the EOB's member share less that payment. | Internal consistency of the statement. | `bill-vs-eob-mismatch` |
| `out-of-network-balance` | implemented | An out-of-network provider's line asks the member to pay the difference between its charge and the plan's allowed amount, with remark OA. | This line is correct because an out-of-network provider outside the No Surprises Act's protections, for care that is not emergency care and not at an in-network facility, may bill the member the difference between its charge and the plan's allowance. | 45 CFR 149.110, 149.120 (the protections it falls outside); Uniform Glossary (balance billing) | `in-network-balance-bill`, `surprise-balance-bill` |
| `consented-balance` | implemented | An out-of-network surgeon at an in-network hospital or surgical center bills the member the difference, with a remark CN note that the patient signed consent. | This line is correct because an out-of-network surgeon at an in-network facility may bill the difference when the patient signed the notice and consent beforehand, since surgery is a specialty for which consent can waive the protection. | 45 CFR 149.420, https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149/subpart-E/section-149.420 | `surprise-balance-bill` |
| `ground-ambulance-balance` | implemented | An out-of-network ground ambulance on an emergency claim bills the member the difference (remark OA), while the EOB's notice says the law protects emergency care. | This line is correct because ground ambulance services are outside the No Surprises Act's balance-billing protections, so an out-of-network ground ambulance may bill the difference even for an emergency. | 45 CFR 149.130 (air ambulance only), https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-149/subpart-B/section-149.130 | `surprise-balance-bill` |
| `problem-visit-beside-listed` | implemented | An office visit line charges the member cost sharing on the same claim as a preventive screening that costs the member nothing. | This line is correct because an office visit billed with a problem visit code is not a preventive visit, so cost sharing applies to it even when a preventive service on the same claim costs the member nothing. | 45 CFR 147.130(a)(2), https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.130 | `preventive-cost-sharing` |
| `oop-excludes-non-covered` | implemented | The out-of-pocket total leaves out an amount the member owes on a line, such as a non-covered charge or a difference billed by an out-of-network provider. | This total is correct because amounts not covered and differences billed by out-of-network providers do not count toward the out-of-pocket maximum, so they are rightly left out of the out-of-pocket total. | Uniform Glossary (out-of-pocket limit), https://www.cms.gov/files/document/uniform-glossary-english-060723.pdf | `math-error`, `oop-max-exceeded` |
| `elective-authorization-denial` | implemented | A surgery line is denied with remark PI because no prior authorization was obtained. | This denial is correct because the plan may require prior authorization for elective, non-emergency surgery, and none was obtained. | 45 CFR 149.110(b)(1) (emergency care only); plan terms | `emergency-authorization-denial` |
| `appeal-rights-by-section` | implemented | A denied line's note gives no appeal rights of its own, only a pointer to the EOB's appeal rights section. | This is correct because the appeal rights may be printed once, in the section that the denied line's note points to. | 29 CFR 2560.503-1(g)(1)(iv), https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XXV/subchapter-G/part-2560/section-2560.503-1 | `missing-required-section` |

## Layout variants

The itemized bill and the two Medicare Advantage EOBs can be printed in layout variants, which change the column
order, the header wording, the style and the way a continued table is marked. Every error and decoy kind above is
recorded the same way on every variant: the variant changes where a value prints on the page, never the paths,
values, kinds or rules in the answer key. The Medicare Summary Notice has one national format and is not varied. The commercial EOB takes no variant either: its
two insurers print it in two layouts, and every error and decoy is recorded the same way under both.

## In the 835 remittance

When a Medicare Summary Notice or a Medicare Advantage or commercial EOB is written with its X12 835 (`--also 835`),
each planted error that the 835 carries names its place there in `x12Ref`. A wrong charged total is a `CLP03` that
differs from the service lines and fails the claim balance; a wrong paid total is a `CLP04` that fails it; a wrong
patient total is a `CLP05` that differs from the claim's patient-responsibility (PR) adjustments; a duplicate charge
is a repeated service line (`SVC`), which a payer handling it correctly would deny as OA-18. Other kinds keep the
printed values and point at their service line without a check of their own in the file. On the commercial EOB the
835's patient total is the claim's PR adjustments, so the 835 stays correct for `in-network-balance-bill` and
`missing-required-section`; these, and an accumulator row's `math-error` (no line), have `x12Ref` null.

## Not errors: specimen classes that test rejection

`out-of-scope-commercial`, `out-of-scope-dental`, `out-of-scope-workers-comp`, `out-of-scope-tricare-va`,
`unrecognized-document`, `adversarial-prompt-injection` — specimens that an extractor or bill-review tool built for
Medicare documents should decline or flag rather than analyze (planned; no scenario produces them yet). They carry
`errors: []` and a `documentGaps` entry naming the class.
