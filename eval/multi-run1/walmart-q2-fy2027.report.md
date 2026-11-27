# Claim check: Walmart's second quarter: sales climb, but profit slips

> Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action.

**Company:** Walmart Inc. (WMT, CIK 0000104169) · **Article:** `data/articles/walmart-q2-fy2027.md`

**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched 2026-11-26T19:27:01.451Z (reporting currency USD). Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.

| Verdict | Claims |
|---|---|
| MATCH | 8 |
| MISMATCH | 1 |
| NOT COMPUTABLE | 0 |
| NOT VERIFIABLE | 1 |
| REFERENCE UNAVAILABLE (SEC data as of 2026-11-26) | 0 |

| Claim | Quote | Numerical result | Context warnings | Audit |
|---|---|---|---|---|
| c1 r1 | total revenue of $187.9 billion for the second quarter of fiscal 2027 | MATCH (actual $187.937B, stated $187.9 billion) | – | approved by auditor (LLM review) |
| c2 r1 | up 5.9% from a year earlier. | MATCH (actual +5.94%, stated +5.9%) | – | approved by auditor (LLM review) |
| c3 r1 | Net income attributable to Walmart fell 9.4% to $6.4 billion. | MATCH (actual -9.39%, stated −9.4%) | – | approved by auditor (LLM review) |
| c4 r1 | Net income attributable to Walmart fell 9.4% to $6.4 billion. | MATCH (actual $6.366B, stated $6.4 billion) | – | approved by auditor (LLM review) |
| c5 r1 | Diluted earnings per share were $0.80 | MATCH (actual $0.8 per share, stated $0.80 per share) | CHERRY_PICKED | approved by auditor (LLM review) |
| c6 r1 | compared with $0.88 in the same quarter last year. | MISMATCH (actual $0.8 per share, stated $0.88 per share) | VALUE_MATCHES_OTHER_PERIOD, VALUE_MATCHES_OTHER_PERIOD, VALUE_MATCHES_OTHER_PERIOD | approved by auditor (LLM review) |
| c7 r1 | Excluding certain items, adjusted earnings per share were $0.68. | NOT_VERIFIABLE | NON_GAAP, CHERRY_PICKED | approved by auditor (rule) |
| c8 r1 | Operating income rose 28.8% to $9.4 billion. | MATCH (actual +28.78%, stated +28.8%) | MISLEADING_FRAMING, BASIS_UNSTATED | approved by auditor (LLM review) |
| c9 r1 | Operating income rose 28.8% to $9.4 billion. | MATCH (actual $9.383B, stated $9.4 billion) | MISLEADING_FRAMING | approved by auditor (LLM review) |
| c10 r1 | For the first half of the fiscal year, revenue totaled $365.7 billion | MATCH (actual $365.688B, stated $365.7 billion) | – | approved by auditor (LLM review) |
| c11 r1 | operating income for the first half reached $19.9 billion. | PENDING | – | FAILED: LIMIT_REACHED: task evidence:c11@r1#1 reached the turn cap (12 model turns) |

## Receipts

