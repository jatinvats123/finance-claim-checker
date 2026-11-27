import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { readArticle } from "../src/article.js"
import { defaultCassettePaths, defaultModel, loadCassettes, providerConfigured } from "../src/llm/cassettes.js"
import { CheckerRunner } from "../src/llm/runner.js"
import { EV } from "../src/runtime/context.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { LaneTracer } from "../src/runtime/trace.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { claimView, referenceView } from "../src/web/viewmodel.js"
import { correctionText } from "../web/src/correction.js"
import type { Claim, NumericVerdict } from "../src/domain/types.js"

if (existsSync(".env")) process.loadEnvFile(".env")
const { values } = parseArgs({ options: {
	live: { type: "boolean" },
	pairs: { type: "string", default: "3" },
	case: { type: "string", default: "wipro" },
	out: { type: "string" },
} })
const pairs = Number(values.pairs)
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error("--pairs must be 1 to 10")
if (values.live && !providerConfigured()) throw new Error("Live benchmarks require a configured provider.")
const mode = values.live ? "live" : "replay"
const scenario = values.case
if (scenario !== "wipro" && scenario !== "apple") throw new Error("--case must be wipro or apple")
if (scenario === "apple" && !values.live) throw new Error("The fresh Apple benchmark requires --live.")
const article = scenario === "wipro"
	? { ...readArticle("data/articles/wipro-fy2025-inr.md"), ticker: "WIT" }
	: {
		title: "Apple annual revenue check",
		text: "Apple reported net sales of $461.2 billion for the fiscal year ended September 27, 2025.\n\nApple reported net income of $112.0 billion for that fiscal year.",
		ticker: "AAPL",
	}
const snapshot = loadSnapshot(article.ticker)
const recordings = values.live ? [] : loadCassettes(defaultCassettePaths("recorded")).map(c => c.data)
const spec = JSON.parse(readFileSync("eval/multi-company.json", "utf8")) as { claims: { article: string; metric: string; kind: string; fiscalPeriod: string; fiscalYear: number; statedNumber: string; expected: string }[] }
const expected = scenario === "wipro" ? spec.claims.filter(c => c.article === "wipro") : [
	{ metric: "revenue", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "461.2", expected: "MISMATCH" },
	{ metric: "net_income", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "112.0", expected: "MATCH" },
]
const mismatch = scenario === "wipro"
	? { metric: "operating_income", value: 151271000000, currency: "INR", accession: "0000950170-25-076303", year: 2025 }
	: { metric: "revenue", value: 416161000000, currency: "USD", accession: "0000320193-25-000079", year: 2025 }
const folder = values.out ?? `out/benchmark-${mode}${scenario === "apple" ? "-apple" : ""}`
const counterfactualDeadlineMs = 60_000
const model = defaultModel()
const benchmarkLimits = { requestTimeoutMs: 30_000, retries: 1 }
const matchesExpected = ({ interpretation: i }: Claim, e: typeof expected[number]) =>
	i.metric === e.metric && i.kind === e.kind && i.fiscalPeriod === e.fiscalPeriod && i.fiscalYear === e.fiscalYear && Number(i.statedNumber) === Number(e.statedNumber)
