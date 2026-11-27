import type { InferenceInput, InferenceRunner } from "@mozaik-ai/core"
import { describe, expect, it, vi } from "vitest"
import script from "../fixtures/nvda-demo.script.js"
import { readArticle } from "../src/article.js"
import { checkReportIssuer } from "../src/docs/issuer.js"
import { parsePdf } from "../src/docs/pdf.js"
import { CheckerRunner, turnOf, type ScriptTurn } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker, type Task } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { makePdf, resultsPage } from "./helpers/pdf.js"

const article = { ...readArticle("data/articles/nvda-q2-fy2027.md"), ticker: "NVDA" }
const snapshot = loadSnapshot("NVDA")
const submit = (index: number, changes: Record<string, unknown> = {}): ScriptTurn => ({
	call: { name: "submit_claim", args: { ...script.tasks["extractor:article"][index].call!.args, ...changes } },
})
const tool = (name: string, args: Record<string, unknown>): ScriptTurn => ({ call: { name, args } })
const done: ScriptTurn = { say: "done" }
const approval = (claimId: string, claimRevision = 1, evidenceRevision = 1) => [tool("approve", { claimId, claimRevision, evidenceRevision, note: "Checked" }), done]

function harness(steps: Record<string, ScriptTurn[]>, beforeCall?: (task: Task, turn: number, input: InferenceInput) => Promise<void> | void) {
	const tasks = new TaskTracker()
	const scripted = new CheckerRunner({ mode: "author", tasks, script: { description: "recovery scenarios", tasks: steps } })
	const inner: InferenceRunner = {
		run: async (input) => {
			await beforeCall?.(tasks.forContext(input.context.id)!, turnOf(input), input)
			return scripted.run(input)
		},
		stream: () => { throw new Error("unused") },
	}
	const runner = new CheckerRunner({ mode: "live", tasks, model: "test", inner, limits: { retries: 0, maxConcurrent: 10 } })
	return { tasks, runner }
}

