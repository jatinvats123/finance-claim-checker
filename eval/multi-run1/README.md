# Multi-company run 1 (independent measurement, 27 Nov 2026)

Genuine `gemini-3.1-flash-lite` runs of the fresh articles, made before any change prompted by them.

- `*.report.md`: the receipts each run produced.
- `walmart-q2-fy2027.2026-11-26-19-47-52.json`: the run-1 recording of the one article whose result led to code changes. It no longer replays under the current code: the extended year-earlier rule now fires on W6 and asks the extractor for a correction that is not in the recording.

Results, against `eval/multi-company.json`:
- NVIDIA 10/10, Apple 7/7, Wipro 8/8, Infosys 5/5 (plus 1 forecast correctly skipped).
- Walmart 9/11:
  - **W6 wrong period.** "compared with $0.88 in the same quarter last year" was labelled with the current quarter. The year-earlier rule only knew "a year earlier/ago". It now also covers "same quarter last year", "previous year" and "last year" (`priorPeriodAttribution`).
  - **W11 not finished.** The evidence agent found H1 operating income ($16.876B) but kept declaring "no reference" because the value differed from the article's $19.9B. Code rejected each attempt until the 12-turn cap. The rejection now names the matching fact ids and says to bind them even when the value differs.
