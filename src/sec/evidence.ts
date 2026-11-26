import { filingDocUrl, filingIndexUrl } from "./edgar.js"
import { METRIC_CONCEPTS, type FilingRow, type SecSnapshot, type VerifiableMetric } from "./types.js"

export type FiscalPeriod = "Q1" | "Q2" | "Q3" | "Q4" | "FY" | "H1" | "9M"
export type DurationClass = "quarter" | "half" | "nine_months" | "annual" | "other"

export type EvidenceFact = {
	/** Stable, readable id. The only handle agents use to reference a value. */
	id: string
	concept: string
	unit: string
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
	/** true when this fact is the filing's own reporting period (not a prior-period comparative). */
	isOriginal: boolean
	filingUrl: string
	documentUrl: string
	/** Present only for values computed from other evidence (e.g. Q4 = FY − 9M YTD). */
	derivation?: { formula: string; inputIds: string[] }
}

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

/** Builds every verifiable fact from 10-Q/10-K XBRL data and identifies its fiscal period from dates, not from the filing's fy/fp tags. */
export class EvidenceRegistry {
	readonly fiscalYears: FiscalYear[]
	readonly calendar: CalendarEntry[]
	private readonly byId = new Map<string, EvidenceFact>()

	constructor(readonly snapshot: SecSnapshot) {
		this.fiscalYears = buildFiscalYears(snapshot)
		this.calendar = buildCalendar(snapshot, this.fiscalYears)
		this.ingest()
		this.deriveQ4()
	}

	get(id: string): EvidenceFact | undefined {
		return this.byId.get(id)
	}

	all(): EvidenceFact[] {
		return [...this.byId.values()]
	}

	/** Candidates for a metric/period, original filings first, then later comparatives. */
	search(metric: VerifiableMetric, fiscalYear: number, fiscalPeriod: FiscalPeriod): EvidenceFact[] {
		const concepts: readonly string[] = METRIC_CONCEPTS[metric]
		return this.all()
			.filter((f) => concepts.includes(f.concept) && f.fiscalYear === fiscalYear && f.fiscalPeriod === fiscalPeriod)
			.sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal) || a.filed.localeCompare(b.filed))
	}

	/** Same concept and dates reported with a different value in another 10-Q/10-K. */
	restatementsOf(fact: EvidenceFact): EvidenceFact[] {
		return this.all().filter((f) => f.concept === fact.concept && f.start === fact.start && f.end === fact.end && f.accn !== fact.accn && f.value !== fact.value && !f.derivation)
	}

	/** Is any 10-Q/10-K period on file for this fiscal year/period? */
	hasReferenceFor(fiscalYear: number, fiscalPeriod: FiscalPeriod): boolean {
		return this.all().some((f) => f.fiscalYear === fiscalYear && f.fiscalPeriod === fiscalPeriod)
	}

	latestReportedPeriod(): CalendarEntry | undefined {
		return [...this.calendar].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0]
	}

	/** Earnings releases (8-K Item 2.02) filed after the latest 10-Q/10-K period — the documents we must NOT verify against. */
	earningsReleasesAfterLatestReport(): FilingRow[] {
		const latest = this.latestReportedPeriod()
		return this.snapshot.filings.filter((f) => f.form.startsWith("8-K") && f.items.split(",").includes("2.02") && (!latest || f.filingDate > latest.filed))
	}

	filingUrlFor(accn: string, primaryDocument?: string) {
		return filingDocUrl(this.snapshot.cik, accn, primaryDocument)
	}

	private ingest() {
		const { snapshot } = this
		const docs = new Map(snapshot.filings.map((f) => [f.accessionNumber, f.primaryDocument]))
		const ownEnd = new Map(this.calendar.map((c) => [c.accn, c.periodEnd]))
		for (const [concept, units] of Object.entries(snapshot.facts)) {
			for (const [unit, rows] of Object.entries(units)) {
				for (const r of rows) {
					if (!r.start || !/^(10-Q|10-K)/.test(r.form)) continue // instants and non-statement forms are not evidence
					const days = daysBetween(r.start, r.end)
					const durationClass = classifyDuration(days)
					const period = identifyPeriod(this.fiscalYears, r.start, r.end, durationClass)
					if (!period) continue
					const id = `${conceptName(concept)}/${periodLabel(period.fy, period.fp)}/${shortAccn(r.accn)}`
					if (this.byId.has(id)) continue // same fact repeated within one filing
					this.byId.set(id, {
						id,
						concept,
						unit,
						value: r.val,
						start: r.start,
						end: r.end,
						days,
						durationClass,
						fiscalYear: period.fy,
						fiscalPeriod: period.fp,
						form: r.form,
						accn: r.accn,
						filed: r.filed,
						isOriginal: ownEnd.has(r.accn) && near(ownEnd.get(r.accn)!, r.end, 1),
						filingUrl: filingIndexUrl(snapshot.cik, r.accn),
						documentUrl: filingDocUrl(snapshot.cik, r.accn, docs.get(r.accn)),
					})
				}
			}
		}
	}

	/** Q4 is rarely tagged on its own: derive it as FY − 9M YTD from original filings. Not done for per-share values (share counts differ by period). */
	private deriveQ4() {
		const originals = this.all().filter((f) => f.isOriginal && f.unit === "USD")
		for (const fy of originals.filter((f) => f.fiscalPeriod === "FY")) {
			const hasQ4 = this.all().some((f) => f.concept === fy.concept && f.fiscalYear === fy.fiscalYear && f.fiscalPeriod === "Q4" && f.isOriginal)
			if (hasQ4) continue
			const ytd = originals.find((f) => f.concept === fy.concept && f.fiscalYear === fy.fiscalYear && f.fiscalPeriod === "9M" && f.start === fy.start)
			if (!ytd) continue
			const id = `${conceptName(fy.concept)}/${periodLabel(fy.fiscalYear, "Q4")}/derived`
			const start = new Date(Date.parse(ytd.end) + DAY).toISOString().slice(0, 10)
			this.byId.set(id, {
				...fy,
				id,
				value: fy.value - ytd.value,
				start,
				days: daysBetween(start, fy.end),
				durationClass: "quarter",
				fiscalPeriod: "Q4",
				derivation: { formula: `${fy.id} − ${ytd.id}`, inputIds: [fy.id, ytd.id] },
			})
		}
	}
}

