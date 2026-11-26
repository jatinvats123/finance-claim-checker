/**
 * Thin web adapter around runChecker(). No business logic: it starts runs on explicit request,
 * turns engine events into RunView snapshots (viewmodel.ts), streams them over Server-Sent Events,
 * and serves the existing Markdown/JSON reports.
 *
 *   GET  /api/meta                      product, company, snapshot date, example article (canonical), modes
 *   POST /api/runs                      { source: "example" } | { source: "custom", mode: "live"|"replay", title, text }
 *   GET  /api/runs/:id                  latest RunView
 *   GET  /api/runs/:id/events           SSE: "state" (RunView) … "end"
 *   GET  /api/runs/:id/report.md|json   existing report renderers
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, normalize, resolve } from "node:path"
import { readArticle } from "../article.js"
import type { CheckerState } from "../domain/store.js"
import { defaultCassettePaths, defaultModel, loadCassettes, providerConfigured } from "../llm/cassettes.js"
import { CheckerRunner, type Cassette } from "../llm/runner.js"
import { DISCLAIMER, renderMarkdown, toJson, type ReportMeta } from "../report/render.js"
import { runChecker, type RunResult } from "../runtime/pipeline.js"
import { TaskTracker } from "../runtime/tasks.js"
import { loadSnapshot, SNAPSHOT_DIR } from "../sec/edgar.js"
import type { InferenceRunner } from "@mozaik-ai/core"
import type { MetaView, RunStatus, RunView } from "./types.js"
import { ActivityLog, runView } from "./viewmodel.js"

export const EXAMPLE_ARTICLE = "data/articles/nvda-q2-fy2027.md"
const EXAMPLE_TICKER = "NVDA"
const MAX_TEXT = 50_000

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message)
	}
}

type RunRecord = {
	id: string
	source: "example" | "custom"
	mode: "replay" | "live"
	startedAt: Date
	status: RunStatus
	error?: string
	articlePath: string
	tasks: TaskTracker
	runner: CheckerRunner
	cassettes: { path: string; data: Cassette }[]
	model: string
	activity: ActivityLog
	state?: CheckerState
	names?: Map<string, string>
	result?: RunResult
	clients: Set<ServerResponse>
	flushTimer?: NodeJS.Timeout
}

export type AppOptions = {
	/** Replay sources; defaults to data/replay recordings + fixtures. */
	cassettePaths?: string[]
	env?: NodeJS.ProcessEnv
	/** Test hook: replace the provider runner used in live mode (receives the run's task tracker). */
	liveInner?: (tasks: TaskTracker) => InferenceRunner
	staticDir?: string
	timeoutMs?: number
}

