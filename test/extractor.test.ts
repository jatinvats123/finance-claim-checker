/**
 * Anchoring guard: interpretations must say what the article says. Found by a live Gemini run where
 * the auditor asked to "correct" an article's "$177.8 million" to billion, hiding the article's error.
 */
import { describe, expect, it } from "vitest"
import { validateInterpretation } from "../src/agents/extractor.js"
import { readArticle } from "../src/article.js"

const { text } = readArticle("data/articles/nvda-q2-fy2027.md")
const base = { accounting: "unspecified", qualifier: "exact", fiscalYear: 2027, fiscalPeriod: "Q2" }
const level = (o: Record<string, unknown>) => ({ ...base, kind: "level", statedUnit: "usd", scale: "units", metric: "revenue", ...o })
const change = (o: Record<string, unknown>) => ({ ...base, kind: "change", direction: "increase", statedUnit: "percent", scale: "units", metric: "revenue", ...o })

describe("anchoring guard", () => {
	it("keeps the article's scale: a units error cannot be revised away", () => {
		const q = "For the first half of fiscal 2027, revenue totaled $177.8 million"
		expect(() => validateInterpretation(level({ quote: q, fiscalPeriod: "H1", statedNumber: "177.8", scale: "million" }), text)).not.toThrow()
		expect(() => validateInterpretation(level({ quote: q, fiscalPeriod: "H1", statedNumber: "177.8", scale: "billion" }), text)).toThrow(/scale "billion" does not match the article.*"million"/)
	})

	it("requires units when no scale word follows, and units for per-share values", () => {
		const q = "diluted earnings per share came in at $2.46"
		expect(() => validateInterpretation(level({ quote: q, metric: "eps_diluted", statedUnit: "usd_per_share", statedNumber: "2.46" }), text)).not.toThrow()
		expect(() => validateInterpretation(level({ quote: q, metric: "eps_diluted", statedUnit: "usd_per_share", statedNumber: "2.46", scale: "billion" }), text)).toThrow()
		expect(() => validateInterpretation(level({ quote: "Nvidia reported revenue of $96.2 billion", statedNumber: "96.2", scale: "units" }), text)).toThrow(/scale "units"/)
	})

	it("matches the number as a whole number, not inside another one", () => {
		expect(() => validateInterpretation(level({ quote: "diluted earnings per share came in at $2.46", metric: "eps_diluted", statedUnit: "usd_per_share", statedNumber: "2" }), text)).toThrow(/does not appear as a number/)
	})

	it("a percentage needs a % sign; a multiple needs multiple wording", () => {
		expect(() => validateInterpretation(change({ quote: "rising 126%", comparison: "yoy", statedNumber: "126" }), text)).not.toThrow()
		expect(() => validateInterpretation(change({ quote: "revenue of $96.2 billion", comparison: "unspecified", statedNumber: "96.2" }), text)).toThrow(/percent/)
		expect(() => validateInterpretation(change({ quote: "Revenue more than doubled from a year earlier", comparison: "yoy", statedNumber: "2", statedUnit: "multiple", qualifier: "more_than" }), text)).not.toThrow()
		expect(() => validateInterpretation(change({ quote: "rising 126%", comparison: "yoy", statedNumber: "2", statedUnit: "multiple" }), text)).toThrow(/doubled/)
	})

	it("a comparison basis must be stated in the sentence (the quote alone may be shorter)", () => {
		// "from a year earlier" is in the sentence, not in the short quote
		expect(() => validateInterpretation(change({ quote: "rising 126%", comparison: "yoy", statedNumber: "126" }), text)).not.toThrow()
		// "Net income climbed 18% ..." states no basis
		expect(() => validateInterpretation(change({ quote: "Net income climbed 18%", metric: "net_income", comparison: "yoy", statedNumber: "18" }), text)).toThrow(/year-over-year.*unspecified/)
		expect(() => validateInterpretation(change({ quote: "Net income climbed 18%", metric: "net_income", comparison: "qoq", statedNumber: "18" }), text)).toThrow(/quarter-over-quarter/)
		expect(() => validateInterpretation(change({ quote: "Net income climbed 18%", metric: "net_income", comparison: "unspecified", statedNumber: "18" }), text)).not.toThrow()
	})
})
