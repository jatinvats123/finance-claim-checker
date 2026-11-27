# Claim check: Apple closes fiscal 2026 with record sales as iPhone demand holds up

> Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action.

**Company:** Apple Inc. (AAPL, CIK 0000320193) · **Article:** `data/articles/apple-fy2026.md`

**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched 2026-11-26T19:27:01.034Z (reporting currency USD). Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.

| Verdict | Claims |
|---|---|
| MATCH | 5 |
| MISMATCH | 2 |
| NOT COMPUTABLE | 0 |
| NOT VERIFIABLE | 0 |
| REFERENCE UNAVAILABLE (SEC data as of 2026-11-26) | 0 |

| Claim | Quote | Numerical result | Context warnings | Audit |
|---|---|---|---|---|
| c1 r1 | Apple reported revenue of $478.8 billion for fiscal 2026 | MATCH (actual $478.834B, stated $478.8 billion) | RECORD_OR_SUPERLATIVE | approved by auditor (LLM review) |
| c2 r1 | up 15% from $416.2 billion a year earlier | MATCH (actual +15.06%, stated +15%) | RECORD_OR_SUPERLATIVE | approved by auditor (LLM review) |
| c3 r2 | up 15% from $416.2 billion a year earlier | MATCH (actual $416.161B, stated $416.2 billion) | RECORD_OR_SUPERLATIVE | approved by auditor (LLM review) |
| c4 r1 | Net income rose to $132.2 billion for the year | MATCH (actual $132.175B, stated $132.2 billion) | RECORD_OR_SUPERLATIVE | approved by auditor (LLM review) |
| c5 r1 | diluted earnings per share came in at $8.89 | MISMATCH (actual $8.98 per share, stated $8.89 per share) | – | approved by auditor (LLM review) |
| c6 r1 | For the fourth quarter alone, revenue was $114.5 billion. | MATCH (actual $114.477B, stated $114.5 billion) | RECORD_OR_SUPERLATIVE, DERIVED_Q4 | approved by auditor (LLM review) |
| c7 r1 | Gross profit for the full year was $223.6 billion | MISMATCH (actual $233.602B, stated $223.6 billion) | MISLEADING_FRAMING | approved by auditor (LLM review) |

## Receipts

### c1 — MATCH
> “Apple reported revenue of $478.8 billion for fiscal 2026”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2026 (gaap); stated **$478.8 billion** |
| From the filings | **$478.834B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026` |
| Computed | `actual = 478,834,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026` | us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax | FY-FY2026 | 2025-09-28 → 2026-09-26 | 478,834,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r1): The claim does not substantiate the superlative claim of record sales made in the title.

<details><summary>History (5 events)</summary>

- 1.75s `claim.extracted` r1 Apple reported revenue of $478.8 billion for fiscal 2026
- 6.26s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The claim does not substantiate the superlative claim of record sales made in the title.
- 41.04s `evidence.bound` r1.e1 RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026
- 41.04s `calculation` r1.e1 MATCH (actual $478.834B vs stated $478.8 billion)
- 76.01s `audit.approved` r1.e1 The interpretation accurately reflects the stated revenue and fiscal period mentioned in the text.

</details>

### c2 — MATCH
> “up 15% from $416.2 billion a year earlier”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy FY-FY2026 (gaap); stated **+15%** |
| From the filings | **+15.06%** |
| Tolerance | rounding of stated digits: ±0.5 pp |
| Formula | `change% = (RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 − RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026) / abs(RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026) × 100` |
| Computed | `(478,834,000,000 − 416,161,000,000) / 416,161,000,000 × 100 = 15.06%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026` | us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax | FY-FY2026 | 2025-09-28 → 2026-09-26 | 478,834,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |
| base | `RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026` | us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax | FY-FY2025 | 2024-09-29 → 2025-09-27 | 416,161,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r1): The paragraph frames the 15% increase as part of a record-setting performance, but the superlative claim in the title is not explicitly supported by the revenue figures provided in the text.

<details><summary>History (5 events)</summary>

- 11.27s `claim.extracted` r1 up 15% from $416.2 billion a year earlier
- 26.05s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The paragraph frames the 15% increase as part of a record-setting performance, but the superlative claim in the title is not explicitly supported by the revenue figures provided in the text.
- 106.37s `evidence.bound` r1.e1 RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 vs RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026
- 106.37s `calculation` r1.e1 MATCH (actual +15.06% vs stated +15%)
- 155.31s `audit.approved` r1.e1 The interpretation accurately reflects the text and the calculated change of ~15.06% supports the stated 15%.

</details>

### c3 — MATCH
> “up 15% from $416.2 billion a year earlier”

**Numerical result** (revision r2.e3; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2025 (gaap); stated **$416.2 billion** |
| From the filings | **$416.161B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/25-000079` |
| Computed | `actual = 416,161,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/25-000079` | us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax | FY-FY2025 | 2024-09-29 → 2025-09-27 | 416,161,000,000 | USD | [10-K 0000320193-25-000079, filed 2025-10-31](https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r2): The article title characterizes the revenue as a record, but the paragraph itself does not substantiate this claim with historical context.

