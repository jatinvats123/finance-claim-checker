import { filingDocUrl, filingIndexUrl } from "./edgar.js"
import { ANNUAL_FORM, isStatementForm, METRIC_CONCEPTS, taxonomyOf, type FilingRow, type SecSnapshot, type VerifiableMetric } from "./types.js"

export type FiscalPeriod = "Q1" | "Q2" | "Q3" | "Q4" | "FY" | "H1" | "9M"
export type DurationClass = "quarter" | "half" | "nine_months" | "annual" | "other"
export type Consolidation = "consolidated" | "standalone"

/** Where a value sits in an official report (PDF): every part was checked against the page by code. */
export type DocLocation = {
	page: number
	/** Statement heading on that page, e.g. "Statement of Consolidated Financial Results". */
	heading: string
	row: string
	column: string
	/** The value exactly as printed (e.g. "1,23,456.78"). */
	printed: string
	/** The page's unit note the scale came from (e.g. "(₹ in crore)"). */
	unitNote: string
	/** What code verified on the page (row, value on that row, column alignment, dates, unit note). */
	verified: string[]
}

export type EvidenceFact = {
	/** Stable, readable id. The only handle agents use to reference a value. */
	id: string
	concept: string
	unit: string
	/** ISO currency of the value (from the XBRL unit or the report's unit note). */
	currency: string
	perShare: boolean
	value: number
	start: string
	end: string
	days: number
	durationClass: DurationClass
	fiscalYear: number
	fiscalPeriod: FiscalPeriod
	form: string
	accn: string
	filed: string
	/** SEC company facts are the consolidated entity; reports say consolidated or standalone per statement. */
	consolidation: Consolidation
	/** Accounting basis of the statements: "US GAAP", "IFRS", or as printed in the report (e.g. "Ind AS"). */
	basis: string
	source: "sec-xbrl" | "report"
	/** true when this fact is the filing's own reporting period (not a prior-period comparative). */
	isOriginal: boolean
	/** A convenience translation into a currency other than the filing's reporting currency (20-F). */
	translated?: boolean
	filingUrl: string
	documentUrl: string
	location?: DocLocation
	/** Present only for values computed from other evidence (e.g. Q4 = FY − 9M YTD). */
	derivation?: { formula: string; inputIds: string[] }
}

/** Facts as they come from a source, before fiscal labelling. */
export type RawFact = Omit<EvidenceFact, "id" | "days" | "durationClass" | "fiscalYear" | "fiscalPeriod" | "isOriginal" | "currency" | "perShare" | "derivation"> & { fyTag?: number | null }

export type ReferenceInfo = {
	kind: "sec" | "report"
	entityName: string
	ticker?: string
	cik?: string
	fetchedAt: string
	/** One line: what the reference is ("SEC EDGAR XBRL: 10-Q/10-K/20-F/40-F statements" or "Official report: …"). */
	label: string
	sources: { label: string; url: string }[]
	reportingCurrency?: string
	note?: string
}

/** A reference built from an official report (PDF): facts already verified against their pages. */
export type ReportEvidence = { kind: "report"; info: ReferenceInfo; facts: RawFact[]; fiscalYearEnd?: string }

export type CalendarEntry = { accn: string; form: string; fy: number; fp: string; periodEnd: string; filed: string; primaryDocument?: string }

const DAY = 86_400_000
export const daysBetween = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1

export function classifyDuration(days: number): DurationClass {
	if (days >= 80 && days <= 100) return "quarter"
	if (days >= 170 && days <= 195) return "half"
	if (days >= 260 && days <= 285) return "nine_months"
	if (days >= 350 && days <= 380) return "annual"
	return "other"
}

const near = (a: string, b: string, tolDays = 4) => Math.abs(Date.parse(a) - Date.parse(b)) <= tolDays * DAY
const shortAccn = (accn: string) => accn.slice(-9)
const conceptName = (c: string) => c.split(":")[1]
export const periodLabel = (fy: number, fp: FiscalPeriod) => `${fp}-FY${fy}`
/** "USD" → USD; "INR/shares" → INR per share; non-currency units ("pure", "shares") → undefined. */
export function parseUnit(unit: string): { currency: string; perShare: boolean } | undefined {
	const m = /^([A-Z]{3})(\/shares)?$/.exec(unit)
	return m ? { currency: m[1], perShare: !!m[2] } : undefined
}

