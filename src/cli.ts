/**
 * Finance Claim Checker CLI.
 *
 *   npm start                                  keyless replay of the bundled NVIDIA demo
 *   npm run check -- --article a.md --ticker NVDA --mode live      real model calls (needs a provider key)
 *   npm run check -- ... --mode record         live + save responses to data/replay/recordings/
 *   npm run check -- ... --mode author --script fixtures/nvda-demo.script.ts   seal hand-written fixtures
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { readArticle } from "./article.js"
import { CheckerRunner, loadCassette, type AuthorScript, type Cassette, type LlmMode } from "./llm/runner.js"
import { liveLine, renderMarkdown, renderTerminalSummary, toJson, DISCLAIMER, type ReportMeta } from "./report/render.js"
import { runChecker } from "./runtime/pipeline.js"
import { TaskTracker } from "./runtime/tasks.js"
import { getSnapshot, SecDataMissing } from "./sec/edgar.js"

const { values: args } = parseArgs({
	options: {
		article: { type: "string", default: "data/articles/nvda-q2-fy2027.md" },
		ticker: { type: "string", default: "NVDA" },
		mode: { type: "string", default: "replay" },
		model: { type: "string" },
		cassette: { type: "string", multiple: true },
		script: { type: "string" },
		out: { type: "string", default: "out" },
		"live-sec": { type: "boolean", default: false },
		quiet: { type: "boolean", default: false },
		timeout: { type: "string", default: "600" },
	},
})

process.on("unhandledRejection", (err) => {
	console.error("[warn] unhandled rejection (run continues):", err instanceof Error ? err.message : err)
})

function defaultModel(): string {
	if (process.env.CHECKER_MODEL) return process.env.CHECKER_MODEL
	if (process.env.ANTHROPIC_API_KEY) return "claude-sonnet-5-5"
	if (process.env.OPENAI_API_KEY) return "gpt-5.5"
	if (process.env.GEMINI_API_KEY) return "gemini-3.5-flash"
	return "claude-sonnet-5-5"
}

function defaultCassettes(): string[] {
	const dirs = [
		["data/replay/recordings", (f: string) => f.endsWith(".json")],
		["data/replay", (f: string) => f.endsWith(".fixtures.json")],
	] as const
	return dirs.flatMap(([d, ok]) => (existsSync(d) ? readdirSync(d).filter(ok).map((f) => join(d, f)) : []))
}

async function main() {
	if (existsSync(".env")) process.loadEnvFile(".env")
	const mode = args.mode as LlmMode
	if (!["live", "record", "replay", "author"].includes(mode)) throw new Error(`--mode must be live, record, replay or author`)
	const model = args.model ?? defaultModel()
	if ((mode === "live" || mode === "record") && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
		throw new Error("live/record mode needs ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY (see README). Use --mode replay for the keyless demo.")
	}

	const article = { ...readArticle(args.article!), ticker: args.ticker!.toUpperCase() }
	const snapshot = await getSnapshot(article.ticker, args["live-sec"]!)
	const tasks = new TaskTracker()

	const cassettePaths = mode === "replay" ? (args.cassette?.length ? args.cassette : defaultCassettes()) : []
	const cassettes: { path: string; data: Cassette }[] = cassettePaths.flatMap((p) => {
		const data = loadCassette(p)
		return data ? [{ path: p, data }] : []
	})
	// Recorded responses take priority over hand-written fixtures.
	cassettes.sort((a, b) => Number(b.data.provenance === "recorded") - Number(a.data.provenance === "recorded"))

	let script: AuthorScript | undefined
	let writeTo: string | undefined
	if (mode === "author") {
		if (!args.script) throw new Error("--mode author needs --script <file.ts>")
		script = (await import(pathToFileURL(resolve(args.script)).href)).default as AuthorScript
		writeTo = join("data/replay", basename(args.script).replace(/\.script\.ts$/, "") + ".fixtures.json")
	}
	if (mode === "record") writeTo = join("data/replay/recordings", `${basename(args.article!).replace(/\.\w+$/, "")}.${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`)

	const runner = new CheckerRunner({ mode, tasks, cassettes: cassettes.map((c) => c.data), script, writeTo })
	const mozaikVersion = JSON.parse(readFileSync("node_modules/@mozaik-ai/core/package.json", "utf8")).version

	console.log(`Finance Claim Checker · ${snapshot.entityName} (${snapshot.ticker}) · mode ${mode}${mode === "replay" ? ` (${cassettes.map((c) => `${c.data.provenance}: ${c.path}`).join("; ") || "no cassettes"})` : ` · model ${model}`}`)
	console.log(`SEC reference data: ${args["live-sec"] ? "fetched live" : `snapshot fetched ${snapshot.source.fetchedAt}`} · 10-Q/10-K only`)
	console.log(DISCLAIMER + "\n")

	const t0 = Date.now()
	const result = await runChecker({
		article,
		snapshot,
		runner,
		tasks,
		model,
		timeoutMs: Number(args.timeout) * 1000,
		onEvent: (e, names, state) => {
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
	}
	mkdirSync(args.out!, { recursive: true })
	writeFileSync(join(args.out!, "report.md"), renderMarkdown(result, meta))
	writeFileSync(join(args.out!, "report.json"), JSON.stringify(toJson(result, meta), null, 2))
	console.log(renderTerminalSummary(result, meta))
	console.log(`\nReceipts: ${join(args.out!, "report.md")} · ${join(args.out!, "report.json")}${writeTo ? ` · ${mode === "author" ? "sealed fixtures" : "recording"}: ${writeTo}` : ""}`)
	const misses = runner.calls.filter((c) => c.provenance === "cache-miss")
	if (misses.length) console.log(`\n${misses.length} CACHE MISS(ES): no recorded/fixture response for this input. Nothing was substituted. Run with --mode live (provider key) to check new input.`)
	process.exitCode = result.timedOut || result.state.extraction === "failed" ? 2 : 0
}

main().catch((err) => {
	if (err instanceof SecDataMissing) console.error(`SEC CACHE MISS: ${err.message}`)
	else console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