mkdirSync(folder, { recursive: true })
const rows = []
const startedAt = new Date().toISOString()
for (let pair = 1; pair <= pairs; pair++) {
	for (const serial of pair % 2 ? [true, false] : [false, true]) {
		const tasks = new TaskTracker()
		const tracer = new LaneTracer(tasks)
		const runner = new CheckerRunner({ mode, tasks, model, cassettes: recordings, replaySpeed: 100, limits: values.live ? benchmarkLimits : undefined })
		let firstMismatchMs: number | undefined
		const readyAt = new Map<string, number>()
		const isTarget = (claim: Claim, calc: { verdict: NumericVerdict; inputs: { role: string; value: number; currency?: string; accn: string }[] }) =>
			claim.interpretation.metric === mismatch.metric && claim.interpretation.fiscalYear === mismatch.year &&
			claim.interpretation.fiscalPeriod === "FY" && calc.verdict === "MISMATCH" &&
			calc.inputs.some(i => i.role === "current" && i.value === mismatch.value && i.currency === mismatch.currency && i.accn === mismatch.accession)
		const start = Date.now()
		const result = await runChecker({
			article, snapshot, runner, tasks, model, serial, timeoutMs: 12 * 60_000,
			onEvent(event, _, state) {
				tracer.onEvent(event)
				if (event.type !== EV.CALCULATION_COMPLETED && event.type !== EV.AUDIT_FINAL && event.type !== EV.CONTEXT_DONE) return
				const id = (event.payload as { claimId: string }).claimId
				const calc = state.calcs.get(id)
				const claim = state.claims.get(id)
				if (!claim || calc?.verdict !== "MISMATCH") return
				const elapsed = Date.now() - start
				if (event.type === EV.CALCULATION_COMPLETED && firstMismatchMs === undefined && isTarget(claim, calc)) firstMismatchMs = elapsed
				if (state.isSettled(id) && correctionText({ reference: referenceView(state) }, claimView(state, claim, false))) {
					const key = `${id}/${claim.revision}/${calc.evidenceRevision}`
					if (!readyAt.has(key)) readyAt.set(key, elapsed)
				}
			},
		})
		const s = result.state
		const claims = [...s.claims.values()]
		const correct = expected.filter(e => claims.some(claim => matchesExpected(claim, e) && s.calcs.get(claim.id)?.verdict === e.expected)).length
		const reviewed = claims.filter(c => s.isSettled(c.id) && s.audits.get(c.id)?.state.status === "approved" && !s.contextFailures.has(c.id)).length
		const claimResults = claims.map(claim => {
			const view = claimView(s, claim, true)
			const calc = s.calcs.get(claim.id)
			const correction = correctionText({ reference: referenceView(s) }, view)
			const copyReadyMs = correction ? readyAt.get(`${claim.id}/${claim.revision}/${calc?.evidenceRevision}`) ?? null : null
			const correctCorrection = !!correction && !!calc && isTarget(claim, calc) && expected.some(e => e.expected === "MISMATCH" && matchesExpected(claim, e))
			return { quote: view.quote, verdict: view.verdict, review: view.review, copyReadyMs, correctCorrection, correction, inputs: view.calc?.inputs, history: view.history }
		})
		const correctCorrections = claimResults.filter(claim => claim.correctCorrection && claim.copyReadyMs !== null)
		const firstCopyReadyMs = correctCorrections.length ? Math.min(...correctCorrections.map(claim => claim.copyReadyMs!)) : null
		const provenance: Record<string, number> = {}
		for (const c of runner.calls) provenance[c.provenance] = (provenance[c.provenance] ?? 0) + 1
		const trace = tracer.trace(provenance)
		const row = { pair, scheduler: serial ? "serial" : "concurrent", firstMismatchMs: firstMismatchMs ?? null, firstCopyReadyMs, correctCorrectionsByDeadline: correctCorrections.filter(claim => claim.copyReadyMs! <= counterfactualDeadlineMs).length, incorrectCorrections: claimResults.filter(claim => claim.correction && !claim.correctCorrection).length, fullMs: result.elapsedMs, correct, expected: expected.length, reviewed, extracted: claims.length, peakLoops: trace.peakActive, calls: provenance, timedOut: result.timedOut }
		rows.push(row)
		writeFileSync(`${folder}/${pair}-${row.scheduler}.json`, JSON.stringify({ row, claims: claimResults, trace }, null, 2))
		console.log(JSON.stringify(row))
	}
}
writeFileSync(`${folder}/results.json`, JSON.stringify({ mode, startedAt, model, scenario, article, expected, mismatch, inputHash: createHash("sha256").update(JSON.stringify({ article, snapshot })).digest("hex"), deadlineMs: counterfactualDeadlineMs, limits: values.live ? benchmarkLimits : undefined, replaySpeed: values.live ? undefined : 100, rows }, null, 2))
if (rows.some(row => row.timedOut || row.firstCopyReadyMs === null || row.incorrectCorrections || row.correct !== row.expected || row.reviewed !== row.expected || row.extracted !== row.expected || Object.keys(row.calls).some(k => k !== (values.live ? "live" : "recorded")))) process.exitCode = 1
