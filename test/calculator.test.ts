import { describe, expect, it } from "vitest"
import { calculate } from "../src/domain/calculator.js"
import type { ClaimInterpretation } from "../src/domain/types.js"
import type { EvidenceFact } from "../src/sec/evidence.js"

const meta = { claimId: "c1", claimRevision: 1, evidenceRevision: 1 }

function fact(value: number, o: Partial<EvidenceFact> = {}): EvidenceFact {
	return {
		id: o.id ?? `X/${value}`,
		concept: "us-gaap:Revenues",
		unit: "USD",
		value,
		start: "2026-04-27",
		end: "2026-07-26",
		days: 91,
		durationClass: "quarter",
		fiscalYear: 2027,
		fiscalPeriod: "Q2",
		form: "10-Q",
		accn: "0000000000-26-000001",
		filed: "2026-08-26",
		isOriginal: true,
		filingUrl: "",
		documentUrl: "",
		...o,
	}
}

function claim(o: Partial<ClaimInterpretation>): ClaimInterpretation {
	return {
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
	}
}

describe("level claims", () => {
	it("matches within the rounding of the stated digits", () => {
		expect(calculate(meta, claim({}), fact(96_221_000_000)).verdict).toBe("MATCH")
		expect(calculate(meta, claim({ statedNumber: "96.3" }), fact(96_221_000_000)).verdict).toBe("MISMATCH")
		// "96" billion tolerates ±0.5B; "96.2" only ±0.05B
		expect(calculate(meta, claim({ statedNumber: "96" }), fact(96_221_000_000)).verdict).toBe("MATCH")
		expect(calculate(meta, claim({ statedNumber: "96.0" }), fact(96_221_000_000)).verdict).toBe("MISMATCH")
	})

	it("flags a million/billion units error instead of silently matching", () => {
		const r = calculate(meta, claim({ statedNumber: "177.8", scale: "million" }), fact(177_837_000_000))
		expect(r.verdict).toBe("MISMATCH")
		expect(r.notes.join(" ")).toMatch(/scale were "billion"/)
	})

	it("handles per-share values and rejects a dollar-scale reading of EPS", () => {
		const eps = fact(2.46, { concept: "us-gaap:EarningsPerShareDiluted", unit: "USD/shares" })
		expect(calculate(meta, claim({ metric: "eps_diluted", statedNumber: "2.46", statedUnit: "usd_per_share", scale: "units" }), eps).verdict).toBe("MATCH")
		expect(calculate(meta, claim({ metric: "eps_diluted", statedNumber: "2.46", statedUnit: "usd", scale: "units" }), eps).verdict).toBe("NOT_COMPUTABLE")
		expect(calculate(meta, claim({ metric: "eps_diluted", statedNumber: "2.46", statedUnit: "usd_per_share", scale: "units" }), fact(2.46)).verdict).toBe("NOT_COMPUTABLE") // USD fact for EPS
	})

	it("applies qualifiers", () => {
		expect(calculate(meta, claim({ statedNumber: "90", qualifier: "more_than" }), fact(96_221_000_000)).verdict).toBe("MATCH")
		expect(calculate(meta, claim({ statedNumber: "100", qualifier: "more_than" }), fact(96_221_000_000)).verdict).toBe("MISMATCH")
		expect(calculate(meta, claim({ statedNumber: "97", qualifier: "about" }), fact(96_221_000_000)).verdict).toBe("MATCH") // within 1%
		expect(calculate(meta, claim({ statedNumber: "98", qualifier: "about" }), fact(96_221_000_000)).verdict).toBe("MISMATCH")
	})

	it("never compares an adjusted (non-GAAP) figure with GAAP evidence", () => {
		const r = calculate(meta, claim({ accounting: "non_gaap", statedNumber: "96.2" }), fact(96_221_000_000))
		expect(r.verdict).toBe("NOT_VERIFIABLE")
		expect(r.inputs).toEqual([])
	})
})

describe("change claims", () => {
	const change = (o: Partial<ClaimInterpretation>) => claim({ kind: "change", comparison: "yoy", direction: "increase", statedUnit: "percent", scale: "units", ...o })

	it("computes percentage change with stated-precision tolerance and shows the formula from evidence ids", () => {
		const cur = fact(96_221_000_000, { id: "R/Q2-FY2027" })
		const base = fact(46_743_000_000, { id: "R/Q2-FY2026" })
		const ok = calculate(meta, change({ statedNumber: "106" }), cur, base)
		expect(ok.verdict).toBe("MATCH")
		expect(ok.actual).toBeCloseTo(105.85, 2)
		expect(ok.formula).toContain("R/Q2-FY2027")
		expect(ok.substituted).toContain("96,221,000,000")
		expect(calculate(meta, change({ statedNumber: "126" }), cur, base).verdict).toBe("MISMATCH")
		expect(calculate(meta, change({ statedNumber: "105" }), cur, base).verdict).toBe("MISMATCH") // 0.85pp > ±0.5
		expect(calculate(meta, change({ statedNumber: "105.9" }), cur, base).verdict).toBe("MATCH") // ±0.05
	})

	it("respects direction", () => {
		const r = calculate(meta, change({ statedNumber: "10", direction: "decrease" }), fact(90), fact(100))
		expect(r.verdict).toBe("MATCH")
		expect(calculate(meta, change({ statedNumber: "10", direction: "increase" }), fact(90), fact(100)).verdict).toBe("MISMATCH")
	})

	it("refuses a percentage from a zero base", () => {
		const r = calculate(meta, change({ statedNumber: "50" }), fact(10), fact(0))
		expect(r.verdict).toBe("NOT_COMPUTABLE")
		expect(r.notes[0]).toMatch(/zero/)
	})

	it("refuses a percentage from a negative base and reports the absolute change", () => {
		const r = calculate(meta, change({ statedNumber: "300" }), fact(200_000_000), fact(-100_000_000))
		expect(r.verdict).toBe("NOT_COMPUTABLE")
		expect(r.notes[0]).toMatch(/negative/)
		expect(r.notes[0]).toMatch(/\$300\.000M/)
	})

	it("handles multiples (doubled / more than doubled)", () => {
		expect(calculate(meta, change({ statedNumber: "2", statedUnit: "multiple", qualifier: "more_than" }), fact(96.2), fact(46.7)).verdict).toBe("MATCH")
		expect(calculate(meta, change({ statedNumber: "2", statedUnit: "multiple" }), fact(96.2), fact(46.7)).verdict).toBe("MATCH") // 2.06× within ±5%
		expect(calculate(meta, change({ statedNumber: "3", statedUnit: "multiple" }), fact(96.2), fact(46.7)).verdict).toBe("MISMATCH")
	})

	it("needs base evidence and consistent units", () => {
		expect(calculate(meta, change({ statedNumber: "10" }), fact(10)).verdict).toBe("NOT_COMPUTABLE")
		expect(calculate(meta, change({ statedNumber: "10" }), fact(10), fact(9, { unit: "USD/shares" })).verdict).toBe("NOT_COMPUTABLE")
	})
})
