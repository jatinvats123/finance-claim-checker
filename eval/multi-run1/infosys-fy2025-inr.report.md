# Claim check: Infosys ends FY25 with steady growth

> Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action.

**Company:** INFOSYS LIMITED (INFY, CIK 0001067491) · **Article:** `data/articles/infosys-fy2025-inr.md`

**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched 2026-11-26T19:27:02.904Z (reporting currency USD). Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.

| Verdict | Claims |
|---|---|
| MATCH | 3 |
| MISMATCH | 0 |
| NOT COMPUTABLE | 2 |
| NOT VERIFIABLE | 0 |
| REFERENCE UNAVAILABLE (SEC data as of 2026-11-26) | 0 |

| Claim | Quote | Numerical result | Context warnings | Audit |
|---|---|---|---|---|
| c1 r1 | Infosys reported revenue of ₹1,62,990 crore for FY25 | NOT_COMPUTABLE | – | approved by auditor (LLM review) |
| c2 r1 | Net profit for the year was ₹26,713 crore | NOT_COMPUTABLE | – | approved by auditor (LLM review) |
| c3 r1 | revenue was $19.28 billion | MATCH (actual $19.277B, stated $19.28 billion) | – | approved by auditor (LLM review) |
| c4 r1 | revenue was $19.28 billion, up 3.9% from the previous year | MATCH (actual +3.85%, stated +3.9%) | – | approved by auditor (LLM review) |
| c5 r1 | diluted earnings per share were $0.76 | MATCH (actual $0.76 per share, stated $0.76 per share) | – | approved by auditor (LLM review) |

## Receipts

### c1 — NOT COMPUTABLE
> “Infosys reported revenue of ₹1,62,990 crore for FY25”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2025 (gaap); stated **₹162990 crore** |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractsWithCustomers/FY-FY2025/25-091925` | ifrs-full:RevenueFromContractsWithCustomers | FY-FY2025 | 2024-04-01 → 2025-03-31 | 19,277,000,000 | USD | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |

- Note: Currency mismatch: the article states INR, the reference reports USD (RevenueFromContractsWithCustomers/FY-FY2025/25-091925). Amounts in different currencies are not compared; no exchange rate is applied.

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 6.34s `claim.extracted` r1 Infosys reported revenue of ₹1,62,990 crore for FY25
- 86.63s `evidence.bound` r1.e1 RevenueFromContractsWithCustomers/FY-FY2025/25-091925
- 86.63s `calculation` r1.e1 NOT_COMPUTABLE
- 113.26s `audit.approved` r1.e1 The interpretation faithfully reflects the article's statement, though the claim cannot be verified against the USD-denominated financial statement provided as evidence.

</details>

### c2 — NOT COMPUTABLE
> “Net profit for the year was ₹26,713 crore”

**Numerical result** (revision r1.e2; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income level FY-FY2025 (gaap); stated **₹26713 crore** |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-091925` | ifrs-full:ProfitLossAttributableToOwnersOfParent | FY-FY2025 | 2024-04-01 → 2025-03-31 | 3,158,000,000 | USD | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |

- Note: Currency mismatch: the article states INR, the reference reports USD (ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-091925). Amounts in different currencies are not compared; no exchange rate is applied.

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (7 events)</summary>

- 16.01s `claim.extracted` r1 Net profit for the year was ₹26,713 crore
- 167.02s `evidence.bound` r1.e1 ProfitLoss/FY-FY2025/25-091925
- 167.03s `calculation` r1.e1 NOT_COMPUTABLE
- 167.03s `audit.investigating` r1.e1 evidence: ifrs-full:ProfitLoss is not the primary net_income line item in this filing; bind ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-091925 (ifrs-full:ProfitLossAttributableToOwnersOfParent)
- 210.66s `evidence.bound` r1.e2 ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-091925 (replaces e1)
- 210.66s `calculation` r1.e2 NOT_COMPUTABLE
- 264.64s `audit.approved` r1.e2 The claim interpretation faithfully represents the quoted sentence; the verdict is NOT_COMPUTABLE due to currency mismatch between the article (INR) and the SEC filing (USD).

</details>

