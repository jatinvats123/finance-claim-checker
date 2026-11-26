# Finance Claim Checker

**Concurrent Mozaik agents that check every number in a finance article against the company's SEC 10-Q/10-K financial statements, and show a receipt for each verdict.**

> Not financial advice. This tool checks whether numbers in a text match a company's SEC financial statements. It does not evaluate the company or recommend any action.

Finance news and earnings coverage often get numbers wrong. Growth rates get transposed between table rows, "million" becomes "billion", a quarter's figure gets reported as the full year, adjusted profit gets presented as plain profit, or a percentage has no stated basis. Readers act on these numbers. This project reads an article, extracts each numerical claim, and checks it against the audited financial statements. Every check comes with the filing, the line item, the dates, the input values and the formula.

```
npm install
npm run web        # verification workspace at http://localhost:4317 (no API key needed)
npm start          # same keyless demo in the terminal
```

## Web app (`npm run web`)

`npm run web` builds the frontend and starts a small local server at **http://localhost:4317**. The workspace opens on the included NVIDIA example, labelled *Synthetic example · Fixture model responses · Real calculations*. From there you can:

1. **Run included example.** This starts the real agent workflow on the server, with no credentials. Claims, agent activity and reviews stream in as they happen over Server-Sent Events.
2. **Select a claim** from the results or from its highlight in the article. The evidence inspector shows:
   - the quote and how it was read
   - the current and comparison periods with dates, values, units and filing links
   - the formula with values substituted, and the tolerance rule
   - context warnings, the audit outcome, and the correction history
3. **View correction.** After a run, this opens each claim the auditor actually blocked (in the demo, c3's wrong comparison period and c4's profit figure wrongly labelled GAAP), with its real revision history.
4. **Download** the existing Markdown or JSON report for the run.
5. **Check your own article.** This uses live mode when a provider key is set on the server. Without one, the dialog explains how to configure it. Replay-only mode on edited text shows an explicit cache miss and offers to restore the example.

Each claim shows its numerical status and its review status separately. A claim counts as *Reviewed* only when the current calculation was approved by the auditor and the context review finished. Failed, pending or unresolved reviews are shown as such. Provenance (live, recorded, fixture or mixed) comes from the server's model-call records, and replay timings are labelled as replay timing, not live model latency.

Layout:
- **Wide screens:** article, results and inspector side by side.
- **Laptop widths:** the inspector opens as a right-hand drawer.
- **Phones:** Article / Results / Evidence tabs.

Keyboard navigation works throughout: highlights are focusable, the drawer and dialog trap focus, and Escape closes them. Reduced-motion settings are respected.

| Command | What it does |
|---|---|
| `npm run web` | Build the frontend and serve app + API on port 4317 (`PORT`/`HOST` env to change) |
| `npm run web:dev` | Vite dev server with hot reload, proxying `/api` to `npm run web:serve` |
| `npm run web:build` / `npm run web:serve` | Build only / serve only |

The server is a thin adapter (`src/web/`) around `runChecker()`. `viewmodel.ts` turns the engine's state, tasks and call records into display data, and the browser does no financial logic.

```
c3   ✘ MISMATCH            “Revenue more than doubled from a year earlier, rising 126%”
      actual +105.85% vs stated +126%  [Revenues/Q2-FY2027/26-000075, Revenues/Q2-FY2026/26-000075]
      context: MISLEADING_FRAMING
      audit: approved by auditor (LLM review)
c8   ✘ MISMATCH            “For the first half of fiscal 2027, revenue totaled $177.8 million”
      actual $177.837B vs stated $177.8 million  [Revenues/H1-FY2027/26-000075]
      note: Value matches if the scale were "billion" instead of "million" — likely a units error.
      audit: approved by auditor (LLM review)
c9   ✘ MISMATCH            “That compares with revenue of $57.0 billion for all of fiscal 2026”
      actual $215.938B vs stated $57.0 billion  [Revenues/FY-FY2026/26-000021]
      context: VALUE_MATCHES_OTHER_PERIOD
      audit: approved by auditor (LLM review)
c10  ⧗ NO 10-Q/10-K YET    “Last week Nvidia said third-quarter revenue reached $115.8 billion”
      context: ATTRIBUTION, EARNINGS_RELEASE_ONLY
      audit: approved by auditor (rule)
```