<details><summary>History (14 events)</summary>

- 31.28s `claim.extracted` r1 up 15% from $416.2 billion a year earlier
- 102.45s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The claim is framed within the context of 'record sales', which is not explicitly supported by the provided text or the claim data.
- 249.47s `evidence.bound` r1.e1 RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 vs RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026
- 249.48s `calculation` r1.e1 MISMATCH (actual $478.834B vs stated $416.2 billion)
- 249.48s `audit.investigating` r1.e1 claim: The quote attaches 416.2 to a year earlier, and it matches FY-FY2025 (RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/25-000079) exactly; the claim is labelled FY-FY2026. Set fiscalYear to 2025 if the sentence means the year-earlier figure.
- 271.48s `claim.revised` r1 → r2: auditor correction: The year-earlier figure corresponds to fiscal year 2025. (evidence, calculation, audit and context for r1 invalidated)
- 271.63s `stale:failure` failure for c3@r1 rejected: claim is now at r2
- 286.04s `context.warning` r2 [RECORD_OR_SUPERLATIVE] The article title characterizes the revenue as a record, but the paragraph itself does not substantiate this claim with historical context.
- 311.44s `evidence.bound` r2.e2 RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 vs RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/26-000026
- 311.44s `calculation` r2.e2 MISMATCH (actual $478.834B vs stated $416.2 billion)
- 311.44s `audit.investigating` r2.e2 evidence: RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 covers FY-FY2026, but the claim is about FY-FY2025
- 350.97s `evidence.bound` r2.e3 RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2025/25-000079 vs RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2024/25-000079 (replaces e2)
- 350.97s `calculation` r2.e3 MATCH (actual $416.161B vs stated $416.2 billion)
- 368.83s `audit.approved` r2.e3 The interpretation faithfully represents the quote and fiscal period, and the rounding is within acceptable limits.

</details>

### c4 — MATCH
> “Net income rose to $132.2 billion for the year”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income level FY-FY2026 (gaap); stated **$132.2 billion** |
| From the filings | **$132.175B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = NetIncomeLoss/FY-FY2026/26-000026` |
| Computed | `actual = 132,175,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `NetIncomeLoss/FY-FY2026/26-000026` | us-gaap:NetIncomeLoss | FY-FY2026 | 2025-09-28 → 2026-09-26 | 132,175,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r1): The article title characterizes the annual performance as a record, which frames this net income figure as part of a superlative performance without direct comparison in the text.

<details><summary>History (5 events)</summary>

- 58.29s `claim.extracted` r1 Net income rose to $132.2 billion for the year
- 81.08s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The article title characterizes the annual performance as a record, which frames this net income figure as part of a superlative performance without direct comparison in the text.
- 151.34s `evidence.bound` r1.e1 NetIncomeLoss/FY-FY2026/26-000026
- 151.34s `calculation` r1.e1 MATCH (actual $132.175B vs stated $132.2 billion)
- 187.21s `audit.approved` r1.e1 The interpretation is faithful to the quote and accurately reflects the fiscal year period and the scale of the net income figure reported in the filing.

</details>

### c5 — MISMATCH
> “diluted earnings per share came in at $8.89”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level FY-FY2026 (gaap); stated **$8.89 per share** |
| From the filings | **$8.98 per share** |
| Difference | actual − stated = 0.0900 |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = EarningsPerShareDiluted/FY-FY2026/26-000026` |
| Computed | `actual = 8.98 USD/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `EarningsPerShareDiluted/FY-FY2026/26-000026` | us-gaap:EarningsPerShareDiluted | FY-FY2026 | 2025-09-28 → 2026-09-26 | 8.98 | USD/shares | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 87.04s `claim.extracted` r1 diluted earnings per share came in at $8.89
- 170.68s `evidence.bound` r1.e1 EarningsPerShareDiluted/FY-FY2026/26-000026
- 170.68s `calculation` r1.e1 MISMATCH (actual $8.98 per share vs stated $8.89 per share)
- 215.94s `audit.approved` r1.e1 The interpretation is a faithful representation of the quoted text; the discrepancy between the stated number and the filing is a factual error in the article, not an interpretation error.