describe("provider-failure recovery", () => {
	it("resumes extraction, deduplicates reworded anchors, and rejects edits to existing claims", async () => {
		const repeated = "Nvidia reported revenue of $96.2 billion"
		const title = { ...article, text: `${article.text}\n\nFor its fiscal first quarter of 2027, ${repeated}.` }
		const revision = tool("revise_claim", { ...submit(0).call!.args, claimId: "c1", fromRevision: 1, reason: "should not be allowed", fiscalPeriod: "Q1" })
		const { tasks, runner } = harness({
			"extractor:article": [submit(0, { quote: repeated })],
			"context:c1@r1": [done],
			"auditor:c1@r1.e1": approval("c1"),
			"extractor:article:recovery:1": [revision, submit(0, { quote: "Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027, which ended July 26, 2026." }), submit(0, { quote: repeated, fiscalPeriod: "Q1" }), done],
			"context:c2@r1:recovery:1": [done],
			"auditor:c2@r1.e1:recovery:1": approval("c2"),
		}, (task, turn, input) => {
			if (task.key === "extractor:article" && turn === 1) throw new Error("provider interruption")
			if (task.key === "extractor:article:recovery:1") expect(input.tools?.map((item) => item.name)).toEqual(["submit_claim"])
		})
		const result = await runChecker({ article: title, snapshot, tasks, runner, model: "test", timeoutMs: 3_000 })
		const { state } = result
		expect(state.extraction).toBe("failed")
		expect(state.audits.get("c1")?.state.status).toBe("approved")
		const previous = [state.claims.get("c1"), state.bindings.get("c1"), state.calcs.get("c1"), state.audits.get("c1")]
		const elapsed = result.elapsedMs
		expect(result.recoveryWork()).toEqual({ reader: false, extraction: true, claimIds: [] })
		expect(await result.recover({ timeoutMs: 3_000 })).toEqual({ timedOut: false, work: { reader: false, extraction: true, claimIds: [] } })
		expect(result.elapsedMs).toBeGreaterThanOrEqual(elapsed)
		expect(state.extraction).toBe("done")
		expect(state.extractionError).toBeUndefined()
		expect([...state.claims.keys()]).toEqual(["c1", "c2"])
		expect(state.claims.get("c1")).toBe(previous[0])
		expect(state.bindings.get("c1")).toBe(previous[1])
		expect(state.calcs.get("c1")).toBe(previous[2])
		expect(state.audits.get("c1")).toBe(previous[3])
		expect(state.claims.get("c2")?.interpretation).toMatchObject({ quote: repeated, fiscalPeriod: "Q1" })
		expect(state.audits.get("c2")?.state.status).toBe("approved")
		expect(result.recoveryWork()).toEqual({ reader: false, extraction: false, claimIds: [] })
	})

	it("restarts only the failed evidence, audit and context stages", async () => {
		const warning = tool("add_context_warning", { claimId: "c3", claimRevision: 1, code: "PERIOD_AMBIGUOUS", message: "The sentence does not specify its reporting period." })
		const { tasks, runner } = harness({
			"extractor:article": [submit(0), submit(1), submit(6), submit(5), done],
			"context:c1@r1": [done],
			"context:c2@r1": [done],
			"context:c3@r1": [warning],
			"context:c4@r1": [done],
			"auditor:c4@r1.e1": approval("c4"),
			"auditor:c1@r1.e1:recovery:1": [tool("request_correction", { claimId: "c4", claimRevision: 1, evidenceRevision: 1, target: "claim", reason: "out of scope" }), ...approval("c1")],
			"evidence:c2@r1#2:recovery:1": [tool("bind_evidence", { claimId: "c2", claimRevision: 1, currentFactId: "Revenues/Q2-FY2027/26-000075", baseFactId: "Revenues/Q2-FY2026/26-000075" }), done],
			"auditor:c2@r1.e1:recovery:1": approval("c2"),
			"context:c3@r1:recovery:1": [warning, done],
		}, (task, turn) => {
			if (["auditor:c1@r1.e1", "evidence:c2@r1#1"].includes(task.key) || (task.key === "context:c3@r1" && turn === 1)) throw new Error("provider interruption")
		})
		const result = await runChecker({ article, snapshot, tasks, runner, model: "test", timeoutMs: 3_000 })
		const { state } = result
		expect(result.recoveryWork()).toEqual({ reader: false, extraction: false, claimIds: ["c1", "c2", "c3"] })
		const c1 = state.calcs.get("c1")
		const c3 = state.audits.get("c3")
		const c4 = state.audits.get("c4")
		const retry = result.recover({ timeoutMs: 3_000 })
		expect(result.recoveryPending).toBe(true)
		await expect(result.recover()).rejects.toThrow("still has active work")
		await expect(result.challenge("c4", "out of scope")).rejects.toThrow("still has active work")
		expect((await retry).timedOut).toBe(false)
		expect(state.calcs.get("c1")).toBe(c1)
		expect(state.audits.get("c1")?.state.status).toBe("approved")
		expect(state.audits.get("c2")?.state.status).toBe("approved")
		expect(state.audits.get("c3")).toBe(c3)
		expect(state.contextFailures.has("c3")).toBe(false)
		expect(state.warnings.get("c3")?.filter((item) => item.source === "context-agent")).toHaveLength(1)
		expect(state.audits.get("c4")).toBe(c4)
		expect(state.corrections).toHaveLength(0)
		expect(result.recoveryPending).toBe(false)
		expect(result.recoveryWork().claimIds).toEqual([])
	})

	it("replays an interrupted claim correction without consuming another correction", async () => {
		const objection = tool("request_correction", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, target: "claim", reason: "Check whether GAAP was specified." })
		const revision = tool("revise_claim", { ...submit(0).call!.args, claimId: "c1", fromRevision: 1, reason: "Fixed interpretation", accounting: "unspecified" })
		const { tasks, runner } = harness({
			"extractor:article": [submit(0, { accounting: "gaap" }), done],
			"context:c1@r1": [done],
			"auditor:c1@r1.e1": [objection, done],
			"extractor-fix:c1@r1:recovery:1": [revision, done],
			"context:c1@r2:recovery:1": [done],
			"auditor:c1@r2.e2:recovery:1": approval("c1", 2, 2),
		}, (task) => {
			if (task.key === "extractor-fix:c1@r1") throw new Error("provider interruption")
		})
		const result = await runChecker({ article, snapshot, tasks, runner, model: "test", timeoutMs: 3_000 })
		expect(result.state.audits.get("c1")?.state.status).toBe("unresolved")
		expect(result.recoveryWork().claimIds).toEqual(["c1"])
		expect((await result.recover({ timeoutMs: 3_000 })).timedOut).toBe(false)
		expect(result.state.claims.get("c1")?.revision).toBe(2)
		expect(result.state.claims.get("c1")?.correctionsUsed).toBe(1)
		expect(result.state.corrections).toHaveLength(1)
		expect(result.state.audits.get("c1")?.state.status).toBe("approved")
	})

	it("retries an interrupted PDF reader before extracting claims", async () => {
		const bytes = makePdf([resultsPage("Consolidated", {
			rev: ["12,345.67", "11,000", "10,500", "23,345.67", "20,800", "45,000"],
			np: ["2,100", "1,900", "1,800", "4,000", "3,500", "7,400"],
			basic: ["5.25", "4.75", "4.50", "10.00", "8.75", "18.50"],
			diluted: ["5.24", "4.74", "4.49", "9.98", "8.73", "18.45"],
		})])
		const doc = { fileName: "report.pdf", sha256: "test", bytes: bytes.length, pageCount: 1, pages: await parsePdf(bytes), fetchedAt: "2026-11-27" }
		const match = checkReportIssuer(doc, "TestCo Limited")
		if (!match.ok) throw new Error(match.message)
		const text = "TestCo reported consolidated revenue from operations of Rs 12,345.67 crore for the September quarter."
		const claim = { quote: text, metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2026, fiscalPeriod: "Q2", statedNumber: "12345.67", statedUnit: "money", scale: "crore", qualifier: "exact" }
		const fact = { metric: "revenue", consolidation: "consolidated", page: 1, row: "Revenue from operations", column: "Quarter ended 30.09.2025", periodType: "quarter", periodEnd: "2025-09-30", value: "12,345.67" }
		const annual = { ...fact, column: "Year ended 31.03.2025", periodType: "year", periodEnd: "2025-03-31", value: "45,000" }
		const { tasks, runner } = harness({
			"reader:report:recovery:1": [tool("record_facts", { facts: [fact, annual] }), done],
			"extractor:article:recovery:1": [tool("submit_claim", claim), done],
			"evidence:c1@r1#1:recovery:1": [tool("bind_evidence", { claimId: "c1", claimRevision: 1, currentFactId: "Revenue/Q2-FY2026/p1" }), done],
			"context:c1@r1:recovery:1": [done],
			"auditor:c1@r1.e1:recovery:1": approval("c1"),
		}, (task) => { if (task.key === "reader:report") throw new Error("provider interruption") })
		const result = await runChecker({ article: { title: "TestCo", text, ticker: "" }, report: { doc, company: { name: "TestCo Limited" }, issuer: match.issuer }, tasks, runner, model: "test", timeoutMs: 3_000 })
		expect(result.state.report?.status).toBe("failed")
		expect(result.recoveryWork()).toEqual({ reader: true, extraction: false, claimIds: [] })
		expect((await result.recover({ timeoutMs: 3_000 })).timedOut).toBe(false)
		expect(result.state.report?.status).toBe("ready")
		expect(result.state.calcs.get("c1")).toMatchObject({ verdict: "MATCH", actualDisplay: "₹12,345.67 crore" })
		expect(result.state.audits.get("c1")?.state.status).toBe("approved")
	})

	it("waits for timed-out work to retire before safely recovering", async () => {
		let release!: () => void
		const waiting = new Promise<void>((resolve) => { release = resolve })
		const { tasks, runner } = harness({ "extractor:article:recovery:2": [done] }, async (task) => {
			if (task.key === "extractor:article") await waiting
			if (task.key !== "extractor:article:recovery:2") throw new Error("provider interruption")
		})
		const result = await runChecker({ article, snapshot, tasks, runner, model: "test", timeoutMs: 10 })
		expect(result.timedOut).toBe(true)
		expect(result.recoveryPending).toBe(true)
		expect(result.recoveryWork().extraction).toBe(false)
		await expect(result.recover()).rejects.toThrow("still has active work")
		release()
		await vi.waitFor(() => expect(result.recoveryWork().extraction).toBe(true))
		await result.recover({ timeoutMs: 3_000 })
		expect(result.recoveryWork().extraction).toBe(true)
		expect((await result.recover({ timeoutMs: 3_000 })).timedOut).toBe(false)
		expect(result.timedOut).toBe(false)
		expect(result.state.extraction).toBe("done")
		expect(tasks.all().map((task) => task.key)).toEqual(["extractor:article", "extractor:article:recovery:1", "extractor:article:recovery:2"])
	})
})
