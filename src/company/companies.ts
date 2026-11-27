/**
 * Company identification against SEC's full list of filers (company_tickers.json, ~8,000 companies).
 * No whitelist: any SEC filer can be resolved by ticker or name, or detected in the article text.
 * When the text or query fits several companies, the caller must ask the user to choose.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { secUserAgent } from "../sec/edgar.js"

export type CompanyEntry = { cik: string; name: string; tickers: string[] }
export type CompanyIndex = { fetchedAt: string; source: string; companies: CompanyEntry[] }
export type Candidate = CompanyEntry & { score: number; why: string[] }
export type Resolution =
	| { status: "resolved"; company: Candidate; candidates: Candidate[]; method: "ticker" | "name" | "detected"; reason: string }
	| { status: "ambiguous"; candidates: Candidate[]; reason: string }
	| { status: "not_found"; candidates: Candidate[]; reason: string }

export const COMPANY_INDEX_PATH = "data/sec-companies.json"
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

export async function fetchCompanyIndex(timeoutMs = 8000): Promise<CompanyIndex> {
	const res = await fetch(TICKERS_URL, { headers: { "User-Agent": secUserAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) })
	if (!res.ok) throw new Error(`SEC company list request failed: ${res.status}`)
	const raw = Object.values<any>(await res.json())
	const byCik = new Map<string, CompanyEntry>()
	for (const r of raw) {
		const cik = String(r.cik_str).padStart(10, "0")
		const e = byCik.get(cik) ?? { cik, name: String(r.title), tickers: [] }
		e.tickers.push(String(r.ticker).toUpperCase())
		byCik.set(cik, e)
	}
	return { fetchedAt: new Date().toISOString(), source: TICKERS_URL, companies: [...byCik.values()] }
}

export function loadCompanyIndex(path = COMPANY_INDEX_PATH): CompanyIndex {
	if (!existsSync(path)) throw new Error(`No company list at ${path}. Run "npm run snapshot:companies" (needs network).`)
	return JSON.parse(readFileSync(path, "utf8")) as CompanyIndex
}

export function saveCompanyIndex(index: CompanyIndex, path = COMPANY_INDEX_PATH) {
	writeFileSync(path, JSON.stringify(index))
}

/** Server use: the live SEC list (refreshed daily), or the committed copy when SEC is unreachable. Both are labelled. */
let live: { index: CompanyIndex; at: number } | undefined
export async function currentCompanyIndex(opts: { allowLive?: boolean } = {}): Promise<CompanyIndex> {
	if (opts.allowLive !== false) {
		if (live && Date.now() - live.at < 24 * 3600_000) return live.index
		try {
			const index = await fetchCompanyIndex()
			live = { index, at: Date.now() }
			return index
		} catch {
			// fall through to the committed copy (its fetchedAt date is shown to the user)
		}
	}
	return loadCompanyIndex()
}

// ── name normalization ─────────────────────────────────────────────────────────────────────────

const SUFFIX = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "companies", "ltd", "limited", "plc", "llc", "lp", "llp", "sa", "se", "nv", "ag", "spa", "ab", "asa", "oyj", "bv", "kk", "holdings", "holding", "group", "the", "de", "md", "nv", "adr", "ads", "class", "cl", "a"])
/** Words that start sentences or name generic things in finance articles; never enough on their own to identify a company. */
const STOP = new Set(
	"the a an this that these its it in on for and of to by with as at from new first second third fourth total net gross operating revenue revenues sales income profit profits quarter quarterly year annual fiscal company shares share stock market markets investors analysts results earnings report reported growth adjusted wall street data cloud energy financial capital bank trust services technologies technology systems solutions partners industries resources health care real estate power digital software products brands foods motors airlines communications media entertainment global international national american united general standard first chief executive officer president ceo cfo however meanwhile overall still also but while during after before despite according next last since its their our we he she they".split(
		" ",
	),
)

