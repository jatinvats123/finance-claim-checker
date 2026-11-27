# Superseded recordings

`nvda-q2-fy2027.2026-11-26-12-31-43.json` is the genuine gemini-3.5-flash-lite run recorded on 2026-11-26
with the single-company (NVIDIA-only) prompts of commit `cfa7f04`. The multi-company version changed the
agents' instructions and tool schemas, so its replay keys no longer match the current pipeline and it is not
loaded. It is kept unchanged as the record of that run; check out `cfa7f04` to replay it.

The five later multi-company captures are in `data/replay/recordings/`. Their archived article fingerprints select their original prompts only for exact recorded inputs. Their recorded responses and latencies are preserved.
