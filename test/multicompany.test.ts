/**
 * Company-independent checking: company resolution (no whitelist, ambiguity asks), multi-currency
 * SEC data (20-F in INR with a USD convenience translation; USD-only 20-F), lakh/crore scales,
 * consolidated vs standalone, and official reports read from a PDF with code verification.
 */
import { describe, expect, it } from "vitest"
import { loadCompanyIndex, resolveCompany, searchCompanies } from "../src/company/companies.js"
import { checkAnchoring, consolidationOf, currencyOf, validateInterpretation } from "../src/agents/extractor.js"
import { parsePdf } from "../src/docs/pdf.js"
import { documentFiscalYearEnd, selectStatementPages, verifyProposed, type ProposedFact } from "../src/docs/verify.js"
import { calculate } from "../src/domain/calculator.js"
import { factChoice, priorPeriodAttribution, ruleWarnings } from "../src/domain/checks.js"
import type { Claim, ClaimInterpretation } from "../src/domain/types.js"
import { CheckerRunner, type AuthorScript, type ScriptTurn } from "../src/llm/runner.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { prepareReference, ReferenceError } from "../src/runtime/reference.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"
import { interimPage, makePdf, resultsPage } from "./helpers/pdf.js"

const index = loadCompanyIndex()

describe("company resolution (SEC's full filer list, no whitelist)", () => {
	it("resolves tickers, names and article mentions; asks when ambiguous; reports unknown companies", () => {
		expect(resolveCompany(index, { query: "AAPL" })).toMatchObject({ status: "resolved", company: { name: "Apple Inc." }, method: "ticker" })
		expect(resolveCompany(index, { query: "wipro" })).toMatchObject({ status: "resolved", company: { tickers: ["WIT"] } })
		const jpm = resolveCompany(index, { text: "JPMorgan Chase reported net income of $15.3 billion. JPMorgan's bank grew.", title: "JPMorgan profit" })
		expect(jpm).toMatchObject({ status: "resolved", company: { tickers: expect.arrayContaining(["JPM"]) } })
		expect(resolveCompany(index, { text: "Walmart Inc. (NYSE: WMT) said revenue rose." })).toMatchObject({ status: "resolved", company: { name: "Walmart Inc." } })
		const two = resolveCompany(index, { text: "Microsoft said cloud revenue grew. Apple said iPhone sales fell. Microsoft's Azure grew.", title: "Microsoft and Apple" })
		expect(two.status).toBe("ambiguous")
		expect(two.candidates.map((c) => c.name)).toEqual(expect.arrayContaining(["MICROSOFT CORP", "Apple Inc."]))
		expect(resolveCompany(index, { query: "bank" }).status).toBe("ambiguous")
		expect(resolveCompany(index, { text: "Zentrix Robotics, a privately held maker of robots, said revenue doubled to $40 million." }).status).toBe("not_found")
		expect(resolveCompany(index, { query: "Tata Consultancy Services" }).status).toBe("not_found")
		// a small filer resolves just like a large one
		expect(searchCompanies(index, "Bank First").some((c) => c.name.toLowerCase().includes("bank first"))).toBe(true)
	})

	it("never falls back to another company: unknown companies without a report are an error", async () => {
		await expect(prepareReference({ article: { title: "", text: "Zentrix Robotics said revenue doubled to $40 million." }, preferCommitted: true }, index)).rejects.toMatchObject({ code: "COMPANY_NOT_FOUND", extra: { needsReport: true } })
		await expect(prepareReference({ article: { title: "Microsoft and Apple", text: "Microsoft said revenue grew. Apple said sales fell. Microsoft again." }, preferCommitted: true }, index)).rejects.toBeInstanceOf(ReferenceError)
		const ref = await prepareReference({ article: { title: "", text: "Apple reported revenue of $478.8 billion for fiscal 2026." }, preferCommitted: true }, index)
		expect(ref).toMatchObject({ kind: "sec", snapshotSource: "committed", company: { name: "Apple Inc." } })
	})
})

