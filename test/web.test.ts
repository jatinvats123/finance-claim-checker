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
	let duplicate: { status: number; body: any }

	beforeAll(async () => {
		base = await listen(app)
		const started = await post(base, { source: "example" })
		expect(started.status).toBe(202)
		runId = started.body.id
		duplicate = await post(base, { source: "example" })
		snapshots = await stream(base, runId)
		final = snapshots.at(-1)!
	}, 30_000)
	afterAll(() => app.server.close())

	it("serves meta with the canonical example article and honest labels", async () => {
		const meta = (await (await fetch(`${base}/api/meta`)).json()) as MetaView
		const canonical = readArticle(EXAMPLE_ARTICLE)
		expect(meta.example.title).toBe(canonical.title)
		expect(meta.example.text).toBe(canonical.text) // byte-identical: replay hashes depend on it
		expect(meta.example.label).toBe("Synthetic example · Fixture model responses · Real calculations")
		expect(meta.company.ticker).toBe("NVDA")
		expect(meta.companies.map((c) => c.ticker)).toEqual(["NVDA"])
		expect(meta.live.configured).toBe(false)
		expect(meta.live.hint).toMatch(/ANTHROPIC_API_KEY/)
		expect(JSON.stringify(meta)).not.toMatch(/sk-|api_key=/i)
	})

	it("refuses a duplicate run while one is active", () => {
		expect(duplicate.status).toBe(409)
		expect(duplicate.body.runId).toBe(runId)
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
