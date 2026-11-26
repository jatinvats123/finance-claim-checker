/**
 * Reviewer challenge ("Recheck this claim"): a validated change creates a new revision and re-runs only
 * that claim's evidence/context/audit work; a declined challenge restores the earlier outcome; other
 * claims stay untouched; the verdict always comes from the calculator.
 */
import { describe, expect, it } from "vitest"
import { readArticle } from "../src/article.js"
import { CheckerRunner, type AuthorScript, type ScriptTurn } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import demo from "../fixtures/nvda-demo.script.js"

const call = (name: string, args: Record<string, unknown>): ScriptTurn => ({ call: { name, args } })
const say = (text: string): ScriptTurn => ({ say: text })

const C1 = { quote: "Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "96.2", statedUnit: "usd", scale: "billion" }

// The demo script plus scripted answers for the two rechecks (stands in for the live model).
const script: AuthorScript = {
	description: "demo + recheck turns",
	tasks: {
		...(demo as AuthorScript).tasks,
		"extractor-fix:c1@r1": [call("revise_claim", { claimId: "c1", fromRevision: 1, reason: "reviewer: treat as an approximate figure", ...C1, qualifier: "about" }), say("done")],
		"evidence:c1@r2#1": [call("search_facts", { metric: "revenue", fiscalYear: 2027, fiscalPeriod: "Q2" }), call("bind_evidence", { claimId: "c1", claimRevision: 2, currentFactId: "Revenues/Q2-FY2027/26-000075" }), say("done")],
		"context:c1@r2": [say("no context issues")],
		"auditor:c1@r2.e2": [call("approve", { claimId: "c1", claimRevision: 2, evidenceRevision: 2, note: "approximate reading confirmed" }), say("done")],
		"extractor-fix:c9@r1": [say('The sentence says "all of fiscal 2026"; the full-year reading is right.')],
		// a reviewer trying to make the units error disappear: the anchoring guard rejects it
		"extractor-fix:c8@r1": [call("revise_claim", { claimId: "c8", fromRevision: 1, reason: "reviewer says billion", quote: "For the first half of fiscal 2027, revenue totaled $177.8 million", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2027, fiscalPeriod: "H1", statedNumber: "177.8", statedUnit: "usd", scale: "billion", qualifier: "exact" }), say("done")],
	},
}

describe("reviewer challenge model", () => {
	it("a recheck after a replayed run calls the live model, not the replay placeholder", async () => {
		const tasks = new TaskTracker()
		const scripted = new CheckerRunner({ mode: "author", tasks, script })
		const seen: { task?: string; model: string }[] = []
		const spy = { run: (input: any) => (seen.push({ task: tasks.forContext(input.context.id)?.key, model: input.model }), scripted.run(input)), stream: () => { throw new Error("unused") } }
		const result = await runChecker({ article: { ...readArticle("data/articles/nvda-q2-fy2027.md"), ticker: "NVDA" }, snapshot: loadSnapshot("NVDA"), runner: spy as any, tasks, model: "replay", timeoutMs: 20_000 })
		expect(seen.every((s) => s.model === "replay")).toBe(true)
		await result.challenge("c9", "Is this really the full fiscal year?", 20_000, "gemini-3.5-flash")
		const fix = seen.filter((s) => s.task === "extractor-fix:c9@r1")
		expect(fix.length).toBeGreaterThan(0)
		expect(fix.every((s) => s.model === "gemini-3.5-flash")).toBe(true)
	}, 40_000)
})

describe("reviewer challenge", () => {
	it("re-runs only the challenged claim, restores declined challenges, and never sets a verdict", async () => {
		const tasks = new TaskTracker()
		const runner = new CheckerRunner({ mode: "author", tasks, script })
		const result = await runChecker({ article: { ...readArticle("data/articles/nvda-q2-fy2027.md"), ticker: "NVDA" }, snapshot: loadSnapshot("NVDA"), runner, tasks, model: "test", timeoutMs: 20_000 })
		const s = result.state
		const before = new Map([...s.claims.keys()].map((id) => [id, { rev: s.claims.get(id)!.revision, ev: s.bindings.get(id)?.evidenceRevision, calc: s.calcs.get(id), audit: s.audits.get(id)!.state.status }]))

		// 1) accepted: a new revision, recomputed by the calculator
		const r1 = await result.challenge("c1", "Should this be read as an approximate figure?")
		expect(r1.timedOut).toBe(false)
		const c1 = s.claims.get("c1")!
		expect(c1.revision).toBe(2)
		expect(c1.interpretation.qualifier).toBe("about")
		expect(s.calcs.get("c1")!.verdict).toBe("MATCH")
		expect(s.calcs.get("c1")!.toleranceRule).toMatch(/about/)
		expect(s.audits.get("c1")!.state).toMatchObject({ status: "approved" })
		expect(s.corrections.some((x) => x.claimId === "c1" && x.by === "reviewer (human)")).toBe(true)
		for (const [id, b] of before) {
			if (id === "c1") continue
			expect(s.claims.get(id)!.revision).toBe(b.rev)
			expect(s.bindings.get(id)?.evidenceRevision).toBe(b.ev)
			expect(s.calcs.get(id)).toBe(b.calc) // same object: not recomputed
		}

		// 2) declined: the earlier outcome is restored
		await result.challenge("c9", "Is this really the full fiscal year?")
		expect(s.claims.get("c9")!.revision).toBe(1)
		expect(s.audits.get("c9")!.state.status).toBe(before.get("c9")!.audit)
		expect(s.history.some((h) => h.claimId === "c9" && h.kind === "challenge.declined")).toBe(true)

		// 3) a challenge cannot launder the article's units error: the revision is rejected by code
		await result.challenge("c8", "The filings say billion, so the article must mean billion.")
		expect(s.claims.get("c8")!.interpretation.scale).toBe("million")
		expect(s.calcs.get("c8")!.verdict).toBe("MISMATCH")
		expect(s.audits.get("c8")!.state.status).toBe("approved")

		// a claim that is still open cannot be challenged
		await expect(result.challenge("c99", "x x x x x")).rejects.toThrow(/unknown claim/)
	}, 40_000)
})