describe("currency, scale and consolidation are read from the article by code", () => {
	const base = { metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedUnit: "money", qualifier: "exact" }
	it("detects the currency attached to the number", () => {
		expect(currencyOf("revenue of ₹89,088 crore", "89088")).toBe("INR")
		expect(currencyOf("revenue of Rs. 1,62,990 crore", "162990")).toBe("INR")
		expect(currencyOf("revenue of 12,345 crore rupees", "12345")).toBe("INR")
		expect(currencyOf("revenue was $10.4 billion", "10.4")).toBe("USD")
		expect(currencyOf("revenue was US$10.4 billion", "10.4")).toBe("USD")
		expect(currencyOf("sales of €1.2 billion", "1.2")).toBe("EUR")
		expect(currencyOf("sales of 3.4 billion euros", "3.4")).toBe("EUR")
		expect(currencyOf("revenue was 40 million", "40")).toBe("unspecified")
		expect(consolidationOf("Standalone net profit rose 12% to ₹500 crore.")).toBe("standalone")
		expect(consolidationOf("Consolidated revenue was ₹900 crore.")).toBe("consolidated")
		expect(consolidationOf("Revenue was ₹900 crore.")).toBe("unspecified")
	})
	it("anchors lakh, crore and lakh crore scales, including Indian digit grouping", () => {
		const text = "Operating profit was ₹1,51,271 crore for the year. Reliance's revenue crossed ₹10.7 lakh crore. Other income was ₹45 lakh."
		const ok = (o: Partial<ClaimInterpretation>) => validateInterpretation({ ...base, ...o }, text)
		expect(ok({ quote: "Operating profit was ₹1,51,271 crore for the year", statedNumber: "151271", scale: "crore", metric: "operating_income" })).toMatchObject({ currency: "INR", scale: "crore" })
		expect(ok({ quote: "revenue crossed ₹10.7 lakh crore", statedNumber: "10.7", scale: "lakh_crore" }).scale).toBe("lakh_crore")
		expect(ok({ quote: "Other income was ₹45 lakh", statedNumber: "45", scale: "lakh", metric: "other" }).scale).toBe("lakh")
		// an agent cannot turn crore into million to agree with the filing
		expect(() => checkAnchoring({ ...base, quote: "Operating profit was ₹1,51,271 crore for the year", statedNumber: "151271", scale: "million" } as ClaimInterpretation, text)).toThrow(/scale "million" does not match/)
	})
})

