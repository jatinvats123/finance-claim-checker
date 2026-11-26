import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ALL_CONCEPTS, type FactRow, type FilingRow, type SecSnapshot } from "./types.js"

export const SNAPSHOT_DIR = "data/sec-snapshot"

/** SEC asks automated clients to identify themselves. Set SEC_USER_AGENT="Your Name you@example.com". */
export function secUserAgent(): string {
	return process.env.SEC_USER_AGENT ?? "finance-claim-checker/0.1 (hackathon prototype; set SEC_USER_AGENT) contact@example.com"
}

export class SecDataMissing extends Error {
	readonly kind = "SEC_CACHE_MISS"
	constructor(message: string) {
		super(message)
	}
}

/** Offline: load the committed snapshot. An unknown ticker is an explicit cache miss, never a guess. */
export function loadSnapshot(ticker: string, dir = SNAPSHOT_DIR): SecSnapshot {
	const path = join(dir, `${ticker.toUpperCase()}.json`)
	if (!existsSync(path)) {
		throw new SecDataMissing(
			`No SEC snapshot for ${ticker.toUpperCase()} in ${dir}. Run "npm run snapshot:sec -- ${ticker.toUpperCase()}" (needs network) or use --live-sec.`,
		)
	}
	return JSON.parse(readFileSync(path, "utf8")) as SecSnapshot
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { "User-Agent": secUserAgent(), Accept: "application/json" } })
	if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${res.statusText} for ${url}`)
	return res.json()
}

export async function resolveCik(ticker: string): Promise<{ cik: string; title: string }> {
	const all = await getJson("https://www.sec.gov/files/company_tickers.json")
	const hit = Object.values<any>(all).find((r) => String(r.ticker).toUpperCase() === ticker.toUpperCase())
	if (!hit) throw new SecDataMissing(`Ticker ${ticker} not found in SEC company_tickers.json`)
	return { cik: String(hit.cik_str).padStart(10, "0"), title: hit.title }
}

/** Online: fetch EDGAR company facts + filing index and trim to the concepts/forms the checker uses. */
export async function fetchSnapshot(ticker: string): Promise<SecSnapshot> {
	const { cik, title } = await resolveCik(ticker)
	const companyFactsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
	const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik}.json`
	const [cf, sub] = await Promise.all([getJson(companyFactsUrl), getJson(submissionsUrl)])

	const facts: SecSnapshot["facts"] = {}
	for (const concept of ALL_CONCEPTS) {
		const [ns, name] = concept.split(":")
		const entry = cf.facts?.[ns]?.[name]
		if (!entry) continue
		facts[concept] = {}
		for (const [unit, rows] of Object.entries<any[]>(entry.units)) {
			facts[concept][unit] = rows
				.filter((r) => /^(10-Q|10-K)(\/A)?$/.test(r.form))
				.map((r): FactRow => ({ start: r.start, end: r.end, val: r.val, accn: r.accn, fy: r.fy ?? null, fp: r.fp ?? null, form: r.form, filed: r.filed, frame: r.frame }))
		}
	}

	const recent = sub.filings.recent
	const filings: FilingRow[] = []
	for (let i = 0; i < recent.accessionNumber.length; i++) {
		if (!/^(8-K|10-Q|10-K)(\/A)?$/.test(recent.form[i])) continue
		filings.push({
			accessionNumber: recent.accessionNumber[i],
			form: recent.form[i],
			filingDate: recent.filingDate[i],
			reportDate: recent.reportDate[i],
			primaryDocument: recent.primaryDocument[i],
			items: recent.items?.[i] ?? "",
		})
	}

	return {
		ticker: ticker.toUpperCase(),
		cik,
		entityName: cf.entityName ?? title,
		source: {
			companyFactsUrl,
			submissionsUrl,
			fetchedAt: new Date().toISOString(),
			note: "Trimmed copy of SEC EDGAR XBRL company facts (10-Q/10-K only) and recent filing index. Public data.",
		},
		facts,
		filings,
	}
}

export async function getSnapshot(ticker: string, live: boolean): Promise<SecSnapshot> {
	return live ? fetchSnapshot(ticker) : loadSnapshot(ticker)
}

export function filingIndexUrl(cik: string, accn: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/`
}

export function filingDocUrl(cik: string, accn: string, primaryDocument?: string): string {
	return primaryDocument ? filingIndexUrl(cik, accn) + primaryDocument : filingIndexUrl(cik, accn)
}
