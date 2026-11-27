# Original multi-claim stress attempt with Gemini 3.1 Flash-Lite

The original benchmark recorded 16 of 24 planned arms. Both schedulers ran against eight of the twelve frozen drafts. The last four arms recorded only an Extractor provider error, with zero successful model responses. A separate provider probe then confirmed HTTP 429 for `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, with a 500-request limit and a retry delay beyond the submission deadline. The recorded arms, including all four failures, remain below. [Frozen inputs](editor-stress-cases.json) · [Partial run data](editor-stress-live/results.json) · [Receipts and traces](editor-stress-live/)

## Observed outcomes

Across the eight paired attempts, concurrent agents delivered **8/12 correct edits by 120 seconds**, versus **4/12** serially. At 60 seconds the counts were **2/12** and **1/12**. Each scheduler offered zero false corrections. The remaining four drafts did not contribute a completed arm. In the first six paired attempts, before the cluster of zero-response failures, the two-minute counts were 8/9 and 4/9.

| Metric | Concurrent / serial |
|---|---:|
| Correct expected outcomes | 19/34 / 14/34 |
| False correction versions | 0 / 0 |
| Unfinished reviews | 14 / 19 |
| Forecast conflict holds among unfinished reviews | 4 / 4 |
| Explicitly provider-failed unfinished reviews | 1 / 0 |
| Unfinished at a run timeout | 1 / 7 |
| Expected claims omitted from a finished extraction | 8 / 8 |
| Model turns ending in provider errors | 4 / 3 |
| Arms reaching the runtime timeout | 1 / 2 |

Every numeric pair below is concurrent / serial.

| Draft | Correct edits by 120 s | Correct edits by 60 s | Unfinished reviews |
|---|---:|---:|---:|
| Apple annual archive | 2/2 · 2/2 | 1 / 0 | 0 / 0 |
| Walmart spring desk | 0/1 · 0/1 | 0 / 0 | 3 / 3 |
| Wipro crore tables | 2/2 · 1/2 | 0 / 0 | 0 / 0 |
| Infosys local-market sidebar | 1/1 · 1/1 | 1 / 1 | 1 / 1 |
| NVIDIA annual bottom line | 2/2 · 0/2 | 0 / 0 | 0 / 3 |
| JPMorgan annual EPS bases | 1/1 · 0/1 | 0 / 0 | 2 / 4 |
| Walmart annual totals | 0/1 · 0/1 | 0 / 0 | 4 / 4 |
| Apple March-quarter units | 0/2 · 0/2 | 0 / 0 | 4 / 4 |

For example, both Walmart spring runs correctly identified the historical figures and excluded a nearby analyst forecast, but the context guard held the three historical sentences for human review. Those holds represent editorial safety decisions. Transport failures are counted separately.

## Protocol and interruptions

The initial review engine was commit `6e394cd`. Both schedulers used Gemini 3.1 Flash-Lite, the same frozen SEC references, a primary cutoff of 120 seconds, a secondary cutoff of 60 seconds, and alternating arm order. Each mode used the same caps of 35 requests per arm, four in flight, and 12 per minute, with a 30-second request timeout, one retry, and a 180-second run timeout.

The process restarted after the two opening Apple arms to add isolation between a timed-out arm and its successor. After the JPMorgan annual serial arm reached the stall-drain limit, the process exited and resumed from a pinned engine checkout. Each restart included a quiet minute for provider requests. The original attempt stopped after four consecutive zero-response arms. The remaining cases stay unmeasured in this experiment. [Separate Gemini 3.5 comparison](editor-stress.md)
