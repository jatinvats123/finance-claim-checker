import { correctionText } from "../web/src/correction.js"
/**
 * Web adapter: API, SSE stream, view model correctness against the engine's own report,
 * provenance/review/failure states. No API key needed.
 */
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ModelMessageItem, type InferenceInput, type InferenceRunner } from "@mozaik-ai/core"
import { readArticle } from "../src/article.js"
import { calculate } from "../src/domain/calculator.js"
import { CheckerState } from "../src/domain/store.js"
import { CheckerRunner, type AuthorScript } from "../src/llm/runner.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { loadCompanyIndex } from "../src/company/companies.js"

const companyIndex = loadCompanyIndex()
import { EvidenceRegistry } from "../src/sec/evidence.js"
import { createApp, EXAMPLE_ARTICLE } from "../src/web/server.js"
import type { MetaView, RunView } from "../src/web/types.js"
import { claimView, locateQuote, referenceView } from "../src/web/viewmodel.js"
import script from "../fixtures/nvda-demo.script.js"

type App = ReturnType<typeof createApp>

async function listen(app: App): Promise<string> {
	await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r))
	return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}

async function post(base: string, body: unknown) {
	const res = await fetch(`${base}/api/runs`, { method: "POST", body: JSON.stringify(body) })
	return { status: res.status, body: (await res.json()) as any }
}

/** Read the SSE stream to the end; return every RunView snapshot. */
async function stream(base: string, id: string): Promise<RunView[]> {
	const text = await (await fetch(`${base}/api/runs/${id}/events`)).text()
	return text
		.split("\n\n")
		.filter((b) => b.startsWith("event: state"))
		.map((b) => JSON.parse(b.split("\n")[1].slice("data: ".length)))
}

