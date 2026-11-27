/**
 * Thin web adapter around runChecker(). No business logic: it starts runs on explicit request,
 * turns engine events into RunView snapshots (viewmodel.ts), streams them over Server-Sent Events,
 * and serves the existing Markdown/JSON reports.
 *
 *   GET  /api/meta                      product, example article (canonical), sample articles, modes
 *   POST /api/resolve                   { title, text, company?, mode } → company resolution + reference preview
 *   GET  /api/companies?q=              search SEC filers by ticker or name
 *   POST /api/runs                      { source: "example" } | { source: "custom", mode, title, text, company?: { cik | query | name }, report?: { url } | { file, statedSourceUrl } }
 *   POST /api/runs/:id/resume            retry provider-interrupted work in the same live run
 *   GET  /api/runs/:id                  latest RunView
 *   GET  /api/runs/:id/events           SSE: "state" (RunView) … "end"
 *   GET  /api/runs/:id/report.md|json   existing report renderers
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, normalize, resolve } from "node:path"
import { readArticle } from "../article.js"
import { currentCompanyIndex, loadCompanyIndex, searchCompanies, type CompanyIndex } from "../company/companies.js"
import type { CheckerState } from "../domain/store.js"
import { defaultCassettePaths, defaultModel, loadCassettes, parseReplaySource, providerConfigured } from "../llm/cassettes.js"
import { DEFAULT_LIMITS, Pacer } from "../llm/limits.js"
import { CheckerRunner, DEFAULT_REPLAY_SPEED, type Cassette } from "../llm/runner.js"
import { DISCLAIMER, renderMarkdown, toJson, type ReportMeta } from "../report/render.js"
import { runChecker, type PreparedReport, type RunResult } from "../runtime/pipeline.js"
import { prepareReference, ReferenceError, secSnapshotFor } from "../runtime/reference.js"
import { TaskTracker } from "../runtime/tasks.js"
import { loadSnapshot } from "../sec/edgar.js"
import { EvidenceRegistry, periodLabel, type FiscalPeriod } from "../sec/evidence.js"
import type { SecSnapshot } from "../sec/types.js"
import type { InferenceRunner } from "@mozaik-ai/core"
import type { MetaView, RunStatus, RunView } from "./types.js"
import { ActivityLog, provenanceOf, runView } from "./viewmodel.js"
import { LaneTracer, type Trace } from "../runtime/trace.js"

export const EXAMPLE_ARTICLE = "data/articles/nvda-q2-fy2027.md"
/** The optional NVIDIA example only. Custom articles resolve their own company; there is no fallback. */
const EXAMPLE_TICKER = "NVDA"
const MAX_TEXT = 50_000
const MAX_BODY = 36 * 1024 * 1024 // a 25 MB PDF upload, base64-encoded
export const SAMPLES_PATH = "data/samples.json"

type Sample = { id: string; label: string; title: string; articlePath: string; company?: string; report?: { url: string }; note: string }
const loadSamples = (): Sample[] => (existsSync(SAMPLES_PATH) ? (JSON.parse(readFileSync(SAMPLES_PATH, "utf8")).samples as Sample[]) : [])

/** A short, human summary of an SEC reference (shown before a run starts). */
export function secSummary(snapshot: SecSnapshot, source: "committed" | "live") {
	const reg = new EvidenceRegistry(snapshot)
	const latest = reg.latestReportedPeriod()
	const forms = [...new Set(reg.calendar.map((c) => c.form.replace("/A", "")))]
	const metrics = [...new Set(reg.all().map((f) => f.concept))]
	return {
		kind: "sec" as const,
		entityName: snapshot.entityName,
		ticker: snapshot.ticker,
		cik: snapshot.cik,
		source,
		fetchedAt: snapshot.source.fetchedAt,
		forms,
		reportingCurrency: reg.info.reportingCurrency,
		latest: latest ? `${periodLabel(latest.fy, latest.fp as FiscalPeriod)} (${latest.form}, period ended ${latest.periodEnd}, filed ${latest.filed})` : undefined,
		facts: reg.all().length,
		concepts: metrics.length,
	}
}

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
	activeSince?: number
	elapsedMs: number
	status: RunStatus
	error?: string
	articlePath: string
	tasks: TaskTracker
	runner: CheckerRunner
	cassettes: { path: string; data: Cassette }[]
	model: string
	activity: ActivityLog
	tracer: LaneTracer
	state?: CheckerState
	names?: Map<string, string>
	result?: RunResult
	clients: Set<ServerResponse>
	/** claim id while a reviewer recheck (live model calls) is in progress */
	challenging?: string
	recovering?: boolean
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
	/** Concurrency caps. Replay runs are cheap and run side by side; live runs spend provider credit. */
	maxReplayRuns?: number
	maxLiveRuns?: number
	/** Replay speed for recordings (recorded latency ÷ speed). Tests use a high value. */
	replaySpeed?: number
	/** Company list to resolve against (tests pass the committed copy); default: SEC's live list. */
	companyIndex?: CompanyIndex
	/** false = never call SEC for the company list (it still fetches company data when needed). */
	liveSec?: boolean
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : undefined)

