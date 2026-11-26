/** Safety limits for live model calls: caps, budget, retries, pacing, measured usage. No API key needed. */
import { describe, expect, it } from "vitest"
import { ModelContext, ModelMessageItem, TokenUsage, InputTokenDetails, OutputTokenDetails, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { CheckerRunner } from "../src/llm/runner.js"
import { Pacer, retryDelayMs, UsageMeter } from "../src/llm/limits.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { readArticle } from "../src/article.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { loadSnapshot } from "../src/sec/edgar.js"

const usage = (i: number, o: number, thinking = 0) => new TokenUsage(i, o, i + o, new InputTokenDetails(0), new OutputTokenDetails(thinking))
const answer = (u = usage(1000, 100)): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text: "ok" })], tokenUsage: u, rowResponse: null })

function input(tasks: TaskTracker, key = "context:c1@r1"): InferenceInput {
	const context = ModelContext.create()
	tasks.register({ key, role: "context", contextId: context.id })
	return { model: "claude-haiku-4-5", context }
}

const fakeProvider = (fn: () => Promise<InferenceOutput>): InferenceRunner => ({ run: fn, stream: () => { throw new Error("unused") } })

describe("live safety limits", () => {
	it("measures real token usage and prices it", async () => {
		const tasks = new TaskTracker()
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", inner: fakeProvider(async () => answer(usage(200_000, 10_000))) })
		await r.run(input(tasks))
		const u = r.usage.summary()
		expect(u.inputTokens).toBe(200_000)
		expect(u.costUsd).toBeCloseTo(0.2 + 0.05, 6) // $1/M in, $5/M out
	})

	it("counts Gemini thinking tokens as billed output", () => {
		const m = new UsageMeter("gemini-3.5-flash", { input: 1, output: 10 })
		m.add(answer(usage(1_000_000, 100_000, 50_000)))
		expect(m.costUsd()).toBeCloseTo(1 + 1.5, 6)
	})

	it("stops at the USD budget and records why", async () => {
		const tasks = new TaskTracker()
		let calls = 0
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-sonnet-5-5", limits: { budgetUsd: 0.05 }, inner: fakeProvider(async () => (calls++, answer(usage(20_000, 1_000)))) }) // $0.05 per call
		await r.run(input(tasks, "a"))
		const blocked = await r.run(input(tasks, "b"))
		expect(calls).toBe(1)
		expect((blocked.items[0] as ModelMessageItem).content.text).toMatch(/LIMIT_REACHED.*budget reached/)
		expect(tasks.all()[1].failure?.kind).toBe("LIMIT_REACHED")
		expect(r.usage.summary().limitHit).toMatch(/budget/)
		expect(r.calls.at(-1)?.provenance).toBe("limit-reached")
	})

	it("refuses a USD budget when the model has no known price", () => {
		expect(() => new CheckerRunner({ mode: "live", tasks: new TaskTracker(), model: "gemini-3.5-flash", limits: { budgetUsd: 1 } })).toThrow(/--price/)
		expect(() => new CheckerRunner({ mode: "live", tasks: new TaskTracker(), model: "gemini-3.5-flash", limits: { budgetUsd: 1, price: { input: 0.3, output: 2.5 } } })).not.toThrow()
	})

	it("stops at the call cap and the per-task turn cap", async () => {
		const tasks = new TaskTracker()
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", limits: { maxCalls: 2, maxTurnsPerTask: 1 }, inner: fakeProvider(async () => answer()) })
		await r.run(input(tasks, "a"))
		await r.run(input(tasks, "b"))
		const third = await r.run(input(tasks, "c"))
		expect((third.items[0] as ModelMessageItem).content.text).toMatch(/call cap reached \(2/)
		// a task already 1 turn deep (one tool result in context) hits the turn cap
		const deep = input(tasks, "d")
		deep.context.addContextItem({ type: "function_call_output", output: { text: "x" } } as any)
		const r2 = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", limits: { maxTurnsPerTask: 1 }, inner: fakeProvider(async () => answer()) })
		expect(((await r2.run(deep)).items[0] as ModelMessageItem).content.text).toMatch(/turn cap/)
	})

	it("retries transient errors (429/overloaded) and gives up on permanent ones", async () => {
		const tasks = new TaskTracker()
		let n = 0
		const flaky = fakeProvider(async () => {
			n++
			if (n === 1) throw Object.assign(new Error("429 RESOURCE_EXHAUSTED. Please retry in 0.01s."), { status: 429 })
			return answer()
		})
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", inner: flaky })
		const out = await r.run(input(tasks))
		expect((out.items[0] as ModelMessageItem).content.text).toBe("ok")
		expect(r.usage.summary()).toMatchObject({ requests: 2, retries: 1 })

		const tasks2 = new TaskTracker()
		let m = 0
		const bad = new CheckerRunner({ mode: "live", tasks: tasks2, model: "claude-haiku-4-5", inner: fakeProvider(async () => (m++, Promise.reject(Object.assign(new Error("400 invalid request"), { status: 400 })))) })
		await bad.run(input(tasks2))
		expect(m).toBe(1)
		expect(tasks2.all()[0].failure?.kind).toBe("PROVIDER_ERROR")
	})

	it("abandons a hung request after the request timeout and retries it", async () => {
		const tasks = new TaskTracker()
		let n = 0
		const hangsOnce = fakeProvider(() => (++n === 1 ? new Promise<InferenceOutput>(() => undefined) : Promise.resolve(answer())))
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", limits: { requestTimeoutMs: 50 }, inner: hangsOnce })
		const t0 = Date.now()
		const out = await r.run(input(tasks))
		expect((out.items[0] as ModelMessageItem).content.text).toBe("ok")
		expect(r.usage.summary()).toMatchObject({ requests: 2, retries: 1 })
		expect(r.usage.retryNotes[0]).toMatch(/no answer from the provider/)
		expect(Date.now() - t0).toBeLessThan(5_000)
	}, 10_000)

	it("treats an empty provider response as a retryable error instead of letting the agent loop die", async () => {
		const tasks = new TaskTracker()
		let n = 0
		const emptyOnce = fakeProvider(async () => (++n === 1 ? { items: [], tokenUsage: undefined, rowResponse: null } : answer()))
		const r = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", inner: emptyOnce })
		const t0 = Date.now()
		const out = await r.run(input(tasks))
		expect((out.items[0] as ModelMessageItem).content.text).toBe("ok")
		expect(r.usage.summary()).toMatchObject({ requests: 2, retries: 1, stalled: [] })
		expect(r.usage.retryNotes[0]).toMatch(/empty response/)
		expect(Date.now() - t0).toBeLessThan(5_000)
	}, 10_000)

	it("reads provider retry hints and backs off otherwise", () => {
		expect(retryDelayMs(new Error("RESOURCE_EXHAUSTED ... \"retryDelay\": \"7s\""), 0)).toBe(7250)
		expect(retryDelayMs(Object.assign(new Error("overloaded"), { status: 529 }), 0)).toBeGreaterThanOrEqual(2000)
		expect(retryDelayMs(Object.assign(new Error("bad"), { status: 400 }), 0)).toBeUndefined()
	})

	it("paces requests: bounded concurrency and requests per minute", async () => {
		const p = new Pacer(2, 600) // ≥100 ms between starts
		let active = 0
		let peak = 0
		const starts: number[] = []
		const t0 = Date.now()
		await Promise.all(
			[1, 2, 3, 4].map(() =>
				p.run(async () => {
					starts.push(Date.now() - t0)
					peak = Math.max(peak, ++active)
					await new Promise((r) => setTimeout(r, 30))
					active--
				}),
			),
		)
		expect(peak).toBeLessThanOrEqual(2)
		expect(starts[3]).toBeGreaterThanOrEqual(280)
	})

	it("a run stopped by the call cap finishes cleanly with partial results", async () => {
		const tasks = new TaskTracker()
		const { default: script } = await import("../fixtures/nvda-demo.script.js")
		const scripted = new CheckerRunner({ mode: "author", tasks, script })
		const runner = new CheckerRunner({ mode: "live", tasks, model: "claude-haiku-4-5", limits: { maxCalls: 20 }, inner: scripted })
		const result = await runChecker({ article: { ...readArticle("data/articles/nvda-q2-fy2027.md"), ticker: "NVDA" }, snapshot: loadSnapshot("NVDA"), runner, tasks, model: "claude-haiku-4-5", timeoutMs: 20_000 })
		expect(result.timedOut).toBe(false)
		expect(runner.usage.summary().requests).toBe(20)
		expect(runner.usage.summary().limitHit).toMatch(/call cap/)
		expect(runner.calls.filter((c) => c.provenance === "limit-reached").length).toBeGreaterThan(0)
		// nothing is shown as fully reviewed unless it really was
		for (const id of result.state.claims.keys()) {
			const a = result.state.audits.get(id)?.state
			if (a?.status === "approved") expect(result.state.calcs.has(id)).toBe(true)
		}
	}, 30_000)
})