`VALUE_MATCHES_OTHER_PERIOD` on c9 means the stated $57.0B is Q3 FY2026's *quarterly* revenue, not the full year. `EARNINGS_RELEASE_ONLY` on c10 means only the 8-K press release (filed 2026-11-17) exists for that quarter, and checking a release against itself would be circular.

Full receipts are written to `out/report.md` (human-readable) and `out/report.json` (machine-readable).

---

## How it works

Seven participants share one Mozaik runtime. Four are model-driven agents, two are deterministic code, and one is an observer. Each agent task runs in its **own Mozaik loop with a fresh context**, so work on every claim proceeds in parallel. Participants coordinate only through semantic events and a shared, versioned `RuntimeState`. There is no fixed pipeline.

```mermaid
flowchart LR
  Desk([Desk]) -- article.submitted --> X[Extractor · LLM]
  X -- claim.revised --> E[Evidence · LLM]
  X -- claim.revised --> C[Context · LLM]
  E -- evidence.bound --> K[Calculator · code]
  K -- calculation.completed --> A[Auditor · rule gate + LLM review]
  A -- "audit.correction_requested (target: evidence)" --> E
  A -- "audit.correction_requested (target: claim)" --> X
  S[(CheckerState: versioned claims, evidence, calculations, audits, warnings)]
  X & E & C & K & A <--> S
  V[Supervisor · observer] -. loop → task mapping, completion .- S
```

| Participant | Kind | Reacts to | Does |
|---|---|---|---|
| **Extractor** | LLM agent | `article.submitted`, claim corrections | Turns sentences into structured claims (`submit_claim`) and fixes a claim when the auditor asks (`revise_claim`). Code checks that each quote appears verbatim in the article and that the stated number appears in the quote. |
| **Evidence** | LLM agent | `claim.revised`, evidence corrections | Searches SEC facts and binds them **by id only** (`search_facts`, `bind_evidence`, `report_no_reference`). It never passes numbers. |
| **Context** | LLM agent | `claim.revised` | Flags framing problems such as cherry-picking, attribution and superlatives, kept separate from the numerical verdict. |
| **Calculator** | code | `evidence.bound` | Resolves values from evidence ids, computes, and attaches rule-based context warnings. |
| **Auditor** | code + LLM | `calculation.completed` | The rule gate blocks bad evidence and sends a correction request. The LLM review checks that the interpretation matches the sentence, then approves or requests a correction. |
| **Supervisor** | observer | every event | Maps Mozaik loops to tasks, finalises failed or silent tasks, and detects completion. |
| **Desk** | human participant | – | Submits the article. |

While one claim is blocked and being corrected, the others keep moving. In the demo, claims c3, c6, c8 and c9 are approved while c4 is being re-extracted.

## Design choices that make the numbers trustworthy

**1. The correct reference document.** Evidence comes only from **10-Q/10-K financial statements** (XBRL facts from SEC EDGAR). 8-K earnings releases are never used, because an earnings release is often the source of the article, so comparing the two would be circular. If no 10-Q/10-K covers a period yet, the result is `REFERENCE_NOT_YET_FILED`, and the release that *was* found is disclosed. Each receipt names the filing (form, accession number, filed date, link).

