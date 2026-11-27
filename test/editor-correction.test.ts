import { describe, expect, it } from "vitest"
import { correctionPreview, correctionText, filingRow, receiptConversion } from "../web/src/correction.js"
import type { CalcInput, ClaimView, ReferenceView } from "../src/web/types.js"

const apple: CalcInput = {
	evidenceId: "NetIncomeLoss/Q3-FY2016/16-017809", role: "current", concept: "us-gaap:NetIncomeLoss", value: 7796000000, unit: "USD",
	period: "Q3-FY2016", start: "2016-03-27", end: "2016-06-25", form: "10-Q", accn: "0001628280-16-017809", filed: "2016-07-27",
	url: "https://www.sec.gov/Archives/edgar/data/320193/000162828016017809/a10-qq320166252016.htm", currency: "USD", consolidation: "consolidated",
}
const wipro: CalcInput = {
	evidenceId: "ProfitLossFromOperatingActivities/FY-FY2025/25-076303", role: "current", concept: "ifrs-full:ProfitLossFromOperatingActivities", value: 151271000000, unit: "INR",
	period: "FY-FY2025", start: "2024-04-01", end: "2025-03-31", form: "20-F", accn: "0000950170-25-076303", filed: "2025-05-22",
	url: "https://www.sec.gov/Archives/edgar/data/1123799/000095017025076303/wit-20250331.htm", currency: "INR", consolidation: "consolidated",
}
const run = { reference: { entityName: "Apple Inc." } as ReferenceView }
const quote = "Apple Inc. reported net income of $10.5 billion for its fiscal third quarter ended June 25, 2016."
function claim(input = apple, text = quote): ClaimView {
	return {
		id: "c1", revision: 1, quote: text, metricLabel: input === wipro ? "Operating income" : "Net income",
		interpretation: { quote: text, metric: input === wipro ? "operating_income" : "net_income", accounting: "gaap", kind: "level", fiscalYear: input === wipro ? 2025 : 2016, fiscalPeriod: input === wipro ? "FY" : "Q3", statedNumber: input === wipro ? "151271" : "10.5", scale: input === wipro ? "crore" : "billion", statedUnit: "money", qualifier: "exact", currency: input.currency },
		review: { status: "complete", label: "", detail: "" }, verdict: "MISMATCH", warnings: [],
		calc: { evidenceRevision: 1, actualDisplay: input === wipro ? "₹15,127.1 crore" : "$7.796B", inputs: [input], statedDisplay: "", formula: "", substituted: "", notes: [] },
	} as unknown as ClaimView
}

describe("editor corrections and filing receipts", () => {
	it("preserves Apple’s fiscal period, full words and original precision with a separate exact option", () => {
		const c = claim()
		expect(correctionPreview(run, c)?.suggestion).toBe(quote.replace("$10.5", "$7.8"))
		expect(correctionText(run, c, "filing")).toContain("Suggested edit: " + quote.replace("$10.5", "$7.796"))
		expect(correctionText(run, c)).toContain("7,796 (USD in millions)")
		expect(receiptConversion(c, apple)).toBe("USD 7,796 million ÷ 1,000 = USD 7.796 billion")
	})
	it("keeps the Indian grouping style and shows both the rounded and exact crore values", () => {
		const text = "Operating profit was ₹1,51,271 crore for the year."
		const c = claim(wipro, text)
		expect(correctionPreview(run, c)?.suggestion).toBe("Operating profit was ₹15,127 crore for the year.")
		expect(receiptConversion(c, wipro)).toBe("INR 151,271 million ÷ 10 = INR 15,127.1 crore")
		expect(correctionText(run, c, "filing")).toContain("Suggested edit: Operating profit was ₹15,127.1 crore for the year.")
		expect(correctionText(run, c)).toContain("Results from operating activities · 151,271 (₹ in millions)")
	})
	it("never substitutes digits seen twice in the quote, mismatched scales or a bounded amount", () => {
		for (const text of ["Net income was $10.5 billion against an estimate of $10.5 billion.", "Net income was $10.5 million.", "Net income was more than $10.5 billion.", "Net income was $10.5 billion against a $9 billion estimate.", "Net loss was $10.5 billion."]) {
			const preview = correctionPreview(run, claim(apple, text))
			expect(preview?.replacement).toBeUndefined()
			expect(preview?.suggestion).toContain("Apple Inc. reported net income")
		}
	})
	it("retains full precision for small nonzero amounts rather than displaying zero", () => {
		const c = claim({ ...apple, value: 1100000 })
		expect(correctionPreview(run, c)?.suggestion).toBe(quote.replace("$10.5", "$0.0011"))
	})
	it("requires accession, dates, unit, line and value to match before attributing a printed SEC row", () => {
		expect(filingRow(apple)?.row).toBe("Net income")
		for (const field of [{ accn: "other" }, { consolidation: "standalone" }, { value: apple.value + 1 }, { concept: "us-gaap:OperatingIncomeLoss" }, { unit: "INR" }, { start: "2015-03-27" }])
			expect(filingRow({ ...apple, ...field })).toBeUndefined()
	})
	it("copies actual PDF positions and gives generic SEC facts their machine-readable concept only", () => {
		const pdf = { ...apple, form: "report", location: { page: 3, row: "Profit after tax", column: "Quarter to June", printed: "77.96", unitNote: "USD in 100 millions" } }
		expect(filingRow(pdf)?.row).toBe("Profit after tax")
		expect(correctionText(run, claim(pdf))).toContain("Report page 3 · Quarter to June · Profit after tax · 77.96 (USD in 100 millions)")
		const other = correctionText(run, claim({ ...apple, accn: "some-other-filing" }))
		expect(other).toContain("us-gaap:NetIncomeLoss")
		expect(other).not.toContain("USD in millions")
	})
	it("withholds every correction if a required source of a derived figure is missing", () => {
		const c = claim({ ...apple, derivation: "FY − 9M" })
		expect(correctionText(run, c)).toBeUndefined()
	})
})
