/**
 * Web adapter: API, SSE stream, view model correctness against the engine's own report,
 * provenance/review/failure states. No API key needed.
 */
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { InferenceInput, InferenceRunner } from "@mozaik-ai/core"
import { readArticle } from "../src/article.js"
import { CheckerState } from "../src/domain/store.js"
import { CheckerRunner, type AuthorScript } from "../src/llm/runner.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"
import { createApp, EXAMPLE_ARTICLE } from "../src/web/server.js"
import type { MetaView, RunView } from "../src/web/types.js"
import { claimView, locateQuote } from "../src/web/viewmodel.js"
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
	const app = createApp({ staticDir: "test/__no_build__" })
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
		expect(final.claims.find((c) => c.id === "c10")!.verdictLabel).toBe("Reference unavailable in this dataset")
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
	it("replays only the recorded model run, labelled as recorded, with no fixture fallback", async () => {
		const app = createApp({ replaySpeed: 1000 })
		const base = await listen(app)
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaView
		const rec = meta.replayOptions.find((o) => o.id === "recorded")!
		if (!rec.available) return app.server.close() // no recording in this checkout
		const { body } = await post(base, { source: "example", replay: "recorded" })
		const final = (await stream(base, body.id)).at(-1)!
		expect(final.status).toBe("done")
		expect(Object.keys(final.provenance.counts)).toEqual(["recorded"])
		expect(final.provenance.label).toBe("Recorded model responses")
		expect(final.trace?.timing).toBe("replay-recorded")
		expect(final.claims.length).toBeGreaterThan(0)
		expect(final.claims.every((c) => c.review.status === "complete")).toBe(true)
		app.server.close()
	}, 30_000)
})

describe("custom articles", () => {
	it("an edited article in replay mode is an explicit cache miss", async () => {
		const app = createApp()
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
		const app = createApp({ env: { ANTHROPIC_API_KEY: "test-placeholder" }, liveInner: () => hang, maxReplayRuns: 1, timeoutMs: 3_000 })
		const base = await listen(app)
		const live1 = await post(base, { source: "custom", mode: "live", title: "t", text: "Revenue rose 5%." })
		const live2 = await post(base, { source: "custom", mode: "live", title: "t", text: "Revenue rose 6%." })
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
		const app = createApp({ env: {} })
		const base = await listen(app)
		const r = await post(base, { source: "custom", mode: "live", title: "t", text: "Revenue rose 5%." })
		expect(r.status).toBe(400)
		expect(r.body.code).toBe("LIVE_NOT_CONFIGURED")
		expect(r.body.error).toMatch(/ANTHROPIC_API_KEY.*\.env/)
		app.server.close()
	})

	it("failed audits and context reviews are never shown as fully reviewed", async () => {
		const failing = new Set(["auditor:c1@r1.e1", "context:c2@r1"])
		const app = createApp({
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

describe("view model", () => {
	const registry = new EvidenceRegistry(loadSnapshot("NVDA"))
	const interp = { quote: "revenue of $96.2 billion", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "96.2", statedUnit: "usd", scale: "billion", qualifier: "exact" } as const

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