**2. Numbers and context are reported separately.** The *numerical result* (`MATCH`, `MISMATCH`, `NOT_COMPUTABLE`, `NOT_VERIFIABLE`, `REFERENCE_NOT_YET_FILED`) is shown separately from *context warnings*. The checker handles:
- **Quarterly vs annual vs year-to-date:** periods are identified from start/end dates and their position in the fiscal year, so a 6-month figure is never used for a quarter. Q4 is derived as FY − 9M and labelled as derived. Per-share Q4 values are not derived, because share counts differ between periods.
- **YoY vs QoQ:** comparison periods are computed deterministically (QoQ for Q1 → prior-year Q4). If the article doesn't state a basis, the check uses YoY and shows the QoQ figure as context.
- **GAAP vs adjusted:** non-GAAP figures are never compared with GAAP lines (`NOT_VERIFIABLE` plus a `NON_GAAP` warning). Profit claims that don't say which basis they use get `GAAP_OR_ADJUSTED_UNSTATED`.
- **Units:** dollar scale and per-share values are checked, and a million/billion slip gets an explicit hint.
- **Rounding:** the tolerance is half a unit in the article's last stated digit, so "$96.2 billion" allows ±$0.05B and "106%" allows ±0.5pp.
- **Zero or negative bases:** a percentage change from a zero or negative base is reported as `NOT_COMPUTABLE` along with the absolute change.
- **Restatements and stock splits:** the comparison value is taken *as presented in the same filing*, so it's split-adjusted. Material differences between filings are flagged as `RESTATED`.

**3. The auditor can correct, not just comment.** The rule gate checks source form, line item, period, duration, comparison base, same-filing comparatives and revision numbers. When a check fails, it **blocks** the result and sends a correction request to the agent that owns the faulty part: the evidence agent or the extractor. The fix triggers re-binding and **recalculation**. The LLM review can do the same for interpretation errors. Each claim has a budget of two corrections; after that it is marked `UNRESOLVED`.

**4. Claims and evidence are versioned.** Every claim has a revision (`r1`, `r2`…), and every evidence binding has an evidence revision (`e1`, `e2`…). Every derived result is stamped with the revisions it was computed from:
- Revising a claim invalidates that claim's evidence, calculation, audit and context warnings. Rebinding evidence invalidates its calculation and audit.
- Late writes stamped with an old revision are rejected and logged (`⟲ STALE`).
- Other claims are never touched. In the demo, a slow context review for c4 r1 arrives after r2 exists and is rejected.

**5. A complete evidence receipt.** Each result shows:
- the original quote and how it was interpreted
- the filing link and the XBRL line item
- the period label, start and end dates, units and every input value with its evidence id
- the formula with the numbers substituted in, the tolerance rule, the context warnings, and the claim's full revision history

The calculator **resolves values from validated evidence ids**. Agents can't pass amounts, and ids that don't exist are rejected.

**6. Mozaik is pinned and verified.** `@mozaik-ai/core` is pinned to exactly `6.0.0`, the package the hackathon rules name. `test/mozaik-compat.test.ts` runs without a key and proves the three runtime behaviours the design depends on:
- two agents' loops running at the same time
- tool calls writing shared `RuntimeState`
- a third participant reacting to a custom event

**7. Replay and validation you can trust.** Every model call is labelled by source:

| Mode | Model responses come from | Labelled |
|---|---|---|
| `--mode live` | the real provider | `live` |
| `--mode record` | the real provider, saved to `data/replay/recordings/` | `live` (saved as `recorded`) |
| `--mode replay` (default) | recordings first, then fixtures | `recorded` / `fixture` |
| `--mode author` | `fixtures/*.script.ts`, sealed to `data/replay/*.fixtures.json` | `fixture` |

- The bundled demo uses **hand-written fixtures**, not recorded model output, and the report says so.
- Replay keys are a hash of the full request: instructions, task message, earlier tool calls and their exact outputs. A different article, refreshed SEC data or a changed prompt produces an explicit **`CACHE_MISS`**. Nothing is substituted.
- In keyless mode, everything except the model text runs for real: SEC lookup, period identification, calculations, the rule gate, revision control and the receipts.
- Provider errors are isolated to their task. The claim is marked `FAILED`, or shown "unaudited" when only the review failed, and the run finishes.

## Running it

Requires Node ≥ 20.12.

```bash
npm install
npm start                       # keyless replay of the bundled NVIDIA demo
npm test                        # 56 tests, no key needed
npm run typecheck               # server + web
```

**Check your own article** (needs a provider key in `.env`, see `.env.example`):

```bash
npm run check -- --article path/to/article.md --ticker NVDA --mode live
npm run check -- --article path/to/article.md --ticker NVDA --mode record   # also saves a replayable cassette
```

