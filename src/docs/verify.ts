/**
 * Deterministic verification of report facts proposed by the Reader agent. The model only says
 * "metric M is the row labelled R, column C, value V as printed"; code checks every part on the page:
 *   - the row label is on the page and the printed value is on that row,
 *   - the value sits under a column header carrying the stated period-end date (x-alignment),
 *   - the period type (quarter / half / nine months / year) fits the column (labels above it, with
 *     column geometry resolving same-date periods),
 *   - scale and currency come from the page's unit note ("₹ in crore", "Rs. in lakhs", "in millions"),
 *     never from the model; consolidated vs standalone comes from the statement heading.
 * The value used is the printed number × the note's scale. Anything that cannot be verified is rejected
 * with a reason; nothing is filled in.
 */
import type { Consolidation, RawFact } from "../sec/evidence.js"
import { isPerShareMetric, reportConcept, type VerifiableMetric } from "../sec/types.js"
import type { PdfItem, PdfLine, PdfPage, ReportDoc } from "./pdf.js"

export type PeriodType = "quarter" | "half" | "nine_months" | "year"
export type ProposedFact = { metric: VerifiableMetric; consolidation: Consolidation; page: number; row: string; column: string; periodType: PeriodType; periodEnd: string; value: string }
export type Verified = { ok: true; fact: RawFact } | { ok: false; reason: string }

const norm = (s: string) => s.replace(/[’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase()
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const MON = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?"
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y < 100 ? 2000 + y : y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : undefined)

/** Every date in a string, with its character offset: 30.09.2025, 30/09/25, September 30, 2025, 30th September 2025, 30-Sep-25. */
export function datesIn(s: string): { date: string; at: number; len: number }[] {
	const out: { date: string; at: number; len: number }[] = []
	for (const m of s.matchAll(/(?<![\d.])(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})(?![\d])/g)) {
		const a = Number(m[1])
		const b = Number(m[2])
		const d = b > 12 ? iso(Number(m[3]), a, b) : iso(Number(m[3]), b, a) // day-first unless impossible
		if (d) out.push({ date: d, at: m.index!, len: m[0].length })
	}
	for (const m of s.matchAll(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) {
		const d = iso(Number(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]))
		if (d) out.push({ date: d, at: m.index!, len: m[0].length })
	}
	for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]+${MON},?[\\s\\-]+(\\d{4}|\\d{2})\\b`, "gi"))) {
		const d = iso(Number(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]))
		if (d) out.push({ date: d, at: m.index!, len: m[0].length })
	}
	return out.sort((x, y) => x.at - y.at)
}

const TYPE_LABEL: [PeriodType, RegExp][] = [
	["half", /half[\s-]*year(?:ly)?\s+ended|(?:six|6)[\s-]+months?(?:\s+period)?\s+ended|\bh1\b/i],
	["nine_months", /(?:nine|9)[\s-]+months?(?:\s+period)?\s+ended/i],
	["quarter", /quarter\s+ended|(?:three|3)[\s-]+months?(?:\s+period)?\s+ended|\bquarter\b/i],
	["year", /(?<!half[\s-]*)year\s+ended|(?:twelve|12)[\s-]+months?(?:\s+period)?\s+ended|financial\s+year|\byear\b/i],
]
const typeOf = (s: string): PeriodType | undefined => TYPE_LABEL.find(([, re]) => re.test(s))?.[0]

/** A printed number: "1,23,456.78", "(1,234)" (negative), "−12.5". Returns undefined for dashes and text. */
export function parsePrinted(s: string): number | undefined {
	const t = s.trim().replace(/[−–]/g, "-")
	const neg = /^\(.*\)$/.test(t) || t.startsWith("-")
	const digits = t.replace(/[(),\s]/g, "").replace(/^-/, "")
	if (!/^\d+(\.\d+)?$/.test(digits)) return undefined
	const v = Number(digits)
	return neg ? -v : v
}

/** Printed number × scale, exact in decimal ("23,345.67" × 1e7 = 233456700000, no float residue). */
export function scaledValue(printed: string, scale: number): number {
	const v = parsePrinted(printed)!
	const digits = printed.replace(/[^\d.]/g, "")
	const decimals = digits.includes(".") ? digits.split(".")[1].length : 0
	const units = Number(digits.replace(".", ""))
	const exact = (units * scale) / 10 ** decimals
	return v < 0 ? -exact : exact
}

const SCALES: [RegExp, number, string][] = [
	[/lakhs?\s+crores?/i, 1e12, "lakh crore"],
	[/\b(?:lakhs?|lacs?)\b/i, 1e5, "lakh"],
	[/\bcrores?\b|\bcr\.?(?=\W|$)/i, 1e7, "crore"],
	[/\bmillions?\b|\bmn\b|\bmio\b/i, 1e6, "million"],
	[/\bbillions?\b|\bbn\b/i, 1e9, "billion"],
	[/\bthousands?\b|\b000s\b|'000/i, 1e3, "thousand"],
]
const CURRENCIES: [RegExp, string][] = [
	[/₹|`|\bRs\.?(?=\W|$)|\bINR\b|\brupees?\b/i, "INR"],
	[/US\$|\bUSD\b|\$|\bU\.S\. dollars\b/i, "USD"],
	[/€|\bEUR\b|\beuros?\b/i, "EUR"],
	[/£|\bGBP\b/i, "GBP"],
	[/¥|\bJPY\b|\byen\b/i, "JPY"],
]
export type UnitNote = { note: string; scale: number; scaleWord: string; currency?: string; line: number }