/**
 * Every verifiable fact from one reference — SEC XBRL (10-Q/10-K/20-F/40-F) or an official report —
 * with its fiscal period identified from dates, not from the filing's fy/fp tags.
 */
export class EvidenceRegistry {
	readonly fiscalYears: FiscalYear[]
	readonly calendar: CalendarEntry[]
	readonly info: ReferenceInfo
	readonly snapshot?: SecSnapshot
	private readonly byId = new Map<string, EvidenceFact>()

	constructor(src: SecSnapshot | ReportEvidence) {
		if ("kind" in src && src.kind === "report") {
			this.info = src.info
			const raw = src.facts
			this.fiscalYears = fiscalYearsFromRaw(raw, 0, src.fiscalYearEnd)
			const latestEnd = raw.reduce((m, f) => (f.end > m ? f.end : m), "")
			this.ingest(raw, (f) => f.end === latestEnd)
			this.calendar = calendarFromFacts(this.all())
		} else {
			const snapshot = src as SecSnapshot
			this.snapshot = snapshot
			const raw = rawFromSnapshot(snapshot)
			this.fiscalYears = buildFiscalYears(snapshot)
			this.calendar = buildCalendar(snapshot, this.fiscalYears)
			const ownEnd = new Map(this.calendar.map((c) => [c.accn, c.periodEnd]))
			const reporting = reportingCurrency(raw)
			this.info = {
				kind: "sec",
				entityName: snapshot.entityName,
				ticker: snapshot.ticker,
				cik: snapshot.cik,
				fetchedAt: snapshot.source.fetchedAt,
				label: "SEC EDGAR XBRL financial statements (10-Q, 10-K, 20-F, 40-F)",
				sources: [
					{ label: "SEC company facts (XBRL)", url: snapshot.source.companyFactsUrl },
					{ label: "SEC filing index", url: snapshot.source.submissionsUrl },
				],
				reportingCurrency: reporting,
			}
			this.ingest(raw, (f) => ownEnd.has(f.accn) && near(ownEnd.get(f.accn)!, f.end, 1), reporting)
		}
		this.deriveQ4()
	}

	get(id: string): EvidenceFact | undefined {
		return this.byId.get(id)
	}

	all(): EvidenceFact[] {
		return [...this.byId.values()]
	}

	/** Priority of a concept within its metric (0 = primary line item). */
	static conceptRank(metric: VerifiableMetric, concept: string): number {
		const i = (METRIC_CONCEPTS[metric] as readonly string[]).indexOf(concept)
		return i < 0 ? 99 : i
	}

	/** Candidates for a metric/period: primary line item, consolidated, reporting currency and original filings first. */
	search(metric: VerifiableMetric, fiscalYear: number, fiscalPeriod: FiscalPeriod): EvidenceFact[] {
		const concepts: readonly string[] = METRIC_CONCEPTS[metric]
		return this.all()
			.filter((f) => concepts.includes(f.concept) && f.fiscalYear === fiscalYear && f.fiscalPeriod === fiscalPeriod)
			.sort(
				(a, b) =>
					Number(!!a.translated) - Number(!!b.translated) ||
					EvidenceRegistry.conceptRank(metric, a.concept) - EvidenceRegistry.conceptRank(metric, b.concept) ||
					Number(a.consolidation !== "consolidated") - Number(b.consolidation !== "consolidated") ||
					Number(b.isOriginal) - Number(a.isOriginal) ||
					a.filed.localeCompare(b.filed),
			)
	}

	/** The metric's primary line item among facts for this period, filing and consolidation (e.g. NetIncomeLoss before ProfitLoss). */
	primaryFor(metric: VerifiableMetric, fact: EvidenceFact): EvidenceFact | undefined {
		return this.search(metric, fact.fiscalYear, fact.fiscalPeriod).find((f) => f.accn === fact.accn && f.consolidation === fact.consolidation && f.currency === fact.currency && !f.derivation === !fact.derivation)
	}

	/** Same concept and dates reported with a different value in another filing. */
	restatementsOf(fact: EvidenceFact): EvidenceFact[] {
		return this.all().filter(
			(f) => f.concept === fact.concept && f.start === fact.start && f.end === fact.end && f.accn !== fact.accn && f.currency === fact.currency && f.consolidation === fact.consolidation && f.value !== fact.value && !f.derivation,
		)
	}

