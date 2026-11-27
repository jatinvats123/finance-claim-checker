# Claim check: Nvidia's second quarter: revenue soars as AI spending surges

> Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action.

**Company:** NVIDIA CORP (NVDA, CIK 0001045810) · **Article:** `data/articles/nvda-q2-fy2027.md`

**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched 2026-11-26T09:13:45.512Z (reporting currency USD). Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.

| Verdict | Claims |
|---|---|
| MATCH | 4 |
| MISMATCH | 4 |
| NOT COMPUTABLE | 0 |
| NOT VERIFIABLE | 1 |
| REFERENCE UNAVAILABLE (SEC data as of 2026-11-26) | 1 |

| Claim | Quote | Numerical result | Context warnings | Audit |
|---|---|---|---|---|
| c1 r1 | Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027 | MATCH (actual $96.221B, stated $96.2 billion) | FORWARD_LOOKING | approved by auditor (LLM review) |
| c2 r1 | Revenue more than doubled from a year earlier | MATCH (actual 2.059×, stated more than 2× (increase)) | OTHER | approved by auditor (LLM review) |
| c3 r1 | rising 126% | MISMATCH (actual +105.85%, stated +126%) | RECORD_OR_SUPERLATIVE | approved by auditor (LLM review) |
| c4 r1 | Net income climbed 18% | MISMATCH (actual +125.90%, stated +18%) | PERIOD_AMBIGUOUS, BASIS_UNSTATED | approved by auditor (LLM review) |
| c5 r1 | Net income climbed 18% to $59.7 billion | MATCH (actual $59.688B, stated $59.7 billion) | – | approved by auditor (LLM review) |
| c6 r1 | diluted earnings per share came in at $2.46 | MATCH (actual $2.46 per share, stated $2.46 per share) | – | approved by auditor (LLM review) |
| c7 r1 | adjusted net income was $54.0 billion | NOT_VERIFIABLE | NON_GAAP | approved by auditor (rule) |
| c8 r1 | For the first half of fiscal 2027, revenue totaled $177.8 million | MISMATCH (actual $177.837B, stated $177.8 million) | CHERRY_PICKED | approved by auditor (LLM review) |
| c9 r1 | revenue of $57.0 billion for all of fiscal 2026 | MISMATCH (actual $215.938B, stated $57.0 billion) | CHERRY_PICKED, VALUE_MATCHES_OTHER_PERIOD | approved by auditor (LLM review) |
| c10 r1 | third-quarter revenue reached $115.8 billion | REFERENCE_NOT_YET_FILED | MISLEADING_FRAMING, EARNINGS_RELEASE_ONLY | approved by auditor (rule) |

## Receipts

### c1 — MATCH
> “Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level Q2-FY2027 (gaap); stated **$96.2 billion** |
| From the filings | **$96.221B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = Revenues/Q2-FY2027/26-000075` |
| Computed | `actual = 96,221,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/Q2-FY2027/26-000075` | us-gaap:Revenues | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 96,221,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- `FORWARD_LOOKING` (context-agent, r1): The fiscal year 2027 period is a future date relative to the current calendar date.

<details><summary>History (5 events)</summary>

- 1.41s `claim.extracted` r1 Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027
- 6.04s `context.warning` r1 [FORWARD_LOOKING] The fiscal year 2027 period is a future date relative to the current calendar date.
- 30.93s `evidence.bound` r1.e1 Revenues/Q2-FY2027/26-000075
- 30.94s `calculation` r1.e1 MATCH (actual $96.221B vs stated $96.2 billion)
- 59.93s `audit.approved` r1.e1 The interpretation faithfully represents the quote, and the reported number is within the acceptable rounding threshold compared to the official filing.

</details>

### c2 — MATCH
> “Revenue more than doubled from a year earlier”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy Q2-FY2027 (gaap); stated **more than 2× (increase)** |
| From the filings | **2.059×** |
| Tolerance | qualifier "more than" |
| Formula | `ratio = Revenues/Q2-FY2027/26-000075 / Revenues/Q2-FY2026/26-000075` |
| Computed | `96,221,000,000 / 46,743,000,000 = 2.059×` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/Q2-FY2027/26-000075` | us-gaap:Revenues | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 96,221,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |
| base | `Revenues/Q2-FY2026/26-000075` | us-gaap:Revenues | Q2-FY2026 | 2025-04-28 → 2025-07-27 | 46,743,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- `OTHER` (context-agent, r1): The statement describes a change as "more than doubled" while providing the precise percentage increase, which could be considered redundant.