/**
 * Fairness policy for a public deployment: no global lock. Each visitor's example run is independent,
 * so one visitor cannot block another; replay runs are capped (default 8 at once, each bounded by a
 * 2-minute timeout); live runs (only possible with a server-side key) are capped at 1 at a time with a
 * 5-minute timeout plus the per-run call/turn caps in src/llm/limits.ts.
 */
export function createApp(opts: AppOptions = {}) {
	const env = opts.env ?? process.env
	const configuredRpm = env.CHECKER_WEB_RPM?.trim()
	const rpm = configuredRpm ? Number(configuredRpm) : undefined
	if (rpm !== undefined && (!Number.isSafeInteger(rpm) || rpm < 1)) throw new Error("CHECKER_WEB_RPM must be a positive whole number of requests per minute.")
	const livePacer = new Pacer(DEFAULT_LIMITS.maxConcurrent, rpm)
	const runs = new Map<string, RunRecord>()
	const maxReplay = opts.maxReplayRuns ?? 8
	const maxLive = opts.maxLiveRuns ?? 1
	const draining = (rec: RunRecord) => rec.mode === "live" && rec.status === "timed_out" && rec.result?.recoveryPending === true
	const active = (mode: "replay" | "live") => [...runs.values()].filter((r) => (
		(mode === "live" && draining(r)) || (r.status === "running" && (mode === "live" ? r.mode === "live" || !!r.challenging : r.mode === mode && !r.challenging))
	)).length
	let counter = 0
	const mozaikVersion = JSON.parse(readFileSync("node_modules/@mozaik-ai/core/package.json", "utf8")).version as string
	const staticDir = resolve(opts.staticDir ?? "dist/web")

	/** SEC's full list of filers (live, refreshed daily; the committed copy if SEC is unreachable). */
	let index = opts.companyIndex ?? loadCompanyIndex()
	const companies = async () => (index = opts.companyIndex ?? (await currentCompanyIndex({ allowLive: opts.liveSec !== false })))

	function meta(): MetaView {
		const snap = loadSnapshot(EXAMPLE_TICKER)
		const example = readArticle(EXAMPLE_ARTICLE)
		const sources = loadCassettes(opts.cassettePaths ?? defaultCassettePaths("all"))
		const fixtures = sources.filter((s) => s.data.provenance === "fixture")
		const recorded = sources.filter((s) => s.data.provenance === "recorded" && (opts.cassettePaths || exampleRecording(s.path)))
		const rec0 = recorded[0]?.data
		const replayOptions: MetaView["replayOptions"] = [
			{
				id: "recorded",
				label: rec0 ? `Genuine recorded run (${rec0.model ?? "model"})` : "Genuine recorded run (none on this server)",
				short: `Recorded ${rec0?.model ?? "model"} responses`,
				available: recorded.length > 0,
				detail: rec0 ? `Genuine responses replayed with the original prompt version. Recorded ${rec0.createdAt.slice(0, 16).replace("T", " ")} UTC with --mode record; replayed at recorded latency ÷ ${DEFAULT_REPLAY_SPEED}.` : "No recording available.",
			},
			{ id: "fixtures", label: "Hand-written fixtures (scripted demo)", short: "Fixture model responses", available: fixtures.length > 0, detail: "Hand-written responses that include two deliberate agent mistakes, to show the auditor's correction paths." },
		]
		const defaultReplay = replayOptions.find((o) => o.available)?.id ?? "fixtures"
		const modelLabel = replayOptions.find((o) => o.id === defaultReplay)!.short
		const configured = providerConfigured(env)
		return {
			product: {
				name: "Finance Claim Checker",
				tagline: "Paste a finance article about any company: concurrent AI agents find its revenue, profit and EPS figures and check each one against the company's official financial statements, with a receipt for every result.",
				disclaimer: DISCLAIMER,
			},
			company: { ticker: snap.ticker, name: snap.entityName, cik: snap.cik },
			companies: [{ ticker: snap.ticker, name: snap.entityName }],
			companyIndex: index ? { count: index.companies.length, fetchedAt: index.fetchedAt, source: index.source } : undefined,
			samples: loadSamples().map((s) => {
				const a = existsSync(s.articlePath) ? readArticle(s.articlePath) : { title: s.title, text: "" }
				return { id: s.id, label: s.label, title: a.title, text: a.text, company: s.company, reportUrl: s.report?.url, note: s.note }
			}),
			snapshotFetchedAt: snap.source.fetchedAt,
			example: { ...example, path: EXAMPLE_ARTICLE, label: `Synthetic example · ${modelLabel} · Real calculations` },
			replaySources: sources.map((s) => ({ path: s.path.replace(/\\/g, "/"), provenance: s.data.provenance, description: s.data.description })),
			replayOptions,
			defaultReplay,
			live: configured
				? { configured, model: defaultModel(env), hint: "Live checks call the configured model provider from the server." }
				: { configured, hint: "Live checking needs a model provider key on the server: set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY in .env and restart `npm run web`. Keys are never sent to the browser." },
			mozaikVersion,
		}
	}

	const traceOf = (rec: RunRecord): Trace => rec.tracer.trace(provenanceOf(rec.runner.calls).counts)
	const elapsed = (rec: RunRecord) => rec.elapsedMs + (rec.activeSince === undefined ? 0 : Date.now() - rec.activeSince)

	function recoveryWork(rec: RunRecord): RunView["recovery"] {
		if (rec.mode !== "live" || rec.status === "running" || !rec.result || !providerConfigured(env)) return
		if (rec.runner.usage.requests >= rec.runner.limits.maxCalls) return
		const work = rec.result.recoveryWork()
		if (work.extraction || work.reader || work.claimIds.length) {
			return { pendingClaims: work.claimIds.length, extractionIncomplete: work.extraction, referenceIncomplete: work.reader }
		}
	}

	function view(rec: RunRecord): RunView | undefined {
		if (!rec.state) return undefined
		const current = runView({ id: rec.id, source: rec.source, mode: rec.mode, startedAt: rec.startedAt, status: rec.status, state: rec.state, tasks: rec.tasks, calls: rec.runner.calls, activity: rec.activity, error: rec.error, trace: traceOf(rec) })
		return { ...current, elapsedMs: elapsed(rec), recovery: recoveryWork(rec), recovering: rec.recovering, recoveryPending: draining(rec) || undefined }
	}

	function recordOutcome(rec: RunRecord, timedOut: boolean, timeoutMessage: string) {
		const error = rec.state?.extractionError
		rec.status = timedOut ? "timed_out" : rec.state?.extraction === "failed" ? (error?.startsWith("CACHE_MISS") ? "cache_miss" : error?.startsWith("REFERENCE_UNAVAILABLE") ? "reference_unavailable" : "failed") : "done"
		rec.error = timedOut ? timeoutMessage : rec.status === "done" ? undefined : error
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
		if (!rec.flushTimer) rec.flushTimer = setTimeout(() => broadcast(rec, rec.status !== "running" && !draining(rec)), 120)
	}

	function finishOperation(rec: RunRecord) {
		rec.elapsedMs = elapsed(rec)
		rec.activeSince = undefined
		broadcast(rec, !draining(rec))
	}

	/** Recordings of the included example (file names start with the example article's name). */
	const exampleRecording = (p: string, articlePath = EXAMPLE_ARTICLE) => p.replace(/\\/g, "/").split("/").pop()!.startsWith(articlePath.split("/").pop()!.replace(/\.\w+$/, "") + ".")

	let preparing = 0
	async function startRun(body: any): Promise<RunRecord> {
		const source = body?.source === "custom" ? "custom" : body?.source === "example" ? "example" : undefined
		if (!source) throw new HttpError(400, 'source must be "example" or "custom"')

		let article: { title: string; text: string; ticker: string }
		let mode: "replay" | "live"
		let snapshot: SecSnapshot | undefined
		let report: PreparedReport | undefined
		const featured = source === "example" && body.sample === "wipro"
		const examplePath = featured ? "data/articles/wipro-fy2025-inr.md" : EXAMPLE_ARTICLE
		let cassettePaths: string[]
		if (source === "example") {
			article = { ...readArticle(examplePath), ticker: featured ? "WIT" : EXAMPLE_TICKER } // canonical parse, exactly as the CLI does
			mode = "replay"
			const replaySource = featured ? "recorded" : parseReplaySource(body?.replay ?? meta().defaultReplay)
			cassettePaths = opts.cassettePaths ?? defaultCassettePaths(replaySource).filter((p) => replaySource === "fixtures" || (replaySource === "all" && p.endsWith(".fixtures.json")) || exampleRecording(p, examplePath))
			if (mode === "replay" && active("replay") >= maxReplay) throw new HttpError(429, "The server is busy with other checks. Try again in a few seconds.", { code: "BUSY" })
			snapshot = loadSnapshot(article.ticker)
		} else {
			const title = typeof body.title === "string" ? body.title.trim() : ""
			const text = typeof body.text === "string" ? body.text : ""
			if (!text.trim()) throw new HttpError(400, "Paste the article text to check.")
			if (text.length > MAX_TEXT || title.length > 300) throw new HttpError(400, `Article is too long (limit ${MAX_TEXT} characters).`)
			mode = body.mode === "live" ? "live" : "replay"
			if (mode === "live" && !providerConfigured(env)) throw new HttpError(400, meta().live.hint, { code: "LIVE_NOT_CONFIGURED" })
			if (mode === "live" && active("live") >= maxLive) throw new HttpError(429, "Another live check, recovery, or recheck is running. Try again shortly.", { code: "LIVE_BUSY" })
			if (mode === "replay" && active("replay") >= maxReplay) throw new HttpError(429, "The server is busy with other checks. Try again in a few seconds.", { code: "BUSY" })
			const company = body.company && typeof body.company === "object" ? { cik: str(body.company.cik), query: str(body.company.query), name: str(body.company.name) } : undefined
			const r = body.report && typeof body.report === "object" ? body.report : undefined
			const reportReq = r && (str(r.url) || r.file) ? { url: str(r.url), file: r.file && typeof r.file.base64 === "string" ? { name: String(r.file.name ?? "report.pdf").slice(0, 200), base64: r.file.base64 } : undefined, statedSourceUrl: str(r.statedSourceUrl) } : undefined
			if (reportReq && preparing >= 2) throw new HttpError(429, "Two reports are being read already; try again in a few seconds.", { code: "BUSY" })
			preparing++
			try {
				const ref = await prepareReference({ article: { title, text }, company, report: reportReq, preferCommitted: mode === "replay" }, await companies())
				if (ref.kind === "sec") snapshot = ref.snapshot
				else report = ref.report
				article = { title: title || "Untitled article", text, ticker: ref.kind === "sec" ? ref.snapshot.ticker : (ref.report.company.ticker ?? "") }
			} catch (e) {
				if (e instanceof ReferenceError) throw new HttpError(e.status, e.message, { code: e.code, ...e.extra })
				throw e
			} finally {
				preparing--
			}
			cassettePaths = opts.cassettePaths ?? defaultCassettePaths("all")
		}

		// Preparing a custom reference awaits I/O. Recheck the live slot before starting work.
		if (mode === "live" && active("live") >= maxLive) throw new HttpError(429, "Another live check, recovery, or recheck is running. Try again shortly.", { code: "LIVE_BUSY" })
		const tasks = new TaskTracker()
		const cassettes = mode === "replay" ? loadCassettes(cassettePaths) : []
		if (mode === "replay" && !cassettes.length) throw new HttpError(400, "No replay data is available on this server.", { code: "NO_REPLAY_DATA" })
		const runner = new CheckerRunner({
			mode, tasks, cassettes: cassettes.map((c) => c.data),
			inner: mode === "live" ? opts.liveInner?.(tasks) : undefined,
			model: mode === "live" ? defaultModel(env) : undefined,
			pacer: livePacer,
			replaySpeed: opts.replaySpeed ?? (featured ? 100 : DEFAULT_REPLAY_SPEED),
		})
		const startedAt = new Date()
		const rec: RunRecord = {
			id: `run-${++counter}-${Date.now().toString(36)}`,
			source,
			mode,
			startedAt,
			activeSince: startedAt.getTime(),
			elapsedMs: 0,
			status: "running",
			articlePath: source === "example" ? examplePath : "(article submitted in the web app)",
			tasks,
			runner,
			cassettes,
			model: mode === "live" ? defaultModel(env) : "replay",
			activity: new ActivityLog(),
			tracer: new LaneTracer(tasks),
			clients: new Set(),
		}
		runs.set(rec.id, rec)
		// keep memory bounded: forget the oldest finished runs
		const finished = [...runs.values()].filter((r) => r.status !== "running" && !draining(r))
		for (const r of finished.slice(0, Math.max(0, finished.length - 30))) runs.delete(r.id)

		runChecker({
			article,
			snapshot,
			report,
			runner,
			tasks,
			model: rec.model,
			timeoutMs: opts.timeoutMs ?? (mode === "live" ? 5 * 60_000 : 2 * 60_000),
			onEvent: (e, names, state) => {
				rec.state = state
				rec.names = names
				rec.activity.record(e, names, state)
				rec.tracer.onEvent(e)
				schedule(rec)
			},
		})
			.then((result) => {
				rec.result = result
				rec.state = result.state
				recordOutcome(rec, result.timedOut, "The run timed out before every claim settled.")
			})
			.catch((err) => {
				rec.status = "failed"
				rec.error = err instanceof Error ? err.message : String(err)
			})
			.finally(() => finishOperation(rec))
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
			usage: rec.mode === "live" ? rec.runner.usage.summary() : undefined,
			trace: traceOf(rec),
		}
	}

	function json(res: ServerResponse, status: number, data: unknown) {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
		res.end(JSON.stringify(data))
	}

	async function readBody(req: IncomingMessage, limit = MAX_TEXT * 4): Promise<any> {
		let size = 0
		const chunks: Buffer[] = []
		for await (const chunk of req) {
			size += chunk.length
			if (size > limit) throw new HttpError(413, "Request too large.")
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
			if (p === "/api/meta" && req.method === "GET") {
				return json(res, 200, meta())
			}
			if (p === "/api/runs" && req.method === "POST") {
				const rec = await startRun(await readBody(req, MAX_BODY))
				return json(res, 202, { id: rec.id })
			}
			if (p === "/api/companies" && req.method === "GET") {
				const q = (url.searchParams.get("q") ?? "").slice(0, 100)
				return json(res, 200, { candidates: searchCompanies(await companies(), q) })
			}
			if (p === "/api/resolve" && req.method === "POST") {
				// identify the company (no run, no model call) and preview the reference it would be checked against
				const body = await readBody(req)
				const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : ""
				const title = typeof body.title === "string" ? body.title.slice(0, 300) : ""
				const ix = await companies()
				const cik = str(body.company?.cik)
				const { companyByCik, resolveCompany } = await import("../company/companies.js")
				const chosen = cik ? companyByCik(ix, cik) : undefined
				const resolution = chosen ? { status: "resolved" as const, company: { ...chosen, score: 100, why: ["selected"] }, candidates: [], method: "name" as const, reason: `Selected ${chosen.name}` } : resolveCompany(ix, { query: str(body.company?.query), text, title })
				let reference: unknown
				if (resolution.status === "resolved") {
					try {
						const { snapshot, source } = await secSnapshotFor(resolution.company, body.mode !== "live")
						reference = secSummary(snapshot, source)
					} catch (e) {
						reference = e instanceof ReferenceError ? { kind: "unavailable", code: e.code, reason: e.message, needsReport: !!e.extra.needsReport } : { kind: "unavailable", code: "ERROR", reason: (e as Error).message }
					}
				}
				return json(res, 200, { resolution, reference, companyIndex: { count: ix.companies.length, fetchedAt: ix.fetchedAt } })
			}
			const resume = /^\/api\/runs\/([\w-]+)\/resume$/.exec(p)
			if (resume && req.method === "POST") {
				const rec = runs.get(resume[1])
				if (!rec) throw new HttpError(404, "Unknown run.")
				await readBody(req, 4096)
				if (rec.status === "running" || draining(rec)) throw new HttpError(409, "This run still has work in progress.", { code: "RUN_BUSY" })
				const result = rec.result
				if (!result || !recoveryWork(rec)) throw new HttpError(409, "This run has no recoverable provider-interrupted work.", { code: "NO_RECOVERY_WORK" })
				if (active("live") >= maxLive) throw new HttpError(429, "Another live check, recovery, or recheck is running. Try again shortly.", { code: "LIVE_BUSY" })
				const previousStatus = rec.status
				rec.status = "running"
				rec.recovering = true
				rec.activeSince = Date.now()
				rec.error = undefined
				result.recover({ timeoutMs: opts.timeoutMs ?? 5 * 60_000, model: rec.model })
					.then(({ timedOut }) => recordOutcome(rec, timedOut, "Recovery timed out before every claim settled."))
					.catch((err) => {
						rec.status = previousStatus
						rec.error = err instanceof Error ? err.message : String(err)
					})
					.finally(() => {
						rec.recovering = undefined
						finishOperation(rec)
					})
				return json(res, 202, { id: rec.id })
			}
			const ch = /^\/api\/runs\/([\w-]+)\/claims\/(c\d+)\/challenge$/.exec(p)
			if (ch && req.method === "POST") {
				const rec = runs.get(ch[1])
				if (!rec) throw new HttpError(404, "Unknown run.")
				const body = await readBody(req)
				const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
				if (reason.length < 5 || reason.length > 600) throw new HttpError(400, "Describe what looks wrong about the interpretation (5–600 characters).")
				if (!providerConfigured(env)) throw new HttpError(400, `Rechecking a claim asks the extractor and auditor again, which needs a live model. ${meta().live.hint}`, { code: "LIVE_NOT_CONFIGURED" })
				if (rec.status === "running" || !rec.result || rec.result.recoveryPending) throw new HttpError(409, "Wait for the run to finish before rechecking a claim.")
				if (!rec.result.state.claims.has(ch[2])) throw new HttpError(404, "Unknown claim.")
				if (!rec.result.state.isSettled(ch[2])) throw new HttpError(409, "This claim's review has not settled, so it cannot be rechecked.")
				if (active("live") >= maxLive) throw new HttpError(429, "Another live check or recheck is running; try again shortly.", { code: "LIVE_BUSY" })
				const result = rec.result
				rec.runner.enableLiveFallback(defaultModel(env))
				rec.status = "running"
				rec.activeSince = Date.now()
				rec.error = undefined
				rec.challenging = ch[2]
				result
					.challenge(ch[2], reason, opts.timeoutMs ?? 5 * 60_000, defaultModel(env))
					.then(({ timedOut }) => {
						rec.status = timedOut ? "timed_out" : "done"
						if (timedOut) rec.error = "The recheck timed out."
					})
					.catch((err) => {
						rec.status = "done"
						rec.error = `Recheck not started: ${err instanceof Error ? err.message : String(err)}`
					})
					.finally(() => {
						rec.challenging = undefined
						finishOperation(rec)
					})
				return json(res, 202, { id: rec.id, claimId: ch[2] })
			}
			const m = /^\/api\/runs\/([\w-]+)(\/events|\/report\.md|\/report\.json|\/trace\.json)?$/.exec(p)
			if (m && req.method === "GET") {
				const rec = runs.get(m[1])
				if (!rec) throw new HttpError(404, "Unknown run.")
				if (!m[2]) return json(res, 200, view(rec) ?? { id: rec.id, status: rec.status })
				if (m[2] === "/events") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
					const v = view(rec)
					if (v) send(res, "state", v)
					if (rec.status !== "running" && !draining(rec)) {
						send(res, "end", { status: rec.status })
						return res.end()
					}
					rec.clients.add(res)
					req.on("close", () => rec.clients.delete(res))
					return
				}
				if (m[2] === "/trace.json") {
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="claim-check-${rec.id}-trace.json"` })
					return res.end(JSON.stringify(traceOf(rec), null, 2))
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
