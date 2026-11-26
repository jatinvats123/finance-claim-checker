/**
 * Independent evaluation (separate from the prepared demo).
 *
 *   npm run eval -- --mode record --model gemini-3.5-flash-lite --rpm 10   genuine model run, saved to eval/recordings/
 *   npm run eval                                                           replay those recordings only (no key)
 *
 * Every rate is reported with its denominator. Claims are matched to eval/expected.json by metric,
 * kind, fiscal year/period and the stated number; nothing is fuzzy-matched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { readArticle } from "../src/article.js"
import type { Claim, NumericVerdict } from "../src/domain/types.js"
import { defaultModel } from "../src/llm/cassettes.js"
import { CheckerRunner, loadCassette } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"

type Expected = { id: string; article: string; metric: string; kind: string; fiscalYear: number; fiscalPeriod: string; statedNumber: string; expected: "MATCH" | "MISMATCH" | "ABSTAIN" | "SKIP"; truth: string }

const { values: args } = parseArgs({ options: { mode: { type: "string", default: "replay" }, model: { type: "string" }, rpm: { type: "string" }, out: { type: "string", default: "eval/results" } } })
if (existsSync(".env")) process.loadEnvFile(".env")
const mode = args.mode as "record" | "replay"
if (mode !== "record" && mode !== "replay") throw new Error("--mode must be record or replay")
const model = args.model ?? defaultModel()
const spec = JSON.parse(readFileSync("eval/expected.json", "utf8")) as { articles: Record<string, string>; claims: Expected[] }
const ABSTAIN_VERDICTS: NumericVerdict[] = ["NOT_VERIFIABLE", "NOT_COMPUTABLE", "REFERENCE_NOT_YET_FILED"]

type Row = { id: string; expected: string; outcome: string; correct: boolean; claimId?: string; verdict?: string; review?: string; truth: string }
const rows: Row[] = []
const spurious: { article: string; claimId: string; quote: string; verdict: string }[] = []
const runs: Record<string, unknown> = {}
let runFailures = 0

for (const [art, path] of Object.entries(spec.articles)) {
	const tasks = new TaskTracker()
	const recPath = join("eval/recordings", `${art}.json`)
	let runner: CheckerRunner
	if (mode === "record") {
		mkdirSync("eval/recordings", { recursive: true })
		runner = new CheckerRunner({ mode: "record", tasks, model, writeTo: recPath, limits: { rpm: args.rpm ? Number(args.rpm) : undefined, requestTimeoutMs: 60_000 } })
	} else {
		const c = loadCassette(recPath)
		if (!c) throw new Error(`no recording at ${recPath}; run with --mode record first`)
		runner = new CheckerRunner({ mode: "replay", tasks, cassettes: [c], replaySpeed: 50 })
	}
	console.log(`[${art}] ${mode} ${mode === "record" ? model : recPath} …`)
	const result = await runChecker({ article: { ...readArticle(path), ticker: "NVDA" }, snapshot: loadSnapshot("NVDA"), runner, tasks, model, timeoutMs: 12 * 60_000 })
	if (mode === "record") runner.save()
	const s = result.state
	if (result.timedOut || s.extraction === "failed") runFailures++
	const calls: Record<string, number> = {}
	for (const c of runner.calls) calls[c.provenance] = (calls[c.provenance] ?? 0) + 1
	runs[art] = { status: result.timedOut ? "timed_out" : s.extraction === "failed" ? `extraction failed: ${s.extractionError}` : "done", calls, usage: mode === "record" ? runner.usage.summary() : undefined }

	const claims = [...s.claims.values()]
	const used = new Set<string>()
	const same = (c: Claim, e: Expected) => {
		const i = c.interpretation
		const metricOk = e.metric === "other" ? i.metric === "other" || i.accounting === "non_gaap" : i.metric === e.metric
		// Unsupported claims (expected ABSTAIN) are matched by metric and number only: their kind/period is not checkable anyway.
		if (e.expected === "ABSTAIN") return metricOk && Number(i.statedNumber) === Number(e.statedNumber)
		return metricOk && i.kind === e.kind && i.fiscalYear === e.fiscalYear && i.fiscalPeriod === e.fiscalPeriod && Number(i.statedNumber) === Number(e.statedNumber)
	}
	for (const e of spec.claims.filter((x) => x.article === art)) {
		const hit = claims.find((c) => !used.has(c.id) && same(c, e))
		if (hit) used.add(hit.id)
		const verdict = hit ? s.calcs.get(hit.id)?.verdict : undefined
		const audit = hit ? s.audits.get(hit.id)?.state.status : undefined
		const reviewed = hit ? s.isSettled(hit.id) && audit === "approved" && !s.contextFailures.has(hit.id) : false
		let outcome: string
		let correct: boolean
		if (e.expected === "SKIP") {
			outcome = hit ? "extracted (should have been skipped)" : "skipped"
			correct = !hit
		} else if (e.expected === "ABSTAIN") {
			outcome = !hit ? "not extracted" : `extracted → ${verdict}`
			correct = !hit || (verdict !== undefined && ABSTAIN_VERDICTS.includes(verdict))
		} else if (!hit) {
			outcome = "missed (not extracted with this metric/period/number)"
			correct = false
		} else {
			outcome = verdict && ABSTAIN_VERDICTS.includes(verdict) ? `abstained (${verdict})` : `${verdict}`
			correct = verdict === e.expected
		}
		rows.push({ id: e.id, expected: e.expected, outcome, correct, claimId: hit?.id, verdict, review: hit ? (reviewed ? "reviewed" : `not fully reviewed (${audit})`) : undefined, truth: e.truth })
	}
	for (const c of claims.filter((c) => !used.has(c.id))) spurious.push({ article: art, claimId: c.id, quote: c.interpretation.quote, verdict: s.calcs.get(c.id)?.verdict ?? "PENDING" })
}

const det = rows.filter((r) => r.expected === "MATCH" || r.expected === "MISMATCH")
const detExtracted = det.filter((r) => r.claimId)
const detCorrect = det.filter((r) => r.correct)
const abstained = detExtracted.filter((r) => r.outcome.startsWith("abstained"))
const unsupported = rows.filter((r) => r.expected === "ABSTAIN")
const skips = rows.filter((r) => r.expected === "SKIP")
const notReviewed = detExtracted.filter((r) => r.review !== "reviewed")
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a")

const summary = {
	source: mode === "record" ? `live ${model} (recorded to eval/recordings/)` : "replay of eval/recordings/ (genuine model responses recorded earlier)",
	extractionCoverage: `${detExtracted.length}/${det.length} (${pct(detExtracted.length, det.length)})`,
	verdictCorrectWhenExtracted: `${detExtracted.filter((r) => r.correct).length}/${detExtracted.length} (${pct(detExtracted.filter((r) => r.correct).length, detExtracted.length)})`,
	endToEndCorrect: `${detCorrect.length}/${det.length} (${pct(detCorrect.length, det.length)})`,
	abstentionsOnCheckableClaims: `${abstained.length}/${detExtracted.length}`,
	unsupportedClaimsHandledCorrectly: `${unsupported.filter((r) => r.correct).length}/${unsupported.length}`,
	forecastsCorrectlySkipped: `${skips.filter((r) => r.correct).length}/${skips.length}`,
	extractedButNotFullyReviewed: `${notReviewed.length}/${detExtracted.length}`,
	spuriousExtractions: spurious.length,
	runFailures: `${runFailures}/${Object.keys(spec.articles).length}`,
}

const md = [
	"# Independent evaluation",
	"",
	"Separate from the prepared demo: two synthetic articles with claims the checker has not seen, ground truth checked by hand (`eval/expected.json`).",
	"",
	`Source: ${summary.source}`,
	"",
	"| Measure | Result |",
	"|---|---|",
	`| Extraction coverage (checkable claims extracted with the right metric, period and number) | ${summary.extractionCoverage} |`,
	`| Verdict correct, among extracted checkable claims | ${summary.verdictCorrectWhenExtracted} |`,
	`| End-to-end correct (all checkable claims) | ${summary.endToEndCorrect} |`,
	`| Abstentions on checkable claims | ${summary.abstentionsOnCheckableClaims} |`,
	`| Unsupported claims handled correctly (abstained or not extracted) | ${summary.unsupportedClaimsHandledCorrectly} |`,
	`| Forecasts correctly not extracted | ${summary.forecastsCorrectlySkipped} |`,
	`| Extracted checkable claims not fully reviewed | ${summary.extractedButNotFullyReviewed} |`,
	`| Spurious extractions (no expected claim) | ${summary.spuriousExtractions} |`,
	`| Runs failed or timed out | ${summary.runFailures} |`,
	"",
	"## Per claim",
	"",
	"| Id | Expected | Outcome | Correct | Review | Ground truth |",
	"|---|---|---|---|---|---|",
	...rows.map((r) => `| ${r.id} | ${r.expected} | ${r.outcome}${r.claimId ? ` (${r.claimId})` : ""} | ${r.correct ? "yes" : "**no**"} | ${r.review ?? "–"} | ${r.truth} |`),
	"",
	spurious.length ? "## Spurious extractions\n\n" + spurious.map((x) => `- ${x.article}/${x.claimId} (${x.verdict}): “${x.quote}”`).join("\n") : "No spurious extractions.",
	"",
	"## Runs",
	"",
	"```json",
	JSON.stringify(runs, null, 2),
	"```",
	"",
].join("\n")

writeFileSync(`${args.out}.md`, md)
writeFileSync(`${args.out}.json`, JSON.stringify({ summary, rows, spurious, runs }, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`→ ${args.out}.md`)