### c1 — MATCH
> “total revenue of $187.9 billion for the second quarter of fiscal 2027”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level Q2-FY2027 (gaap); stated **$187.9 billion** |
| From the filings | **$187.937B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = Revenues/Q2-FY2027/26-000154` |
| Computed | `actual = 187,937,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/Q2-FY2027/26-000154` | us-gaap:Revenues | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 187,937,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 3.46s `claim.extracted` r1 total revenue of $187.9 billion for the second quarter of fiscal 2027
- 37.42s `evidence.bound` r1.e1 Revenues/Q2-FY2027/26-000154
- 37.43s `calculation` r1.e1 MATCH (actual $187.937B vs stated $187.9 billion)
- 75.86s `audit.approved` r1.e1 The interpretation matches the quoted text and the extracted financial data.

</details>

### c2 — MATCH
> “up 5.9% from a year earlier.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue change yoy Q2-FY2027 (gaap); stated **+5.9%** |
| From the filings | **+5.94%** |
| Tolerance | rounding of stated digits: ±0.05 pp |
| Formula | `change% = (Revenues/Q2-FY2027/26-000154 − Revenues/Q2-FY2026/26-000154) / abs(Revenues/Q2-FY2026/26-000154) × 100` |
| Computed | `(187,937,000,000 − 177,402,000,000) / 177,402,000,000 × 100 = 5.94%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/Q2-FY2027/26-000154` | us-gaap:Revenues | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 187,937,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |
| base | `Revenues/Q2-FY2026/26-000154` | us-gaap:Revenues | Q2-FY2026 | 2025-05-01 → 2025-07-31 | 177,402,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 11.04s `claim.extracted` r1 up 5.9% from a year earlier.
- 92.58s `evidence.bound` r1.e1 Revenues/Q2-FY2027/26-000154 vs Revenues/Q2-FY2026/26-000154
- 92.58s `calculation` r1.e1 MATCH (actual +5.94% vs stated +5.9%)
- 132.62s `audit.approved` r1.e1 The interpretation accurately reflects the percentage increase in revenue reported in the text and matches the calculated value.

</details>

### c3 — MATCH
> “Net income attributable to Walmart fell 9.4% to $6.4 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income change yoy Q2-FY2027 (gaap); stated **−9.4%** |
| From the filings | **-9.39%** |
| Tolerance | rounding of stated digits: ±0.05 pp |
| Formula | `change% = (NetIncomeLoss/Q2-FY2027/26-000154 − NetIncomeLoss/Q2-FY2026/26-000154) / abs(NetIncomeLoss/Q2-FY2026/26-000154) × 100` |
| Computed | `(6,366,000,000 − 7,026,000,000) / 7,026,000,000 × 100 = -9.39%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `NetIncomeLoss/Q2-FY2027/26-000154` | us-gaap:NetIncomeLoss | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 6,366,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |
| base | `NetIncomeLoss/Q2-FY2026/26-000154` | us-gaap:NetIncomeLoss | Q2-FY2026 | 2025-05-01 → 2025-07-31 | 7,026,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 27.82s `claim.extracted` r1 Net income attributable to Walmart fell 9.4% to $6.4 billion.
- 117.95s `evidence.bound` r1.e1 NetIncomeLoss/Q2-FY2027/26-000154 vs NetIncomeLoss/Q2-FY2026/26-000154
- 117.95s `calculation` r1.e1 MATCH (actual -9.39% vs stated −9.4%)
- 166.49s `audit.approved` r1.e1 The interpretation is faithful to the quoted sentence and the stated percentage decline of 9.4% is consistent with the reported figures from the filing.

</details>

### c4 — MATCH
> “Net income attributable to Walmart fell 9.4% to $6.4 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | net_income level Q2-FY2027 (gaap); stated **$6.4 billion** |
| From the filings | **$6.366B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = NetIncomeLoss/Q2-FY2027/26-000154` |
| Computed | `actual = 6,366,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `NetIncomeLoss/Q2-FY2027/26-000154` | us-gaap:NetIncomeLoss | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 6,366,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 46.11s `claim.extracted` r1 Net income attributable to Walmart fell 9.4% to $6.4 billion.
- 174.43s `evidence.bound` r1.e1 NetIncomeLoss/Q2-FY2027/26-000154 vs NetIncomeLoss/Q2-FY2026/26-000154
- 174.43s `calculation` r1.e1 MATCH (actual $6.366B vs stated $6.4 billion)
- 210.93s `audit.approved` r1.e1 The interpretation accurately reflects the quote and aligns with the financial data, noting the minor discrepancy due to rounding.

</details>

### c5 — MATCH
> “Diluted earnings per share were $0.80”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level Q2-FY2027 (gaap); stated **$0.80 per share** |
| From the filings | **$0.8 per share** |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = EarningsPerShareDiluted/Q2-FY2027/26-000154` |
| Computed | `actual = 0.8 USD/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `EarningsPerShareDiluted/Q2-FY2027/26-000154` | us-gaap:EarningsPerShareDiluted | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 0.8 | USD/shares | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- `CHERRY_PICKED` (context-agent, r1): The paragraph selectively contrasts the current diluted earnings per share with the prior year's figure while omitting the context of the adjusted earnings per share provided in the same paragraph.

<details><summary>History (5 events)</summary>

- 79.53s `claim.extracted` r1 Diluted earnings per share were $0.80
- 101.40s `context.warning` r1 [CHERRY_PICKED] The paragraph selectively contrasts the current diluted earnings per share with the prior year's figure while omitting the context of the adjusted earnings per share provided in the same paragraph.
- 195.84s `evidence.bound` r1.e1 EarningsPerShareDiluted/Q2-FY2027/26-000154
- 195.84s `calculation` r1.e1 MATCH (actual $0.8 per share vs stated $0.80 per share)
- 256.45s `audit.approved` r1.e1 The interpretation accurately reflects the provided quote and the data matches the financial filing.

</details>