### c3 — MATCH
> “revenue was $19.28 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level FY-FY2025 (gaap); stated **$19.28 billion** |
| From the filings | **$19.277B** |
| Tolerance | rounding of stated digits: ±$5.000M |
| Formula | `actual = RevenueFromContractsWithCustomers/FY-FY2025/25-091925` |
| Computed | `actual = 19,277,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractsWithCustomers/FY-FY2025/25-091925` | ifrs-full:RevenueFromContractsWithCustomers | FY-FY2025 | 2024-04-01 → 2025-03-31 | 19,277,000,000 | USD | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 56.39s `claim.extracted` r1 revenue was $19.28 billion
- 97.61s `evidence.bound` r1.e1 RevenueFromContractsWithCustomers/FY-FY2025/25-091925
- 97.67s `calculation` r1.e1 MATCH (actual $19.277B vs stated $19.28 billion)
- 121.16s `audit.approved` r1.e1 The claim interpretation matches the provided quote and the fiscal year 2025 revenue figure from the 20-F filing.

</details>

### c4 — MATCH
> “revenue was $19.28 billion, up 3.9% from the previous year”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy FY-FY2025 (gaap); stated **+3.9%** |
| From the filings | **+3.85%** |
| Tolerance | rounding of stated digits: ±0.05 pp |
| Formula | `change% = (RevenueFromContractsWithCustomers/FY-FY2025/25-091925 − RevenueFromContractsWithCustomers/FY-FY2024/25-091925) / abs(RevenueFromContractsWithCustomers/FY-FY2024/25-091925) × 100` |
| Computed | `(19,277,000,000 − 18,562,000,000) / 18,562,000,000 × 100 = 3.85%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `RevenueFromContractsWithCustomers/FY-FY2025/25-091925` | ifrs-full:RevenueFromContractsWithCustomers | FY-FY2025 | 2024-04-01 → 2025-03-31 | 19,277,000,000 | USD | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |
| base | `RevenueFromContractsWithCustomers/FY-FY2024/25-091925` | ifrs-full:RevenueFromContractsWithCustomers | FY-FY2024 | 2023-04-01 → 2024-03-31 | 18,562,000,000 | USD | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 132.49s `claim.extracted` r1 revenue was $19.28 billion, up 3.9% from the previous year
- 209.94s `evidence.bound` r1.e1 RevenueFromContractsWithCustomers/FY-FY2025/25-091925 vs RevenueFromContractsWithCustomers/FY-FY2024/25-091925
- 209.94s `calculation` r1.e1 MATCH (actual +3.85% vs stated +3.9%)
- 236.09s `audit.approved` r1.e1 The interpretation accurately reflects the quote, and the minor discrepancy between the calculated figure (3.85%) and the stated figure (3.9%) is within acceptable rounding limits.

</details>

### c5 — MATCH
> “diluted earnings per share were $0.76”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level FY-FY2025 (gaap); stated **$0.76 per share** |
| From the filings | **$0.76 per share** |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = DilutedEarningsLossPerShare/FY-FY2025/25-091925` |
| Computed | `actual = 0.76 USD/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `DilutedEarningsLossPerShare/FY-FY2025/25-091925` | ifrs-full:DilutedEarningsLossPerShare | FY-FY2025 | 2024-04-01 → 2025-03-31 | 0.76 | USD/shares | [20-F 0000950170-25-091925, filed 2025-07-01](https://www.sec.gov/Archives/edgar/data/1067491/000095017025091925/infy-20250331.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 151.43s `claim.extracted` r1 diluted earnings per share were $0.76
- 200.63s `evidence.bound` r1.e1 DilutedEarningsLossPerShare/FY-FY2025/25-091925
- 200.63s `calculation` r1.e1 MATCH (actual $0.76 per share vs stated $0.76 per share)
- 221.32s `audit.approved` r1.e1 The interpretation is faithful to the quote and accurately reflects the provided financial data.

</details>

## Run provenance

- Mode: `record`; model setting: `gemini-3.1-flash-lite`; Mozaik `@mozaik-ai/core@6.0.0`
- Model calls by source: live: 48
- Measured usage (gemini-3.1-flash-lite): 57 requests, 66629 input + 1776 output tokens, cost not computed (no price for this model)
- Concurrency (measured from Mozaik loop start/end events): peak 7 agent loops active at once across 17 loops. Measured wall-clock times of live provider calls (including pacing and retries).
- Reference: [SEC company facts (XBRL)](https://data.sec.gov/api/xbrl/companyfacts/CIK0001067491.json), [SEC filing index](https://data.sec.gov/submissions/CIK0001067491.json), fetched 2026-11-26T19:27:02.904Z.
- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is `replay`.
- Stale results rejected: 0
- Elapsed: 290.49s
