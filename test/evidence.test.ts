/** Uses the committed NVIDIA SEC snapshot (real public data). */
import { describe, expect, it } from "vitest"
import { loadSnapshot, SecDataMissing } from "../src/sec/edgar.js"
import { basePeriod, EvidenceRegistry } from "../src/sec/evidence.js"

const reg = new EvidenceRegistry(loadSnapshot("NVDA"))

describe("evidence registry (NVDA snapshot)", () => {
	it("contains only 10-Q/10-K facts — never an 8-K earnings release", () => {
		expect(reg.all().every((f) => /^10-[QK]/.test(f.form))).toBe(true)
	})

	it("separates the quarter from the year-to-date figure in the same 10-Q", () => {
		const q = reg.search("revenue", 2027, "Q2")
		const h1 = reg.search("revenue", 2027, "H1")
		expect(q[0].days).toBe(91)
		expect(q[0].value).toBe(96_221_000_000)
		expect(h1[0].days).toBe(182)
		expect(h1[0].value).toBe(177_837_000_000)
		expect(q[0].accn).toBe(h1[0].accn)
	})

	it("identifies periods from dates, not from the filing's fy/fp tags", () => {
		// The Q2 FY2027 10-Q tags every fact fy=2027, including its prior-year comparatives.
		const comparative = reg.search("revenue", 2026, "Q2").find((f) => f.accn === "0001045810-26-000075")!
		expect(comparative.value).toBe(46_743_000_000)
		expect(comparative.isOriginal).toBe(false)
		expect(comparative.end).toBe("2025-07-27")
	})

	it("derives Q4 as FY − 9M for dollar values only, and says so", () => {
		const q4 = reg.search("revenue", 2026, "Q4")[0]
		expect(q4.derivation?.formula).toContain("Revenues/FY-FY2026")
		expect(q4.value).toBe(215_938_000_000 - 147_811_000_000)
		expect(reg.search("eps_diluted", 2026, "Q4")).toEqual([]) // share counts differ; not derivable
	})

	it("knows when no 10-Q/10-K covers a period and finds the earnings release it must not use", () => {
		expect(reg.hasReferenceFor(2027, "Q2")).toBe(true)
		expect(reg.hasReferenceFor(2027, "Q3")).toBe(false)
		const releases = reg.earningsReleasesAfterLatestReport()
		expect(releases.map((r) => r.accessionNumber)).toContain("0001045810-26-000088")
		expect(releases.every((r) => r.form.startsWith("8-K") && r.items.includes("2.02"))).toBe(true)
	})

	it("detects restated / split-adjusted values", () => {
		const restated = reg.all().filter((f) => f.concept.includes("EarningsPerShare") && reg.restatementsOf(f).length > 0)
		expect(restated.length).toBeGreaterThan(0)
	})

	it("an unknown ticker is an explicit cache miss", () => {
		expect(() => loadSnapshot("ZZZZ")).toThrow(SecDataMissing)
	})
})

describe("comparison periods", () => {
	it("maps YoY and QoQ bases, including across fiscal years", () => {
		expect(basePeriod(2027, "Q2", "yoy")).toEqual({ fy: 2026, fp: "Q2" })
		expect(basePeriod(2027, "Q2", "qoq")).toEqual({ fy: 2027, fp: "Q1" })
		expect(basePeriod(2027, "Q1", "qoq")).toEqual({ fy: 2026, fp: "Q4" })
		expect(basePeriod(2027, "FY", "qoq")).toBeUndefined()
		expect(basePeriod(2027, "H1", "yoy")).toEqual({ fy: 2026, fp: "H1" })
	})
})
