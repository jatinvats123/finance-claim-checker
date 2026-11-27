import { describe, expect, it } from "vitest"
import { calculate } from "../src/domain/calculator.js"
import { CheckerState } from "../src/domain/store.js"
import type { ClaimInterpretation } from "../src/domain/types.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"
import { claimView, referenceView } from "../src/web/viewmodel.js"
import { correctionText } from "../web/src/correction.js"
import { readArticle } from "../src/article.js"

const registry = new EvidenceRegistry(loadSnapshot("WMT"))
const historical = "For the same year ended January 31, 2026, the draft puts consolidated operating income at $29.852 billion and diluted earnings per share at $2.73."
const adjusted = "The analyst memo also cites adjusted non-GAAP diluted earnings per share of $2.96 for FY2026."
const operatingIncome: ClaimInterpretation = {
	quote: historical, statedNumber: "29.852", metric: "operating_income", fiscalPeriod: "FY", fiscalYear: 2026,
	kind: "level", statedUnit: "money", scale: "billion", accounting: "gaap", currency: "USD", qualifier: "exact",
}
function review(text: string, claim: ClaimInterpretation, title = "Walmart fiscal-year totals") {
	const state = new CheckerState()
	state.article = { title, text, ticker: "WMT" }
	state.registry = registry
	state.referenceInfo = registry.info
	const current = state.addClaim(claim)
	const warning = (archived = false) => state.addWarning({
		claimId: current.id, claimRevision: 1, source: "context-agent", code: "FORWARD_LOOKING", message: "The draft projects this amount.",
	}, archived)
	return { state, current, warning }
}

describe("forecast scope and historical filing receipts", () => {
	it("dismisses both original Wipro paragraph warnings when the Extractor omits the reporting verb", () => {
		const state = new CheckerState()
		state.article = { ...readArticle("data/articles/wipro-mixed-desk.md"), ticker: "WIT" }
		state.registry = new EvidenceRegistry(loadSnapshot("WIT"))
		state.referenceInfo = state.registry.info
		const levels: ClaimInterpretation[] = [
			{ ...operatingIncome, quote: "consolidated operating income of ₹15,172.1 crore for the year ended March 31, 2025", fiscalYear: 2025, currency: "INR", statedNumber: "15172.1", scale: "crore" },
			{ ...operatingIncome, quote: "diluted earnings per share of ₹12.52 for the same year", fiscalYear: 2025, currency: "INR", statedNumber: "12.52", scale: "units", statedUnit: "per_share", metric: "eps_diluted" },
		]
		for (const level of levels) {
			const claim = state.addClaim(level)
			expect(state.addWarning({ claimId: claim.id, claimRevision: 1, source: "context-agent", code: "FORWARD_LOOKING",
				message: "The paragraph combines reported historical results with a speculative future forecast." })).toMatchObject({ dismissed: true })
		}
	})

	it("releases the filed Walmart operating-income correction only after both reviews", () => {
		const { state, current, warning } = review(historical + " " + adjusted, operatingIncome)
		const stamp = { claimId: current.id, claimRevision: 1, evidenceRevision: 1 }
		const fact = registry.search("operating_income", 2026, "FY").find(f => f.value === 29825000000)!
		state.bindEvidence({ ...stamp, currentFactId: fact.id, boundBy: "test" })
		state.acceptCalculation(calculate(stamp, operatingIncome, fact), [])
		expect(warning()).toMatchObject({ dismissed: true })
		state.finishContext(current.id, 1)
		const run = { reference: referenceView(state) }
		expect(correctionText(run, claimView(state, current, true))).toBeUndefined()
		state.setAudit(current.id, 1, 1, { status: "approved", by: "test", note: "checked" })
		const copy = correctionText(run, claimView(state, current, true))
		expect(copy).toMatch(/\$29\.825(?:B| billion)\b/)
		expect(copy).toContain("0000104169-26-000055")
	})

	it("keeps the attributed adjusted EPS outside GAAP even after dismissing a forecast warning", () => {
		const claim: ClaimInterpretation = { ...operatingIncome, quote: adjusted, metric: "eps_diluted", accounting: "non_gaap", statedNumber: "2.96", statedUnit: "per_share", scale: "units" }
		const { state, current, warning } = review(historical + " " + adjusted, claim)
		const stamp = { claimId: current.id, claimRevision: 1, evidenceRevision: 1 }
		state.bindEvidence({ ...stamp, noReference: { status: "NOT_IN_STATEMENTS", detail: "Adjusted EPS is outside GAAP." }, boundBy: "test" })
		state.acceptCalculation(calculate(stamp, claim), [])
		expect(warning()).toMatchObject({ dismissed: true })
		state.finishContext(current.id, 1)
		state.setAudit(current.id, 1, 1, { status: "approved", by: "test", note: "checked" })
		const view = claimView(state, current, true)
		expect(view.review.status).toBe("complete")
		expect(correctionText({ reference: referenceView(state) }, view)).toBeUndefined()
		expect(view.verdict).toBe("NOT_VERIFIABLE")
	})

	it("separates two amounts even if the extractor supplies the same broad quotation for both", () => {
		const quote = "Walmart reported operating income of $29.852 billion, while management expects $31 billion next year."
		expect(review(quote, { ...operatingIncome, quote }).warning()).toMatchObject({ dismissed: true })
		expect(review(quote, { ...operatingIncome, quote, statedNumber: "31" }).warning()).toMatchObject({ ok: true })
	})

	it("holds ambiguous, conditional, stale, unfiled and archived observations", () => {
		const conditional = "Assuming that " + historical
		expect(review(conditional, operatingIncome).warning()).toMatchObject({ retainedForReview: true })
		const quote = "the draft puts consolidated operating income at $29.852 billion"
		const repeated = historical + " A forecast assumes " + quote + "."
		expect(review(repeated, { ...operatingIncome, quote }).warning()).toMatchObject({ retainedForReview: true })
		expect(review(historical, operatingIncome, "Analyst forecasts for Walmart").warning()).toMatchObject({ retainedForReview: true })
		const projection = "The report cites projected consolidated operating income of $29.852 billion for the year ended January 31, 2026."
		expect(review(projection, { ...operatingIncome, quote: projection }).warning()).toMatchObject({ ok: true })
		expect(review(historical, { ...operatingIncome, fiscalYear: 2040 }).warning()).toMatchObject({ ok: true })
		expect(review(historical, operatingIncome).warning(true)).toMatchObject({ retainedForReview: true })
		const stale = review(historical, operatingIncome)
		stale.state.reviseClaim(stale.current.id, 1, operatingIncome, "Updated interpretation")
		expect(stale.warning()).toMatchObject({ stale: true })
	})
})
