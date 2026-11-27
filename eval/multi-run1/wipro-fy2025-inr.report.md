# Claim check: Wipro's FY25: revenue flat, profit up sharply

> Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action.

**Company:** WIPRO LIMITED (WIT, CIK 0001123799) · **Article:** `data/articles/wipro-fy2025-inr.md`

**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched 2026-11-26T19:27:02.456Z (reporting currency INR). Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.

| Verdict | Claims |
|---|---|
| MATCH | 7 |
| MISMATCH | 1 |
| NOT COMPUTABLE | 0 |
| NOT VERIFIABLE | 0 |
| REFERENCE UNAVAILABLE (SEC data as of 2026-11-26) | 0 |

| Claim | Quote | Numerical result | Context warnings | Audit |
|---|---|---|---|---|
| c1 r1 | Wipro reported revenue of ₹89,088 crore for the financial year ended March 31, 2025 | MATCH (actual ₹89,088.4 crore, stated ₹89088 crore) | PERIOD_AMBIGUOUS | approved by auditor (LLM review) |
| c2 r1 | which slipped 0.75% from ₹89,760 crore in the previous year | MATCH (actual -0.75%, stated −0.75%) | – | approved by auditor (LLM review) |
| c3 r1 | from ₹89,760 crore in the previous year | MATCH (actual ₹89,760.3 crore, stated ₹89760 crore) | – | approved by auditor (LLM review) |
| c4 r1 | Net profit attributable to shareholders rose 18.9% | MATCH (actual +18.92%, stated +18.9%) | PERIOD_AMBIGUOUS, BASIS_UNSTATED | approved by auditor (LLM review) |
| c5 r1 | to ₹13,135 crore. | MATCH (actual ₹13,135.4 crore, stated ₹13135 crore) | – | approved by auditor (LLM review) |
| c6 r1 | Diluted earnings per share were ₹12.52. | MATCH (actual ₹12.52 per share, stated ₹12.52 per share) | – | approved by auditor (LLM review) |
| c7 r1 | Operating profit was ₹1,51,271 crore for the year. | MISMATCH (actual ₹15,127.1 crore, stated ₹151271 crore) | OTHER | approved by auditor (LLM review) |
| c8 r1 | In dollar terms, revenue was $10.4 billion. | MATCH (actual $10.428B, stated $10.4 billion) | MISLEADING_FRAMING, CONVENIENCE_TRANSLATION | approved by auditor (LLM review) |

## Receipts