export function createApp(opts: AppOptions = {}) {
	const env = opts.env ?? process.env
	const runs = new Map<string, RunRecord>()
	let activeId: string | undefined
	let counter = 0
	const mozaikVersion = JSON.parse(readFileSync("node_modules/@mozaik-ai/core/package.json", "utf8")).version as string
	const staticDir = resolve(opts.staticDir ?? "dist/web")

	const companies = () =>
		existsSync(SNAPSHOT_DIR)
			? readdirSync(SNAPSHOT_DIR)
					.filter((f) => f.endsWith(".json"))
					.map((f) => {
						const s = loadSnapshot(f.replace(/\.json$/, ""))
						return { ticker: s.ticker, name: s.entityName }
					})
			: []

	function meta(): MetaView {
		const snap = loadSnapshot(EXAMPLE_TICKER)
		const example = readArticle(EXAMPLE_ARTICLE)
		const sources = loadCassettes(opts.cassettePaths ?? defaultCassettePaths())
		const kinds = [...new Set(sources.map((s) => s.data.provenance))]
		const modelLabel = kinds.length === 0 ? "No replay data" : kinds.length > 1 ? "Mixed replay responses" : kinds[0] === "fixture" ? "Fixture model responses" : "Recorded model responses"
		const configured = providerConfigured(env)
		return {
			product: {
				name: "Finance Claim Checker",
				tagline: "Concurrent AI agents check every number in a finance article against the company's SEC 10-Q/10-K financial statements, with a receipt for each result.",
				disclaimer: DISCLAIMER,
			},
			company: { ticker: snap.ticker, name: snap.entityName, cik: snap.cik },
			companies: companies(),
			snapshotFetchedAt: snap.source.fetchedAt,
			example: { ...example, path: EXAMPLE_ARTICLE, label: `Synthetic example · ${modelLabel} · Real calculations` },
			replaySources: sources.map((s) => ({ path: s.path.replace(/\\/g, "/"), provenance: s.data.provenance, description: s.data.description })),
			live: configured
				? { configured, model: defaultModel(env), hint: "Live checks call the configured model provider from the server." }
				: { configured, hint: "Live checking needs a model provider key on the server: set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY in .env and restart `npm run web`. Keys are never sent to the browser." },
			mozaikVersion,
			activeRunId: activeId,
		}
	}

	function view(rec: RunRecord): RunView | undefined {
		if (!rec.state) return undefined
		return runView({ id: rec.id, source: rec.source, mode: rec.mode, startedAt: rec.startedAt, status: rec.status, state: rec.state, tasks: rec.tasks, calls: rec.runner.calls, activity: rec.activity, error: rec.error })
	}

	function send(res: ServerResponse, event: string, data: unknown) {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
	}

	function broadcast(rec: RunRecord, final = false) {
		if (rec.flushTimer) clearTimeout(rec.flushTimer)
		rec.flushTimer = undefined
		const v = view(rec)
		for (const c of rec.clients) {
			if (v) send(c, "state", v)
			if (final) {
				send(c, "end", { status: rec.status })
				c.end()
			}
		}
		if (final) rec.clients.clear()
	}

	function schedule(rec: RunRecord) {
		if (!rec.flushTimer) rec.flushTimer = setTimeout(() => broadcast(rec), 120)
	}

	function startRun(body: any): RunRecord {
		if (activeId && runs.get(activeId)?.status === "running") throw new HttpError(409, "A check is already running.", { runId: activeId })
		const source = body?.source === "custom" ? "custom" : body?.source === "example" ? "example" : undefined
		if (!source) throw new HttpError(400, 'source must be "example" or "custom"')

		let article: { title: string; text: string; ticker: string }
		let mode: "replay" | "live"
		if (source === "example") {
			article = { ...readArticle(EXAMPLE_ARTICLE), ticker: EXAMPLE_TICKER } // canonical parse, exactly as the CLI does
			mode = "replay"
		} else {
			const title = typeof body.title === "string" ? body.title.trim() : ""
			const text = typeof body.text === "string" ? body.text : ""
			if (!text.trim()) throw new HttpError(400, "Paste the article text to check.")
			if (text.length > MAX_TEXT || title.length > 300) throw new HttpError(400, `Article is too long (limit ${MAX_TEXT} characters).`)
			mode = body.mode === "live" ? "live" : "replay"
			if (mode === "live" && !providerConfigured(env)) throw new HttpError(400, meta().live.hint, { code: "LIVE_NOT_CONFIGURED" })
			article = { title: title || "Untitled article", text, ticker: EXAMPLE_TICKER }
		}

		const snapshot = loadSnapshot(article.ticker)
		const tasks = new TaskTracker()
		const cassettes = mode === "replay" ? loadCassettes(opts.cassettePaths ?? defaultCassettePaths()) : []
		const runner = new CheckerRunner({ mode, tasks, cassettes: cassettes.map((c) => c.data), inner: mode === "live" ? opts.liveInner?.(tasks) : undefined })
		const rec: RunRecord = {
			id: `run-${++counter}-${Date.now().toString(36)}`,
			source,
			mode,
			startedAt: new Date(),
			status: "running",
			articlePath: source === "example" ? EXAMPLE_ARTICLE : "(article submitted in the web app)",
			tasks,
			runner,
			cassettes,
			model: mode === "live" ? defaultModel(env) : "replay",
			activity: new ActivityLog(),
			clients: new Set(),
		}
		runs.set(rec.id, rec)
		activeId = rec.id
		// keep memory bounded
		for (const id of [...runs.keys()].slice(0, -6)) runs.delete(id)

		runChecker({
			article,
			snapshot,
			runner,
			tasks,
			model: rec.model,
			timeoutMs: opts.timeoutMs ?? 10 * 60_000,
			onEvent: (e, names, state) => {
				rec.state = state
				rec.names = names
				rec.activity.record(e, names, state)
				schedule(rec)
			},
		})
			.then((result) => {
				rec.result = result
				rec.state = result.state
				const err = result.state.extractionError
				rec.status = result.timedOut ? "timed_out" : result.state.extraction === "failed" ? (err?.startsWith("CACHE_MISS") ? "cache_miss" : "failed") : "done"
				if (rec.status !== "done") rec.error = result.timedOut ? "The run timed out before every claim settled." : err
			})
			.catch((err) => {
				rec.status = "failed"
				rec.error = err instanceof Error ? err.message : String(err)
			})
			.finally(() => broadcast(rec, true))
		return rec
	}

	function reportMeta(rec: RunRecord): ReportMeta {
		return {
			mode: rec.mode,
			model: rec.model,
			articlePath: rec.articlePath,
			mozaikVersion,
			calls: rec.runner.calls,
			cassettes: rec.cassettes.map((c) => ({ path: c.path, provenance: c.data.provenance, description: c.data.description })),
		}
	}

	function json(res: ServerResponse, status: number, data: unknown) {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
		res.end(JSON.stringify(data))
	}

	async function readBody(req: IncomingMessage): Promise<any> {
		let size = 0
		const chunks: Buffer[] = []
		for await (const chunk of req) {
			size += chunk.length
			if (size > MAX_TEXT * 4) throw new HttpError(413, "Request too large.")
			chunks.push(chunk)
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
		} catch {
			throw new HttpError(400, "Body must be JSON.")
		}
	}

	const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" }

	function serveStatic(pathname: string, res: ServerResponse) {
		if (!existsSync(join(staticDir, "index.html"))) {
			res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
			res.end("The web app has not been built. Run `npm run web` (it builds, then serves).")
			return
		}
		const target = normalize(join(staticDir, decodeURIComponent(pathname)))
		const file = target.startsWith(staticDir) && existsSync(target) && statSync(target).isFile() ? target : join(staticDir, "index.html")
		res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600" })
		res.end(readFileSync(file))
	}

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost")
		const p = url.pathname
		try {
			if (p === "/api/meta" && req.method === "GET") return json(res, 200, meta())
			if (p === "/api/runs" && req.method === "POST") {
				const rec = startRun(await readBody(req))
				return json(res, 202, { id: rec.id })
			}
			const m = /^\/api\/runs\/([\w-]+)(\/events|\/report\.md|\/report\.json)?$/.exec(p)
			if (m && req.method === "GET") {
				const rec = runs.get(m[1])
				if (!rec) throw new HttpError(404, "Unknown run.")
				if (!m[2]) return json(res, 200, view(rec) ?? { id: rec.id, status: rec.status })
				if (m[2] === "/events") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
					const v = view(rec)
					if (v) send(res, "state", v)
					if (rec.status !== "running") {
						send(res, "end", { status: rec.status })
						return res.end()
					}
					rec.clients.add(res)
					req.on("close", () => rec.clients.delete(res))
					return
				}
				if (rec.status === "running" || !rec.result) throw new HttpError(409, "The report is available when the run has finished.")
				const r = reportMeta(rec)
				const name = `claim-check-${rec.id}`
				if (m[2] === "/report.md") {
					res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.md"` })
					return res.end(renderMarkdown(rec.result, r))
				}
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.json"` })
				return res.end(JSON.stringify(toJson(rec.result, r), null, 2))
			}
			if (p.startsWith("/api/")) throw new HttpError(404, "Not found.")
			if (req.method !== "GET") throw new HttpError(405, "Method not allowed.")
			return serveStatic(p, res)
		} catch (err) {
			if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...err.extra })
			console.error(err)
			return json(res, 500, { error: err instanceof Error ? err.message : "Internal error" })
		}
	}

	const server: Server = createServer((req, res) => void handle(req, res))
	return { server, runs, meta }
}

// Entry point: `npm run web`
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
	if (existsSync(".env")) process.loadEnvFile(".env")
	process.on("unhandledRejection", (err) => console.error("[warn] unhandled rejection:", err instanceof Error ? err.message : err))
	const port = Number(process.env.PORT ?? 4317)
	const host = process.env.HOST ?? "127.0.0.1"
	const { server } = createApp()
	server.listen(port, host, () => {
		console.log(`Finance Claim Checker web app → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
		console.log(providerConfigured() ? `Live checking enabled (model ${defaultModel()}).` : "Live checking disabled (no provider key). The included example runs without one.")
	})
}