	/** Is any statement period on file for this fiscal year/period? */
	hasReferenceFor(fiscalYear: number, fiscalPeriod: FiscalPeriod): boolean {
		return this.all().some((f) => f.fiscalYear === fiscalYear && f.fiscalPeriod === fiscalPeriod)
	}

	latestReportedPeriod(): CalendarEntry | undefined {
		return [...this.calendar].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0]
	}

	/** Earnings releases (8-K Item 2.02) filed after the latest statements — the documents we must NOT verify against. */
	earningsReleasesAfterLatestReport(): FilingRow[] {
		if (!this.snapshot) return []
		const latest = this.latestReportedPeriod()
		return this.snapshot.filings.filter((f) => f.form.startsWith("8-K") && f.items.split(",").includes("2.02") && (!latest || f.filingDate > latest.filed))
	}

	filingUrlFor(accn: string, primaryDocument?: string) {
		return this.snapshot ? filingDocUrl(this.snapshot.cik, accn, primaryDocument) : (this.info.sources[0]?.url ?? "")
	}

	/** "SEC data fetched 2026-11-26" / "the report fetched 2026-11-26". */
	asOf(): string {
		return `${this.info.kind === "sec" ? "the SEC data" : "the report"} fetched ${this.info.fetchedAt.slice(0, 10)}`
	}

	private ingest(raw: RawFact[], isOriginal: (f: RawFact) => boolean, reporting?: string) {
		// facts in a second currency for the same concept/period/filing are convenience translations
		const key = (f: RawFact, cur: string) => `${f.concept}|${f.start}|${f.end}|${f.accn}|${cur}|${f.consolidation}`
		const present = new Set(raw.map((f) => key(f, parseUnit(f.unit)?.currency ?? "")))
		for (const r of raw) {
			const u = parseUnit(r.unit)
			if (!u) continue // "pure", "shares": not money
			const days = daysBetween(r.start, r.end)
			const durationClass = classifyDuration(days)
			const period = identifyPeriod(this.fiscalYears, r.start, r.end, durationClass)
			if (!period) continue
			const translated = !!reporting && u.currency !== reporting && present.has(key(r, reporting))
			const suffix = (r.consolidation === "standalone" ? ".standalone" : "") + (reporting && u.currency !== reporting ? `.${u.currency}` : "")
			const tail = r.location ? `p${r.location.page}` : shortAccn(r.accn)
			const id = `${conceptName(r.concept)}${suffix}/${periodLabel(period.fy, period.fp)}/${tail}`
			if (this.byId.has(id)) continue // same fact repeated within one filing
			const { fyTag: _t, ...rest } = r
			this.byId.set(id, { ...rest, id, currency: u.currency, perShare: u.perShare, days, durationClass, fiscalYear: period.fy, fiscalPeriod: period.fp, isOriginal: isOriginal(r), translated: translated || undefined })
		}
	}

	/** Q4 is rarely tagged on its own: derive it as FY − 9M YTD from original filings. Not done for per-share values (share counts differ by period). */
	private deriveQ4() {
		const originals = this.all().filter((f) => f.isOriginal && !f.perShare && !f.derivation)
		for (const fy of originals.filter((f) => f.fiscalPeriod === "FY")) {
			const same = (f: EvidenceFact) => f.concept === fy.concept && f.fiscalYear === fy.fiscalYear && f.currency === fy.currency && f.consolidation === fy.consolidation
			if (this.all().some((f) => same(f) && f.fiscalPeriod === "Q4" && f.isOriginal)) continue
			const ytd = originals.find((f) => same(f) && f.fiscalPeriod === "9M" && f.start === fy.start)
			if (!ytd) continue
			const id = fy.id.replace(`/${periodLabel(fy.fiscalYear, "FY")}/`, `/${periodLabel(fy.fiscalYear, "Q4")}/`).replace(/\/[^/]+$/, "/derived")
			const start = new Date(Date.parse(ytd.end) + DAY).toISOString().slice(0, 10)
			this.byId.set(id, {
				...fy,
				id,
				value: fy.value - ytd.value,
				start,
				days: daysBetween(start, fy.end),
				durationClass: "quarter",
				fiscalPeriod: "Q4",
				location: undefined,
				derivation: { formula: `${fy.id} − ${ytd.id}`, inputIds: [fy.id, ytd.id] },
			})
		}
	}
}

