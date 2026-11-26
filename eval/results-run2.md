# Independent evaluation

Separate from the prepared demo: two synthetic articles with claims the checker has not seen, ground truth checked by hand (`eval/expected.json`).

Source: live gemini-3.5-flash-lite (recorded to eval/recordings/)

| Measure | Result |
|---|---|
| Extraction coverage (checkable claims extracted with the right metric, period and number) | 8/15 (53%) |
| Verdict correct, among extracted checkable claims | 8/8 (100%) |
| End-to-end correct (all checkable claims) | 8/15 (53%) |
| Abstentions on checkable claims | 0/8 |
| Unsupported claims handled correctly (abstained or not extracted) | 1/1 |
| Forecasts correctly not extracted | 1/1 |
| Extracted checkable claims not fully reviewed | 0/8 |
| Spurious extractions (no expected claim) | 0 |
| Runs failed or timed out | 1/2 |

## Per claim

| Id | Expected | Outcome | Correct | Review | Ground truth |
|---|---|---|---|---|---|
| A1 | MATCH | MATCH (c1) | yes | reviewed | Q1 FY2027 revenue $81,615M; stated $81.6B ± $0.05B |
| A2 | MATCH | MATCH (c2) | yes | reviewed | (81,615 − 44,062) / 44,062 = 85.23%; stated 85% ± 0.5 pp |
| A3 | MATCH | MATCH (c3) | yes | reviewed | Q1 FY2026 revenue $44,062M; stated $44.1B ± $0.05B (diff $0.038B) |
| A4 | MATCH | MATCH (c4) | yes | reviewed | Q1 FY2027 gross profit $61,157M; stated $61.2B ± $0.05B |
| A5 | MATCH | MATCH (c5) | yes | reviewed | (58,321 − 18,775) / 18,775 = 210.63%; stated 211% ± 0.5 pp |
| A6 | MATCH | MATCH (c6) | yes | reviewed | Q1 FY2027 net income $58,321M; stated $58.3B ± $0.05B |
| A7 | MISMATCH | MISMATCH (c7) | yes | reviewed | Q1 FY2027 diluted EPS $2.39; stated $2.93 (digits transposed) |
| A8 | MISMATCH | MISMATCH (c8) | yes | reviewed | QoQ vs derived Q4 FY2026 ($130,387M − $86,088M = $44,299M): (53,536 − 44,299) / 44,299 = +20.85%; article says it fell 5% |
| A9 | SKIP | skipped | yes | – | forecast ('expects ... next quarter'); must not be extracted |
| B1 | MATCH | missed (not extracted with this metric/period/number) | **no** | – | FY2026 revenue $215,938M; stated $215.9B ± $0.05B |
| B2 | MATCH | missed (not extracted with this metric/period/number) | **no** | – | (215,938 − 130,497) / 130,497 = 65.47%; stated 65% ± 0.5 pp |
| B3 | MATCH | missed (not extracted with this metric/period/number) | **no** | – | FY2026 net income $120,067M; stated $120.1B ± $0.05B |
| B4 | MATCH | missed (not extracted with this metric/period/number) | **no** | – | FY2026 diluted EPS $4.90; stated $4.90 ± $0.005 |
| B5 | MATCH | missed (not extracted with this metric/period/number) | **no** | – | Q4 FY2026 revenue derived as FY − 9M = $215,938M − $147,811M = $68,127M; stated $68.1B ± $0.05B |
| B6 | MISMATCH | missed (not extracted with this metric/period/number) | **no** | – | QoQ: (68,127 − 57,006) / 57,006 = 19.51%; article says 'more than 20%' |
| B7 | ABSTAIN | not extracted | yes | – | adjusted gross margin: a non-GAAP ratio, not a supported statement line |
| B8 | MISMATCH | missed (not extracted with this metric/period/number) | **no** | – | Q3 FY2026 net income $31,910M; article says $31.9 million (units error) |

No spurious extractions.

## Runs

```json
{
  "a": {
    "status": "done",
    "calls": {
      "live": 77
    },
    "usage": {
      "model": "gemini-3.5-flash-lite",
      "requests": 78,
      "retries": 1,
      "inputTokens": 102282,
      "outputTokens": 3043,
      "reasoningTokens": 0,
      "retryNotes": [
        "auditor:c7@r1.e1: {\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details. For more information on this er"
      ],
      "stalled": []
    }
  },
  "b": {
    "status": "extraction failed: PROVIDER_ERROR: {\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500, model: gemini-3.5-flash-lite, description: Generate content requests per day limit exceeded on Free Tier. See https://aistudio.google.com/docs/rate-limits.\\nPlease retry in 16h53m48.954853798s.\",\"status\":\"RESOURCE_EXHAUSTED\",\"details\":[{\"@type\":\"type.googleapis.com/google.rpc.Help\",\"links\":[{\"description\":\"Learn more about Gemini API quotas\",\"url\":\"https://aistudio.google.com/docs/rate-limits\"}]},{\"@type\":\"type.googleapis.com/google.rpc.QuotaFailure\",\"violations\":[{\"description\":\"Generate content requests per day limit exceeded on Free Tier. See https://aistudio.google.com/docs/rate-limits.\",\"quotaMetric\":\"generativelanguage.googleapis.com/generate_content_free_tier_requests\",\"quotaId\":\"GenerateRequestsPerDayPerProjectPerModel-FreeTier\",\"quotaDimensions\":{\"location\":\"global\",\"model\":\"gemini-3.5-flash-lite\"},\"quotaValue\":\"500\"}]},{\"@type\":\"type.googleapis.com/google.rpc.RetryInfo\",\"retryDelay\":\"60828s\"}]}}",
    "calls": {
      "provider-error": 1
    },
    "usage": {
      "model": "gemini-3.5-flash-lite",
      "requests": 4,
      "retries": 3,
      "inputTokens": 0,
      "outputTokens": 0,
      "reasoningTokens": 0,
      "retryNotes": [
        "extractor:article: {\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details. For more information on this er",
        "extractor:article: {\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details. For more information on this er",
        "extractor:article: {\"error\":{\"code\":429,\"message\":\"You exceeded your current quota, please check your plan and billing details. For more information on this er"
      ],
      "stalled": []
    }
  }
}
```
