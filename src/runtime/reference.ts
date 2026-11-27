/**
 * Decide what a custom article is checked against — before any agent runs:
 *   1. Identify the company (an explicit CIK or query, else detection in the article). Ambiguous → the
 *      caller must ask the user; nothing is guessed, and there is no fallback company.
 *   2. Reference: the official report the user provided (PDF URL or upload), else the company's SEC
 *      financial statements (fetched live; replays use the committed snapshot when one exists).
 *   3. A company without usable SEC data and without a report is reported as unavailable.
 */
import { companyByCik, resolveCompany, type Candidate, type CompanyEntry, type CompanyIndex, type Resolution } from "../company/companies.js"
import { loadReport, ReportUnavailable } from "../docs/pdf.js"
import { cachedLiveSnapshot, hasSnapshot, loadSnapshot, SecDataMissing, SecDataUnavailable } from "../sec/edgar.js"
import type { SecSnapshot } from "../sec/types.js"
import type { PreparedReport } from "./pipeline.js"

export type ReferenceRequest = {
	article: { title: string; text: string }
	company?: { cik?: string; query?: string; name?: string }
	report?: { url?: string; file?: { name: string; base64: string }; statedSourceUrl?: string }
	/** Replays prefer the committed SEC snapshot so recorded runs stay reproducible. */
	preferCommitted: boolean
}

export type PreparedReference =
	| { kind: "sec"; snapshot: SecSnapshot; company: CompanyEntry; resolution?: Resolution; snapshotSource: "committed" | "live" }
	| { kind: "report"; report: PreparedReport; company?: CompanyEntry; resolution?: Resolution }

export type ReferenceErrorCode = "COMPANY_AMBIGUOUS" | "COMPANY_NOT_FOUND" | "COMPANY_NAME_REQUIRED" | "SEC_DATA_UNAVAILABLE" | "SEC_UNREACHABLE" | ReportUnavailable["code"]
export class ReferenceError extends Error {
	constructor(
		readonly status: number,
		readonly code: ReferenceErrorCode,
		message: string,
		readonly extra: { candidates?: Candidate[]; needsReport?: boolean; company?: CompanyEntry } = {},
	) {
		super(message)
	}
}

export async function secSnapshotFor(company: CompanyEntry, preferCommitted: boolean): Promise<{ snapshot: SecSnapshot; source: "committed" | "live" }> {
	const ticker = company.tickers[0]
	if (preferCommitted && ticker && hasSnapshot(ticker)) {
		const s = loadSnapshot(ticker)
		if (s.cik === company.cik) return { snapshot: s, source: "committed" }
	}
	try {
		return { snapshot: await cachedLiveSnapshot({ cik: company.cik, ticker, name: company.name }), source: "live" }
	} catch (e) {
		if (e instanceof SecDataUnavailable || e instanceof SecDataMissing)
			throw new ReferenceError(422, "SEC_DATA_UNAVAILABLE", `${e.message} Provide the company's official financial report (PDF) to check this article.`, { needsReport: true, company })
		throw new ReferenceError(502, "SEC_UNREACHABLE", `SEC EDGAR could not be reached (${(e as Error).message}). Nothing was substituted; try again.`, { company })
	}
}

export async function prepareReference(req: ReferenceRequest, index: CompanyIndex): Promise<PreparedReference> {
	// 1. company
	let company: CompanyEntry | undefined
	let resolution: Resolution | undefined
	if (req.company?.cik) {
		company = companyByCik(index, req.company.cik)
		if (!company) throw new ReferenceError(404, "COMPANY_NOT_FOUND", `No SEC filer has CIK ${req.company.cik}.`)
	} else {
		resolution = resolveCompany(index, { query: req.company?.query, text: req.article.text, title: req.article.title })
		if (resolution.status === "resolved") company = resolution.company
		else if (resolution.status === "ambiguous" && !req.report) throw new ReferenceError(409, "COMPANY_AMBIGUOUS", resolution.reason, { candidates: resolution.candidates })
		else if (resolution.status === "not_found" && !req.report) throw new ReferenceError(404, "COMPANY_NOT_FOUND", resolution.reason, { needsReport: true })
	}

	// 2. an explicit official report wins (e.g. an Indian company's results in ₹ crore)
	if (req.report && (req.report.url || req.report.file)) {
		const name = req.company?.name?.trim() || company?.name || req.company?.query?.trim()
		if (!name) throw new ReferenceError(400, "COMPANY_NAME_REQUIRED", "Enter the company's name for the report.")
		try {
			const doc = await loadReport(req.report)
			return { kind: "report", report: { doc, company: { name, ticker: company?.tickers[0] } }, company, resolution }
		} catch (e) {
			if (e instanceof ReportUnavailable) throw new ReferenceError(e.code === "REPORT_FETCH_FAILED" ? 502 : 422, e.code, e.message, { needsReport: true })
			throw e
		}
	}

	// 3. SEC statements
	const { snapshot, source } = await secSnapshotFor(company!, req.preferCommitted)
	return { kind: "sec", snapshot, company: company!, resolution, snapshotSource: source }
}