</details>

### c6 — MATCH
> “For the fourth quarter alone, revenue was $114.5 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level Q4-FY2026 (gaap); stated **$114.5 billion** |
| From the filings | **$114.477B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = RevenueFromContractWithCustomerExcludingAssessedTax/Q4-FY2026/derived` |
| Computed | `actual = 114,477,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractWithCustomerExcludingAssessedTax/Q4-FY2026/derived` | us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax | Q4-FY2026 | 2026-06-28 → 2026-09-26 | 114,477,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) (derived: RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 − RevenueFromContractWithCustomerExcludingAssessedTax/9M-FY2026/26-000020) |

**Context warnings** (separate from the numerical result)

- `RECORD_OR_SUPERLATIVE` (context-agent, r1): The paragraph omits the context that the record sales mentioned in the article title are not explicitly tied to the revenue or profit figures provided.
- `DERIVED_Q4` (rule): RevenueFromContractWithCustomerExcludingAssessedTax/Q4-FY2026/derived is not reported on its own; it is derived as RevenueFromContractWithCustomerExcludingAssessedTax/FY-FY2026/26-000026 − RevenueFromContractWithCustomerExcludingAssessedTax/9M-FY2026/26-000020.

<details><summary>History (5 events)</summary>

- 126.30s `claim.extracted` r1 For the fourth quarter alone, revenue was $114.5 billion.
- 155.91s `context.warning` r1 [RECORD_OR_SUPERLATIVE] The paragraph omits the context that the record sales mentioned in the article title are not explicitly tied to the revenue or profit figures provided.
- 315.99s `evidence.bound` r1.e1 RevenueFromContractWithCustomerExcludingAssessedTax/Q4-FY2026/derived
- 315.99s `calculation` r1.e1 MATCH (actual $114.477B vs stated $114.5 billion)
- 331.02s `audit.approved` r1.e1 The claim accurately reflects the revenue stated in the quote for the fourth quarter.

</details>

### c7 — MISMATCH
> “Gross profit for the full year was $223.6 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | gross_profit level FY-FY2026 (gaap); stated **$223.6 billion** |
| From the filings | **$233.602B** |
| Difference | actual − stated = $10.002B |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = GrossProfit/FY-FY2026/26-000026` |
| Computed | `actual = 233,602,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `GrossProfit/FY-FY2026/26-000026` | us-gaap:GrossProfit | FY-FY2026 | 2025-09-28 → 2026-09-26 | 233,602,000,000 | USD | [10-K 0000320193-26-000026, filed 2026-11-03](https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm) |

**Context warnings** (separate from the numerical result)

- `MISLEADING_FRAMING` (context-agent, r1): Presenting a full-year figure alongside a fourth-quarter figure without explicit clarification can misleadingly imply the full-year figure is also specific to the fourth quarter.

<details><summary>History (5 events)</summary>

- 161.43s `claim.extracted` r1 Gross profit for the full year was $223.6 billion
- 195.90s `context.warning` r1 [MISLEADING_FRAMING] Presenting a full-year figure alongside a fourth-quarter figure without explicit clarification can misleadingly imply the full-year figure is also specific to the fourth quarter.
- 239.94s `evidence.bound` r1.e1 GrossProfit/FY-FY2026/26-000026
- 239.94s `calculation` r1.e1 MISMATCH (actual $233.602B vs stated $223.6 billion)
- 260.89s `audit.approved` r1.e1 The interpretation accurately reflects the stated value in the text, and the mismatch is correctly identified by the formula calculation against the financial filing.

</details>

## Run provenance

- Mode: `record`; model setting: `gemini-3.1-flash-lite`; Mozaik `@mozaik-ai/core@6.0.0`
- Model calls by source: live: 70
- Measured usage (gemini-3.1-flash-lite): 73 requests, 86464 input + 2782 output tokens, cost not computed (no price for this model)
- Concurrency (measured from Mozaik loop start/end events): peak 11 agent loops active at once across 26 loops. Measured wall-clock times of live provider calls (including pacing and retries).
- Reference: [SEC company facts (XBRL)](https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json), [SEC filing index](https://data.sec.gov/submissions/CIK0000320193.json), fetched 2026-11-26T19:27:01.034Z.
- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is `replay`.
- Stale results rejected: 1
  - 271.63s failure for c3@r1 rejected: claim is now at r2
- Elapsed: 379.79s