export const normName = (s: string) =>
	s
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[’']s\b/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
export function coreTokens(name: string): string[] {
	const toks = normName(name.replace(/\/[A-Z]{2}\/?$/i, "")).split(" ").filter(Boolean)
	while (toks.length > 1 && (SUFFIX.has(toks.at(-1)!) || toks.at(-1) === "and")) toks.pop()
	while (toks.length > 1 && toks[0] === "the") toks.shift()
	return toks
}

type Prepared = { index: CompanyIndex; byTicker: Map<string, CompanyEntry>; byFirst: Map<string, { entry: CompanyEntry; toks: string[]; alias: boolean }[]> }
const prepared = new WeakMap<CompanyIndex, Prepared>()

function prepare(index: CompanyIndex): Prepared {
	const hit = prepared.get(index)
	if (hit) return hit
	const byTicker = new Map<string, CompanyEntry>()
	const byFirst: Prepared["byFirst"] = new Map()
	const firstCount = new Map<string, number>()
	const cores = index.companies.map((e) => ({ e, toks: coreTokens(e.name) }))
	for (const { toks } of cores) if (toks[0]) firstCount.set(toks[0], (firstCount.get(toks[0]) ?? 0) + 1)
	const add = (tok: string, v: { entry: CompanyEntry; toks: string[]; alias: boolean }) => byFirst.set(tok, [...(byFirst.get(tok) ?? []), v])
	for (const { e, toks } of cores) {
		for (const t of e.tickers) byTicker.set(t, e)
		if (!toks.length) continue
		if (!(toks.length === 1 && (STOP.has(toks[0]) || toks[0].length < 3))) add(toks[0], { entry: e, toks, alias: false })
		// "JPMorgan" for "JPMorgan Chase & Co": a distinctive first word also identifies the company (weaker signal)
		if (toks.length > 1 && toks[0].length >= 4 && !STOP.has(toks[0]) && (firstCount.get(toks[0]) ?? 0) <= 2 && !/^\d+$/.test(toks[0])) add(toks[0], { entry: e, toks: [toks[0]], alias: true })
	}
	const p = { index, byTicker, byFirst }
	prepared.set(index, p)
	return p
}

const candidate = (e: CompanyEntry, score: number, why: string): Candidate => ({ ...e, score, why: [why] })

function merge(list: Candidate[]): Candidate[] {
	const by = new Map<string, Candidate>()
	for (const c of list) {
		const cur = by.get(c.cik)
		if (!cur) by.set(c.cik, { ...c, why: [...c.why] })
		else {
			cur.score += c.score
			for (const w of c.why) if (!cur.why.includes(w)) cur.why.push(w)
		}
	}
	return [...by.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** Search by ticker or name (what the user typed). */
export function searchCompanies(index: CompanyIndex, query: string, limit = 8): Candidate[] {
	const p = prepare(index)
	const q = query.trim()
	if (!q) return []
	const out: Candidate[] = []
	const t = p.byTicker.get(q.toUpperCase().replace(/^\$/, ""))
	if (t) out.push(candidate(t, 100, `ticker ${q.toUpperCase()}`))
	const qt = coreTokens(q)
	const qn = qt.join(" ")
	if (qn) {
		for (const e of index.companies) {
			const ct = coreTokens(e.name)
			const cn = ct.join(" ")
			if (cn === qn) out.push(candidate(e, 90, "name matches"))
			else if (cn.startsWith(qn + " ") || (qn.length >= 3 && cn.startsWith(qn))) out.push(candidate(e, 60, "name starts with the query"))
			else if (qt.every((w) => ct.includes(w))) out.push(candidate(e, 40, "name contains every word of the query"))
		}
	}
	return merge(out).slice(0, limit)
}

const EXCHANGE_TICKER = /\b(?:NASDAQ|Nasdaq|NYSE(?:\s+American)?|NYSE\s+Arca|AMEX|OTC(?:QX|QB)?|Cboe)\s*:\s*\$?([A-Z][A-Z.\-]{0,6})\b/g
const PAREN_TICKER = /\((?:ticker:\s*)?\$?([A-Z]{1,5}(?:\.[A-Z])?)\)/g

/** Companies mentioned in an article: exchange tickers, then company names (whole words, capitalized in the text). */
export function detectCompanies(index: CompanyIndex, text: string, title = ""): Candidate[] {
	const p = prepare(index)
	const out: Candidate[] = []
	const full = `${title}\n${text}`
	for (const m of full.matchAll(EXCHANGE_TICKER)) {
		const e = p.byTicker.get(m[1].toUpperCase())
		if (e) out.push(candidate(e, 50, `ticker ${m[0].replace(/\s+/g, " ")} in the text`))
	}
	for (const m of full.matchAll(PAREN_TICKER)) {
		const e = p.byTicker.get(m[1])
		if (e) out.push(candidate(e, 8, `ticker (${m[1]}) in the text`))
	}
	// name mentions
	const words = [...full.matchAll(/[A-Za-z][A-Za-z0-9&.\-]*(?:[’']s)?/g)].map((m) => ({ raw: m[0], at: m.index!, tok: normName(m[0]).split(" ")[0] ?? "" }))
	const titleEnd = title.length
	const leadEnd = titleEnd + 1 + Math.min(text.length, 400)
	for (let i = 0; i < words.length; i++) {
		const w = words[i]
		if (!/^[A-Z]/.test(w.raw)) continue
		const options = p.byFirst.get(w.tok)
		if (!options) continue
		// longest match at this position wins ("Apple Hospitality REIT" over "Apple")
		let best: { entry: CompanyEntry; toks: string[]; alias: boolean } | undefined
		for (const o of options) {
			if (o.toks.every((t, k) => words[i + k]?.tok === t) && (!best || o.toks.length > best.toks.length || (o.toks.length === best.toks.length && best.alias && !o.alias))) best = o
		}
		if (!best) continue
		const weight = (best.alias ? 0.6 : 1) * (w.at < titleEnd ? 3 : w.at < leadEnd ? 2 : 1)
		out.push(candidate(best.entry, weight, best.alias ? `"${best.toks[0]}" (first word of the name) in the text` : `name "${words.slice(i, i + best.toks.length).map((x) => x.raw).join(" ")}" in the text`))
		i += best.toks.length - 1
	}
	return merge(out).slice(0, 8)
}

/**
 * Resolve the article's company. An explicit query (ticker or name) wins; otherwise detect from the text.
 * Auto-resolves only on a clear signal; anything close is returned as "ambiguous" for the user to choose.
 */
export function resolveCompany(index: CompanyIndex, input: { query?: string; text?: string; title?: string }): Resolution {
	const q = input.query?.trim()
	if (q) {
		const hits = searchCompanies(index, q)
		if (!hits.length) return { status: "not_found", candidates: [], reason: `No SEC filer matches "${q}". If the company does not file with the SEC, provide its official financial report (PDF).` }
		const [a, b] = hits
		if (a.score >= 100) return { status: "resolved", company: a, candidates: hits, method: "ticker", reason: `Ticker ${q.toUpperCase()} → ${a.name}` }
		if (a.score >= 90 && (!b || b.score < 90)) return { status: "resolved", company: a, candidates: hits, method: "name", reason: `Name matches ${a.name}` }
		if (hits.length === 1) return { status: "resolved", company: a, candidates: hits, method: "name", reason: `Only match for "${q}": ${a.name}` }
		return { status: "ambiguous", candidates: hits, reason: `"${q}" matches ${hits.length} SEC filers; choose one.` }
	}
	const found = detectCompanies(index, input.text ?? "", input.title ?? "")
	if (!found.length) return { status: "not_found", candidates: [], reason: "No SEC filer is named in the article. Enter the company name or ticker, or provide its official financial report (PDF)." }
	const [a, b] = found
	// clear = an exchange ticker, an uncontested mention in the headline/lead, or a dominant repeated mention
	const clear = a.score >= 50 || (!b && a.score >= 2) || (a.score >= 3 && (!b || a.score >= 2 * b.score))
	if (clear) return { status: "resolved", company: a, candidates: found, method: "detected", reason: `Detected ${a.name}: ${a.why.join("; ")}` }
	return { status: "ambiguous", candidates: found, reason: `The article could refer to ${found.length > 1 ? `${found.length} companies` : a.name}; choose the company it reports on.` }
}

export function companyByCik(index: CompanyIndex, cik: string): CompanyEntry | undefined {
	const c = cik.padStart(10, "0")
	return index.companies.find((e) => e.cik === c)
}