<details><summary>History (5 events)</summary>

- 25.86s `claim.extracted` r1 Revenue more than doubled from a year earlier
- 36.47s `context.warning` r1 [OTHER] The statement describes a change as "more than doubled" while providing the precise percentage increase, which could be considered redundant.
- 132.60s `evidence.bound` r1.e1 Revenues/Q2-FY2027/26-000075 vs Revenues/Q2-FY2026/26-000075
- 132.60s `calculation` r1.e1 MATCH (actual 2.059× vs stated more than 2× (increase))
- 138.75s `audit.approved` r1.e1 The claim accurately interprets the statement that revenue more than doubled (2x) by correctly identifying it as a year-over-year increase in revenue.

</details>

### c3 — MISMATCH
> “rising 126%”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy Q2-FY2027 (gaap); stated **+126%** |
| From the filings | **+105.85%** |
| Difference | actual − stated = -20.15 pp |
| Tolerance | rounding of stated digits: ±0.5 pp |
| Formula | `change% = (Revenues/Q2-FY2027/26-000075 − Revenues/Q2-FY2026/26-000075) / abs(Revenues/Q2-FY2026/26-000075) × 100` |
| Computed | `(96,221,000,000 − 46,743,000,000) / 46,743,000,000 × 100 = 105.85%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/Q2-FY2027/26-000075` | us-gaap:Revenues | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 96,221,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |
| base | `Revenues/Q2-FY2026/26-000075` | us-gaap:Revenues | Q2-FY2026 | 2025-04-28 → 2025-07-27 | 46,743,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r1): The phrase "soars" in the title and the claim of revenue more than doubling emphasize a superlative growth trend.

<details><summary>History (5 events)</summary>

- 41.50s `claim.extracted` r1 rising 126%
- 66.39s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The phrase "soars" in the title and the claim of revenue more than doubling emphasize a superlative growth trend.
- 108.37s `evidence.bound` r1.e1 Revenues/Q2-FY2027/26-000075 vs Revenues/Q2-FY2026/26-000075
- 108.37s `calculation` r1.e1 MISMATCH (actual +105.85% vs stated +126%)
- 126.17s `audit.approved` r1.e1 The interpretation is a faithful representation of the claim's text, which contains a mismatch with the computed financial data.

</details>

