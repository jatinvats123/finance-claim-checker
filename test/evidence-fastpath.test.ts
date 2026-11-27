/**
 * Evidence without the round trips: one unambiguous statement figure is bound by code (zero Evidence
 * model calls); change claims and conflicting/restated figures go to the agent with the candidates
 * preloaded in its first prompt. Every path still runs through the calculator, auditor and corrections.
 */
import { describe, expect, it } from "vitest"
import type { InferenceInput } from "@mozaik-ai/core"
import { planEvidence } from "../src/domain/evidence-plan.js"
import type { Claim, ClaimInterpretation } from "../src/domain/types.js"
import { CheckerRunner, type AuthorScript, type ScriptTurn } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"

const wit = new EvidenceRegistry(loadSnapshot("WIT"))
const claim = (o: Partial<ClaimInterpretation>): Claim => ({
	id: "c1",
	revision: 1,
	reason: "test",
	correctionsUsed: 0,
	interpretation: { quote: "x", metric: "eps_diluted", accounting: "unspecified", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "12.25", statedUnit: "per_share", scale: "units", qualifier: "exact", currency: "INR", consolidation: "unspecified", ...o },
})

describe("evidence plan (deterministic triage)", () => {
	it("binds the single unambiguous statement figure", () => {
		expect(planEvidence(claim({}), wit)).toMatchObject({ kind: "bind", currentFactId: "DilutedEarningsLossPerShare/FY-FY2025/25-076303" })
		// a stated currency picks that currency's figure; an unstated one never picks a convenience translation
		expect(planEvidence(claim({ metric: "revenue", statedUnit: "money", scale: "billion", statedNumber: "10.4", currency: "USD" }), wit)).toMatchObject({ kind: "bind", currentFactId: "Revenue.USD/FY-FY2025/25-076303" })
		expect(planEvidence(claim({ metric: "revenue", statedUnit: "money", scale: "crore", statedNumber: "89088", currency: "unspecified" }), wit)).toMatchObject({ kind: "bind", currentFactId: "Revenue/FY-FY2025/25-076303" })
		// a rupee claim against a dollar-only filer still binds the statement figure; the calculator reports "not comparable"
		const infy = new EvidenceRegistry(loadSnapshot("INFY"))
		expect(planEvidence(claim({ metric: "revenue", statedUnit: "money", scale: "crore", statedNumber: "162990" }), infy)).toMatchObject({ kind: "bind", currentFactId: "RevenueFromContractsWithCustomers/FY-FY2025/25-091925" })
	})

	it("records 'no statement for the period' by code", () => {
		const nvda = new EvidenceRegistry(loadSnapshot("NVDA"))
		expect(planEvidence(claim({ metric: "revenue", statedUnit: "money", scale: "billion", statedNumber: "115.8", currency: "USD", fiscalYear: 2027, fiscalPeriod: "Q3" }), nvda)).toMatchObject({ kind: "no_reference" })
	})

	it("sends judgement calls to the agent with a shortlist", () => {
		// conflicting filings: FY2024 EPS as first reported (₹20.82) vs restated after the bonus issue (₹10.41)
		const conflict = planEvidence(claim({ fiscalYear: 2024, statedNumber: "20.82" }), wit)
		expect(conflict).toMatchObject({ kind: "agent", reason: expect.stringMatching(/conflicting figures for FY-FY2024: .*= 20\.82, .*= 10\.41/) })
		// year-over-year change: current and comparison candidates are preloaded
		const yoy = planEvidence(claim({ metric: "net_income", kind: "change", comparison: "yoy", direction: "increase", statedUnit: "percent", statedNumber: "18.9" }), wit)
		expect(yoy.kind).toBe("agent")
		const ids = yoy.kind === "agent" ? yoy.shortlist.flatMap((s) => s.facts.map((f) => f.id)) : []
		expect(ids).toEqual(expect.arrayContaining(["ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303", "ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303"]))
		// a named narrower line item, and a standalone figure a consolidated-only filer does not have
		const wmt = new EvidenceRegistry(loadSnapshot("WMT"))
		expect(planEvidence(claim({ metric: "revenue", statedUnit: "money", scale: "billion", statedNumber: "186.1", currency: "USD", fiscalYear: 2027, fiscalPeriod: "Q2", quote: "net sales of $186.1 billion" }), wmt)).toMatchObject({ kind: "agent", reason: "the article names a specific line item" })
		expect(planEvidence(claim({ consolidation: "standalone" }), wit)).toMatchObject({ kind: "agent", reason: "no standalone figure for FY-FY2025" })
	})
})

