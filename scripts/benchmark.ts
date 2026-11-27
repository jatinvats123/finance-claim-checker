import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { readArticle } from "../src/article.js"
import { defaultCassettePaths, defaultModel, loadCassettes, providerConfigured } from "../src/llm/cassettes.js"
import { CheckerRunner } from "../src/llm/runner.js"
import { EV } from "../src/runtime/context.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { LaneTracer } from "../src/runtime/trace.js"
import { loadSnapshot } from "../src/sec/edgar.js"

if (existsSync(".env")) process.loadEnvFile(".env")
const { values } = parseArgs({ options: { live: { type: "boolean" }, pairs: { type: "string", default: "3" } } })
const pairs = Number(values.pairs)
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) throw new Error("--pairs must be 1 to 10")
if (values.live && !providerConfigured()) throw new Error("Live benchmarks require a configured provider.")
const mode = values.live ? "live" : "replay"
const article = { ...readArticle("data/articles/wipro-fy2025-inr.md"), ticker: "WIT" }
const snapshot = loadSnapshot("WIT")
const recordings = loadCassettes(defaultCassettePaths("recorded")).map(c => c.data)
const spec = JSON.parse(readFileSync("eval/multi-company.json", "utf8")) as { claims: { article: string; metric: string; kind: string; fiscalPeriod: string; fiscalYear: number; statedNumber: string; expected: string }[] }
const expected = spec.claims.filter(c => c.article === "wipro")
const folder = `out/benchmark-${mode}`
mkdirSync(folder, { recursive: true })
const rows = []
for (let pair = 1; pair <= pairs; pair++) {
	for (const serial of pair % 2 ? [true, false] : [false, true]) {
		const tasks = new TaskTracker()
		const tracer = new LaneTracer(tasks)
		const model = defaultModel()
		const runner = new CheckerRunner({ mode, tasks, model, cassettes: recordings, replaySpeed: 100 })
		let firstMismatchMs: number | undefined
		const start = Date.now()
		const result = await runChecker({
			article, snapshot, runner, tasks, model, serial, timeoutMs: 12 * 60_000,
			onEvent(event, _, state) {
				tracer.onEvent(event)
				if (event.type !== EV.CALCULATION_COMPLETED || firstMismatchMs !== undefined) return
				const id = (event.payload as { claimId: string }).claimId
				const calc = state.calcs.get(id)
				const claim = state.claims.get(id)?.interpretation
				if (claim?.metric === "operating_income" && claim.fiscalYear === 2025 && claim.fiscalPeriod === "FY" && calc?.verdict === "MISMATCH" &&
					calc.inputs.some(i => i.role === "current" && i.value === 151271000000 && i.currency === "INR" && i.accn === "0000950170-25-076303")) firstMismatchMs = Date.now() - start
			},
		})
		const s = result.state
		const claims = [...s.claims.values()]
		const correct = expected.filter(e => claims.some(({ id, interpretation: i }) =>
			i.metric === e.metric && i.kind === e.kind && i.fiscalPeriod === e.fiscalPeriod && i.fiscalYear === e.fiscalYear && Number(i.statedNumber) === Number(e.statedNumber) && s.calcs.get(id)?.verdict === e.expected)).length
		const reviewed = claims.filter(c => s.isSettled(c.id) && s.audits.get(c.id)?.state.status === "approved" && !s.contextFailures.has(c.id)).length
		const provenance: Record<string, number> = {}
		for (const c of runner.calls) provenance[c.provenance] = (provenance[c.provenance] ?? 0) + 1
		const trace = tracer.trace(provenance)
		const row = { pair, scheduler: serial ? "serial" : "concurrent", firstMismatchMs: firstMismatchMs ?? null, fullMs: result.elapsedMs, correct, expected: expected.length, reviewed, extracted: claims.length, peakLoops: trace.peakActive, calls: provenance, timedOut: result.timedOut }
		rows.push(row)
		writeFileSync(`${folder}/${pair}-${row.scheduler}.json`, JSON.stringify({ row, trace }, null, 2))
		console.log(JSON.stringify(row))
	}
}
writeFileSync(`${folder}/results.json`, JSON.stringify({ mode, replaySpeed: values.live ? undefined : 100, rows }, null, 2))
if (rows.some(row => row.timedOut || row.firstMismatchMs === null || row.correct !== row.expected || row.reviewed !== row.expected || row.extracted !== row.expected || Object.keys(row.calls).some(k => k !== (values.live ? "live" : "recorded")))) process.exitCode = 1