### c4 — MISMATCH
> “Net income climbed 18%”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income change unspecified Q2-FY2027 (gaap); stated **+18%** |
| From the filings | **+125.90%** |
| Difference | actual − stated = 107.90 pp |
| Tolerance | rounding of stated digits: ±0.5 pp |
| Formula | `change% = (NetIncomeLoss/Q2-FY2027/26-000075 − NetIncomeLoss/Q2-FY2026/26-000075) / abs(NetIncomeLoss/Q2-FY2026/26-000075) × 100` |
| Computed | `(59,688,000,000 − 26,422,000,000) / 26,422,000,000 × 100 = 125.90%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `NetIncomeLoss/Q2-FY2027/26-000075` | us-gaap:NetIncomeLoss | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 59,688,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |
| base | `NetIncomeLoss/Q2-FY2026/26-000075` | us-gaap:NetIncomeLoss | Q2-FY2026 | 2025-04-28 → 2025-07-27 | 26,422,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- `PERIOD_AMBIGUOUS` (context-agent, r1): The claim states net income climbed 18% without specifying the period being compared.
- `BASIS_UNSTATED` (rule): Article does not say what the change is measured against; year-over-year was assumed. Quarter-over-quarter it would be +2.34% (NetIncomeLoss/Q1-FY2027/26-000052).

<details><summary>History (5 events)</summary>

- 244.39s `claim.extracted` r1 Net income climbed 18%
- 250.63s `context.warning` r1 [PERIOD_AMBIGUOUS] The claim states net income climbed 18% without specifying the period being compared.
- 382.70s `evidence.bound` r1.e1 NetIncomeLoss/Q2-FY2027/26-000075 vs NetIncomeLoss/Q2-FY2026/26-000075
- 382.70s `calculation` r1.e1 MISMATCH (actual +125.90% vs stated +18%)
- 392.96s `audit.approved` r1.e1 The interpretation faithfully represents the text as written, and the mismatch is correctly identified by the formula analysis.

</details>

### c5 — MATCH
> “Net income climbed 18% to $59.7 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income level Q2-FY2027 (gaap); stated **$59.7 billion** |
| From the filings | **$59.688B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = NetIncomeLoss/Q2-FY2027/26-000075` |
| Computed | `actual = 59,688,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `NetIncomeLoss/Q2-FY2027/26-000075` | us-gaap:NetIncomeLoss | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 59,688,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 256.13s `claim.extracted` r1 Net income climbed 18% to $59.7 billion
- 343.74s `evidence.bound` r1.e1 NetIncomeLoss/Q2-FY2027/26-000075 vs NetIncomeLoss/Q2-FY2026/26-000075
- 343.74s `calculation` r1.e1 MATCH (actual $59.688B vs stated $59.7 billion)
- 361.94s `audit.approved` r1.e1 The interpretation faithfully represents the quote and the stated number is consistent with the financial statement value.

</details>

### c6 — MATCH
> “diluted earnings per share came in at $2.46”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level Q2-FY2027 (gaap); stated **$2.46 per share** |
| From the filings | **$2.46 per share** |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = EarningsPerShareDiluted/Q2-FY2027/26-000075` |
| Computed | `actual = 2.46 USD/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `EarningsPerShareDiluted/Q2-FY2027/26-000075` | us-gaap:EarningsPerShareDiluted | Q2-FY2027 | 2026-04-27 → 2026-07-26 | 2.46 | USD/shares | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 272.71s `claim.extracted` r1 diluted earnings per share came in at $2.46
- 308.89s `evidence.bound` r1.e1 EarningsPerShareDiluted/Q2-FY2027/26-000075
- 308.90s `calculation` r1.e1 MATCH (actual $2.46 per share vs stated $2.46 per share)
- 318.11s `audit.approved` r1.e1 The interpretation faithfully represents the quote and matches the financial data.

</details>

### c7 — NOT VERIFIABLE
> “adjusted net income was $54.0 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (rule))

| | |
|---|---|
| Claim read as | net_income level Q2-FY2027 (non_gaap); stated **$54.0 billion** |

**Reference:** Adjusted (non-GAAP) figure: not a line item of the financial statements.

**Context warnings** (separate from the numerical result)

- `NON_GAAP` (rule): Article cites an adjusted (non-GAAP) figure. Companies define these themselves; they are not line items in the financial statements.

<details><summary>History (4 events)</summary>

- 412.41s `claim.extracted` r1 adjusted net income was $54.0 billion
- 412.41s `evidence.bound` r1.e1 NOT_IN_STATEMENTS
- 412.41s `calculation` r1.e1 NOT_VERIFIABLE
- 412.41s `audit.approved` r1.e1 rule gate passed; nothing in the financial statements to compute against

</details>

### c8 — MISMATCH
> “For the first half of fiscal 2027, revenue totaled $177.8 million”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level H1-FY2027 (gaap); stated **$177.8 million** |
| From the filings | **$177.837B** |
| Difference | actual − stated = $177.659B |
| Tolerance | rounding of stated digits: ±$50,000 |
| Formula | `actual = Revenues/H1-FY2027/26-000075` |
| Computed | `actual = 177,837,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/H1-FY2027/26-000075` | us-gaap:Revenues | H1-FY2027 | 2026-01-26 → 2026-07-26 | 177,837,000,000 | USD | [10-Q 0001045810-26-000075, filed 2026-08-26](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) |

- Note: Value matches if the scale were "billion" instead of "million" — likely a units error.

**Context warnings** (separate from the numerical result)

- `CHERRY_PICKED` (context-agent, r1): Comparing a six-month period to a full fiscal year provides a misleading scale for performance.

<details><summary>History (5 events)</summary>

- 419.86s `claim.extracted` r1 For the first half of fiscal 2027, revenue totaled $177.8 million
- 426.33s `context.warning` r1 [CHERRY_PICKED] Comparing a six-month period to a full fiscal year provides a misleading scale for performance.
- 459.22s `evidence.bound` r1.e1 Revenues/H1-FY2027/26-000075 vs Revenues/H1-FY2027/26-000075
- 459.22s `calculation` r1.e1 MISMATCH (actual $177.837B vs stated $177.8 million)
- 493.60s `audit.approved` r1.e1 The interpretation correctly reflects the text provided in the article, which contains a unit mismatch compared to the official financial report.

</details>

### c9 — MISMATCH
> “revenue of $57.0 billion for all of fiscal 2026”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2026 (gaap); stated **$57.0 billion** |
| From the filings | **$215.938B** |
| Difference | actual − stated = $158.938B |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = Revenues/FY-FY2026/26-000021` |
| Computed | `actual = 215,938,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/FY-FY2026/26-000021` | us-gaap:Revenues | FY-FY2026 | 2025-01-27 → 2026-01-25 | 215,938,000,000 | USD | [10-K 0001045810-26-000021, filed 2026-02-25](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm) |

