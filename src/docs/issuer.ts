import { normName } from "../company/companies.js"
import type { PdfPage, ReportDoc } from "./pdf.js"
import { selectStatementPages } from "./verify.js"

const FINANCIAL_TITLE = /\b(?:financial (?:statements?|results)|statements? of (?:profit|operations|income|cash flows?|financial position|changes in equity|results)|balance sheets?|income statements?)\b/i
const LEGAL_SUFFIX = "(?:incorporated|corporation|limited|company|inc|corp|ltd|plc|llc|llp|pvt|ag|se|sa|nv|oyj|ab)"
const LEGAL_HEADING = new RegExp(`^.{2,100}\\b${LEGAL_SUFFIX}\\.?$`, "i")
const LEGAL_END = new RegExp(`\\s+${LEGAL_SUFFIX}$`)
const BOILERPLATE = /^(?:for|from|to|under|report|independent|statement|notes?|auditor|unaudited|audited|consolidated|standalone|financial|the financial)(?:\s|$)/i
const QUALIFIERS = /(?:\s+|\s*[-–—:|]\s*)(?:(?:statement of|consolidated|standalone|interim|annual|quarterly|audited|unaudited|condensed|summary)\s*)+$/i
const KNOWN_ALIASES = new Map([["tcs", "tata consultancy services"]])

function normalizeIssuer(name: string): string {
	let result = normName(name.normalize("NFKD").replace(/\p{Diacritic}/gu, "")).replace(/^the\s+/, "")
	while (LEGAL_END.test(result)) result = result.replace(LEGAL_END, "")
	return KNOWN_ALIASES.get(result) ?? result
}

export function sameIssuer(a: string, b: string): boolean {
	const x = normalizeIssuer(a)
	const y = normalizeIssuer(b)
	return x.length >= 3 && x === y
}

function issuerCandidate(candidate: string, expected: string): string | undefined {
	if (!candidate || BOILERPLATE.test(candidate)) return
	const name = candidate.replace(QUALIFIERS, "").replace(/\s*[-–—:|]\s*$/, "").trim()
	if (sameIssuer(name, expected) || (LEGAL_HEADING.test(name) && normalizeIssuer(name).length >= 3)) return name
}

/** Look only at the first title and the adjacent issuer line, never a body mention or filename. */
function issuerHeadings(page: PdfPage, expected: string): string[] {
	const lines = page.lines.slice(0, 8).map(line => line.text.trim()).filter(Boolean)
	for (const [i, line] of lines.entries()) {
		const title = FINANCIAL_TITLE.exec(line)
		if (!title) continue
		const prefix = line.slice(0, title.index).trim()
		const tail = line.slice(title.index + title[0].length)
		const suffix = /^(?:\s+(?:of|for)|\s*[-–—:|])\s+(.+)$/i.exec(tail)?.[1] ?? ""
		const previous = lines[i - 1] ?? ""
		const earlier = lines[i - 2] ?? ""
		const names = [prefix, suffix, previous, earlier].map(candidate => issuerCandidate(candidate, expected)).filter((name): name is string => !!name)
		if (names.length) return names
		const split = earlier && previous ? issuerCandidate(`${earlier} ${previous}`, expected) : undefined
		return split ? [split] : []
	}
	return []
}

export type ReportIssuer = { printedName: string; page: number; pages: PdfPage[] }
type IssuerCheck =
	| { ok: true; issuer: ReportIssuer }
	| { ok: false; code: "REPORT_ISSUER_MISMATCH" | "REPORT_ISSUER_UNVERIFIED"; message: string }

/** This checks identity consistency. It does not authenticate a supplied document or its host. */
export function checkReportIssuer(doc: ReportDoc, expected: string): IssuerCheck {
	const statements = selectStatementPages(doc)
	const pages = statements.length ? statements : doc.pages.slice(0, 3)
	const matches: { page: PdfPage; name: string }[] = []
	for (const page of pages) {
		const names = issuerHeadings(page, expected)
		const mismatch = names.find(name => !sameIssuer(name, expected))
		if (mismatch) {
			return { ok: false, code: "REPORT_ISSUER_MISMATCH", message: `The PDF header on page ${page.n} identifies "${mismatch}", which conflicts with the selected company "${expected}". Supply the selected company's report or correct the company selection.` }
		}
		if (names[0]) matches.push({ page, name: names[0] })
	}
	const first = matches[0]
	if (!first) {
		return { ok: false, code: "REPORT_ISSUER_UNVERIFIED", message: `The PDF does not have a readable financial statement heading identifying "${expected}". Supply the company's report with its issuer name visible on the statement pages.` }
	}
	return { ok: true, issuer: { printedName: first.name, page: first.page.n, pages: matches.map(match => match.page).filter(page => statements.includes(page)) } }
}
