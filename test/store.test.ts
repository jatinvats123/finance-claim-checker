import { describe, expect, it } from "vitest"
import { calculate } from "../src/domain/calculator.js"
import { CheckerState } from "../src/domain/store.js"
import type { ClaimInterpretation } from "../src/domain/types.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"

const registry = new EvidenceRegistry(loadSnapshot("NVDA"))
const REV_Q2 = registry.search("revenue", 2027, "Q2")[0].id
const REV_Q1 = registry.search("revenue", 2027, "Q1")[0].id
const NI_Q2 = registry.search("net_income", 2027, "Q2")[0].id

const interp = (o: Partial<ClaimInterpretation> = {}): ClaimInterpretation => ({
	quote: "q",
	metric: "revenue",
	accounting: "unspecified",
	kind: "level",
	fiscalYear: 2027,
	fiscalPeriod: "Q2",
	statedNumber: "96.2",
	statedUnit: "usd",
	scale: "billion",
	qualifier: "exact",
	...o,
})

function fresh() {
	const s = new CheckerState()
	s.registry = registry
	return s
}

const calcFor = (s: CheckerState, claimId: string, claimRevision: number, evidenceRevision: number) => {
	const c = s.claims.get(claimId)!
	const b = s.bindings.get(claimId)!
	return calculate({ claimId, claimRevision, evidenceRevision }, c.interpretation, registry.get(b.currentFactId!), undefined)
}

describe("versioned claims and evidence", () => {
	it("rejects a calculation computed for an outdated claim revision, and keeps other claims intact", () => {
		const s = fresh()
		const a = s.addClaim(interp())
		const b = s.addClaim(interp({ metric: "net_income", statedNumber: "59.7" }))
		s.bindEvidence({ claimId: a.id, claimRevision: 1, currentFactId: REV_Q2, boundBy: "t" })
		s.bindEvidence({ claimId: b.id, claimRevision: 1, currentFactId: NI_Q2, boundBy: "t" })
		const lateCalc = calcFor(s, a.id, 1, 1)
		expect(s.acceptCalculation(calcFor(s, b.id, 1, 1), []).ok).toBe(true)

		// claim a is revised while its calculation is in flight
		expect(s.reviseClaim(a.id, 1, interp({ statedNumber: "96" }), "fix").ok).toBe(true)
		const res = s.acceptCalculation(lateCalc, [])
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.stale).toBe(true)
		expect(s.bindings.has(a.id)).toBe(false) // old evidence invalidated
		expect(s.calcs.has(b.id)).toBe(true) // unaffected claim preserved
		expect(s.bindings.get(b.id)!.evidenceRevision).toBe(1)
		expect(s.staleRejections).toHaveLength(1)
	})

	it("new evidence invalidates the old calculation and audit; late results for the old evidence are rejected", () => {
		const s = fresh()
		const a = s.addClaim(interp())
		s.bindEvidence({ claimId: a.id, claimRevision: 1, currentFactId: REV_Q1, boundBy: "t" })
		expect(s.acceptCalculation(calcFor(s, a.id, 1, 1), []).ok).toBe(true)
		const lateCalc = calcFor(s, a.id, 1, 1)

		s.bindEvidence({ claimId: a.id, claimRevision: 1, currentFactId: REV_Q2, boundBy: "t" })
		expect(s.bindings.get(a.id)!.evidenceRevision).toBe(2)
		expect(s.calcs.has(a.id)).toBe(false)
		expect(s.audits.get(a.id)!.state.status).toBe("pending")

		expect(s.acceptCalculation(lateCalc, []).ok).toBe(false)
		expect(s.setAudit(a.id, 1, 1, { status: "approved", note: "late", by: "t" }).ok).toBe(false)
		expect(s.acceptCalculation(calcFor(s, a.id, 1, 2), []).ok).toBe(true)
		expect(s.setAudit(a.id, 1, 2, { status: "approved", note: "ok", by: "t" }).ok).toBe(true)
		expect(s.calcs.get(a.id)!.verdict).toBe("MATCH")
	})

	it("rejects a context warning and a context completion for an old claim revision", () => {
		const s = fresh()
		const a = s.addClaim(interp())
		s.reviseClaim(a.id, 1, interp({ statedNumber: "96" }), "fix")
		expect(s.addWarning({ claimId: a.id, claimRevision: 1, source: "context-agent", code: "OTHER", message: "late" }).ok).toBe(false)
		expect(s.finishContext(a.id, 1).ok).toBe(false)
		expect(s.addWarning({ claimId: a.id, claimRevision: 2, source: "context-agent", code: "OTHER", message: "fresh" }).ok).toBe(true)
		expect(s.warnings.get(a.id)!.map((w) => w.message)).toEqual(["fresh"])
	})

	it("rejects evidence ids that do not exist (no model-invented references)", () => {
		const s = fresh()
		const a = s.addClaim(interp())
		const r = s.bindEvidence({ claimId: a.id, claimRevision: 1, currentFactId: "Revenues/Q2-FY2027/made-up", boundBy: "t" })
		expect(r.ok).toBe(false)
		expect(s.bindings.has(a.id)).toBe(false)
	})

	it("a final audit cannot be overwritten, and approval needs a calculation", () => {
		const s = fresh()
		const a = s.addClaim(interp())
		s.bindEvidence({ claimId: a.id, claimRevision: 1, currentFactId: REV_Q2, boundBy: "t" })
		expect(s.setAudit(a.id, 1, 1, { status: "approved", note: "x", by: "t" }).ok).toBe(false)
		s.acceptCalculation(calcFor(s, a.id, 1, 1), [])
		expect(s.setAudit(a.id, 1, 1, { status: "approved", note: "x", by: "t" }).ok).toBe(true)
		expect(s.setAudit(a.id, 1, 1, { status: "unresolved", reason: "y" }).ok).toBe(false)
	})
})