export type FiscalYear = { label: number; start: string; end: string; projected: boolean }

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10)
const year = (d: string) => Number(d.slice(0, 4))

function* durationRows(snapshot: SecSnapshot) {
	for (const units of Object.values(snapshot.facts)) for (const rows of Object.values(units)) for (const r of rows) if (r.start && /^(10-Q|10-K)/.test(r.form)) yield r
}

/**
 * Fiscal years come from the annual periods reported in 10-Ks (their actual start/end dates).
 * Filing fy/fp tags are only used to learn the company's labelling convention (e.g. NVIDIA calls the
 * year ending January 2026 "FY2026"); early XBRL filings carry wrong tags, so they never label a fact.
 * The current, unfinished fiscal year is projected one year past the last 10-K.
 */
export function buildFiscalYears(snapshot: SecSnapshot): FiscalYear[] {
	const maxEnd = new Map<string, string>()
	for (const r of durationRows(snapshot)) if (r.end > (maxEnd.get(r.accn) ?? "")) maxEnd.set(r.accn, r.end)

	const annual = new Map<string, { start: string; end: string; n: number }>() // keyed by end date
	const offsets: { end: string; offset: number }[] = []
	for (const r of durationRows(snapshot)) {
		if (!r.form.startsWith("10-K") || classifyDuration(daysBetween(r.start!, r.end)) !== "annual") continue
		const k = r.end
		const cur = annual.get(k)
		annual.set(k, { start: cur?.start ?? r.start!, end: r.end, n: (cur?.n ?? 0) + 1 })
		if (r.fy != null && r.end === maxEnd.get(r.accn)) offsets.push({ end: r.end, offset: r.fy - year(r.end) })
	}
	// labelling convention from the most recent 10-Ks' own periods
	const recent = offsets.sort((a, b) => b.end.localeCompare(a.end)).slice(0, 12)
	const counts = new Map<number, number>()
	for (const o of recent) counts.set(o.offset, (counts.get(o.offset) ?? 0) + 1)
	const offset = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0

	const years: FiscalYear[] = []
	for (const a of [...annual.values()].sort((x, y) => x.end.localeCompare(y.end))) {
		const prev = years.at(-1)
		if (prev && near(prev.end, a.end, 7)) continue
		years.push({ label: year(a.end) + offset, start: a.start, end: a.end, projected: false })
	}
	const last = years.at(-1)
	if (last) years.push({ label: last.label + 1, start: addDays(last.end, 1), end: addDays(last.end, 371), projected: true })
	return years
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

/** The filing's own reporting period for each 10-Q/10-K accession, labelled from fiscal-year dates. */
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
		const fp = r.form.startsWith("10-K") ? "FY" : `Q${Math.round(daysBetween(fy.start, periodEnd) / 91)}`
		byAccn.set(r.accn, { accn: r.accn, form: r.form, fy: fy.label, fp, periodEnd, filed: r.filed, primaryDocument: doc?.primaryDocument })
	}
	return [...byAccn.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
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