/** Unit notes on a page: parentheticals like "(₹ in crore)", "(In millions, except per share data)", or short lines like "Rs. in Lakhs". */
export function unitNotes(page: PdfPage): UnitNote[] {
	const out: UnitNote[] = []
	page.lines.forEach((l, i) => {
		const candidates = [...l.text.matchAll(/\(([^()]{2,80})\)/g)].map((m) => m[1])
		if (l.text.length <= 40) candidates.push(l.text)
		for (const c of candidates) {
			const sc = SCALES.find(([re]) => re.test(c))
			if (!sc) continue
			if (!/\bin\b|₹|`|\bRs\b|\bINR\b|\$|€|£|USD|rupees/i.test(c)) continue
			if (/\d/.test(c.replace(/'000|000s/g, ""))) continue // "12 crore shares" is text, not a note
			out.push({ note: c.trim(), scale: sc[1], scaleWord: sc[2], currency: CURRENCIES.find(([re]) => re.test(c))?.[1], line: i })
		}
	})
	return out
}

/** The dominant currency marker in the whole report, used when a page's unit note names no currency. */
export function documentCurrency(doc: ReportDoc): string | undefined {
	const counts = new Map<string, number>()
	for (const p of doc.pages) for (const [re, cur] of CURRENCIES) counts.set(cur, (counts.get(cur) ?? 0) + (p.text.match(new RegExp(re.source, "gi"))?.length ?? 0))
	const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
	return best && best[1] >= 2 ? best[0] : undefined
}

export function documentBasis(doc: ReportDoc): string {
	const t = doc.pages.map((p) => p.text).join("\n")
	if (/\bInd\s?AS\b/i.test(t)) return "Ind AS"
	if (/\bIFRS\b|International Financial Reporting Standards/i.test(t)) return "IFRS"
	if (/\bU\.?S\.? GAAP\b|generally accepted accounting principles/i.test(t)) return "US GAAP"
	return "as reported"
}

/** Row-label plausibility per metric (the model maps rows; code refuses obviously wrong rows). */
const ROW_OK: Record<VerifiableMetric, (row: string, pageText: string) => boolean> = {
	revenue: (r) => /revenue|sales|turnover/i.test(r) && !/other income|total income|cost|expense|deferred|per share/i.test(r),
	net_income: (r) => /profit|net income|earnings|income attributable|net loss|\bloss\b/i.test(r) && !/before tax|gross|operating|per share|other comprehensive|exceptional|from operations|discontinued/i.test(r),
	gross_profit: (r) => /gross (profit|margin)/i.test(r) && !/%|percent/i.test(r),
	operating_income: (r) => /operating (profit|income)|profit from operations|income from operations|operating loss/i.test(r),
	eps_basic: (r, t) => /basic/i.test(r) && /earnings per|per (equity )?share|\beps\b/i.test(t),
	eps_diluted: (r, t) => /diluted/i.test(r) && /earnings per|per (equity )?share|\beps\b/i.test(t),
}

type DateHeader = { date: string; x: number; y: number; text: string }

/** Column-header dates above a line: date tokens in short header cells, with their estimated x-centre. */
function headerDates(page: PdfPage, belowY: number): DateHeader[] {
	const out: DateHeader[] = []
	for (const l of page.lines) {
		if (l.y <= belowY) continue
		for (const it of l.items) {
			const ds = datesIn(it.str)
			if (!ds.length) continue
			const rest = ds.reduceRight((s, d) => s.slice(0, d.at) + s.slice(d.at + d.len), it.str).replace(/quarter|three|six|nine|twelve|months?|half|year|ended|audited|unaudited|reviewed|refer|note|\(|\)|\d|[.,:/-]/gi, "").replace(/\s+/g, "")
			if (rest.length > 12) continue // a title sentence that happens to contain a date
			const w = Math.max(1, it.str.length)
			for (const d of ds) out.push({ date: d.date, x: it.x0 + ((d.at + d.len / 2) / w) * (it.x1 - it.x0), y: l.y, text: it.str.trim() })
		}
	}
	return out
}

const xc = (it: PdfItem) => (it.x0 + it.x1) / 2

const HDR_WORDS = new Set(
	"note notes three six nine twelve month months quarter quarters half year years ended ending period periods as at audited unaudited reviewed refer for the and of jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november dec december".split(" "),
)
const STRONG = /^(ended|ending|months?|quarters?|year|half|period|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|(19|20)\d{2})$/
const hdrTokens = (s: string) => s.toLowerCase().replace(/[(),.:/\-–]/g, " ").split(/\s+/).filter(Boolean)
const isHeaderCell = (s: string) => {
	const t = hdrTokens(s)
	return t.length > 0 && t.every((w) => HDR_WORDS.has(w) || /^\d{1,2}(st|nd|rd|th)?$/.test(w) || /^(19|20)\d{2}$/.test(w))
}
const isHeaderLine = (l: PdfLine) => l.items.length >= 2 && l.items.filter((it) => isHeaderCell(it.str)).length >= 0.75 * l.items.length && l.items.some((it) => hdrTokens(it.str).some((w) => STRONG.test(w)))

/**
 * Column headers printed over several lines ("Three months" / "ended" / "September 30," / "2026"):
 * take the block of header lines nearest above the row, group its cells into columns by horizontal
 * overlap, and read each column top to bottom ("Three months ended September 30, 2026").
 */
function stackedColumns(page: PdfPage, aboveIdx: number): DateHeader[] {
	let i = aboveIdx - 1
	while (i >= 0 && !isHeaderLine(page.lines[i])) i--
	if (i < 0) return []
	const block: PdfLine[] = []
	while (i >= 0 && isHeaderLine(page.lines[i])) block.unshift(page.lines[i--])
	const cells = block.flatMap((l) => l.items.map((it) => ({ it, y: l.y }))).sort((a, b) => xc(a.it) - xc(b.it))
	const cols: { x0: number; x1: number; cells: { it: PdfItem; y: number }[] }[] = []
	for (const c of cells) {
		const col = cols.find((k) => c.it.x0 <= k.x1 + 2 && c.it.x1 >= k.x0 - 2)
		if (col) {
			col.cells.push(c)
			col.x0 = Math.min(col.x0, c.it.x0)
			col.x1 = Math.max(col.x1, c.it.x1)
		} else cols.push({ x0: c.it.x0, x1: c.it.x1, cells: [c] })
	}
	const out: DateHeader[] = []
	for (const k of cols) {
		const text = k.cells
			.sort((a, b) => b.y - a.y || a.it.x0 - b.it.x0)
			.map((c) => c.it.str.trim())
			.join(" ")
			.replace(/\s+/g, " ")
		const d = datesIn(text)
		if (d.length === 1) out.push({ date: d[0].date, x: (k.x0 + k.x1) / 2, y: k.cells[0].y, text })
	}
	return out
}

/** A group label can cover several dates on the same line. Ambiguous group boundaries abstain. */
function groupedPeriod(page: PdfPage, dateHeader: DateHeader, headers: DateHeader[]): PeriodType | undefined {
	const columns = headers.filter(header => header.y === dateHeader.y).sort((a, b) => a.x - b.x)
	const above = [...page.lines].reverse().filter(line => line.y > dateHeader.y && line.y - dateHeader.y < 42)
	for (const line of above) {
		const labels = line.items.filter(item => item.str.length <= 40 && typeOf(item.str))
		if (!labels.length) continue
		if (labels.length === 1) {
			const item = labels[0]
			return dateHeader.x >= item.x0 - 40 && dateHeader.x <= item.x1 + 40 ? typeOf(item.str) : undefined
		}
		const groups = labels.map(item => {
			const nearest = columns.reduce((best, col) => Math.abs(col.x - item.x0) < Math.abs(best.x - item.x0) ? col : best)
			return { start: columns.indexOf(nearest), type: typeOf(item.str) }
		}).sort((a, b) => a.start - b.start)
		// Distinct start columns and distinct dates within each group are necessary to identify a period.
		if (groups[0].start !== 0 || new Set(groups.map(group => group.start)).size !== groups.length) return
		const i = columns.indexOf(dateHeader)
		for (let g = 0; g < groups.length; g++) {
			const { start, type } = groups[g]
			const end = groups[g + 1]?.start ?? columns.length
			const dates = columns.slice(start, end).map(col => col.date)
			if (new Set(dates).size !== dates.length) return
			if (i >= start && i < end) return type
		}
	}
}

type PrintedCell = { line: PdfLine; idx: number; x: number }
const numericLine = (line: PdfLine) => line.items.every(item => /^[\s\d,.()+%−–—-]+$/.test(item.str))

/** The nearest label line above a row that carries no numbers (e.g. "Profit for the period attributable to:"). */
function rowHeading(page: PdfPage, idx: number): string {
	for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
		const l = page.lines[i]
		if (l.items.every((it) => parsePrinted(it.str) === undefined)) return l.text
	}
	return ""
}

/** "year ended March 31, 2026" in the report text → the fiscal year end ("03-31"), when no annual column states it. */
export function documentFiscalYearEnd(doc: ReportDoc): string | undefined {
	const counts = new Map<string, number>()
	for (const p of doc.pages)
		for (const m of p.text.matchAll(/(?:financial\s+|fiscal\s+)?year\s+end(?:ed|ing)\s+([^\n|]{6,32})/gi)) {
			const d = datesIn(m[1])[0]
			if (d && d.at <= 3) counts.set(d.date.slice(5), (counts.get(d.date.slice(5)) ?? 0) + 1)
		}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function startOf(end: string, type: PeriodType): string {
	const months = { quarter: 3, half: 6, nine_months: 9, year: 12 }[type]
	const d = new Date(`${end}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + 1)
	d.setUTCMonth(d.getUTCMonth() - months)
	return d.toISOString().slice(0, 10)
}

/** Statement pages worth reading: revenue, profit and EPS rows, a unit note and column dates. */
export function selectStatementPages(doc: ReportDoc, max = 4): PdfPage[] {
	const scored = doc.pages.map((p) => {
		const t = p.text
		let s = 0
		if (/revenue from operations|total revenues?|net sales|\brevenues?\b|turnover/i.test(t)) s += 3
		if (/profit for the (period|year|quarter)|net (profit|income)|profit attributable/i.test(t)) s += 3
		if (/earnings per (equity )?share|\beps\b|per share/i.test(t)) s += 3
		if (unitNotes(p).length) s += 2
		if (headerDates(p, -Infinity).length >= 2 || stackedColumns(p, p.lines.length).length >= 2) s += 2
		if (/statement of .*(results|profit and loss|income|operations)|consolidated statements? of (income|operations)/i.test(t)) s += 2
		if (/independent auditor|auditor'?s report|limited review report/i.test(t)) s -= 4
		return { p, s }
	})
	return scored
		.filter((x) => x.s >= 9)
		.sort((a, b) => b.s - a.s || a.p.n - b.p.n)
		.slice(0, max)
		.map((x) => x.p)
		.sort((a, b) => a.n - b.n)
}

/** Text the Reader sees for a page: one line per printed row, cells separated by " | ". */
export const pageForModel = (p: PdfPage, maxChars = 9000) => `=== Page ${p.n} ===\n${p.text.slice(0, maxChars)}`

function consolidationOf(page: PdfPage, lineIdx: number, doc: ReportDoc): { value?: Consolidation; heading: string } {
	const isS = (s: string) => /stand[\s-]?alone/i.test(s)
	const isC = (s: string) => /consolidated/i.test(s)
	for (let i = lineIdx; i >= 0; i--) {
		const t = page.lines[i].text
		if (isS(t) && !isC(t)) return { value: "standalone", heading: t }
		if (isC(t) && !isS(t)) return { value: "consolidated", heading: t }
	}
	const docText = doc.pages.map((p) => p.text).join("\n")
	if (!isS(docText) && isC(docText)) return { value: "consolidated", heading: "report presents consolidated statements only" }
	return { heading: "" }
}

export function verifyProposed(doc: ReportDoc, p: ProposedFact, ctx: { basis: string; docCurrency?: string }): Verified {
	const fail = (reason: string): Verified => ({ ok: false, reason })
	const page = doc.pages.find((x) => x.n === Number(p.page))
	if (!page) return fail(`page ${p.page} does not exist (the report has ${doc.pageCount} pages)`)
	if (!/^\d{4}-\d{2}-\d{2}$/.test(p.periodEnd)) return fail(`periodEnd "${p.periodEnd}" must be YYYY-MM-DD`)
	const row = norm(p.row ?? "")
	if (row.length < 3) return fail("row label is missing")
	if (!ROW_OK[p.metric]) return fail(`unknown metric "${p.metric}"`)
	// rows that cannot be this metric are refused before looking at values; indented shareholder rows are checked with their heading below
	const maybeAttributable = p.metric === "net_income" && /shareholders|owners|equity holders|parent|attributable/i.test(p.row)
	if (!ROW_OK[p.metric](p.row, page.text) && !maybeAttributable) return fail(`row "${p.row}" is not a ${p.metric} line`)
	const printed = parsePrinted(p.value ?? "")
	if (printed === undefined) return fail(`value "${p.value}" is not a printed number`)

	// 1. the row label, and the printed value on that row (or the line just below a wrapped label)
	const rowLines = page.lines.map((l, i) => ({ l, i })).filter(({ l }) => norm(l.text).includes(row))
	if (!rowLines.length) return fail(`row label "${p.row}" is not on page ${page.n}`)
	const target = p.value.trim()
	const matches: PrintedCell[] = []
	for (const { l, i } of rowLines) {
		const next = page.lines[i + 1]
		// A label without figures may wrap onto a numeric-only continuation line.
		// A new label or a row that already contains figures ends that logical row.
		const lines = [{ line: l, idx: i }]
		if (next && !l.items.some(item => item.str.split(/\s+/).some(token => parsePrinted(token) !== undefined)) && numericLine(next)) {
			lines.push({ line: next, idx: i + 1 })
		}
		for (const { line, idx } of lines) {
			for (const item of line.items) {
				for (const token of item.str.matchAll(/\S+/g)) {
					if (token[0] !== target) continue
					const fraction = (token.index + target.length / 2) / item.str.length
					matches.push({ line, idx, x: item.x0 + fraction * (item.x1 - item.x0) })
				}
			}
		}
	}
	if (!matches.length) return fail(`value "${target}" is not printed on the row "${p.row}" (page ${page.n})`)
	let firstError: Verified | undefined
	for (const hit of matches) {
		const result = verifyCell(doc, page, p, ctx, hit)
		if (result.ok) return result
		firstError ??= result
	}
	return firstError!
}

function verifyCell(doc: ReportDoc, page: PdfPage, p: ProposedFact, ctx: { basis: string; docCurrency?: string }, hit: PrintedCell): Verified {
	const fail = (reason: string): Verified => ({ ok: false, reason })
	const target = p.value.trim()
	// the row must be a line of this metric; an indented row ("Shareholders of the Company") is read with its heading
	const heading = rowHeading(page, hit.idx)
	const attributableRow = p.metric === "net_income" && /shareholders|owners|equity holders|parent|attributable/i.test(p.row) && /profit|net income|earnings/i.test(`${p.row} ${heading}`) && /attributable/i.test(`${p.row} ${heading}`) && !/comprehensive/i.test(`${p.row} ${heading}`)
	if (!ROW_OK[p.metric](p.row, page.text) && !attributableRow) return fail(`row "${p.row}"${heading ? ` (under "${heading}")` : ""} is not a ${p.metric} line`)
	const verified = [`row "${p.row}"${attributableRow && !/attributable/i.test(p.row) ? ` under "${heading}"` : ""} found on page ${page.n}`, `value ${target} printed on that row`]

	// 2. column: the nearest column-header date above the value must be the stated period end
	const flatHeaders = headerDates(page, hit.line.y)
	const headers = [...stackedColumns(page, hit.idx).filter(header => typeOf(header.text)), ...flatHeaders]
	if (!headers.length) return fail(`no column-header dates found above the value on page ${page.n}`)
	const cellX = hit.x
	const nearest = [...headers].sort((a, b) => Math.abs(a.x - cellX) - Math.abs(b.x - cellX))[0]
	if (Math.abs(nearest.x - cellX) > 90) return fail(`could not align the value with a column header on page ${page.n}`)
	if (nearest.date !== p.periodEnd) return fail(`the value sits under the column dated ${nearest.date}, not ${p.periodEnd}`)
	verified.push(`printed under the column dated ${nearest.date} ("${nearest.text}")`)

	// 3. Period identity comes exclusively from the header above this column.
	const inHeader = typeOf(nearest.text)
	if (inHeader && inHeader !== p.periodType) return fail(`the column header "${nearest.text}" is a ${inHeader} column, not ${p.periodType}`)
	if (!inHeader) {
		const type = groupedPeriod(page, nearest, flatHeaders)
		if (!type) return fail(`no unambiguous period label above the column dated ${nearest.date}`)
		if (type !== p.periodType) return fail(`the column is labelled ${type}, not ${p.periodType}`)
	}
	verified.push(`column labelled ${p.periodType}`)

	// 4. scale and currency from the page's unit note (EPS is per share: no scale)
	const perShare = isPerShareMetric(p.metric)
	const notes = unitNotes(page)
	let scale = 1
	let unitNote = "per share (no scale)"
	let currency: string | undefined
	if (!perShare) {
		const scalesOnPage = [...new Set(notes.map((n) => n.scaleWord))]
		if (!notes.length) return fail(`page ${page.n} has no unit note (e.g. "₹ in crore"); the scale cannot be established`)
		if (scalesOnPage.length > 1) {
			// several notes: use the nearest one above the value
			const above = notes.filter((n) => n.line <= hit.idx).sort((a, b) => b.line - a.line)[0]
			if (!above) return fail(`page ${page.n} has several unit notes (${scalesOnPage.join(", ")}) and none above the value`)
			scale = above.scale
			unitNote = above.note
			currency = above.currency
		} else {
			scale = notes[0].scale
			unitNote = notes[0].note
			currency = notes.find((n) => n.currency)?.currency
		}
	} else currency = notes.find((n) => n.currency)?.currency
	currency ??= ctx.docCurrency
	if (!currency) return fail(`no currency is stated on page ${page.n} or in the report`)
	verified.push(perShare ? `per-share value in ${currency}` : `unit note "${unitNote}" → ×${scale.toLocaleString("en-US")} ${currency}`)

	// 5. consolidated vs standalone from the statement heading
	const cons = consolidationOf(page, hit.idx, doc)
	if (!cons.value) return fail(`page ${page.n} does not say whether the statement is consolidated or standalone`)
	if (cons.value !== p.consolidation) return fail(`the statement on page ${page.n} is ${cons.value}, not ${p.consolidation}`)
	verified.push(`${cons.value} statement ("${cons.heading.slice(0, 90)}")`)

	const start = startOf(p.periodEnd, p.periodType)
	const value = scaledValue(target, scale)
	const src = doc.url ?? `uploaded file ${doc.fileName ?? ""}`.trim()
	return {
		ok: true,
		fact: {
			// net income: profit attributable to the company's shareholders is the primary line; profit for the period (incl. non-controlling interests) is separate
			concept: p.metric === "net_income" ? (attributableRow || /attributable/i.test(p.row) ? "report:NetIncome" : "report:ProfitLoss") : reportConcept(p.metric),
			unit: perShare ? `${currency}/shares` : currency,
			value,
			start,
			end: p.periodEnd,
			form: "REPORT",
			accn: `report-${doc.sha256.slice(0, 10)}`,
			filed: doc.fetchedAt.slice(0, 10),
			consolidation: cons.value,
			basis: ctx.basis,
			source: "report",
			filingUrl: src,
			documentUrl: doc.url ? `${doc.url}#page=${page.n}` : src,
			location: { page: page.n, heading: cons.heading.slice(0, 160), row: attributableRow && !/attributable/i.test(p.row) ? `${heading.replace(/:\s*$/, "")}: ${p.row}` : p.row, column: nearest.text || p.column, printed: target, unitNote, verified },
		},
	}
}
