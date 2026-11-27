# Superseded recordings

`nvda-q2-fy2027.2026-11-26-12-31-43.json` is the genuine gemini-3.5-flash-lite run recorded on 2026-11-26
with the single-company (NVIDIA-only) prompts of commit `cfa7f04`. The multi-company version changed the
agents' instructions and tool schemas, so its replay keys no longer match the current pipeline and it is not
loaded. It is kept unchanged as the record of that run; check out `cfa7f04` to replay it.

The five `gemini-3.1-flash-lite` recordings of 26–27 Nov (NVIDIA, Apple, Walmart run 2, Wipro, Infosys) were made before the Evidence fast path. They are superseded for the same reason: the Evidence agent's prompt now lists candidate facts, and clear claims are bound by code. They are kept unchanged as the record of those runs; their results are in `eval/multi-run1/` and `eval/multi-company-results.md`.
