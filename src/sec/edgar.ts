import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ALL_CONCEPTS, isStatementForm, type FactRow, type FilingRow, type SecSnapshot } from "./types.js"

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

/** The company files with the SEC but has no machine-readable financial statements we can use. */
export class SecDataUnavailable extends Error {
	readonly kind = "SEC_DATA_UNAVAILABLE"
	constructor(message: string) {
		super(message)
	}
}

export const snapshotPath = (ticker: string, dir = SNAPSHOT_DIR) => join(dir, `${ticker.toUpperCase()}.json`)
export const hasSnapshot = (ticker: string, dir = SNAPSHOT_DIR) => existsSync(snapshotPath(ticker, dir))

/** Offline: load the committed snapshot. An unknown ticker is an explicit cache miss, never a guess. */
export function loadSnapshot(ticker: string, dir = SNAPSHOT_DIR): SecSnapshot {
	const path = snapshotPath(ticker, dir)
	if (!existsSync(path)) {
		throw new SecDataMissing(
			`No SEC snapshot for ${ticker.toUpperCase()} in ${dir}. Run "npm run snapshot:sec -- ${ticker.toUpperCase()}" (needs network) or use --live-sec.`,
		)
	}
	return JSON.parse(readFileSync(path, "utf8")) as SecSnapshot
}

async function getJson(url: string, timeoutMs = 30_000): Promise<any> {
	const res = await fetch(url, { headers: { "User-Agent": secUserAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
	if (res.status === 404) return undefined
	if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${res.statusText} for ${url}`)
	return res.json()
}

export async function resolveCik(ticker: string): Promise<{ cik: string; title: string }> {
	const all = await getJson("https://www.sec.gov/files/company_tickers.json")
	const hit = Object.values<any>(all ?? {}).find((r) => String(r.ticker).toUpperCase() === ticker.toUpperCase())
	if (!hit) throw new SecDataMissing(`Ticker ${ticker} not found in SEC company_tickers.json`)
	return { cik: String(hit.cik_str).padStart(10, "0"), title: hit.title }
}

/**
 * Online: fetch EDGAR company facts + filing index for one company (by CIK, or by ticker) and trim them
 * to the concepts and statement forms the checker uses (10-Q, 10-K, 20-F, 40-F). Earnings-release
 * filings (8-K, 6-K) are kept in the filing index only, to say what we must NOT verify against.
 */
export async function fetchSnapshot(company: string | { cik: string; ticker?: string; name?: string }): Promise<SecSnapshot> {
	const { cik, ticker, title } =
		typeof company === "string" ? await resolveCik(company).then((r) => ({ ...r, ticker: company.toUpperCase() })) : { cik: company.cik.padStart(10, "0"), ticker: company.ticker, title: company.name }
	const companyFactsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`
	const submissionsUrl = `https://data.sec.gov/submissions/CIK${cik}.json`
	const [cf, sub] = await Promise.all([getJson(companyFactsUrl), getJson(submissionsUrl)])
	if (!sub) throw new SecDataMissing(`SEC has no filer with CIK ${cik}.`)
	if (!cf) throw new SecDataUnavailable(`${sub.name ?? title ?? `CIK ${cik}`} files with the SEC but has no XBRL financial data (company facts) to check against.`)

	const facts: SecSnapshot["facts"] = {}
	let rows = 0
	for (const concept of ALL_CONCEPTS) {
		const [ns, name] = concept.split(":")
		const entry = cf.facts?.[ns]?.[name]
		if (!entry) continue
		facts[concept] = {}
		for (const [unit, list] of Object.entries<any[]>(entry.units)) {
			const kept = list
				.filter((r) => isStatementForm(r.form))
				.map((r): FactRow => ({ start: r.start, end: r.end, val: r.val, accn: r.accn, fy: r.fy ?? null, fp: r.fp ?? null, form: r.form, filed: r.filed, frame: r.frame }))
			if (kept.length) facts[concept][unit] = kept
			rows += kept.length
		}
		if (!Object.keys(facts[concept]).length) delete facts[concept]
	}
	const entityName = cf.entityName ?? sub.name ?? title ?? `CIK ${cik}`
	if (!rows) throw new SecDataUnavailable(`${entityName} has no revenue, profit or EPS facts from 10-Q/10-K/20-F/40-F statements in SEC XBRL data.`)

	const recent = sub.filings.recent
	const filings: FilingRow[] = []
	for (let i = 0; i < recent.accessionNumber.length; i++) {
		if (!/^(8-K|6-K|10-Q|10-K|20-F|40-F)(\/A)?$/.test(recent.form[i])) continue
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
		ticker: (ticker ?? sub.tickers?.[0] ?? `CIK${Number(cik)}`).toUpperCase(),
		cik,
		entityName,
		source: {
			companyFactsUrl,
			submissionsUrl,
			fetchedAt: new Date().toISOString(),
			note: "Trimmed copy of SEC EDGAR XBRL company facts (10-Q/10-K/20-F/40-F only) and recent filing index. Public data.",
		},
		facts,
		filings,
	}
}

export async function getSnapshot(ticker: string, live: boolean): Promise<SecSnapshot> {
	return live ? fetchSnapshot(ticker) : loadSnapshot(ticker)
}

/** Server-side cache of live SEC fetches (per CIK, 6 hours): repeated checks of one company reuse one fetch. */
const liveCache = new Map<string, { at: number; snapshot?: SecSnapshot; error?: Error }>()
export async function cachedLiveSnapshot(company: { cik: string; ticker?: string; name?: string }, ttlMs = 6 * 3600_000): Promise<SecSnapshot> {
	const key = company.cik.padStart(10, "0")
	const hit = liveCache.get(key)
	if (hit && Date.now() - hit.at < (hit.error ? 10 * 60_000 : ttlMs)) {
		if (hit.error) throw hit.error
		return hit.snapshot!
	}
	try {
		const snapshot = await fetchSnapshot(company)
		liveCache.set(key, { at: Date.now(), snapshot })
		return snapshot
	} catch (e) {
		if (e instanceof SecDataUnavailable || e instanceof SecDataMissing) liveCache.set(key, { at: Date.now(), error: e })
		throw e
	}
}

export function filingIndexUrl(cik: string, accn: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/`
}

export function filingDocUrl(cik: string, accn: string, primaryDocument?: string): string {
	return primaryDocument ? filingIndexUrl(cik, accn) + primaryDocument : filingIndexUrl(cik, accn)
}