const call = (name: string, args: Record<string, unknown>): ScriptTurn => ({ call: { name, args } })
const say = (text: string): ScriptTurn => ({ say: text })

/** Run with scripted model turns, recording every model input (task key + full context). */
async function run(text: string, tasks: AuthorScript["tasks"]) {
	const tracker = new TaskTracker()
	const scripted = new CheckerRunner({ mode: "author", tasks: tracker, script: { description: "test", tasks } })
	const seen: { task: string; context: string }[] = []
	const spy = { run: (input: InferenceInput) => (seen.push({ task: tracker.forContext(input.context.id)?.key ?? "?", context: JSON.stringify(input.context.getItems()) }), scripted.run(input)), stream: () => { throw new Error("unused") } }
	const res = await runChecker({ article: { title: "Wipro", text, ticker: "WIT" }, snapshot: loadSnapshot("WIT"), runner: spy as any, tasks: tracker, model: "test", timeoutMs: 20_000 })
	return { res, seen, evidenceCalls: seen.filter((s) => s.task.startsWith("evidence:")).length }
}

describe("evidence paths end to end (calculator, auditor and corrections unchanged)", () => {
	it("Wipro's ₹12.25 EPS claim: bound by code, zero Evidence model calls, figures differ (₹12.52), audit complete", async () => {
		const text = "Wipro Limited reported diluted earnings per share of ₹12.25 for its fiscal year ended March 31, 2025."
		const { res, evidenceCalls, seen } = await run(text, {
			"extractor:article": [call("submit_claim", { quote: text.slice(0, -1), metric: "eps_diluted", accounting: "unspecified", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "12.25", statedUnit: "per_share", scale: "units", qualifier: "exact" }), say("1 claim")],
			"context:c1@r1": [say("no context issues")],
			"auditor:c1@r1.e1": [call("approve", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, note: "faithful reading" }), say("done")],
		})
		const s = res.state
		expect(res.timedOut).toBe(false)
		expect(evidenceCalls).toBe(0)
		expect(res.tasks.all().some((t) => t.role === "evidence")).toBe(false)
		expect(s.bindings.get("c1")).toMatchObject({ currentFactId: "DilutedEarningsLossPerShare/FY-FY2025/25-076303", boundBy: "evidence (code: single statement figure)" })
		expect(s.calcs.get("c1")).toMatchObject({ verdict: "MISMATCH", actualDisplay: "₹12.52 per share", statedDisplay: "₹12.25 per share" })
		expect(s.audits.get("c1")!.state).toMatchObject({ status: "approved" })
		expect(s.isSettled("c1")).toBe(true)
		// the model calls were the extractor, the context review and the auditor: nothing else
		expect(new Set(seen.map((x) => x.task.split(":")[0]))).toEqual(new Set(["extractor", "context", "auditor"]))
	}, 30_000)

	it("a year-over-year claim: candidates preloaded, bound on the agent's first turn (no search)", async () => {
		const text = "Net profit attributable to shareholders rose 18.9% for the financial year ended March 31, 2025."
		const { res, seen, evidenceCalls } = await run(text, {
			"extractor:article": [call("submit_claim", { quote: "Net profit attributable to shareholders rose 18.9%", metric: "net_income", accounting: "unspecified", kind: "change", comparison: "unspecified", direction: "increase", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "18.9", statedUnit: "percent", scale: "units", qualifier: "exact" }), say("1 claim")],
			"evidence:c1@r1#1": [call("bind_evidence", { claimId: "c1", claimRevision: 1, currentFactId: "ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303", baseFactId: "ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303" }), say("done")],
			"context:c1@r1": [say("no context issues")],
			"auditor:c1@r1.e1": [call("approve", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, note: "ok" }), say("done")],
		})
		const first = seen.find((x) => x.task === "evidence:c1@r1#1")!
		expect(first.context).toMatch(/Candidate facts from the reference/)
		expect(first.context).toContain("ProfitLossAttributableToOwnersOfParent/FY-FY2025/25-076303")
		expect(first.context).toContain("ProfitLossAttributableToOwnersOfParent/FY-FY2024/25-076303")
		expect(evidenceCalls).toBe(2) // bind, then "done"
		expect(res.state.calcs.get("c1")).toMatchObject({ verdict: "MATCH", actualDisplay: "+18.92%" })
		expect(res.state.isSettled("c1")).toBe(true)
	}, 30_000)

	it("a conflicting (restated) filing goes to the agent with both figures, and the restatement is flagged", async () => {
		const text = "Wipro's diluted earnings per share were ₹20.82 for the financial year ended March 31, 2024."
		const { res, seen } = await run(text, {
			"extractor:article": [call("submit_claim", { quote: "diluted earnings per share were ₹20.82", metric: "eps_diluted", accounting: "unspecified", kind: "level", fiscalYear: 2024, fiscalPeriod: "FY", statedNumber: "20.82", statedUnit: "per_share", scale: "units", qualifier: "exact" }), say("1 claim")],
			"evidence:c1@r1#1": [call("bind_evidence", { claimId: "c1", claimRevision: 1, currentFactId: "DilutedEarningsLossPerShare/FY-FY2024/24-063468" }), say("done")],
			"context:c1@r1": [say("no context issues")],
			"auditor:c1@r1.e1": [call("approve", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, note: "as first reported; restated after the bonus issue" }), say("done")],
		})
		const first = seen.find((x) => x.task === "evidence:c1@r1#1")!
		expect(first.context).toMatch(/conflicting figures for FY-FY2024/)
		expect(first.context).toContain("DilutedEarningsLossPerShare/FY-FY2024/24-063468")
		expect(first.context).toContain("DilutedEarningsLossPerShare/FY-FY2024/25-076303")
		const s = res.state
		expect(s.bindings.get("c1")?.boundBy).toBe("evidence-agent")
		expect(s.calcs.get("c1")).toMatchObject({ verdict: "MATCH" })
		expect((s.warnings.get("c1") ?? []).map((w) => w.code)).toContain("RESTATED")
		expect(s.isSettled("c1")).toBe(true)
	}, 30_000)

	it("an auditor's evidence correction on a code binding still reaches the Evidence agent", async () => {
		const text = "Wipro Limited reported diluted earnings per share of ₹12.25 for its fiscal year ended March 31, 2025."
		const { res, seen } = await run(text, {
			"extractor:article": [call("submit_claim", { quote: text.slice(0, -1), metric: "eps_diluted", accounting: "unspecified", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "12.25", statedUnit: "per_share", scale: "units", qualifier: "exact" }), say("1 claim")],
			"context:c1@r1": [say("no context issues")],
			"auditor:c1@r1.e1": [call("request_correction", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, target: "evidence", reason: "check the basic vs diluted line" }), say("done")],
			"evidence:c1@r1#1": [call("bind_evidence", { claimId: "c1", claimRevision: 1, currentFactId: "DilutedEarningsLossPerShare/FY-FY2025/25-076303" }), say("rebound the diluted figure")],
			"auditor:c1@r1.e2": [call("approve", { claimId: "c1", claimRevision: 1, evidenceRevision: 2, note: "diluted line confirmed" }), say("done")],
		})
		const fix = seen.find((x) => x.task === "evidence:c1@r1#1")!
		expect(fix.context).toMatch(/CORRECTION REQUEST/)
		expect(fix.context).toContain("DilutedEarningsLossPerShare/FY-FY2025/25-076303")
		expect(res.state.bindings.get("c1")).toMatchObject({ evidenceRevision: 2, boundBy: "evidence-agent" })
		expect(res.state.calcs.get("c1")).toMatchObject({ verdict: "MISMATCH", evidenceRevision: 2 })
		expect(res.state.isSettled("c1")).toBe(true)
	}, 30_000)
})
