import { describe, expect, it } from "vitest"
import { calculate } from "../src/domain/calculator.js"
import { auditGate, ruleWarnings } from "../src/domain/checks.js"
import type { Claim, ClaimInterpretation, EvidenceBinding } from "../src/domain/types.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { basePeriod, EvidenceRegistry, type EvidenceFact } from "../src/sec/evidence.js"

const reg = new EvidenceRegistry(loadSnapshot("NVDA"))
const id = (metric: Parameters<typeof reg.search>[0], fy: number, fp: Parameters<typeof reg.search>[2], accn?: string) => {
	const hits = reg.search(metric, fy, fp)
	return (accn ? hits.find((f) => f.accn.endsWith(accn)) : hits[0])!.id
}

function setup(interp: Partial<ClaimInterpretation>, b: Partial<EvidenceBinding>) {
	const claim: Claim = {
		id: "c1",
		revision: 1,
		reason: "extracted",
		correctionsUsed: 0,
		interpretation: { quote: "q", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "96.2", statedUnit: "usd", scale: "billion", qualifier: "exact", ...interp },
	}
	const binding: EvidenceBinding = { claimId: "c1", claimRevision: 1, evidenceRevision: 1, boundBy: "test", ...b }
	const calc = calculate({ claimId: "c1", claimRevision: 1, evidenceRevision: 1 }, claim.interpretation, b.currentFactId ? reg.get(b.currentFactId) : undefined, b.baseFactId ? reg.get(b.baseFactId) : undefined)
	return { claim, binding, calc, gate: auditGate(claim, binding, calc, reg), warnings: ruleWarnings(claim, binding, calc, reg) }
}

const change = { kind: "change" as const, comparison: "yoy" as const, direction: "increase" as const, statedUnit: "percent" as const, scale: "units" as const, statedNumber: "106" }

describe("auditor rule gate", () => {
	it("passes correctly bound evidence", () => {
		expect(setup({}, { currentFactId: id("revenue", 2027, "Q2") }).gate.ok).toBe(true)
		expect(setup(change, { currentFactId: id("revenue", 2027, "Q2"), baseFactId: id("revenue", 2026, "Q2", "26-000075") }).gate.ok).toBe(true)
	})

	it("blocks a year-to-date figure bound to a quarterly claim (quarterly vs annual/YTD)", () => {
		const g = setup({}, { currentFactId: id("revenue", 2027, "H1") }).gate
		expect(g.ok).toBe(false)
		if (!g.ok) expect(g.target).toBe("evidence")
	})

	it("blocks the previous quarter used as a year-over-year base (YoY vs QoQ)", () => {
		const g = setup(change, { currentFactId: id("revenue", 2027, "Q2"), baseFactId: id("revenue", 2027, "Q1") }).gate
		expect(g.ok).toBe(false)
		if (!g.ok) expect(g.reason).toMatch(/YOY base must be Q2-FY2026/)
	})

	it("blocks a line item that does not match the metric", () => {
		const g = setup({ metric: "net_income" }, { currentFactId: id("revenue", 2027, "Q2") }).gate
		expect(g.ok).toBe(false)
	})

	it("requires the comparative as presented in the current filing when values differ (stock splits)", () => {
		// Find a quarter whose prior-year EPS was later presented split-adjusted.
		let found: { cur: EvidenceFact; original: EvidenceFact; sameFiling: EvidenceFact } | undefined
		for (const cur of reg.all().filter((f) => f.concept === "us-gaap:EarningsPerShareDiluted" && f.isOriginal && f.durationClass === "quarter")) {
			const bp = basePeriod(cur.fiscalYear, cur.fiscalPeriod, "yoy")!
			const cands = reg.search("eps_diluted", bp.fy, bp.fp)
			const sameFiling = cands.find((f) => f.accn === cur.accn)
			const original = cands.find((f) => f.isOriginal)
			if (sameFiling && original && sameFiling.value !== original.value) {
				found = { cur, original, sameFiling }
				break
			}
		}
		expect(found).toBeDefined()
		const { cur, original, sameFiling } = found!
		const base = { metric: "eps_diluted" as const, fiscalYear: cur.fiscalYear, fiscalPeriod: cur.fiscalPeriod, ...change }
		const wrong = setup(base, { currentFactId: cur.id, baseFactId: original.id })
		expect(wrong.gate.ok).toBe(false)
		if (!wrong.gate.ok) expect(wrong.gate.reason).toContain(sameFiling.id)
		expect(wrong.warnings.map((w) => w.code)).toContain("RESTATED")
		expect(setup(base, { currentFactId: cur.id, baseFactId: sameFiling.id }).gate.ok).toBe(true)
	})

	it("verifies no-reference claims deterministically", () => {
		const filed = setup({}, { noReference: { status: "REFERENCE_NOT_YET_FILED", detail: "" } })
		expect(filed.gate.ok).toBe(false) // Q2 FY2027 has a 10-Q
		expect(setup({ fiscalPeriod: "Q3" }, { noReference: { status: "REFERENCE_NOT_YET_FILED", detail: "" } }).gate.ok).toBe(true)
		expect(setup({}, { noReference: { status: "NOT_IN_STATEMENTS", detail: "" } }).gate.ok).toBe(false) // GAAP revenue is in the statements
		expect(setup({ accounting: "non_gaap" }, { noReference: { status: "NOT_IN_STATEMENTS", detail: "" } }).gate.ok).toBe(true)
	})

	it("sends a stated-unit misreading back to the extractor", () => {
		const g = setup({ statedUnit: "percent" }, { currentFactId: id("revenue", 2027, "Q2") }).gate
		expect(g.ok).toBe(false)
		if (!g.ok) expect(g.target).toBe("claim")
	})
})

describe("rule context warnings", () => {
	it("shows the alternative basis when the article does not state one", () => {
		const { warnings } = setup(
			{ ...change, metric: "net_income", comparison: "unspecified", statedNumber: "18" },
			{ currentFactId: id("net_income", 2027, "Q2"), baseFactId: id("net_income", 2026, "Q2", "26-000075"), alternateBaseFactId: id("net_income", 2027, "Q1") },
		)
		const basis = warnings.find((w) => w.code === "BASIS_UNSTATED")!
		expect(basis.message).toMatch(/\+2\.34%/)
		expect(warnings.map((w) => w.code)).toContain("GAAP_OR_ADJUSTED_UNSTATED")
	})

	it("points out a figure that belongs to another period (quarter vs. full year)", () => {
		const { calc, warnings } = setup({ fiscalYear: 2026, fiscalPeriod: "FY", statedNumber: "57.0" }, { currentFactId: id("revenue", 2026, "FY") })
		expect(calc.verdict).toBe("MISMATCH")
		expect(warnings.find((w) => w.code === "VALUE_MATCHES_OTHER_PERIOD")?.message).toMatch(/Q3-FY2026/)
	})

	it("keeps context separate from the numerical result", () => {
		const { calc, warnings } = setup({ accounting: "non_gaap" }, { noReference: { status: "NOT_IN_STATEMENTS", detail: "" } })
		expect(calc.verdict).toBe("NOT_VERIFIABLE")
		expect(warnings.map((w) => w.code)).toEqual(["NON_GAAP"])
	})
})