describe("multi-currency SEC statements", () => {
	const wit = new EvidenceRegistry(loadSnapshot("WIT"))
	const infy = new EvidenceRegistry(loadSnapshot("INFY"))
	const claim = (o: Partial<ClaimInterpretation>): Claim => ({ id: "c1", revision: 1, reason: "test", correctionsUsed: 0, interpretation: { quote: "x", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2025, fiscalPeriod: "FY", statedNumber: "89088", statedUnit: "money", scale: "crore", qualifier: "exact", currency: "INR", consolidation: "unspecified", ...o } })
	const meta = { claimId: "c1", claimRevision: 1, evidenceRevision: 1 }

	it("identifies the 20-F reporting currency and flags convenience translations", () => {
		expect(wit.info.reportingCurrency).toBe("INR")
		const rev = wit.search("revenue", 2025, "FY")
		expect(rev[0]).toMatchObject({ currency: "INR", translated: undefined, form: "20-F", basis: "IFRS" })
		expect(rev.find((f) => f.currency === "USD")).toMatchObject({ translated: true, id: "Revenue.USD/FY-FY2025/25-076303" })
		expect(infy.info.reportingCurrency).toBe("USD")
	})

	it("checks ₹ crore against INR statements, compares only like currencies, and routes to the right fact", () => {
		const inr = wit.search("revenue", 2025, "FY")[0]
		expect(calculate(meta, claim({}).interpretation, inr)).toMatchObject({ verdict: "MATCH", actualDisplay: "₹89,088.4 crore" })
		// units error: "₹1,51,271 crore" when the filing says ₹151,271 million
		const op = wit.search("operating_income", 2025, "FY")[0]
		const units = calculate(meta, claim({ metric: "operating_income", statedNumber: "151271" }).interpretation, op)
		expect(units.verdict).toBe("MISMATCH")
		expect(units.notes.join(" ")).toMatch(/scale were "million" instead of "crore"/)
		// a rupee claim against a USD-only filer is not compared (no exchange rate)
		const usd = infy.search("revenue", 2025, "FY")[0]
		const x = calculate(meta, claim({ statedNumber: "162990" }).interpretation, usd)
		expect(x.verdict).toBe("NOT_COMPUTABLE")
		expect(x.notes[0]).toMatch(/Currency mismatch: the article states INR, the reference reports USD/)
		// a dollar claim about Wipro may use the convenience translation; an unstated currency may not
		expect(factChoice(claim({ currency: "USD", statedNumber: "10.4", scale: "billion" }), inr, wit)).toMatch(/states USD: bind Revenue.USD/)
		const translated = wit.search("revenue", 2025, "FY").find((f) => f.translated)!
		expect(factChoice(claim({ currency: "unspecified" }), translated, wit)).toMatch(/convenience translation/)
		expect(factChoice(claim({}), inr, wit)).toBeUndefined()
	})

	it("flags an article that names a different accounting basis than the statements", () => {
		const inr = wit.search("revenue", 2025, "FY")[0]
		const c = claim({ quote: "Under US GAAP, revenue was ₹89,088 crore" })
		const calc = calculate(meta, c.interpretation, inr)
		const ws = ruleWarnings(c, { claimId: "c1", claimRevision: 1, evidenceRevision: 1, currentFactId: inr.id, boundBy: "test" }, calc, wit)
		expect(ws.find((w) => w.code === "ACCOUNTING_BASIS_DIFFERS")?.message).toMatch(/US GAAP figure; Revenue\/FY-FY2025\/25-076303 comes from IFRS statements/)
		const plain = ruleWarnings(claim({}), { claimId: "c1", claimRevision: 1, evidenceRevision: 1, currentFactId: inr.id, boundBy: "test" }, calc, wit)
		expect(plain.some((w) => w.code === "ACCOUNTING_BASIS_DIFFERS")).toBe(false)
	})

	it("sends a year-ago figure labelled with the current period back to the extractor ('same quarter last year')", () => {
		const wmt = new EvidenceRegistry(loadSnapshot("WMT"))
		const interp = claim({ quote: "compared with $0.88 in the same quarter last year.", metric: "eps_diluted", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "0.88", statedUnit: "per_share", scale: "units", currency: "USD" })
		const calc = calculate(meta, interp.interpretation, wmt.search("eps_diluted", 2027, "Q2")[0])
		expect(calc.verdict).toBe("MISMATCH")
		expect(priorPeriodAttribution(interp, calc, wmt)).toMatch(/matches Q2-FY2026 .* exactly/)
		for (const q of ["$0.88 in the previous year", "$0.88 last year", "$0.88 for the prior year"]) expect(priorPeriodAttribution({ ...interp, interpretation: { ...interp.interpretation, quote: q } }, calc, wmt)).toBeDefined()
		expect(priorPeriodAttribution({ ...interp, interpretation: { ...interp.interpretation, quote: "$0.88, up from a year earlier" } }, calc, wmt)).toBeUndefined()
	})

	it("uses the primary line item unless the article names a narrower one", () => {
		const wmt = new EvidenceRegistry(loadSnapshot("WMT"))
		const [total, netSales] = wmt.search("revenue", 2027, "Q2")
		expect(total.concept).toBe("us-gaap:Revenues")
		expect(netSales.concept).toBe("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax")
		const c = claim({ fiscalYear: 2027, fiscalPeriod: "Q2", currency: "USD", scale: "billion", statedNumber: "187.9", quote: "total revenue of $187.9 billion" })
		expect(factChoice(c, netSales, wmt)).toMatch(/not the primary revenue line item/)
		expect(factChoice({ ...c, interpretation: { ...c.interpretation, quote: "net sales of $186.1 billion" } }, netSales, wmt)).toBeUndefined()
		const jpm = new EvidenceRegistry(loadSnapshot("JPM"))
		expect(jpm.search("revenue", 2026, "Q3")[0].concept).toBe("us-gaap:RevenuesNetOfInterestExpense")
	})
})