**Context warnings** (separate from the numerical result)

- `CHERRY_PICKED` (context-agent, r1): The paragraph compares a half-year result to a full-year result to create a misleading impression of performance.
- `VALUE_MATCHES_OTHER_PERIOD` (rule): The stated figure matches Q3-FY2026 (quarter, $57.006B, Revenues/Q3-FY2026/25-000230) — possibly the wrong period (e.g. quarter vs. full year).

<details><summary>History (5 events)</summary>

- 431.06s `claim.extracted` r1 revenue of $57.0 billion for all of fiscal 2026
- 448.06s `context.warning` r1 [CHERRY_PICKED] The paragraph compares a half-year result to a full-year result to create a misleading impression of performance.
- 483.64s `evidence.bound` r1.e1 Revenues/FY-FY2026/26-000021
- 483.64s `calculation` r1.e1 MISMATCH (actual $215.938B vs stated $57.0 billion)
- 519.02s `audit.approved` r1.e1 The claim correctly interprets the text provided, which references $57.0 billion for fiscal 2026, even though the company's actual full-year revenue was $215.938 billion.

</details>

### c10 — REFERENCE NOT YET FILED
> “third-quarter revenue reached $115.8 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (rule))

| | |
|---|---|
| Claim read as | revenue level Q3-FY2027 (gaap); stated **$115.8 billion** |

**Reference:** No 10-Q/10-K/20-F covers Q3-FY2027 as of the SEC data fetched 2026-11-26. Latest statements: Q2-FY2027 (10-Q filed 2026-08-26).
- Not used (would be circular): earnings release [8-K accn 0001045810-26-000088, filed 2026-11-17](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000088/nvda-20261117.htm)

**Context warnings** (separate from the numerical result)

- `MISLEADING_FRAMING` (context-agent, r1): The paragraph states that the third-quarter report is still to come, contradicting the framing that the revenue has already been reached.
- `EARNINGS_RELEASE_ONLY` (rule): In the SEC data fetched 2026-11-26, only the company's earnings release covers this period (8-K filed 2026-11-17, accn 0001045810-26-000088). Checking a release against itself would be circular; a 10-Q/10-K may have been filed after 2026-11-26.

<details><summary>History (5 events)</summary>

- 451.12s `claim.extracted` r1 third-quarter revenue reached $115.8 billion
- 469.07s `context.warning` r1 [MISLEADING_FRAMING] The paragraph states that the third-quarter report is still to come, contradicting the framing that the revenue has already been reached.
- 503.79s `evidence.bound` r1.e1 REFERENCE_NOT_YET_FILED
- 503.79s `calculation` r1.e1 REFERENCE_NOT_YET_FILED
- 503.79s `audit.approved` r1.e1 rule gate passed; nothing in the financial statements to compute against

</details>

## Run provenance

- Mode: `record`; model setting: `gemini-3.1-flash-lite`; Mozaik `@mozaik-ai/core@6.0.0`
- Model calls by source: live: 78
- Measured usage (gemini-3.1-flash-lite): 84 requests, 102147 input + 3156 output tokens, cost not computed (no price for this model)
- Concurrency (measured from Mozaik loop start/end events): peak 7 agent loops active at once across 28 loops. Measured wall-clock times of live provider calls (including pacing and retries).
- Reference: [SEC company facts (XBRL)](https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json), [SEC filing index](https://data.sec.gov/submissions/CIK0001045810.json), fetched 2026-11-26T09:13:45.512Z.
- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is `replay`.
- Stale results rejected: 0
- Elapsed: 635.92s
