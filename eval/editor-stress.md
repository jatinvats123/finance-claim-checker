# Multi-claim editor deadline benchmark

The follow-up benchmark asks how many correct, source-backed edits an editor receives in two minutes when a draft presents several figures. Twelve fresh synthetic drafts cover Apple, Walmart, Wipro, Infosys, NVIDIA, and JPMorgan Chase. The 53 candidate figures include 18 needed corrections, 25 correct figures, six forecasts, and four claims outside the comparison basis. Each draft contains four or five candidates. [Frozen drafts and answer key](editor-stress-cases.json)

## Observed results

The live comparison finished 24 arms. **By 120 seconds, concurrent delivered 16/18 correct edits and serial delivered 16/18.** At 60 seconds, concurrent delivered 10/18 and serial delivered 8/18. At the primary cutoff, concurrent led in 0 draft pairs, tied in 12, and serial led in 0.

| Metric | Concurrent | Serial |
|---|---:|---:|
| Correct expected outcomes across all 53 candidate figures | 50/53 | 50/53 |
| False correction versions offered | 0 | 0 |
| Unfinished reviews across 47 expected non-forecast figures | 3 | 3 |
| Model turns ending in provider errors | 0 | 0 |
| Model turns stopped by an inference limit | 0 | 0 |
| Arms reaching the run timeout | 0 | 0 |

Of the unfinished reviews, **forecast conflict holds accounted for 2 / 2** in concurrent / serial. Receipts explicitly marked 0 / 0 reviews as provider errors, and 0 / 0 were pending when an arm timed out. No extracted claim could be matched to 1 / 1 expected figures in arms that had finished, while 0 / 0 had another unfinished status. Provider-turn counts are separate because a run may preserve earlier verdicts even after a later call fails.

Both modes omitted the Infosys operating-profit typo of US$3.843 billion (the 20-F gives US$3.834 billion). Both also held the Walmart annual operating-income figure and the adjusted EPS figure after a forecast-conflict warning. The comparison includes these misses and holds in full. [Infosys receipt](editor-stress-live-35/infy-usd-with-local-sidebar-concurrent.json) · [Walmart receipt](editor-stress-live-35/wmt-fy-annual-check-concurrent.json)

Every numeric pair in the draft table is concurrent / serial. Later and unfinished reviews remain visible in the raw receipts.

| Draft | First arm | Correct edits by 120 s | Correct edits by 60 s | False offers | Unfinished reviews |
|---|---|---:|---:|---:|---:|
| Apple annual numbers for the hardware archive | Serial | 2/2 · 2/2 | 1 / 1 | 0 / 0 | 0 / 0 |
| Walmart spring sales and the desk outlook | Concurrent | 1/1 · 1/1 | 1 / 1 | 0 / 0 | 0 / 0 |
| Wipro historical figures for an Indian market brief | Serial | 2/2 · 2/2 | 1 / 1 | 0 / 0 | 0 / 0 |
| Infosys reporting currency in a local-market sidebar | Concurrent | 0/1 · 0/1 | 0 / 0 | 0 / 0 | 1 / 1 |
| NVIDIA FY2025 figures in the sector review | Serial | 2/2 · 2/2 | 1 / 0 | 0 / 0 | 0 / 0 |
| JPMorgan Chase annual earnings with an adjusted line | Concurrent | 1/1 · 1/1 | 1 / 0 | 0 / 0 | 0 / 0 |
| Walmart fiscal-year totals for a retailer comparison | Serial | 0/1 · 0/1 | 0 / 0 | 0 / 0 | 2 / 2 |
| Apple March quarter earnings box | Concurrent | 2/2 · 2/2 | 1 / 1 | 0 / 0 | 0 / 0 |
| Infosys past earnings and projected sales | Serial | 1/1 · 1/1 | 1 / 1 | 0 / 0 | 0 / 0 |
| Wipro year-end lines for the accounting archive | Concurrent | 1/1 · 1/1 | 1 / 1 | 0 / 0 | 0 / 0 |
| JPMorgan Chase September-quarter results box | Serial | 2/2 · 2/2 | 1 / 1 | 0 / 0 | 0 / 0 |
| NVIDIA October quarter review and outlook | Concurrent | 2/2 · 2/2 | 1 / 1 | 0 / 0 | 0 / 0 |



Each draft contributes one live pair. The comparison describes the workload, selected model, and request limits above. [Full result summary](editor-stress-live-35/results.json) · [Per-arm receipts and Mozaik traces](editor-stress-live-35/)

## How the comparison works

The primary cutoff is 120 seconds. Drafts with several figures require more review work than the one- and two-claim cases in the first comparison. The original 60-second cutoff remains a secondary measure. Both were fixed with the drafts and expected filing evidence before live runs. The runner verifies each pinned snapshot hash and every expected filing value before making a provider request. [Previous benchmark](editor-deadline.md) · [Pinned SEC snapshots](../data/sec-snapshot/)

Each draft runs once per scheduler. Draft order alternates between serial first and concurrent first. Each issuer appears in both orders. Both arms use the same inputs, Gemini 3.5 Flash-Lite, four maximum in-flight requests, 12 requests per minute, 35 maximum requests per run, a 30-second request timeout, and one retry. Each arm has a 180-second run timeout and a five-second pause before the next arm. Timing starts when checking the draft begins. The runner uses the app's copy formatter and the same model paths as the live checker.

- **Correct by cutoff** counts each expected correction once if it became fully reviewed and copy-ready by the cutoff, with the expected amount, metric, currency, fiscal period, and filing accessions.
- **False corrections** counts ineligible or incorrect correction versions offered by the copy formatter, including amounts whose source or interpretation fails the frozen expectation.
- **Unfinished reviews** includes expected reviewable figures that were missed or still lacked a full review at the end. Forecast exclusion counts separately toward all correct outcomes. Provider failures remain in the denominators.

The benchmark covers SEC inputs and automated review. The review engine comes from commit `7fe4424`. The run measures time inside that engine. The browser, filing retrieval, and editor-initiated recovery sit outside the measurement. Separate tests cover the PDF issuer gate and explicit recovery action. [PDF issuer regression](../test/multicompany.test.ts)

The Gemini 3.5 experiment starts all 24 planned arms from the beginning. An earlier Gemini 3.1 Flash-Lite attempt reached the provider's daily model quota after 16 recorded arms and is documented separately. [Original attempt and provider failure details](editor-stress-original.md)

## Reproduce it

Install dependencies with `npm ci`. Set `CHECKER_MODEL` to `gemini-3.5-flash-lite` and configure a live provider key for the second command. The first command verifies the frozen inputs without a key.

```sh
node --import tsx scripts/benchmark-editor.ts --verify-only --manifest eval/editor-stress-cases.json
node --import tsx scripts/benchmark-editor.ts --manifest eval/editor-stress-cases.json
```

The runner writes the protocol, summary, and a receipt and Mozaik trace for each arm under `out/benchmark-editor-manifests/editor-stress-cases/`. After a timeout it saves the arm, waits for its pending agent loops to close, and gives the provider a quiet minute before the next arm. If task drain exceeds three minutes, the runner exits with the saved results. To recover a stopped run, append `--resume` and point at the same output folder after the original process exits. The runner checks the saved protocol, arm order, and receipts before continuing with the first unfinished arm.
