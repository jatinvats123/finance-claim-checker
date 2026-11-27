/**
 * Finance Claim Checker CLI.
 *
 *   npm start                                  keyless replay of the bundled NVIDIA demo
 *   npm run check -- --article a.md --mode live                     any company: detected from the article (or --company "Apple")
 *   npm run check -- --article a.md --company "TCS" --report https://…/results.pdf --mode live   a company without SEC data
 *   npm run check -- --article a.md --ticker NVDA --mode live      real model calls (needs a provider key)
 *   npm run check -- ... --mode record         live + save responses to data/replay/recordings/
 *   npm run check -- ... --mode author --script fixtures/nvda-demo.script.ts   seal hand-written fixtures
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { readArticle } from "./article.js"
import { currentCompanyIndex } from "./company/companies.js"
import { prepareReference, ReferenceError } from "./runtime/reference.js"
import type { PreparedReport } from "./runtime/pipeline.js"
import type { SecSnapshot } from "./sec/types.js"
import { defaultCassettePaths, defaultModel, loadCassettes, parseReplaySource, providerConfigured } from "./llm/cassettes.js"
import type { LiveLimits, UsageSummary } from "./llm/limits.js"
import { CheckerRunner, type AuthorScript, type LlmMode } from "./llm/runner.js"
import { liveLine, renderMarkdown, renderTerminalSummary, toJson, DISCLAIMER, type ReportMeta } from "./report/render.js"
import { runChecker } from "./runtime/pipeline.js"
import { TaskTracker } from "./runtime/tasks.js"
import { LaneTracer } from "./runtime/trace.js"
import { getSnapshot, SecDataMissing } from "./sec/edgar.js"

const { values: args } = parseArgs({
	options: {
		article: { type: "string", default: "data/articles/nvda-q2-fy2027.md" },
		ticker: { type: "string" },
		company: { type: "string" },
		"company-name": { type: "string" },
		report: { type: "string" },
		"report-file": { type: "string" },
		mode: { type: "string", default: "replay" },
		model: { type: "string" },
		cassette: { type: "string", multiple: true },
		script: { type: "string" },
		out: { type: "string", default: "out" },
		"live-sec": { type: "boolean", default: false },
		// replay: which sources to use (fixtures = hand-written only, recorded = genuine recordings only, all = recordings then fixtures)
		"replay-source": { type: "string", default: "fixtures" },
		"replay-speed": { type: "string" },
		quiet: { type: "boolean", default: false },
		timeout: { type: "string" },
		// live/record safety limits (see src/llm/limits.ts)
		"max-calls": { type: "string" },
		"max-turns": { type: "string" },
		"budget-usd": { type: "string" },
		price: { type: "string" },
		"max-concurrent": { type: "string" },
		"request-timeout": { type: "string" },
		rpm: { type: "string" },
		retries: { type: "string" },
	},
})

function limitsFromArgs(): Partial<LiveLimits> {
	const num = (name: string, v?: string) => {
		if (v === undefined) return undefined
		const n = Number(v)
		if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`)
		return n
	}
	const price = args.price?.split(",").map(Number)
	if (price && (price.length !== 2 || price.some((p) => !Number.isFinite(p) || p < 0))) throw new Error("--price must be <input>,<output> in USD per 1M tokens, e.g. --price 0.3,2.5")
	const out: Partial<LiveLimits> = {
		maxCalls: num("max-calls", args["max-calls"]),
		maxTurnsPerTask: num("max-turns", args["max-turns"]),
		budgetUsd: num("budget-usd", args["budget-usd"]),
		maxConcurrent: num("max-concurrent", args["max-concurrent"]),
		rpm: num("rpm", args.rpm),
		retries: num("retries", args.retries),
		requestTimeoutMs: args["request-timeout"] === undefined ? undefined : num("request-timeout", args["request-timeout"])! * 1000,
		price: price ? { input: price[0], output: price[1] } : undefined,
	}
	return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

function usageLine(u: UsageSummary): string {
	const tokens = `${u.inputTokens.toLocaleString("en-US")} input + ${(u.outputTokens + u.reasoningTokens).toLocaleString("en-US")} output tokens${u.reasoningTokens ? ` (incl. ${u.reasoningTokens.toLocaleString("en-US")} thinking)` : ""}`
	const cost = u.costUsd !== undefined ? `$${u.costUsd.toFixed(4)} at $${u.price!.input}/$${u.price!.output} per 1M` : "cost unknown (no price for this model; pass --price to compute)"
	const retries = (u.retryNotes?.length ? `\nRetried after: ${u.retryNotes.join(" | ")}` : "") + (u.stalled?.length ? `\nAbandoned by watchdog: ${u.stalled.join(" | ")}` : "")
	return `Model usage (${u.model}): ${u.requests} requests${u.retries ? `, ${u.retries} retries` : ""} · ${tokens} · ${cost}${u.limitHit ? `\nSTOPPED BY LIMIT: ${u.limitHit}` : ""}${retries}`
}

process.on("unhandledRejection", (err) => {
	console.error("[warn] unhandled rejection (run continues):", err instanceof Error ? err.message : err)
})

async function main() {
	if (existsSync(".env")) process.loadEnvFile(".env")
	const mode = args.mode as LlmMode
	if (!["live", "record", "replay", "author"].includes(mode)) throw new Error(`--mode must be live, record, replay or author`)
	const model = args.model ?? defaultModel()
	if ((mode === "live" || mode === "record") && !providerConfigured()) {
		throw new Error("live/record mode needs ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY (see README). Use --mode replay for the keyless demo.")
	}

	const parsed = readArticle(args.article!)
	let snapshot: SecSnapshot | undefined
	let report: PreparedReport | undefined
	let ticker = ""
	const exampleArticle = args.article === "data/articles/nvda-q2-fy2027.md"
	if (args.ticker || (exampleArticle && !args.company && !args.report && !args["report-file"])) {
		// explicit ticker (or the bundled NVIDIA example): committed snapshot, or --live-sec
		ticker = (args.ticker ?? "NVDA").toUpperCase()
		snapshot = await getSnapshot(ticker, args["live-sec"]!)
	} else {
		const reportReq = args.report ? { url: args.report } : args["report-file"] ? { file: { name: basename(args["report-file"]), base64: readFileSync(args["report-file"]).toString("base64") } } : undefined
		try {
			const ref = await prepareReference(
				{ article: parsed, company: { query: args.company, name: args["company-name"] ?? args.company }, report: reportReq, preferCommitted: !args["live-sec"] },
				await currentCompanyIndex(),
			)
			if (ref.kind === "sec") {
				snapshot = ref.snapshot
				ticker = ref.snapshot.ticker
				console.log(`Company: ${ref.company.name} (${ref.company.tickers.join(", ")}, CIK ${ref.company.cik})${ref.resolution ? ` · ${ref.resolution.status === "resolved" ? ref.resolution.reason : ""}` : ""} · SEC data: ${ref.snapshotSource}`)
			} else {
				report = ref.report
				ticker = ref.report.company.ticker ?? ""
				console.log(`Company: ${ref.report.company.name} · supplied report PDF: ${ref.report.doc.url ?? ref.report.doc.fileName} (${ref.report.doc.pageCount} pages)`)
			}
		} catch (e) {
			if (e instanceof ReferenceError) {
				console.error(`${e.code}: ${e.message}`)
				for (const c of e.extra.candidates ?? []) console.error(`  - ${c.name} (${c.tickers.join(", ")}, CIK ${c.cik}): ${c.why.join("; ")}`)
				if (e.code === "COMPANY_AMBIGUOUS") console.error('Pass --company "<ticker or name>" to choose.')
				if (e.extra.needsReport) console.error("Pass --report <PDF URL> (or --report-file <path>) with --company-name to check against the company's official report.")
				process.exit(2)
			}
			throw e
		}
	}
	const article = { ...parsed, ticker }
	const tasks = new TaskTracker()

	const cassettes = mode === "replay" ? loadCassettes(args.cassette?.length ? args.cassette : defaultCassettePaths(parseReplaySource(args["replay-source"]))) : []

	let script: AuthorScript | undefined
	let writeTo: string | undefined
	if (mode === "author") {
		if (!args.script) throw new Error("--mode author needs --script <file.ts>")
		script = (await import(pathToFileURL(resolve(args.script)).href)).default as AuthorScript
		writeTo = join("data/replay", basename(args.script).replace(/\.script\.ts$/, "") + ".fixtures.json")
	}
	if (mode === "record") writeTo = join("data/replay/recordings", `${basename(args.article!).replace(/\.\w+$/, "")}.${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`)

	const live = mode === "live" || mode === "record"
	const runner = new CheckerRunner({ mode, tasks, cassettes: cassettes.map((c) => c.data), script, writeTo, model, limits: limitsFromArgs(), replaySpeed: args["replay-speed"] ? Number(args["replay-speed"]) : undefined })
	if (live) {
		const l = runner.limits
		console.log(`Safety limits: ≤${l.maxCalls} requests, ≤${l.maxTurnsPerTask} turns per task (extractor ≤${l.maxExtractorTurns}), ≤${l.maxConcurrent} in flight${l.rpm ? `, ≤${l.rpm}/min` : ""}, ${l.retries} retries${l.budgetUsd !== undefined ? `, budget $${l.budgetUsd}` : ", no USD budget set"}`)
	}
	const mozaikVersion = JSON.parse(readFileSync("node_modules/@mozaik-ai/core/package.json", "utf8")).version

	console.log(`Finance Claim Checker · ${snapshot ? `${snapshot.entityName} (${snapshot.ticker})` : report!.company.name} · mode ${mode}${mode === "replay" ? ` (${cassettes.map((c) => `${c.data.provenance}: ${c.path}`).join("; ") || "no cassettes"})` : ` · model ${model}`}`)
	console.log(snapshot ? `Reference: SEC statements (10-Q/10-K/20-F/40-F), data fetched ${snapshot.source.fetchedAt}` : `Reference: supplied report PDF ${report!.doc.url ?? report!.doc.fileName}, fetched ${report!.doc.fetchedAt} (sha256 ${report!.doc.sha256.slice(0, 12)}…)`)
	console.log(DISCLAIMER + "\n")

	const t0 = Date.now()
	const tracer = new LaneTracer(tasks)
	const result = await runChecker({
		article,
		snapshot,
		report,
		runner,
		tasks,
		model,
		// live runs wait on real model latency (and pacing), so they get a longer default
		timeoutMs: Number(args.timeout ?? (live ? 1800 : 600)) * 1000,
		onEvent: (e, names, state) => {
			tracer.onEvent(e)
			if (args.quiet) return
			const line = liveLine(e, names, state, t0, (id) => tasks.forContext(id)?.key)
			if (line) console.log(line)
		},
	})
	runner.save()

	const meta: ReportMeta = {
		mode,
		model,
		articlePath: args.article!,
		mozaikVersion,
		calls: runner.calls,
		cassettes: cassettes.map((c) => ({ path: c.path, provenance: c.data.provenance, description: c.data.description })),
		usage: live ? runner.usage.summary() : undefined,
		trace: tracer.trace(Object.fromEntries(["live", "recorded", "fixture"].map((k) => [k, runner.calls.filter((c) => c.provenance === k).length]))),
	}
	mkdirSync(args.out!, { recursive: true })
	writeFileSync(join(args.out!, "report.md"), renderMarkdown(result, meta))
	writeFileSync(join(args.out!, "report.json"), JSON.stringify(toJson(result, meta), null, 2))
	writeFileSync(join(args.out!, "trace.json"), JSON.stringify(meta.trace, null, 2))
	console.log(`Concurrency: peak ${meta.trace!.peakActive} agent loops at once (${meta.trace!.lanes.length} loops; ${meta.trace!.timing} timing) · trace: ${join(args.out!, "trace.json")}`)
	console.log(renderTerminalSummary(result, meta))
	console.log(`\nReceipts: ${join(args.out!, "report.md")} · ${join(args.out!, "report.json")}${writeTo ? ` · ${mode === "author" ? "sealed fixtures" : "recording"}: ${writeTo}` : ""}`)
	if (live) console.log("\n" + usageLine(runner.usage.summary()))
	const misses = runner.calls.filter((c) => c.provenance === "cache-miss")
	if (misses.length) console.log(`\n${misses.length} CACHE MISS(ES): no recorded/fixture response for this input. Nothing was substituted. Run with --mode live (provider key) to check new input.`)
	process.exitCode = result.timedOut || result.state.extraction === "failed" ? 2 : 0
}

main().catch((err) => {
	if (err instanceof SecDataMissing) console.error(`SEC CACHE MISS: ${err.message}`)
	else console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
