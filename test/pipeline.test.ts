/**
 * End-to-end runs of the Mozaik pipeline with no API key:
 *  - replay of the sealed demo fixtures (the real calculation/validation workflow runs),
 *  - explicit cache miss on unsupported input,
 *  - provider failures isolated to the affected claim,
 *  - concurrency and stale-result rejection.
 */
import { describe, expect, it } from "vitest"
import type { InferenceInput, InferenceOutput, InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { readArticle } from "../src/article.js"
import { CheckerRunner, loadCassette, type AuthorScript } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import script from "../fixtures/nvda-demo.script.js"

const snapshot = loadSnapshot("NVDA")
const ARTICLE = { ...readArticle("data/articles/nvda-q2-fy2027.md"), ticker: "NVDA" }
const fixtures = loadCassette("data/replay/nvda-demo.fixtures.json")!

const EXPECTED: Record<string, string> = {
	c1: "MATCH",
	c2: "MATCH",
	c3: "MISMATCH",
	c4: "MISMATCH",
	c5: "MATCH",
	c6: "MATCH",
	c7: "NOT_VERIFIABLE",
	c8: "MISMATCH",
	c9: "MISMATCH",
	c10: "REFERENCE_NOT_YET_FILED",
}

async function run(runner: InferenceRunner, tasks: TaskTracker, article = ARTICLE) {
	let open = 0
	let maxOpen = 0
	const onEvent = (e: SemanticEvent) => {
		if (e.type === "message_received.started") maxOpen = Math.max(maxOpen, ++open)
		if (e.type === "model.answer") open--
	}
	const result = await runChecker({ article, snapshot, runner, tasks, model: "test", timeoutMs: 30_000, onEvent })
	return { ...result, maxOpen }
}

const verdicts = (state: Awaited<ReturnType<typeof run>>["state"]) => Object.fromEntries([...state.claims.keys()].map((id) => [id, state.calcs.get(id)?.verdict ?? "NONE"]))

describe("pipeline (keyless)", () => {
	it("replays the sealed demo: real calculations, both correction paths, a stale rejection, no cache misses", async () => {
		const tasks = new TaskTracker()
		const runner = new CheckerRunner({ mode: "replay", tasks, cassettes: [fixtures] })
		const { state, timedOut, maxOpen } = await run(runner, tasks)

		expect(timedOut).toBe(false)
		expect(verdicts(state)).toEqual(EXPECTED)
		expect(runner.calls.every((c) => c.provenance === "fixture")).toBe(true)
		expect(fixtures.provenance).toBe("fixture")

		// Concurrency: several agent loops were in flight at once.
		expect(maxOpen).toBeGreaterThanOrEqual(3)

		// Rule gate correction (c3): wrong base blocked, evidence re-bound, recalculated.
		expect(state.bindings.get("c3")!.evidenceRevision).toBe(2)
		expect(state.calcs.get("c3")!.actual).toBeCloseTo(105.85, 2)
		expect(state.history.some((h) => h.claimId === "c3" && h.kind === "audit.investigating" && /YOY base/.test(h.detail))).toBe(true)

		// LLM-review correction (c4): claim revised, old work invalidated, others kept moving meanwhile.
		const c4 = state.claims.get("c4")!
		expect(c4.revision).toBe(2)
		expect(c4.interpretation.comparison).toBe("unspecified")
		const invAt = state.history.find((h) => h.claimId === "c4" && h.kind === "audit.investigating")!.at
		const c4DoneAt = state.history.find((h) => h.claimId === "c4" && h.kind === "audit.approved")!.at
		const othersApprovedMeanwhile = state.history.filter((h) => h.claimId !== "c4" && h.kind === "audit.approved" && h.at > invAt && h.at < c4DoneAt)
		expect(othersApprovedMeanwhile.length).toBeGreaterThan(0)

		// Late result from the r1 context review rejected; r2's warning kept.
		expect(state.staleRejections.some((s) => /context warning for c4@r1/.test(s.detail))).toBe(true)
		expect(state.warnings.get("c4")!.filter((w) => w.source === "context-agent").every((w) => w.claimRevision === 2)).toBe(true)

		// Every result was audited.
		for (const id of state.claims.keys()) expect(state.audits.get(id)!.state.status).toBe("approved")
	}, 30_000)

	it("returns an explicit cache miss for input it has no recorded/fixture response for", async () => {
		const tasks = new TaskTracker()
		const runner = new CheckerRunner({ mode: "replay", tasks, cassettes: [fixtures] })
		const changed = { ...ARTICLE, text: ARTICLE.text.replace("$96.2 billion", "$97.0 billion") }
		const { state, timedOut } = await run(runner, tasks, changed)
		expect(timedOut).toBe(false)
		expect(state.extraction).toBe("failed")
		expect(state.extractionError).toMatch(/^CACHE_MISS/)
		expect(state.claims.size).toBe(0) // nothing substituted
		expect(runner.calls.map((c) => c.provenance)).toEqual(["cache-miss"])
	}, 30_000)

	it("isolates provider failures to the affected claim", async () => {
		const tasks = new TaskTracker()
		const scripted = new CheckerRunner({ mode: "author", tasks, script: script as AuthorScript })
		const failing = new Set(["evidence:c5@r1#1", "auditor:c1@r1.e1"])
		const flaky: InferenceRunner = {
			run: async (input: InferenceInput): Promise<InferenceOutput> => {
				const t = tasks.forContext(input.context.id)
				if (t && failing.has(t.key)) throw new Error("503 Service Unavailable (simulated)")
				return scripted.run(input)
			},
			stream: () => {
				throw new Error("unused")
			},
		}
		const runner = new CheckerRunner({ mode: "live", tasks, inner: flaky })
		const { state, timedOut } = await run(runner, tasks)

		expect(timedOut).toBe(false)
		const c5 = state.audits.get("c5")!.state
		expect(c5.status).toBe("failed")
		if (c5.status === "failed") expect(c5.reason).toMatch(/PROVIDER_ERROR.*503/)
		expect(state.calcs.has("c5")).toBe(false) // no evidence → no number shown

		const c1 = state.audits.get("c1")!.state
		expect(c1.status).toBe("failed")
		if (c1.status === "failed") expect(c1.reason).toMatch(/unaudited/)
		expect(state.calcs.get("c1")!.verdict).toBe("MATCH") // numeric result kept, flagged unaudited

		const { c1: _1, c5: _5, ...rest } = verdicts(state)
		const { c1: _e1, c5: _e5, ...expectedRest } = EXPECTED
		expect(rest).toEqual(expectedRest)
		expect(runner.calls.filter((c) => c.provenance === "provider-error")).toHaveLength(2)
	}, 30_000)
})