describe("web API with the included example (keyless)", () => {
	const app = createApp({ companyIndex, staticDir: "test/__no_build__" })
	let base = ""
	let final: RunView
	let snapshots: RunView[]
	let runId = ""
	let second: { status: number; body: any }
	let secondFinal: RunView

	beforeAll(async () => {
		base = await listen(app)
		const started = await post(base, { source: "example", replay: "fixtures" })
		expect(started.status).toBe(202)
		runId = started.body.id
		second = await post(base, { source: "example", replay: "fixtures" }) // another visitor, at the same time
		const [a, b] = await Promise.all([stream(base, runId), stream(base, second.body.id)])
		snapshots = a
		final = snapshots.at(-1)!
		secondFinal = b.at(-1)!
	}, 30_000)
	afterAll(() => app.server.close())

	it("serves meta with the canonical example article and honest labels", async () => {
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaView
		const canonical = readArticle(EXAMPLE_ARTICLE)
		expect(meta.example.title).toBe(canonical.title)
		expect(meta.example.text).toBe(canonical.text) // byte-identical: replay hashes depend on it
		const fixturesOpt = meta.replayOptions.find((o) => o.id === "fixtures")!
		expect(fixturesOpt).toMatchObject({ available: true, short: "Fixture model responses" })
		const def = meta.replayOptions.find((o) => o.id === meta.defaultReplay)!
		expect(def.available).toBe(true)
		expect(meta.example.label).toBe(`Synthetic example · ${def.short} · Real calculations`)
		// a recorded option is only offered when a genuine recording exists, and is labelled with its model
		const recOpt = meta.replayOptions.find((o) => o.id === "recorded")!
		if (recOpt.available) expect(recOpt.label).toMatch(/^Genuine recorded run \(/)
		expect(meta.company.ticker).toBe("NVDA")
		expect(meta.companies.map((c) => c.ticker)).toEqual(["NVDA"])
		expect(meta.live.configured).toBe(false)
		expect(meta.live.hint).toMatch(/ANTHROPIC_API_KEY/)
		expect(JSON.stringify(meta)).not.toMatch(/sk-|api_key=/i)
	})

	it("one visitor's run never blocks another's: both complete independently", () => {
		expect(second.status).toBe(202)
		expect(second.body.id).not.toBe(runId)
		expect(secondFinal.status).toBe("done")
		expect(secondFinal.claims.map((c) => c.verdict)).toEqual(final.claims.map((c) => c.verdict))
	})

	it("finished replays do not expose live recovery", async () => {
		expect(final.recovery).toBeUndefined()
		const resume = await fetch(`${base}/api/runs/${runId}/resume`, { method: "POST", body: "{}" })
		expect(resume.status).toBe(409)
		expect(await resume.json()).toMatchObject({ code: "NO_RECOVERY_WORK" })
	})

	it("streams progress, then every bundled claim with its engine status", () => {
		expect(snapshots.length).toBeGreaterThan(2)
		expect(snapshots[0].status).toBe("running")
		expect(final.status).toBe("done")
		expect(final.claims.map((c) => [c.id, c.verdict])).toEqual([
			["c1", "MATCH"],
			["c2", "MATCH"],
			["c3", "MISMATCH"],
			["c4", "MISMATCH"],
			["c5", "MATCH"],
			["c6", "MATCH"],
			["c7", "NOT_VERIFIABLE"],
			["c8", "MISMATCH"],
			["c9", "MISMATCH"],
			["c10", "REFERENCE_NOT_YET_FILED"],
		])
		expect(final.claims.find((c) => c.id === "c10")!.verdictLabel).toBe("No statement for this period in the reference")
		expect(final.summary).toMatchObject({ match: 4, mismatch: 4, notVerifiable: 1, referenceUnavailable: 1, reviewComplete: 10, reviewIncomplete: 0 })
		// claim cards never disappear or reorder between snapshots
		for (let i = 1; i < snapshots.length; i++) {
			const prev = snapshots[i - 1].claims.map((c) => c.id)
			const cur = snapshots[i].claims.map((c) => c.id)
			expect(cur.filter((id) => prev.includes(id))).toEqual(prev)
		}
	})

	it("labels provenance from the backend call records", () => {
		expect(final.provenance.kind).toBe("fixture")
		expect(final.provenance.label).toBe("Hand-written fixture responses")
		expect(final.provenance.simulatedTiming).toBe(true)
		expect(Object.keys(final.provenance.counts)).toEqual(["fixture"])
		expect(final.provenance.counts.fixture).toBeGreaterThan(50)
	})

	it("evidence values, dates, formulas and tolerance match the engine report exactly", async () => {
		const report = (await (await fetch(`${base}/api/runs/${runId}/report.json`)).json()) as any
		for (const c of final.claims) {
			const r = report.claims.find((x: any) => x.id === c.id)
			expect(c.revision).toBe(r.revision)
			expect(c.calc?.formula ?? "").toBe(r.numericalResult?.formula ?? "")
			expect(c.calc?.substituted ?? "").toBe(r.numericalResult?.substituted ?? "")
			expect(c.calc?.actualDisplay).toBe(r.numericalResult?.actualDisplay)
			expect(c.calc?.toleranceRule).toBe(r.numericalResult?.toleranceRule)
			expect(c.calc?.inputs ?? []).toEqual(r.numericalResult?.inputs ?? [])
			expect(c.warnings).toEqual(r.contextWarnings)
		}
	})

	it("highlights point at the exact quotation, including overlapping and repeated claims", () => {
		const text = final.article.text
		for (const c of final.claims) {
			expect(c.location.spans.length).toBe(1)
			const s = c.location.spans[0]
			expect(text.slice(s.start, s.end)).toBe(c.quote)
		}
		const span = (id: string) => final.claims.find((c) => c.id === id)!.location.spans[0]
		expect(span("c2").start).toBe(span("c3").start) // c2 is inside c3
		expect(span("c2").end).toBeLessThan(span("c3").end)
		expect(span("c4")).toEqual(span("c5")) // same sentence, two claims
	})

	it("exposes the genuine corrections from the run", () => {
		const c3 = final.claims.find((c) => c.id === "c3")!
		const c4 = final.claims.find((c) => c.id === "c4")!
		expect(c3.corrections).toHaveLength(1)
		expect(c3.corrections[0]).toMatchObject({ target: "evidence", by: "auditor (rule)", claimRevision: 1, evidenceRevision: 1 })
		expect(c4.corrections[0]).toMatchObject({ target: "claim", by: "auditor (LLM review)", claimRevision: 1 })
		expect(c4.revision).toBe(2)
		expect(c4.history.some((h) => h.kind === "claim.revised")).toBe(true)
		expect(final.staleRejections.length).toBe(2)
		expect(final.claims.filter((c) => c.corrections.length).map((c) => c.id)).toEqual(["c3", "c4"])
	})

	it("reports agent activity from real tasks and events", () => {
		const by = Object.fromEntries(final.agents.map((a) => [a.name, a]))
		expect(by.Calculator.kind).toBe("code")
		expect(by.Extractor.finished).toBe(2) // article + one correction
		expect(Object.values(by).every((a) => a.running === 0 && a.queued === 0 && a.failed === 0)).toBe(true)
		expect(final.timeline.some((t) => t.text.startsWith("Correction requested (auditor (rule))"))).toBe(true)
		expect(final.timeline.some((t) => t.tone === "stale")).toBe(true)
	})

	it("exports measured execution lanes with claim/revision ids and an honest timing label", async () => {
		const t = (await (await fetch(`${base}/api/runs/${runId}/trace.json`)).json()) as any
		expect(t.timing).toBe("replay-fixture")
		expect(t.timingNote).toMatch(/Not model latency/)
		expect(t.peakActive).toBeGreaterThanOrEqual(3)
		expect(t.lanes.every((l: any) => typeof l.endMs === "number" && l.endMs >= l.startMs)).toBe(true)
		expect(t.lanes.some((l: any) => l.task === "context:c4@r2" && l.claimRevision === 2)).toBe(true)
		// peak recomputed independently from the lanes
		const at = t.peakAtMs
		expect(t.lanes.filter((l: any) => l.startMs <= at && l.endMs > at).length).toBe(t.peakActive)
		expect(final.trace?.peakActive).toBe(t.peakActive)
	})

	it("serves the existing Markdown and JSON reports as downloads", async () => {
		const md = await fetch(`${base}/api/runs/${runId}/report.md`)
		expect(md.status).toBe(200)
		expect(md.headers.get("content-disposition")).toMatch(/attachment; filename="claim-check-.*\.md"/)
		const text = await md.text()
		expect(text).toContain("Not financial advice")
		expect(text).toContain("Hand-written model responses")
		const js = await fetch(`${base}/api/runs/${runId}/report.json`)
		expect(js.headers.get("content-disposition")).toMatch(/\.json"/)
	})

	it("explains a missing build and unknown runs", async () => {
		const page = await fetch(`${base}/`)
		expect(page.status).toBe(503)
		expect(await page.text()).toMatch(/npm run web/)
		expect((await fetch(`${base}/api/runs/nope`)).status).toBe(404)
	})
})

describe("genuine recording replay", () => {
	it("opens the featured Wipro example without a provider or SEC lookup and exports a sourced correction", async () => {
		const app = createApp({ env: {}, liveSec: false, replaySpeed: 1000 })
		const base = await listen(app)
		try {
			const { status, body } = await post(base, { source: "example", sample: "wipro" })
			expect(status).toBe(202)
			const final = (await stream(base, body.id)).at(-1)!
			expect(final.status).toBe("done")
			expect(final.reference.ticker).toBe("WIT")
			expect(final.provenance.counts).toEqual({ recorded: 64 })
			expect(final.claims).toHaveLength(8)
			expect(final.claims.every(c => c.review.status === "complete")).toBe(true)
			const mismatch = final.claims.find(c => c.interpretation.metric === "operating_income" && c.verdict === "MISMATCH")!
			const edit = correctionText(final, mismatch)!
			expect(edit).toContain("₹15,127.1 crore")
			expect(edit).toContain("0000950170-25-076303")
			expect(edit).toMatch(/https:\/\/www\.sec\.gov\/Archives/)
			expect(correctionText(final, { ...mismatch, review: { ...mismatch.review, status: "incomplete" } })).toBeUndefined()
		} finally {
			app.server.close()
		}
	}, 30_000)

	it("replays only the recorded model run, labelled as recorded, with no fixture fallback", async () => {
		const app = createApp({ companyIndex, replaySpeed: 1000 })
		const base = await listen(app)
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaView
		const rec = meta.replayOptions.find((o) => o.id === "recorded")!
		expect(rec.available).toBe(true)
		const { body } = await post(base, { source: "example", replay: "recorded" })
		const final = (await stream(base, body.id)).at(-1)!
		expect(final.status).toBe("done")
		expect(Object.keys(final.provenance.counts)).toEqual(["recorded"])
		expect(final.provenance.label).toBe("Recorded model responses")
		expect(final.trace?.timing).toBe("replay-recorded")
		expect(final.claims.length).toBeGreaterThan(0)
		const disputed = final.claims.filter(c => c.review.status !== "complete")
		expect(disputed.map(c => c.id)).toEqual(["c1"])
		expect(disputed[0].context.reason).toContain("Forecast warning conflicts")
		app.server.close()
	}, 30_000)
})

describe("custom articles", () => {
	it("an edited article in replay mode is an explicit cache miss", async () => {
		const app = createApp({ companyIndex })
		const base = await listen(app)
		const ex = readArticle(EXAMPLE_ARTICLE)
		const { body } = await post(base, { source: "custom", mode: "replay", title: ex.title, text: ex.text + " Shares rose 5%." })
		const final = (await stream(base, body.id)).at(-1)!
		expect(final.status).toBe("cache_miss")
		expect(final.error).toMatch(/^CACHE_MISS/)
		expect(final.claims).toEqual([])
		expect(final.provenance.counts).toEqual({ "cache-miss": 1 })
		app.server.close()
	}, 30_000)

	it("bounds public load: replay runs are capped, live runs run one at a time", async () => {
		const hang: InferenceRunner = { run: () => new Promise(() => undefined), stream: () => { throw new Error("unused") } }
		const app = createApp({ companyIndex, env: { ANTHROPIC_API_KEY: "test-placeholder" }, liveInner: () => hang, maxReplayRuns: 1, timeoutMs: 3_000 })
		const base = await listen(app)
		const live1 = await post(base, { source: "custom", mode: "live", title: "t", text: "Nvidia said revenue rose 5%." })
		const live2 = await post(base, { source: "custom", mode: "live", title: "t", text: "Nvidia said revenue rose 6%." })
		expect(live1.status).toBe(202)
		expect(live2.status).toBe(429)
		expect(live2.body.code).toBe("LIVE_BUSY")
		// a busy live slot does not block the included example
		const ex1 = await post(base, { source: "example" })
		expect(ex1.status).toBe(202)
		const ex2 = await post(base, { source: "example" })
		expect(ex2.status).toBe(429) // replay cap of 1 in this test
		expect(ex2.body.code).toBe("BUSY")
		await stream(base, ex1.body.id)
		expect((await post(base, { source: "example" })).status).toBe(202) // slot free again
		app.server.close()
	}, 30_000)

	it("live mode without a provider key explains the configuration", async () => {
		const app = createApp({ companyIndex, env: {} })
		const base = await listen(app)
		const r = await post(base, { source: "custom", mode: "live", title: "t", text: "Nvidia said revenue rose 5%." })
		expect(r.status).toBe(400)
		expect(r.body.code).toBe("LIVE_NOT_CONFIGURED")
		expect(r.body.error).toMatch(/ANTHROPIC_API_KEY.*\.env/)
		app.server.close()
	})

	it("recovers interrupted extraction over SSE in the same run and reserves the live slot", async () => {
		let releaseRecovery!: () => void
		const hold = new Promise<void>(resolve => { releaseRecovery = resolve })
		let requests = 0
		const app = createApp({
			companyIndex,
			env: { ANTHROPIC_API_KEY: "test-placeholder" },
			liveInner: () => ({
				run: async () => {
					if (++requests === 1) throw new Error("Provider test interruption")
					await hold
					return { items: [ModelMessageItem.rehydrate({ text: "No checkable claims." })], tokenUsage: undefined, rowResponse: null }
				},
				stream: () => { throw new Error("unused") },
			}),
		})
		const base = await listen(app)
		const body = { source: "custom", mode: "live", title: "NVIDIA outlook", text: "Nvidia expects revenue of $100 billion next year." }
		try {
			const started = await post(base, body)
			expect(started.status).toBe(202)
			const id = started.body.id as string
			const initial = (await stream(base, id)).at(-1)!
			expect(initial).toMatchObject({ id, status: "failed", recovery: { pendingClaims: 0, extractionIncomplete: true, referenceIncomplete: false } })
			const resume = () => fetch(`${base}/api/runs/${id}/resume`, { method: "POST", body: "{}" })
			const resumed = await resume()
			expect(resumed.status).toBe(202)
			expect(await resumed.json()).toEqual({ id })
			const running = await (await fetch(`${base}/api/runs/${id}`)).json()
			expect(running).toMatchObject({ id, status: "running", recovering: true })
			const duplicate = await resume()
			expect(duplicate.status).toBe(409)
			expect(await duplicate.json()).toMatchObject({ code: "RUN_BUSY" })
			expect((await post(base, body)).status).toBe(429)
			releaseRecovery()
			const finished = (await stream(base, id)).at(-1)!
			expect(finished).toMatchObject({ id, status: "done", extraction: { status: "done" }, provenance: { counts: { "provider-error": 1, live: 1 } } })
			expect(finished.recovering).toBeUndefined()
			expect(finished.recovery).toBeUndefined()
			expect(requests).toBe(2)
		} finally {
			releaseRecovery()
			app.server.close()
		}
	}, 15_000)

	it("keeps the timeout stream open until provider work has settled and recovery is safe", async () => {
		let releaseProvider!: () => void
		const hold = new Promise<void>(resolve => { releaseProvider = resolve })
		const app = createApp({
			companyIndex,
			timeoutMs: 300,
			env: { ANTHROPIC_API_KEY: "test-placeholder" },
			liveInner: () => ({
				run: async () => {
					await hold
					throw new Error("Provider test interruption")
				},
				stream: () => { throw new Error("unused") },
			}),
		})
		const base = await listen(app)
		try {
			const started = await post(base, { source: "custom", mode: "live", title: "NVIDIA outlook", text: "Nvidia expects its revenue to rise next year." })
			expect(started.status).toBe(202)
			const id = started.body.id as string
			const snapshots = stream(base, id)
			const getRun = async () => (await fetch(`${base}/api/runs/${id}`)).json()
			await expect.poll(getRun, { timeout: 3000 }).toMatchObject({ status: "timed_out", recoveryPending: true })
			const retry = await fetch(`${base}/api/runs/${id}/resume`, { method: "POST", body: "{}" })
			expect(retry.status).toBe(409)
			expect(await retry.json()).toMatchObject({ code: "RUN_BUSY" })
			releaseProvider()
			const drained = (await snapshots).at(-1)!
			expect(drained).toMatchObject({ status: "timed_out", recovery: { extractionIncomplete: true } })
			expect(drained.recoveryPending).toBeUndefined()
		} finally {
			releaseProvider()
			app.server.close()
		}
	}, 15_000)

	it("failed audits and context reviews are never shown as fully reviewed", async () => {
		const failing = new Set(["auditor:c1@r1.e1", "context:c2@r1"])
		const app = createApp({
			companyIndex,
			env: { ANTHROPIC_API_KEY: "test-placeholder" },
			liveInner: (tasks) => {
				const scripted = new CheckerRunner({ mode: "author", tasks, script: script as AuthorScript })
				return {
					run: async (input: InferenceInput) => {
						const t = tasks.forContext(input.context.id)
						if (t && failing.has(t.key)) throw new Error("503 Service Unavailable (simulated)")
						return scripted.run(input)
					},
					stream: () => {
						throw new Error("unused")
					},
				} satisfies InferenceRunner
			},
		})
		const base = await listen(app)
		const ex = readArticle(EXAMPLE_ARTICLE)
		const { body } = await post(base, { source: "custom", mode: "live", title: ex.title, text: ex.text })
		const final = (await stream(base, body.id)).at(-1)!
		const c1 = final.claims.find((c) => c.id === "c1")!
		const c2 = final.claims.find((c) => c.id === "c2")!
		expect(c1.verdict).toBe("MATCH")
		expect(c1.review.status).toBe("incomplete")
		expect(c1.audit.status).toBe("failed")
		expect(c2.verdict).toBe("MATCH")
		expect(c2.audit.status).toBe("approved")
		expect(c2.context.status).toBe("failed")
		expect(c2.review.status).toBe("incomplete")
		expect(final.summary.reviewComplete).toBe(8)
		expect(final.summary.reviewIncomplete).toBe(2)
		expect(final.provenance.kind).toBe("live") // scripted inner stands in for the provider here
		expect(final.provenance.counts["provider-error"]).toBe(2)
		app.server.close()
	}, 30_000)
})

describe("company-independent custom articles", () => {
	const resolve = async (base: string, body: unknown) => {
		const r = await fetch(`${base}/api/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
		return (await r.json()) as any
	}

	it("identifies the company and previews its reference before any run; asks when ambiguous", async () => {
		const app = createApp({ companyIndex })
		const base = await listen(app)
		const apple = await resolve(base, { title: "Apple's year", text: "Apple reported revenue of $478.8 billion for fiscal 2026.", mode: "replay" })
		expect(apple.resolution).toMatchObject({ status: "resolved", company: { name: "Apple Inc." } })
		expect(apple.reference).toMatchObject({ kind: "sec", ticker: "AAPL", source: "committed", reportingCurrency: "USD" })
		expect(apple.reference.latest).toMatch(/^FY-FY2026 \(10-K/)
		const wipro = await resolve(base, { title: "", text: "Wipro posted revenue of ₹89,088 crore.", mode: "replay" })
		expect(wipro.reference).toMatchObject({ kind: "sec", reportingCurrency: "INR", forms: ["20-F"] })
		const two = await resolve(base, { title: "Microsoft and Apple", text: "Microsoft said revenue grew. Apple said sales fell. Microsoft again.", mode: "replay" })
		expect(two.resolution.status).toBe("ambiguous")
		const picked = await resolve(base, { title: "", text: "anything at all about results", company: { cik: "320193" }, mode: "replay" })
		expect(picked.resolution).toMatchObject({ status: "resolved", company: { tickers: ["AAPL"] } })
		const search = (await (await fetch(`${base}/api/companies?q=walmart`)).json()) as any
		expect(search.candidates[0]).toMatchObject({ name: "Walmart Inc." })
		app.server.close()
	})

	it("never checks against another company's data: unknown and ambiguous companies stop with a reason", async () => {
		const app = createApp({ companyIndex })
		const base = await listen(app)
		const unknown = await post(base, { source: "custom", mode: "replay", title: "", text: "Zentrix Robotics, a private robot maker, said revenue doubled to $40 million." })
		expect(unknown.status).toBe(404)
		expect(unknown.body).toMatchObject({ code: "COMPANY_NOT_FOUND", needsReport: true })
		const ambiguous = await post(base, { source: "custom", mode: "replay", title: "Microsoft and Apple", text: "Microsoft said revenue grew. Apple said sales fell. Microsoft again." })
		expect(ambiguous.status).toBe(409)
		expect(ambiguous.body.code).toBe("COMPANY_AMBIGUOUS")
		expect(ambiguous.body.candidates.length).toBeGreaterThan(1)
		// a public server never fetches private or local addresses as "reports"
		const local = await post(base, { source: "custom", mode: "replay", title: "", text: "TestCo revenue was Rs 5 crore.", company: { name: "TestCo" }, report: { url: "http://localhost:8080/secret.pdf" } })
		expect(local.status).toBe(422)
		expect(local.body.code).toBe("REPORT_URL_REJECTED")
		const notPdf = await post(base, { source: "custom", mode: "replay", title: "", text: "TestCo revenue was Rs 5 crore.", company: { name: "TestCo" }, report: { file: { name: "x.pdf", base64: Buffer.from("<html>not a pdf</html>").toString("base64") } } })
		expect(notPdf.status).toBe(422)
		expect(notPdf.body.code).toBe("REPORT_NOT_PDF")
		app.server.close()
	})

	it("a fresh sample article replays its genuine recording against its own company's statements", async () => {
		const app = createApp({ companyIndex, replaySpeed: 1000 })
		const base = await listen(app)
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaView
		const apple = meta.samples.find((s) => s.id === "apple")!
		expect(apple.text).toMatch(/Apple reported revenue/)
		const { status, body } = await post(base, { source: "custom", mode: "replay", title: apple.title, text: apple.text })
		expect(status).toBe(202)
		const final = (await stream(base, body.id)).at(-1)!
		expect(final.reference).toMatchObject({ kind: "sec", entityName: "Apple Inc.", ticker: "AAPL" })
		expect(final.provenance.counts["cache-miss"] ?? 0).toBe(0)
		expect(final.status).toBe("done")
		expect(final.provenance.kind).toBe("recorded")
		expect(final.claims.find((c) => c.statedDisplay === "$8.89 per share")?.verdict).toBe("MISMATCH")
		expect(final.claims.every(c => c.review.status === "complete")).toBe(true)
		app.server.close()
	}, 60_000)

	it("a custom article about another company runs against that company's statements (cache miss without a recording)", async () => {
		const app = createApp({ companyIndex })
		const base = await listen(app)
		const { status, body } = await post(base, { source: "custom", mode: "replay", title: "Walmart quarter", text: "Walmart Inc. (NYSE: WMT) reported total revenue of $187.9 billion for the second quarter of fiscal 2027. Shares rose." })
		expect(status).toBe(202)
		const final = (await stream(base, body.id)).at(-1)!
		expect(final.reference).toMatchObject({ kind: "sec", entityName: "Walmart Inc.", ticker: "WMT" })
		expect(final.company.name).toBe("Walmart Inc.")
		expect(["cache_miss", "done"]).toContain(final.status)
		app.server.close()
	})
})

describe("view model", () => {
	const registry = new EvidenceRegistry(loadSnapshot("NVDA"))
	const interp = { quote: "revenue of $96.2 billion", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "96.2", statedUnit: "money", scale: "billion", qualifier: "exact" } as const

	function stateWith(text: string) {
		const s = new CheckerState()
		s.registry = registry
		s.article = { title: "t", text, ticker: "NVDA" }
		return s
	}

	it("pending audit/context is 'in review' while running and 'did not complete' after", () => {
		const s = stateWith("It had revenue of $96.2 billion.")
		const c = s.addClaim({ ...interp })
		expect(claimView(s, c, false).review.status).toBe("in_progress")
		expect(claimView(s, c, true).review.status).toBe("not_completed")
		expect(claimView(s, c, true).verdict).toBe("PENDING")
	})

	it("an approved audit without a finished context review is not complete", () => {
		const s = stateWith("It had revenue of $96.2 billion.")
		const c = s.addClaim({ ...interp })
		s.bindEvidence({ claimId: c.id, claimRevision: 1, currentFactId: registry.search("revenue", 2027, "Q2")[0].id, boundBy: "t" })
		s.acceptCalculation({ claimId: c.id, claimRevision: 1, evidenceRevision: 1, verdict: "MATCH", formula: "", substituted: "", statedDisplay: "", inputs: [], notes: [] }, [])
		s.setAudit(c.id, 1, 1, { status: "approved", note: "ok", by: "t" })
		expect(claimView(s, c, false).review.status).toBe("in_progress")
		s.finishContext(c.id, 1)
		expect(claimView(s, c, false).review.status).toBe("complete")
	})

	it("marks every occurrence of a repeated quotation and says why", () => {
		const s = stateWith("Its revenue of $96.2 billion was a record.\n\nAgain: revenue of $96.2 billion.")
		const c = s.addClaim({ ...interp })
		const v = claimView(s, c, true)
		expect(v.location.spans).toHaveLength(2)
		expect(v.location.note).toMatch(/appears 2 times/)
	})

	it("locates quotes across line breaks and curly quotes using original offsets", () => {
		const text = "He said “net income\nrose” sharply."
		const [s] = locateQuote(text, '"net income rose"')
		expect(text.slice(s.start, s.end)).toBe("“net income\nrose”")
	})
})

it("copies the calculation and both original filing links for a derived Apple Q4 correction", () => {
	const quote = "Apple reported revenue of $141.5 billion for Q4 FY2026."
	const s = new CheckerState()
	s.article = { title: "Apple quarterly report", text: quote, ticker: "AAPL" }
	s.registry = new EvidenceRegistry(loadSnapshot("AAPL"))
	s.referenceInfo = s.registry.info
	const c = s.addClaim({
		quote, metric: "revenue", kind: "level", accounting: "gaap", fiscalYear: 2026, fiscalPeriod: "Q4",
		statedNumber: "141.5", statedUnit: "money", scale: "billion", qualifier: "exact", currency: "USD",
	})
	const fact = s.registry.search("revenue", 2026, "Q4").find(f => f.derivation && f.value === 114477000000)!
	expect(s.bindEvidence({ claimId: c.id, claimRevision: 1, currentFactId: fact.id, boundBy: "t" }).ok).toBe(true)
	s.acceptCalculation(calculate({ claimId: c.id, claimRevision: 1, evidenceRevision: 1 }, c.interpretation, fact), [])
	s.setAudit(c.id, 1, 1, { status: "approved", note: "checked", by: "t" })
	s.finishContext(c.id, 1)
	const view = claimView(s, c, true)
	const run = { reference: referenceView(s) }
	const edit = correctionText(run, view)
	expect(edit).toContain("calculated from its financial statements")
	expect(edit).toContain("USD 478,834,000,000 full year − USD 364,357,000,000 first nine months = USD 114,477,000,000")
	expect(edit).toContain("https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm")
	expect(edit).toContain("https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm")
	expect(correctionText(run, { ...view, warnings: [{ claimId: c.id, claimRevision: 1, source: "context-agent", code: "FORWARD_LOOKING", message: "The quote is a forecast." }] })).toBeUndefined()
})