### c6 — MISMATCH
> “compared with $0.88 in the same quarter last year.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | eps_diluted level Q2-FY2027 (gaap); stated **$0.88 per share** |
| From the filings | **$0.8 per share** |
| Difference | actual − stated = -0.0800 |
| Tolerance | rounding of stated digits: ±0.0050 |
| Formula | `actual = EarningsPerShareDiluted/Q2-FY2027/26-000154` |
| Computed | `actual = 0.8 USD/shares` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `EarningsPerShareDiluted/Q2-FY2027/26-000154` | us-gaap:EarningsPerShareDiluted | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 0.8 | USD/shares | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- `VALUE_MATCHES_OTHER_PERIOD` (rule): The stated figure matches Q2-FY2010 (quarter, $0.88 per share, EarningsPerShareDiluted/Q2-FY2010/09-189177) — possibly the wrong period (e.g. quarter vs. full year).
- `VALUE_MATCHES_OTHER_PERIOD` (rule): The stated figure matches Q1-FY2011 (quarter, $0.88 per share, EarningsPerShareDiluted/Q1-FY2011/10-132759) — possibly the wrong period (e.g. quarter vs. full year).
- `VALUE_MATCHES_OTHER_PERIOD` (rule): The stated figure matches Q2-FY2026 (quarter, $0.88 per share, EarningsPerShareDiluted/Q2-FY2026/25-000137) — possibly the wrong period (e.g. quarter vs. full year).

<details><summary>History (4 events)</summary>

- 106.52s `claim.extracted` r1 compared with $0.88 in the same quarter last year.
- 236.63s `evidence.bound` r1.e1 EarningsPerShareDiluted/Q2-FY2027/26-000154 vs EarningsPerShareDiluted/Q2-FY2026/26-000154
- 236.63s `calculation` r1.e1 MISMATCH (actual $0.8 per share vs stated $0.88 per share)
- 276.31s `audit.approved` r1.e1 The claim accurately reflects the text provided in the article, and the mismatch with the filing value is correctly identified as a MISMATCH.

</details>

### c7 — NOT VERIFIABLE
> “Excluding certain items, adjusted earnings per share were $0.68.”

**Numerical result** (revision r1.e1; audit: approved by auditor (rule))

| | |
|---|---|
| Claim read as | eps_diluted level Q2-FY2027 (non_gaap); stated **$0.68 per share** |

**Reference:** Adjusted (non-GAAP) figure: not a line item of the financial statements.

**Context warnings** (separate from the numerical result)

- `NON_GAAP` (rule): Article cites an adjusted (non-GAAP) figure. Companies define these themselves; they are not line items in the financial statements.
- `CHERRY_PICKED` (context-agent, r1): The paragraph presents a negative trend in GAAP earnings alongside an adjusted figure without clarifying that the adjusted figure is not directly comparable to the GAAP earnings decline.

<details><summary>History (5 events)</summary>

- 146.91s `claim.extracted` r1 Excluding certain items, adjusted earnings per share were $0.68.
- 146.91s `evidence.bound` r1.e1 NOT_IN_STATEMENTS
- 146.92s `calculation` r1.e1 NOT_VERIFIABLE
- 146.92s `audit.approved` r1.e1 rule gate passed; nothing in the financial statements to compute against
- 186.15s `context.warning` r1 [CHERRY_PICKED] The paragraph presents a negative trend in GAAP earnings alongside an adjusted figure without clarifying that the adjusted figure is not directly comparable to the GAAP earnings decline.

</details>

### c8 — MATCH
> “Operating income rose 28.8% to $9.4 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | operating_income change unspecified Q2-FY2027 (gaap); stated **+28.8%** |
| From the filings | **+28.78%** |
| Tolerance | rounding of stated digits: ±0.05 pp |
| Formula | `change% = (OperatingIncomeLoss/Q2-FY2027/26-000154 − OperatingIncomeLoss/Q2-FY2026/26-000154) / abs(OperatingIncomeLoss/Q2-FY2026/26-000154) × 100` |
| Computed | `(9,383,000,000 − 7,286,000,000) / 7,286,000,000 × 100 = 28.78%` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `OperatingIncomeLoss/Q2-FY2027/26-000154` | us-gaap:OperatingIncomeLoss | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 9,383,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |
| base | `OperatingIncomeLoss/Q2-FY2026/26-000154` | us-gaap:OperatingIncomeLoss | Q2-FY2026 | 2025-05-01 → 2025-07-31 | 7,286,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- `MISLEADING_FRAMING` (context-agent, r1): The paragraph presents a quarterly increase as a standalone result while the article title indicates that overall profit for the period has slipped.
- `BASIS_UNSTATED` (rule): Article does not say what the change is measured against; year-over-year was assumed. Quarter-over-quarter it would be +25.22% (OperatingIncomeLoss/Q1-FY2027/26-000102).

<details><summary>History (5 events)</summary>

- 221.34s `claim.extracted` r1 Operating income rose 28.8% to $9.4 billion.
- 290.24s `context.warning` r1 [MISLEADING_FRAMING] The paragraph presents a quarterly increase as a standalone result while the article title indicates that overall profit for the period has slipped.
- 505.37s `evidence.bound` r1.e1 OperatingIncomeLoss/Q2-FY2027/26-000154 vs OperatingIncomeLoss/Q2-FY2026/26-000154
- 505.38s `calculation` r1.e1 MATCH (actual +28.78% vs stated +28.8%)
- 521.26s `audit.approved` r1.e1 The interpretation accurately reflects the quote and the context of the claim, with the growth rate calculation confirmed as a match within standard rounding conventions.