// ── official report (PDF) ────────────────────────────────────────────────────────────────────

const CONS = { rev: ["12,345.67", "11,000.00", "10,500.00", "23,345.67", "20,800.00", "45,000.00"], np: ["2,100.50", "1,900.00", "1,800.25", "4,000.50", "3,500.00", "7,400.00"], basic: ["5.25", "4.75", "4.50", "10.00", "8.75", "18.50"], diluted: ["5.24", "4.74", "4.49", "9.98", "8.73", "18.45"] }
const STAND = { rev: ["9,876.54", "9,000.00", "8,800.00", "18,876.54", "17,000.00", "35,000.00"], np: ["1,500.00", "1,400.00", "1,300.00", "2,900.00", "2,600.00", "5,500.00"], basic: ["3.75", "3.50", "3.25", "7.25", "6.50", "13.75"], diluted: ["3.74", "3.49", "3.24", "7.23", "6.48", "13.70"] }
async function testReport() {
	const bytes = makePdf([resultsPage("Consolidated", CONS), resultsPage("Standalone", STAND), [{ x: 40, y: 700, text: "Independent Auditor's Limited Review Report on the financial results of TestCo Limited." }]])
	const pages = await parsePdf(bytes)
	return { url: "https://example.com/testco-q2.pdf", sha256: "0123456789abcdef", bytes: bytes.length, pageCount: pages.length, pages, fetchedAt: "2026-11-27T00:00:00.000Z" }
}