### c1 — MATCH
> “Wipro reported revenue of ₹89,088 crore for the financial year ended March 31, 2025”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2025 (gaap); stated **₹89088 crore** |
| From the filings | **₹89,088.4 crore** |
| Tolerance | rounding of stated digits: ±₹50 lakh |
| Formula | `actual = Revenue/FY-FY2025/25-076303` |
| Computed | `actual = 890,884,000,000 INR` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenue/FY-FY2025/25-076303` | ifrs-full:Revenue | FY-FY2025 | 2024-04-01 → 2025-03-31 | 890,884,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- `PERIOD_AMBIGUOUS` (context-agent, r1): The financial year ended March 31, 2025, has not yet concluded, making the report of full-year results for this period premature.

<details><summary>History (5 events)</summary>

- 1.59s `claim.extracted` r1 Wipro reported revenue of ₹89,088 crore for the financial year ended March 31, 2025
- 6.33s `context.warning` r1 [PERIOD_AMBIGUOUS] The financial year ended March 31, 2025, has not yet concluded, making the report of full-year results for this period premature.
- 172.34s `evidence.bound` r1.e1 Revenue/FY-FY2025/25-076303
- 172.34s `calculation` r1.e1 MATCH (actual ₹89,088.4 crore vs stated ₹89088 crore)
- 350.49s `audit.approved` r1.e1 The claim interpretation correctly reflects the provided quote and the fiscal period data.

</details>

### c2 — MATCH
> “which slipped 0.75% from ₹89,760 crore in the previous year”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy FY-FY2025 (gaap); stated **−0.75%** |
| From the filings | **-0.75%** |
| Tolerance | rounding of stated digits: ±0.005 pp |
| Formula | `change% = (Revenue/FY-FY2025/25-076303 − Revenue/FY-FY2024/25-076303) / abs(Revenue/FY-FY2024/25-076303) × 100` |
| Computed | `(890,884,000,000 − 897,603,000,000) / 897,603,000,000 × 100 = -0.75%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenue/FY-FY2025/25-076303` | ifrs-full:Revenue | FY-FY2025 | 2024-04-01 → 2025-03-31 | 890,884,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |
| base | `Revenue/FY-FY2024/25-076303` | ifrs-full:Revenue | FY-FY2024 | 2023-04-01 → 2024-03-31 | 897,603,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 11.20s `claim.extracted` r1 which slipped 0.75% from ₹89,760 crore in the previous year
- 106.86s `evidence.bound` r1.e1 Revenue/FY-FY2025/25-076303 vs Revenue/FY-FY2024/25-076303
- 106.86s `calculation` r1.e1 MATCH (actual -0.75% vs stated −0.75%)
- 180.97s `audit.approved` r1.e1 The interpretation faithfully captures the revenue change percentage and basis as stated in the text, and the calculation aligns with the reported financial figures.

</details>

### c3 — MATCH
> “from ₹89,760 crore in the previous year”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2024 (gaap); stated **₹89760 crore** |
| From the filings | **₹89,760.3 crore** |
| Tolerance | rounding of stated digits: ±₹50 lakh |
| Formula | `actual = Revenue/FY-FY2024/24-063468` |
| Computed | `actual = 897,603,000,000 INR` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenue/FY-FY2024/24-063468` | ifrs-full:Revenue | FY-FY2024 | 2023-04-01 → 2024-03-31 | 897,603,000,000 | INR | [20-F 0000950170-24-063468, filed 2024-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017024063468/wit-20240331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 33.36s `claim.extracted` r1 from ₹89,760 crore in the previous year
- 72.95s `evidence.bound` r1.e1 Revenue/FY-FY2024/24-063468
- 72.97s `calculation` r1.e1 MATCH (actual ₹89,760.3 crore vs stated ₹89760 crore)
- 101.08s `audit.approved` r1.e1 The interpretation faithfully captures the revenue figure for the previous fiscal year as mentioned in the text.

</details>

### c4 — MATCH
> “Net profit attributable to shareholders rose 18.9%”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income change unspecified FY-FY2025 (gaap); stated **+18.9%** |
| From the filings | **+18.92%** |
| Tolerance | rounding of stated digits: ±0.05 pp |
| Formula | `change% = (ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303 − ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303) / abs(ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303) × 100` |
| Computed | `(131,354,000,000 − 110,452,000,000) / 110,452,000,000 × 100 = 18.92%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303` | ifrs-full:ProfitLossAttributableToOwnersOfParent | FY-FY2025 | 2024-04-01 → 2025-03-31 | 131,354,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |
| base | `ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303` | ifrs-full:ProfitLossAttributableToOwnersOfParent | FY-FY2024 | 2023-04-01 → 2024-03-31 | 110,452,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- `PERIOD_AMBIGUOUS` (context-agent, r1): The paragraph does not specify the period over which the profit increase occurred.
- `BASIS_UNSTATED` (rule): Article does not say what the change is measured against; year-over-year was assumed.

<details><summary>History (5 events)</summary>

- 70.05s `claim.extracted` r1 Net profit attributable to shareholders rose 18.9%
- 80.97s `context.warning` r1 [PERIOD_AMBIGUOUS] The paragraph does not specify the period over which the profit increase occurred.
- 217.98s `evidence.bound` r1.e1 ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303 vs ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303
- 217.99s `calculation` r1.e1 MATCH (actual +18.92% vs stated +18.9%)
- 267.23s `audit.approved` r1.e1 The interpretation faithfully represents the claim, and the calculated change confirms the accuracy of the percentage growth.

</details>

### c5 — MATCH
> “to ₹13,135 crore.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income level FY-FY2025 (gaap); stated **₹13135 crore** |
| From the filings | **₹13,135.4 crore** |
| Tolerance | rounding of stated digits: ±₹50 lakh |
| Formula | `actual = ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303` |
| Computed | `actual = 131,354,000,000 INR` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303` | ifrs-full:ProfitLossAttributableToOwnersOfParent | FY-FY2025 | 2024-04-01 → 2025-03-31 | 131,354,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 93.84s `claim.extracted` r1 to ₹13,135 crore.
- 177.05s `evidence.bound` r1.e1 ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303
- 177.05s `calculation` r1.e1 MATCH (actual ₹13,135.4 crore vs stated ₹13135 crore)
- 226.34s `audit.approved` r1.e1 The claim interpretation faithfully represents the provided text, and the minor discrepancy in the reported number is due to rounding, which is acceptable under the audit rules.

</details>

### c6 — MATCH
> “Diluted earnings per share were ₹12.52.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level FY-FY2025 (gaap); stated **₹12.52 per share** |
| From the filings | **₹12.52 per share** |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = DilutedEarningsLossPerShare/FY-FY2025/25-076303` |
| Computed | `actual = 12.52 INR/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `DilutedEarningsLossPerShare/FY-FY2025/25-076303` | ifrs-full:DilutedEarningsLossPerShare | FY-FY2025 | 2024-04-01 → 2025-03-31 | 12.52 | INR/shares | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 121.46s `claim.extracted` r1 Diluted earnings per share were ₹12.52.
- 203.23s `evidence.bound` r1.e1 DilutedEarningsLossPerShare/FY-FY2025/25-076303
- 203.23s `calculation` r1.e1 MATCH (actual ₹12.52 per share vs stated ₹12.52 per share)
- 241.34s `audit.approved` r1.e1 The claim accurately interprets the quoted sentence regarding diluted earnings per share.

</details>

### c7 — MISMATCH
> “Operating profit was ₹1,51,271 crore for the year.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | operating_income level FY-FY2025 (gaap); stated **₹151271 crore** |
| From the filings | **₹15,127.1 crore** |
| Difference | actual − stated = −₹1,36,143.9 crore |
| Tolerance | rounding of stated digits: ±₹50 lakh |
| Formula | `actual = ProfitLossFromOperatingActivities/FY-FY2025/25-076303` |
| Computed | `actual = 151,271,000,000 INR` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `ProfitLossFromOperatingActivities/FY-FY2025/25-076303` | ifrs-full:ProfitLossFromOperatingActivities | FY-FY2025 | 2024-04-01 → 2025-03-31 | 151,271,000,000 | INR | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

- Note: Value matches if the scale were "million" instead of "crore" — likely a units error.

**Context warnings** (separate from the numerical result)

- `OTHER` (context-agent, r1): The paragraph compares an operating profit figure in rupees with a revenue figure in dollars without providing a consistent currency basis for the comparison.

<details><summary>History (5 events)</summary>

- 162.09s `claim.extracted` r1 Operating profit was ₹1,51,271 crore for the year.
- 256.07s `context.warning` r1 [OTHER] The paragraph compares an operating profit figure in rupees with a revenue figure in dollars without providing a consistent currency basis for the comparison.
- 286.02s `evidence.bound` r1.e1 ProfitLossFromOperatingActivities/FY-FY2025/25-076303
- 286.02s `calculation` r1.e1 MISMATCH (actual ₹15,127.1 crore vs stated ₹151271 crore)
- 369.90s `audit.approved` r1.e1 The interpretation accurately reflects the text, and the MISMATCH verdict correctly identifies the unit discrepancy between the reported value and the filing.

</details>

### c8 — MATCH
> “In dollar terms, revenue was $10.4 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2025 (gaap); stated **$10.4 billion** |
| From the filings | **$10.428B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = Revenue.USD/FY-FY2025/25-076303` |
| Computed | `actual = 10,428,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenue.USD/FY-FY2025/25-076303` | ifrs-full:Revenue | FY-FY2025 | 2024-04-01 → 2025-03-31 | 10,428,000,000 | USD | [20-F 0000950170-25-076303, filed 2025-05-22](https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm) |

**Context warnings** (separate from the numerical result)

- `MISLEADING_FRAMING` (context-agent, r1): The statement presents revenue in USD without mentioning that the primary operating figure is in INR, which creates a misleading impression of the company's financial reporting currency.
- `CONVENIENCE_TRANSLATION` (rule): Revenue.USD/FY-FY2025/25-076303 is a convenience translation into USD, not the filing's reporting currency (INR).

<details><summary>History (5 events)</summary>

- 251.40s `claim.extracted` r1 In dollar terms, revenue was $10.4 billion.
- 286.74s `context.warning` r1 [MISLEADING_FRAMING] The statement presents revenue in USD without mentioning that the primary operating figure is in INR, which creates a misleading impression of the company's financial reporting currency.
- 345.09s `evidence.bound` r1.e1 Revenue.USD/FY-FY2025/25-076303
- 345.10s `calculation` r1.e1 MATCH (actual $10.428B vs stated $10.4 billion)
- 359.75s `audit.approved` r1.e1 The interpretation faithfully represents the quote, and the mismatch between the stated $10.4 billion and the calculated $10.428 billion is a valid rounding difference.

</details>

## Run provenance

- Mode: `record`; model setting: `gemini-3.1-flash-lite`; Mozaik `@mozaik-ai/core@6.0.0`
- Model calls by source: live: 64
- Measured usage (gemini-3.1-flash-lite): 77 requests, 90273 input + 2446 output tokens, cost not computed (no price for this model)
- Concurrency (measured from Mozaik loop start/end events): peak 12 agent loops active at once across 25 loops. Measured wall-clock times of live provider calls (including pacing and retries).
- Reference: [SEC company facts (XBRL)](https://data.sec.gov/api/xbrl/companyfacts/CIK0001123799.json), [SEC filing index](https://data.sec.gov/submissions/CIK0001123799.json), fetched 2026-11-26T19:27:02.456Z.
- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is `replay`.
- Stale results rejected: 0
- Elapsed: 400.15s