</details>

### c9 — MATCH
> “Operating income rose 28.8% to $9.4 billion.”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | operating_income level Q2-FY2027 (gaap); stated **$9.4 billion** |
| From the filings | **$9.383B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = OperatingIncomeLoss/Q2-FY2027/26-000154` |
| Computed | `actual = 9,383,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `OperatingIncomeLoss/Q2-FY2027/26-000154` | us-gaap:OperatingIncomeLoss | Q2-FY2027 | 2026-05-01 → 2026-07-31 | 9,383,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- `MISLEADING_FRAMING` (context-agent, r1): The paragraph frames a quarterly increase alongside six-month totals, which may mislead the reader about the company's profitability trend.

<details><summary>History (5 events)</summary>

- 263.80s `claim.extracted` r1 Operating income rose 28.8% to $9.4 billion.
- 308.44s `context.warning` r1 [MISLEADING_FRAMING] The paragraph frames a quarterly increase alongside six-month totals, which may mislead the reader about the company's profitability trend.
- 386.19s `evidence.bound` r1.e1 OperatingIncomeLoss/Q2-FY2027/26-000154 vs OperatingIncomeLoss/Q2-FY2026/26-000154
- 386.19s `calculation` r1.e1 MATCH (actual $9.383B vs stated $9.4 billion)
- 463.70s `audit.approved` r1.e1 The interpretation is faithful to the quote, and the reported figure of $9.4 billion is a reasonable rounding of the actual $9.383 billion.

</details>

### c10 — MATCH
> “For the first half of the fiscal year, revenue totaled $365.7 billion”

**Numerical result** (revision r1.e1; audit: approved by auditor (LLM review))

| | |
|---|---|
| Claim read as | revenue level H1-FY2027 (gaap); stated **$365.7 billion** |
| From the filings | **$365.688B** |
| Tolerance | rounding of stated digits: ±$50.000M |
| Formula | `actual = Revenues/H1-FY2027/26-000154` |
| Computed | `actual = 365,688,000,000 USD` |

**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)

| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |
|---|---|---|---|---|---|---|---|
| current | `Revenues/H1-FY2027/26-000154` | us-gaap:Revenues | H1-FY2027 | 2026-02-01 → 2026-07-31 | 365,688,000,000 | USD | [10-Q 0000104169-26-000154, filed 2026-08-28](https://www.sec.gov/Archives/edgar/data/104169/000010416926000154/wmt-20260731.htm) |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (4 events)</summary>

- 293.30s `claim.extracted` r1 For the first half of the fiscal year, revenue totaled $365.7 billion
- 361.12s `evidence.bound` r1.e1 Revenues/H1-FY2027/26-000154
- 361.12s `calculation` r1.e1 MATCH (actual $365.688B vs stated $365.7 billion)
- 381.62s `audit.approved` r1.e1 The interpretation is faithful to the quoted text and accurately reflects the fiscal period, metric, and value.

</details>

### c11 — PENDING
> “operating income for the first half reached $19.9 billion.”

**Numerical result** (revision r1; audit: FAILED: LIMIT_REACHED: task evidence:c11@r1#1 reached the turn cap (12 model turns))

| | |
|---|---|
| Claim read as | operating_income level H1-FY2027 (gaap); stated **19.9** |

**Context warnings** (separate from the numerical result)

- none

<details><summary>History (2 events)</summary>

- 325.97s `claim.extracted` r1 operating income for the first half reached $19.9 billion.
- 579.30s `audit.failed` r1 LIMIT_REACHED: task evidence:c11@r1#1 reached the turn cap (12 model turns)

</details>

## Run provenance

- Mode: `record`; model setting: `gemini-3.1-flash-lite`; Mozaik `@mozaik-ai/core@6.0.0`
- Model calls by source: live: 92, limit-reached: 1
- Measured usage (gemini-3.1-flash-lite): 100 requests, 134655 input + 3641 output tokens, cost not computed (no price for this model); stopped by limit: task evidence:c11@r1#1 reached the turn cap (12 model turns)
- Concurrency (measured from Mozaik loop start/end events): peak 10 agent loops active at once across 31 loops. Measured wall-clock times of live provider calls (including pacing and retries).
- Reference: [SEC company facts (XBRL)](https://data.sec.gov/api/xbrl/companyfacts/CIK0000104169.json), [SEC filing index](https://data.sec.gov/submissions/CIK0000104169.json), fetched 2026-11-26T19:27:01.451Z.
- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is `replay`.
- Stale results rejected: 0
- Elapsed: 579.30s