/** The filing's reporting currency: the currency of most revenue/profit facts (20-F filers may add a USD convenience translation). */
function reportingCurrency(raw: RawFact[]): string | undefined {
	const counts = new Map<string, number>()
	for (const f of raw) {
		const u = parseUnit(f.unit)
		if (u && !u.perShare) counts.set(u.currency, (counts.get(u.currency) ?? 0) + 1)
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function rawFromSnapshot(snapshot: SecSnapshot): RawFact[] {
	const docs = new Map(snapshot.filings.map((f) => [f.accessionNumber, f.primaryDocument]))
	const out: RawFact[] = []
	for (const [concept, units] of Object.entries(snapshot.facts)) {
		for (const [unit, rows] of Object.entries(units)) {
			for (const r of rows) {
				if (!r.start || !isStatementForm(r.form)) continue // instants and non-statement forms are not evidence
				out.push({
					concept,
					unit,
					value: r.val,
					start: r.start,
					end: r.end,
					form: r.form,
					accn: r.accn,
					filed: r.filed,
					fyTag: r.fy,
					consolidation: "consolidated",
					basis: taxonomyOf(concept),
					source: "sec-xbrl",
					filingUrl: filingIndexUrl(snapshot.cik, r.accn),
					documentUrl: filingDocUrl(snapshot.cik, r.accn, docs.get(r.accn)),
				})
			}
		}
	}
	return out
}

export type FiscalYear = { label: number; start: string; end: string; projected: boolean }

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10)
const year = (d: string) => Number(d.slice(0, 4))

function* durationRows(snapshot: SecSnapshot) {
	for (const units of Object.values(snapshot.facts)) for (const rows of Object.values(units)) for (const r of rows) if (r.start && isStatementForm(r.form)) yield r
}

function yearsFromAnnual(annual: { start: string; end: string }[], offset: number): FiscalYear[] {
	const years: FiscalYear[] = []
	for (const a of [...annual].sort((x, y) => x.end.localeCompare(y.end))) {
		const prev = years.at(-1)
		if (prev && near(prev.end, a.end, 7)) continue
		years.push({ label: year(a.end) + offset, start: a.start, end: a.end, projected: false })
	}
	const last = years.at(-1)
	if (last) years.push({ label: last.label + 1, start: addDays(last.end, 1), end: addDays(last.end, 371), projected: true })
	return years
}

/**
 * Fiscal years come from the annual periods reported in 10-K/20-F/40-F filings (their actual start/end
 * dates). Filing fy/fp tags are only used to learn the company's labelling convention (e.g. NVIDIA
 * calls the year ending January 2026 "FY2026"); early XBRL filings carry wrong tags, so they never
 * label a fact. The current, unfinished fiscal year is projected one year past the last annual report.
 */
export function buildFiscalYears(snapshot: SecSnapshot): FiscalYear[] {
	const maxEnd = new Map<string, string>()
	for (const r of durationRows(snapshot)) if (r.end > (maxEnd.get(r.accn) ?? "")) maxEnd.set(r.accn, r.end)

	const annual = new Map<string, { start: string; end: string }>() // keyed by end date
	const offsets: { end: string; offset: number }[] = []
	for (const r of durationRows(snapshot)) {
		if (!ANNUAL_FORM.test(r.form) || classifyDuration(daysBetween(r.start!, r.end)) !== "annual") continue
		if (!annual.has(r.end)) annual.set(r.end, { start: r.start!, end: r.end })
		if (r.fy != null && r.end === maxEnd.get(r.accn)) offsets.push({ end: r.end, offset: r.fy - year(r.end) })
	}
	// labelling convention from the most recent annual reports' own periods
	const recent = offsets.sort((a, b) => b.end.localeCompare(a.end)).slice(0, 12)
	const counts = new Map<number, number>()
	for (const o of recent) counts.set(o.offset, (counts.get(o.offset) ?? 0) + 1)
	const offset = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
	return yearsFromAnnual([...annual.values()], offset)
}

/** Fiscal years of a report: from its annual columns, else from a "year ending MM-DD" stated in the report. */
function fiscalYearsFromRaw(raw: RawFact[], offset: number, fiscalYearEnd?: string): FiscalYear[] {
	const annual = raw.filter((f) => classifyDuration(daysBetween(f.start, f.end)) === "annual").map((f) => ({ start: f.start, end: f.end }))
	if (annual.length) return yearsFromAnnual(annual, offset)
	if (!fiscalYearEnd || !raw.length) return []
	// no annual column: anchor on the stated year end, covering every period in the report
	const ends = raw.map((f) => f.end).sort()
	const first = Number(ends[0].slice(0, 4)) - 1
	const last = Number(ends.at(-1)!.slice(0, 4)) + 1
	const synth: { start: string; end: string }[] = []
	for (let y = first; y <= last; y++) synth.push({ start: addDays(`${y - 1}-${fiscalYearEnd}`, 1), end: `${y}-${fiscalYearEnd}` })
	return yearsFromAnnual(synth, offset).filter((y) => !y.projected)
}

const fiscalYearOf = (years: FiscalYear[], date: string) => years.find((y) => Date.parse(date) >= Date.parse(y.start) - 3 * DAY && Date.parse(date) <= Date.parse(y.end) + 3 * DAY)

/** Map a fact (start, end, duration) to the fiscal period it covers, by position inside its fiscal year. */
export function identifyPeriod(years: FiscalYear[], start: string, end: string, dc: DurationClass): { fy: number; fp: FiscalPeriod } | undefined {
	const fy = fiscalYearOf(years, end)
	if (!fy || Date.parse(start) < Date.parse(fy.start) - 7 * DAY) return undefined
	const fromStart = near(start, fy.start, 7)
	switch (dc) {
		case "annual":
			return fromStart && !fy.projected ? { fy: fy.label, fp: "FY" } : undefined
		case "half":
			return fromStart ? { fy: fy.label, fp: "H1" } : undefined
		case "nine_months":
			return fromStart ? { fy: fy.label, fp: "9M" } : undefined
		case "quarter": {
			const q = Math.round(daysBetween(fy.start, end) / 91)
			return q >= 1 && q <= 4 ? { fy: fy.label, fp: `Q${q}` as FiscalPeriod } : undefined
		}
		default:
			return undefined
	}
}

/** The filing's own reporting period for each statement accession, labelled from fiscal-year dates. */
export function buildCalendar(snapshot: SecSnapshot, years: FiscalYear[]): CalendarEntry[] {
	const byAccn = new Map<string, CalendarEntry>()
	const docs = new Map(snapshot.filings.map((f) => [f.accessionNumber, f]))
	for (const r of durationRows(snapshot)) {
		const doc = docs.get(r.accn)
		const periodEnd = doc?.reportDate || r.end
		const cur = byAccn.get(r.accn)
		if (cur && (doc || r.end <= cur.periodEnd)) continue
		const fy = fiscalYearOf(years, periodEnd)
		if (!fy) continue
		const fp = ANNUAL_FORM.test(r.form) ? "FY" : `Q${Math.round(daysBetween(fy.start, periodEnd) / 91)}`
		byAccn.set(r.accn, { accn: r.accn, form: r.form, fy: fy.label, fp, periodEnd, filed: r.filed, primaryDocument: doc?.primaryDocument })
	}
	return [...byAccn.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
}

/** A report's periods (one entry per distinct column period). */
function calendarFromFacts(facts: EvidenceFact[]): CalendarEntry[] {
	const by = new Map<string, CalendarEntry>()
	for (const f of facts) {
		const k = `${f.fiscalYear}-${f.fiscalPeriod}`
		if (!by.has(k)) by.set(k, { accn: f.accn, form: f.form, fy: f.fiscalYear, fp: f.fiscalPeriod, periodEnd: f.end, filed: f.filed })
	}
	return [...by.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.fp.localeCompare(b.fp))
}

/** The period a change claim must be compared against. */
export function basePeriod(fy: number, fp: FiscalPeriod, basis: "yoy" | "qoq"): { fy: number; fp: FiscalPeriod } | undefined {
	if (basis === "yoy") return { fy: fy - 1, fp }
	const order: FiscalPeriod[] = ["Q1", "Q2", "Q3", "Q4"]
	const i = order.indexOf(fp)
	if (i < 0) return undefined // QoQ is undefined for FY / H1 / 9M
	return i === 0 ? { fy: fy - 1, fp: "Q4" } : { fy, fp: order[i - 1] }
}

export function expectedDuration(fp: FiscalPeriod): DurationClass {
	return fp === "FY" ? "annual" : fp === "H1" ? "half" : fp === "9M" ? "nine_months" : "quarter"
}