- Articles are Markdown: the first `# ` line is the title.
- The model is chosen from whichever key is set (`claude-sonnet-5-5`, `gpt-5.5` or `gemini-3.5-flash`). Override it with `--model` or `CHECKER_MODEL`.
- Other companies: `npm run snapshot:sec -- MSFT` saves a trimmed SEC snapshot, or pass `--live-sec`. Set `SEC_USER_AGENT="Your Name you@example.com"` first; SEC asks automated clients to identify themselves.
- Re-seal the demo fixtures after changing prompts or tools: `npm run fixtures:seal`.

## Tests

| File | Covers |
|---|---|
| `test/mozaik-compat.test.ts` | Pinned version; two concurrent agents, shared state, event reaction |
| `test/calculator.test.ts` | Rounding tolerance, units and scale errors, per-share, qualifiers, non-GAAP, YoY %, direction, zero and negative bases, multiples |
| `test/evidence.test.ts` | 10-Q/10-K only, quarter vs YTD, periods from dates (not tags), derived Q4, missing 10-Q + 8-K detection, restatements, SEC cache miss |
| `test/checks.test.ts` | Rule gate: YTD-for-quarter, QoQ-as-YoY, wrong line item, split-adjusted comparatives, no-reference verification, misread units; context rules |
| `test/store.test.ts` | Stale calculations, audits and context rejected; unaffected claims preserved; invalid evidence ids rejected; final audits immutable |
| `test/pipeline.test.ts` | Full keyless run: expected verdicts, ≥3 loops in flight, both correction paths, stale rejection, explicit cache miss, provider failures isolated |
| `test/web.test.ts` | Web adapter: canonical example article, duplicate-run guard, SSE snapshots, UI values identical to the engine report, exact highlight offsets (overlapping/repeated quotes), real corrections, provenance, downloads, cache miss, live-without-key, failed audit/context never shown as reviewed |

## Notes on Mozaik 6.0.0 (found while building)

- `runLoop` doesn't catch inference errors, so a provider failure becomes an unhandled rejection. Our runner catches it and ends the loop cleanly with the failure recorded on the task.
- Only the **first** function call of a model turn is executed. The agent instructions ask for one tool call per message.
- The Anthropic adapter sends `max_tokens` from `maxOutputTokens` with no default. We always set it.
- `InferenceInputValidator` isn't exported. To keep Mozaik's request validation in live mode, we get the default runner through `initializeRuntime(...).getInferenceRunner()`.
- `runLoop` appends to the `ModelContext` it receives. We give every task a fresh context; that keeps loops independent and makes the replay hashes deterministic.

## Limitations

- **Live mode hasn't been tried against a real provider in this repo yet.** The prompts have only been run through the hand-written fixtures. Run `--mode record` with a key to produce real recordings.
- The checker covers six statement line items (revenue, net income, gross profit, operating income, diluted and basic EPS) for one company per article, and only US SEC filers.
- Fiscal periods in the article are mapped by the extractor model, using the fiscal calendar it is given. The auditor's LLM review is the check on that mapping.
- Tolerance choices are deliberate policies: rounding of stated digits, "about" = 1%, multiples ±5%.
- Non-GAAP figures can't be verified against financial statements by design.

## Project layout

```
src/sec/        EDGAR snapshot/fetch, fiscal-period identification, evidence registry
src/domain/     claim types, deterministic calculator, rule gate + context rules, versioned state
src/agents/     Extractor, Evidence, Context, Calculator, Auditor participants
src/runtime/    Mozaik wiring, task tracking, pipeline/supervisor
src/llm/        provenance-labelled runner (live / record / replay / author)
src/report/     live terminal view, Markdown and JSON receipts
src/web/        web server (SSE + downloads) and view model
web/            React workspace (Vite)
data/           SEC snapshot (NVDA), demo article, sealed fixtures, recordings
fixtures/       hand-written demo script (source of the sealed fixtures)
```

**Data:** the SEC EDGAR XBRL company facts and filing index are public data, and the snapshot records its source URLs and fetch time. The demo article is synthetic and labelled as such. Its correct figures come from NVIDIA's public filings, and its errors are deliberate.