describe("official report: every figure verified on its page", () => {
	it("uses printed headings when a quarter exceeds its half-year, values repeat, or the headings are missing", async () => {
		const values = { ...CONS, np: ["20,000", "(6,000)", "17,000", "14,000", "17,000", "30,000"] }
		const page = resultsPage("Consolidated", values)
		const check = async (items: typeof page, value: string, periodType: "quarter" | "half", periodEnd = "2025-09-30") => {
			const pages = await parsePdf(makePdf([items]))
			const doc = { fileName: "periods.pdf", sha256: "aaa", bytes: 1, pageCount: 1, pages, fetchedAt: "2026-11-27" }
			return verifyProposed(doc, { metric: "net_income", consolidation: "consolidated", page: 1, row: "Net profit for the period", column: "", periodType, periodEnd, value }, { basis: "Ind AS", docCurrency: "INR" })
		}
		expect(await check(page, "20,000", "quarter")).toMatchObject({ ok: true })
		expect(await check(page, "14,000", "half")).toMatchObject({ ok: true })
		expect(await check(page, "14,000", "quarter")).toMatchObject({ ok: false })
		expect(await check(page, "(6,000)", "quarter", "2025-06-30")).toMatchObject({ ok: true, fact: { value: -60000000000 } })
		expect(await check(page, "17,000", "half", "2024-09-30")).toMatchObject({ ok: true, fact: { start: "2024-04-01" } })
		expect(await check(page.filter(item => item.y !== 736), "14,000", "half")).toMatchObject({ ok: false })
	})

	it("selects statement pages and verifies row, column, period type, unit note and consolidation", async () => {
		const doc = await testReport()
		expect(selectStatementPages(doc).map((p) => p.n)).toEqual([1, 2])
		const p: ProposedFact = { metric: "revenue", consolidation: "consolidated", page: 1, row: "Revenue from operations", column: "Quarter ended 30.09.2025", periodType: "quarter", periodEnd: "2025-09-30", value: "12,345.67" }
		const v = (o: Partial<ProposedFact>) => verifyProposed(doc, { ...p, ...o }, { basis: "as reported", docCurrency: "INR" })
		expect(v({})).toMatchObject({ ok: true, fact: { value: 123456700000, unit: "INR", start: "2025-07-01", end: "2025-09-30", consolidation: "consolidated", location: { page: 1, unitNote: "Rs. in crore" } } })
		expect(v({ periodType: "half" })).toMatchObject({ ok: false, reason: expect.stringMatching(/labelled quarter, not half/) })
		expect(v({ value: "23,345.67", periodType: "quarter" })).toMatchObject({ ok: false })
		expect(v({ value: "23,345.67", periodType: "half" })).toMatchObject({ ok: true, fact: { value: 233456700000, start: "2025-04-01" } })
		expect(v({ value: "11,000.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/column dated 2025-06-30/) })
		expect(v({ consolidation: "standalone" })).toMatchObject({ ok: false, reason: expect.stringMatching(/is consolidated, not standalone/) })
		expect(v({ row: "Other income" })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a revenue line/) })
		expect(v({ value: "99,999.00" })).toMatchObject({ ok: false, reason: expect.stringMatching(/not printed on the row/) })
		expect(v({ metric: "eps_diluted", row: "(b) Diluted", value: "5.24" })).toMatchObject({ ok: true, fact: { value: 5.24, unit: "INR/shares" } })
		expect(v({ page: 2, consolidation: "standalone", value: "9,876.54" })).toMatchObject({ ok: true, fact: { consolidation: "standalone" } })
	})

	it("runs the full pipeline against a report: Reader → verified facts → claims checked with page receipts", async () => {
		const doc = await testReport()
		const call = (name: string, args: Record<string, unknown>): ScriptTurn => ({ call: { name, args } })
		const fact = (o: Partial<ProposedFact>): ProposedFact => ({ metric: "revenue", consolidation: "consolidated", page: 1, row: "Revenue from operations", column: "Quarter ended 30.09.2025", periodType: "quarter", periodEnd: "2025-09-30", value: "12,345.67", ...o })
		const text = "TestCo reported consolidated revenue from operations of Rs 12,345.67 crore for the September quarter. Standalone net profit was Rs 1,600 crore. Revenue grew 17.6% from a year earlier."
		const c1 = { quote: "consolidated revenue from operations of Rs 12,345.67 crore for the September quarter", metric: "revenue", accounting: "unspecified", kind: "level", fiscalYear: 2026, fiscalPeriod: "Q2", statedNumber: "12345.67", statedUnit: "money", scale: "crore", qualifier: "exact" }
		const c2 = { quote: "Standalone net profit was Rs 1,600 crore", metric: "net_income", accounting: "unspecified", kind: "level", fiscalYear: 2026, fiscalPeriod: "Q2", statedNumber: "1600", statedUnit: "money", scale: "crore", qualifier: "exact" }
		const c3 = { quote: "Revenue grew 17.6% from a year earlier", metric: "revenue", accounting: "unspecified", kind: "change", comparison: "yoy", direction: "increase", fiscalYear: 2026, fiscalPeriod: "Q2", statedNumber: "17.6", statedUnit: "percent", scale: "units", qualifier: "exact" }
		const script: AuthorScript = {
			description: "report run",
			tasks: {
				"reader:report": [
					call("record_facts", {
						facts: [
							fact({}),
							fact({ value: "10,500.00", periodEnd: "2024-09-30", column: "Quarter ended 30.09.2024" }),
							fact({ value: "45,000.00", periodType: "year", periodEnd: "2025-03-31", column: "Year ended 31.03.2025" }),
							fact({ page: 2, consolidation: "standalone", metric: "net_income", row: "Net profit for the period", value: "1,500.00" }),
							fact({ value: "11,000.00" }), // wrong column: rejected by code
						],
					}),
					{ say: "done" },
				],
				"extractor:article": [call("submit_claim", c1), call("submit_claim", c2), call("submit_claim", c3), { say: "3 claims" }],
				"evidence:c1@r1#1": [call("bind_evidence", { claimId: "c1", claimRevision: 1, currentFactId: "Revenue/Q2-FY2026/p1" }), { say: "done" }],
				"evidence:c2@r1#1": [call("bind_evidence", { claimId: "c2", claimRevision: 1, currentFactId: "ProfitLoss.standalone/Q2-FY2026/p2" }), { say: "done" }],
				"evidence:c3@r1#1": [call("bind_evidence", { claimId: "c3", claimRevision: 1, currentFactId: "Revenue/Q2-FY2026/p1", baseFactId: "Revenue/Q2-FY2025/p1" }), { say: "done" }],
				"context:c1@r1": [{ say: "no context issues" }],
				"context:c2@r1": [{ say: "no context issues" }],
				"context:c3@r1": [{ say: "no context issues" }],
				"auditor:c1@r1.e1": [call("approve", { claimId: "c1", claimRevision: 1, evidenceRevision: 1, note: "ok" }), { say: "done" }],
				"auditor:c2@r1.e1": [call("approve", { claimId: "c2", claimRevision: 1, evidenceRevision: 1, note: "standalone figure differs" }), { say: "done" }],
				"auditor:c3@r1.e1": [call("approve", { claimId: "c3", claimRevision: 1, evidenceRevision: 1, note: "ok" }), { say: "done" }],
			},
		}
		const tasks = new TaskTracker()
		const runner = new CheckerRunner({ mode: "author", tasks, script })
		const res = await runChecker({ article: { title: "TestCo Q2", text, ticker: "" }, report: { doc, company: { name: "TestCo Limited" } }, runner, tasks, model: "test", timeoutMs: 20_000 })
		const s = res.state
		expect(res.timedOut).toBe(false)
		expect(s.report).toMatchObject({ status: "ready" })
		expect(s.report!.accepted).toHaveLength(4)
		expect(s.report!.rejected[0].reason).toMatch(/column dated 2025-06-30/)
		expect(s.referenceInfo).toMatchObject({ kind: "report", entityName: "TestCo Limited" })
		expect(s.claims.get("c1")!.interpretation).toMatchObject({ currency: "INR", consolidation: "consolidated" })
		expect(s.calcs.get("c1")).toMatchObject({ verdict: "MATCH", actualDisplay: "₹12,345.67 crore" })
		expect(s.calcs.get("c1")!.inputs[0].location).toMatchObject({ page: 1, row: "Revenue from operations", printed: "12,345.67" })
		expect(s.calcs.get("c2")).toMatchObject({ verdict: "MISMATCH" }) // standalone 1,500 vs stated 1,600
		expect(s.calcs.get("c3")).toMatchObject({ verdict: "MATCH" }) // 12,345.67 / 10,500 = +17.58%
		expect([...s.claims.keys()].every((id) => s.isSettled(id))).toBe(true)
	}, 40_000)

	it("stops with an explicit reason when no statement page can be found", async () => {
		const bytes = makePdf([Array.from({ length: 8 }, (_, i) => ({ x: 40, y: 700 - i * 16, text: `Sustainability highlight ${i + 1}: our people, our planet and our communities.` }))])
		const pages = await parsePdf(bytes)
		const doc = { url: "https://example.com/esg.pdf", sha256: "ff", bytes: bytes.length, pageCount: pages.length, pages, fetchedAt: "2026-11-27T00:00:00.000Z" }
		const tasks = new TaskTracker()
		const res = await runChecker({ article: { title: "x", text: "TestCo revenue was Rs 5 crore.", ticker: "" }, report: { doc, company: { name: "TestCo" } }, runner: new CheckerRunner({ mode: "author", tasks, script: { description: "", tasks: {} } }), tasks, model: "test", timeoutMs: 5_000 })
		expect(res.state.extraction).toBe("failed")
		expect(res.state.extractionError).toMatch(/^REFERENCE_UNAVAILABLE: no financial-statement page/)
		expect(res.state.claims.size).toBe(0)
	})

	it("reads a real-world interim layout: stacked headers, indented attributable profit, fiscal year from the text", async () => {
		const notes = Array.from({ length: 6 }, (_, i) => ({ x: 40, y: 700 - i * 16, text: `Note ${i + 1}: dividends paid during the year ended March 31, 2026 were approved by the Board.` }))
		const bytes = makePdf([interimPage(), notes])
		const pages = await parsePdf(bytes)
		const doc = { fileName: "interim.pdf", sha256: "abcdef0123456789", bytes: bytes.length, pageCount: pages.length, pages, fetchedAt: "2026-11-27T00:00:00.000Z" }
		expect(documentFiscalYearEnd(doc)).toBe("03-31")
		expect(selectStatementPages(doc).map((p) => p.n)).toEqual([1])
		const p: ProposedFact = { metric: "revenue", consolidation: "consolidated", page: 1, row: "Revenue from operations", column: "", periodType: "quarter", periodEnd: "2026-09-30", value: "73,188" }
		const v = (o: Partial<ProposedFact>) => verifyProposed(doc, { ...p, ...o }, { basis: "Ind AS", docCurrency: "INR" })
		expect(v({})).toMatchObject({ ok: true, fact: { value: 731880000000, start: "2026-07-01", location: { column: "Three months ended September 30, 2026" } } })
		expect(v({ value: "1,337" })).toMatchObject({ ok: false, reason: expect.stringContaining("not printed on the row") })
		expect(v({ value: "1,45,463", periodType: "half" })).toMatchObject({ ok: true, fact: { value: 1454630000000, start: "2026-04-01" } })
		expect(v({ value: "1,45,463" })).toMatchObject({ ok: false, reason: expect.stringMatching(/is a half column, not quarter/) })
		expect(v({ value: "65,799" })).toMatchObject({ ok: false, reason: expect.stringMatching(/column dated 2025-09-30/) })
		expect(v({ metric: "net_income", row: "Shareholders of the Company", value: "13,884" })).toMatchObject({ ok: true, fact: { concept: "report:NetIncome", location: { row: "Profit for the period attributable to: Shareholders of the Company" } } })
		expect(v({ metric: "net_income", row: "PROFIT FOR THE PERIOD", value: "13,934" })).toMatchObject({ ok: true, fact: { concept: "report:ProfitLoss" } })
		expect(v({ metric: "net_income", row: "Shareholders of the Company", value: "13,695" })).toMatchObject({ ok: false, reason: expect.stringMatching(/comprehensive income/i) })
		expect(v({ row: "TOTAL INCOME", value: "74,525" })).toMatchObject({ ok: false })
		expect(v({ metric: "eps_diluted", row: "Earnings per equity share:- Basic and diluted (Rs.)", value: "75.27", periodType: "half" })).toMatchObject({ ok: true, fact: { unit: "INR/shares", value: 75.27 } })

		// without an annual column, the fiscal year comes from "year ended March 31" in the text: Q2 and H1 of FY2027
		const facts = [v({}), v({ value: "65,799", periodEnd: "2025-09-30" }), v({ value: "1,45,463", periodType: "half" })].map((r) => (r.ok ? r.fact : undefined)!)
		const reg = new EvidenceRegistry({ kind: "report", info: { kind: "report", entityName: "TestCo", fetchedAt: doc.fetchedAt, label: "test", sources: [] }, facts, fiscalYearEnd: documentFiscalYearEnd(doc) })
		expect(reg.all().map((f) => `${f.fiscalPeriod}-FY${f.fiscalYear}`).sort()).toEqual(["H1-FY2027", "Q2-FY2026", "Q2-FY2027"])
	})
})
