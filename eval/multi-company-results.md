# Independent evaluation

Separate from the prepared demo. Spec: `eval/multi-company.json` (articles the checker was not tuned on; ground truth computed by hand from the filings).

Source: replay of data/replay/recordings/ (genuine model responses recorded earlier)

| Measure | Result |
|---|---|
| Extraction coverage (checkable claims extracted with the right metric, period and number) | 28/28 (100%) |
| Verdict correct, among extracted checkable claims | 28/28 (100%) |
| End-to-end correct (all checkable claims) | 28/28 (100%) |
| Abstentions on checkable claims | 0/28 |
| Unsupported claims handled correctly (abstained or not extracted) | 3/3 |
| Forecasts correctly not extracted | 1/1 |
| Extracted checkable claims not fully reviewed | 1/28 |
| Spurious extractions (no expected claim) | 0 |
| Runs failed or timed out | 0/5 |

## Per claim

| Id | Expected | Outcome | Correct | Review | Ground truth |
|---|---|---|---|---|---|
| A1 | MATCH | MATCH (c1) | yes | reviewed | FY2026 revenue $478.834B (10-K accn 0000320193-26-000026) |
| A2 | MATCH | MATCH (c2) | yes | reviewed | 478.834 / 416.161 = +15.06% |
| A3 | MATCH | MATCH (c3) | yes | reviewed | FY2025 revenue $416.161B |
| A4 | MATCH | MATCH (c4) | yes | reviewed | FY2026 net income $132.175B |
| A5 | MISMATCH | MISMATCH (c5) | yes | reviewed | FY2026 diluted EPS $8.98 (digits transposed) |
| A6 | MATCH | MATCH (c6) | yes | reviewed | Q4 FY2026 = FY − 9M = $114.477B (derived) |
| A7 | MISMATCH | MISMATCH (c7) | yes | reviewed | FY2026 gross profit $233.602B |
| W1 | MATCH | MATCH (c1) | yes | reviewed | Q2 FY2027 total revenues $187.937B (10-Q accn 0000104169-26-000154) |
| W2 | MATCH | MATCH (c2) | yes | reviewed | 187.937 / 177.402 = +5.94% |
| W3 | MATCH | MATCH (c3) | yes | reviewed | 6.366 / 7.026 = −9.39% |
| W4 | MATCH | MATCH (c4) | yes | reviewed | net income attributable to Walmart $6.366B |
| W5 | MATCH | MATCH (c5) | yes | reviewed | diluted EPS $0.80 |
| W6 | MATCH | MATCH (c6) | yes | reviewed | Q2 FY2026 diluted EPS $0.88 |
| W7 | ABSTAIN | extracted → NOT_VERIFIABLE (c7) | yes | reviewed | adjusted EPS: not a statement line item |
| W8 | MATCH | MATCH (c8) | yes | reviewed | 9.383 / 7.286 = +28.78% |
| W9 | MATCH | MATCH (c9) | yes | reviewed | operating income $9.383B |
| W10 | MATCH | MATCH (c10) | yes | not fully reviewed (failed) | H1 FY2027 total revenues $365.688B |
| W11 | MISMATCH | MISMATCH (c11) | yes | reviewed | H1 FY2027 operating income $16.876B |
| P1 | MATCH | MATCH (c1) | yes | reviewed | FY2025 revenue ₹890,884 million = ₹89,088.4 crore (20-F accn 0000950170-25-076303) |
| P2 | MATCH | MATCH (c2) | yes | reviewed | 890,884 / 897,603 = −0.75% |
| P3 | MATCH | MATCH (c3) | yes | reviewed | FY2024 revenue ₹897,603 million = ₹89,760.3 crore |
| P4 | MATCH | MATCH (c4) | yes | reviewed | 131,354 / 110,452 = +18.92% |
| P5 | MATCH | MATCH (c5) | yes | reviewed | profit attributable to owners ₹131,354 million = ₹13,135.4 crore |
| P6 | MATCH | MATCH (c6) | yes | reviewed | diluted EPS ₹12.52 |
| P7 | MISMATCH | MISMATCH (c7) | yes | reviewed | ₹151,271 million = ₹15,127.1 crore; the article says ₹1,51,271 crore (million read as crore) |
| P8 | MATCH | MATCH (c8) | yes | reviewed | USD convenience translation in the 20-F: $10.428B |
| I1 | ABSTAIN | extracted → NOT_COMPUTABLE (c1) | yes | reviewed | Infosys's 20-F is in USD only: a rupee figure cannot be compared (no exchange rate applied) |
| I2 | ABSTAIN | extracted → NOT_COMPUTABLE (c2) | yes | reviewed | rupee figure vs USD statements: not comparable |
| I3 | MATCH | MATCH (c3) | yes | reviewed | FY2025 revenue $19.277B (20-F accn 0000950170-25-091925) |
| I4 | MATCH | MATCH (c4) | yes | reviewed | 19.277 / 18.562 = +3.85% |
| I5 | MATCH | MATCH (c5) | yes | reviewed | diluted EPS $0.76 |
| I6 | SKIP | skipped | yes | – | guidance for the coming year |

No spurious extractions.

## Runs

```json
{
  "apple": {
    "status": "done",
    "calls": {
      "recorded": 70
    }
  },
  "walmart": {
    "status": "done",
    "calls": {
      "recorded": 85,
      "cache-miss": 3
    }
  },
  "wipro": {
    "status": "done",
    "calls": {
      "recorded": 64
    }
  },
  "infosys": {
    "status": "done",
    "calls": {
      "recorded": 48
    }
  },
  "zentrix": {
    "status": "reference error COMPANY_NOT_FOUND (expected): No SEC filer is named in the article. Enter the company name or ticker, or provide its official financial report (PDF)."
  }
}
```
