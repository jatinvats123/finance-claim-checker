# Editor deadline benchmark

How many fully reviewed, source-backed edits can a financial editor copy within 60 seconds? Six fresh synthetic drafts cover four issuers and ten candidate amounts. Five require corrections. The remaining candidates include three matches, one forecast, and one non-GAAP amount that the GAAP statement cannot verify.

## Observed results

Before the context-review guard update, the concurrent scheduler produced **5/5 correct edits by 60 seconds**. The serial scheduler produced **4/5**. Across all ten expected outcomes, concurrent returned 8/10 correct and serial returned 8/10.

Every pair below is **concurrent / serial**. The edit times are shown in seconds, including corrections offered after the cutoff.

| Draft | Correct by 60 s (C · S) | Copy-ready times (C / S) | False corrections (C / S) | Unfinished reviews (C / S) |
|---|---:|---:|---:|---:|
| Apple Q4 prior-year figure | 1/1 · 1/1 | 32.16 / 35.46 | 0 / 0 | 0 / 0 |
| Wipro profit unit and EPS control | 1/1 · 1/1 | 41.06 / 53.66 | 0 / 0 | 0 / 1 |
| Walmart quarter vs half year | 1/1 · 1/1 | 38.05 / 48.63 | 0 / 0 | 0 / 0 |
| Infosys historical EPS and forecast | — | — / — | 0 / 0 | 1 / 1 |
| Walmart adjusted and reported EPS | — | — / — | 0 / 0 | 1 / 0 |
| Apple two annual corrections | 2/2 · 1/2 | 16.11, 41.11 / 34.13, 92.08 | 0 / 0 | 0 / 0 |
| **Total** | **5/5 · 4/5** | — | **0 / 0** | **2 / 2** |

One concurrent model turn and two serial model turns ended in provider errors after the configured retry policy. All twelve benchmark arms reached a reported outcome within the run timeout.

Both modes correctly excluded the Infosys forecast, but a forward-looking warning held the historical EPS match in both arms. The serial Wipro arm left its EPS match unfinished after a provider error. The concurrent Walmart alternate-basis arm correctly abstained on non-GAAP EPS, then a provider error stopped extraction before the separate GAAP figure.

The full [run summary](editor-deadline-live/results.json) and [per-arm receipts and traces](editor-deadline-live/) include the completed and incomplete outcomes. These six pairs describe this workload at these provider limits.

## Targeted Infosys rerun after the guard update

The warning guard now recognizes filed, explicitly historical EPS wording. This rerun used the same Infosys draft, pinned 20-F, model, request limits, 60-second cutoff, and concurrent-first order. The original six-pair comparison above retains its original results.

| Scheduler | Correct outcomes before → after | FY2025 EPS after | FY2027 forecast after | False corrections after |
|---|---:|---|---|---:|
| concurrent | 1/2 → 2/2 | Reviewed match | Excluded | 0 |
| serial | 1/2 → 2/2 | Reviewed match | Excluded | 0 |

Both traces record the context guard dismissing the forecast warning on the reported EPS. Reproduce the follow-up with `node --import tsx scripts/benchmark-editor.ts --case infosys-reported-and-forecast`. [Targeted run summary](editor-deadline-infosys-postfix/results.json) · [Per-arm traces](editor-deadline-infosys-postfix/)

## Reproduce the comparison

The [draft manifest](editor-deadline-cases.json) pins the text, expected outcomes, accepted values and filing accessions. The runner checks the four SEC snapshot hashes and verifies the evidence expectations before it contacts a provider. Apple’s fourth-quarter correction requires both the 10-K and the nine-month 10-Q.

Install dependencies with `npm ci` and configure a provider key in `.env`. For this experiment, select `gemini-3.1-flash-lite` with `CHECKER_MODEL`.

```bash
node --import tsx scripts/benchmark-editor.ts --verify-only
node --import tsx scripts/benchmark-editor.ts
```

The keyless command validates the inputs. The full run uses fresh provider responses and writes `out/benchmark-editor-live/`. Each draft runs once per scheduler. Scheduler order alternates by draft. Both modes use the same model, inputs, 35-call cap, limit of four requests in flight, 12 requests per minute, 30-second request timeout, one retry, and 180-second run timeout. There is a five-second pause between arms. The measurement begins at pipeline start and excludes browser rendering, filing downloads, and provider setup. The 60-second window is a declared test cutoff.

- **Correct edits by cutoff** counts each expected correction once when both reviews complete and the app's copy formatter produces a correction with the expected amount, currency, fiscal period, and filing accessions.
- **False corrections** counts copy-ready claim versions offered with the wrong interpretation or evidence, or for an amount that should receive no correction.
- **Unfinished reviews** includes expected reviewable amounts that were missed or still lacked a complete review at the end. The forecast is scored separately. Trace and provenance records retain timeouts and provider failures.

The comparison uses these six paired drafts. The issuer gate was verified separately in tests and on Render. A synthetic PDF labeled Example Beta Limited for an Example Alpha Limited draft returned `REPORT_ISSUER_MISMATCH`. A statement with no readable issuer heading returned `REPORT_ISSUER_UNVERIFIED`. Both returned HTTP 422 before a model call. [PDF issuer regression tests](../test/multicompany.test.ts)

## Reproduce an Auditor intervention without a key

Run `npm start` for the scripted NVIDIA fixture. Claim `c3` starts with evidence from the previous quarter, even though the article says year over year. The Auditor rejects the period, Evidence rebinds to the previous year's quarter, and the numerical comparison changes from +17.90% to +105.85%. The Auditor approved the revised comparison while other claims continued. The trace shows the `c6` Auditor and `c8` Context loops overlapping the `c3` evidence recheck. Claim `c4` separately shows an interpretation revision and two stale context results discarded. These are fixture timings. [Timeline excerpt and lanes](editor-auditor-fixture.json)
