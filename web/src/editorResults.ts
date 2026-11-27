import type { ClaimView, RunView } from "./api"
import { correctionText } from "./correction"

const MONEY_SCALE = { units: 1, thousand: 1e3, lakh: 1e5, million: 1e6, crore: 1e7, billion: 1e9, trillion: 1e12, lakh_crore: 1e12 } satisfies Record<ClaimView["interpretation"]["scale"], number>

export type EditorStatus = "fix" | "match" | "review"

export function editorStatus(run: RunView, claim: ClaimView): EditorStatus {
	if (correctionText(run, claim)) return "fix"
	if (claim.verdict === "MATCH" && claim.review.status === "complete" && !claim.warnings.some(warning => warning.code === "FORWARD_LOOKING")) return "match"
	return "review"
}

// Rank proportional discrepancies because currencies and percentages cannot be compared directly.
function discrepancy(claim: ClaimView): number {
	const { kind, statedNumber, statedUnit, scale, direction } = claim.interpretation
	const current = claim.calc?.inputs.find(input => input.role === "current")
	const base = claim.calc?.inputs.find(input => input.role === "base")
	if (!current) return 0
	const stated = Number(statedNumber.replace(/,/g, ""))
	if (!Number.isFinite(stated)) return 0
	const article = kind === "level"
		? stated * (statedUnit === "money" ? MONEY_SCALE[scale] : 1)
		: direction === "decrease" && statedUnit === "percent" ? -stated : stated
	const filed = kind === "level"
		? current.value
		: !base?.value ? article
			: statedUnit === "multiple" ? current.value / base.value : (current.value - base.value) / Math.abs(base.value) * 100
	return Math.abs(article - filed) / (Math.max(Math.abs(article), Math.abs(filed)) || 1)
}

export function priorityCorrection(run: RunView): ClaimView | undefined {
	return run.claims.filter(claim => editorStatus(run, claim) === "fix").reduce<ClaimView | undefined>(
		(best, claim) => !best || discrepancy(claim) > discrepancy(best) ? claim : best,
		undefined,
	)
}

export function notVerifiableReason(claim: ClaimView): string {
	return claim.calc?.notes[0] ?? claim.evidence?.reference?.detail ?? "No supported financial-statement line was available for this figure."
}

type FinancialMention = {
	start: number
	value: string
	before: string
	after: string
	forecast: boolean
}

const currency = /(?:[A-Z]{1,2}\$|[\p{Sc}]|USD|INR|EUR|GBP|JPY|CNY|CAD|AUD|CHF|HKD|SGD|NZD|SEK|NOK|DKK|KRW|BRL|MXN|ZAR|Rs\.?)/u
const number = /(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?/
const unit = /(?:lakh\s+crore|crores?|lakhs?|thousand|millions?|billions?|trillions?|mn|bn|tn|[kmbt](?!\p{L})|per\s+cent|percent(?:age points?)?|basis points?|bps|pp|per\s+share|times)/u
const beforeAmount = /(?<![\p{L}\d.,])/u
const afterAmount = /(?![\p{L}\d]|[.,]\d)/u
const whitespace = /[^\S\n]*/
const explicitAmount = new RegExp(beforeAmount.source + "(?:(?<currency>" + currency.source + ")" + whitespace.source + "[+−-]?" + whitespace.source + ")?(?<number>" + number.source + ")(?<unit>" + whitespace.source + "(?:" + unit.source + "\\b|[%×]))?" + afterAmount.source, "giu")
const roughRate = /\b(?:(?:low|mid|high)[-\s])?(?:single|double)[-\s]digit(?:s|\s+(?:growth|rate))?\b/gi
const financialContext = /\b(?:revenue|sales|income|profits?|earnings|eps|cash|debt|margin|expenses?|costs?|bookings|capex|dividends?|financial|operating|share price|guidance)\b/i
const forecastClause = /\b(?:expects?|expected\s+to|(?:forecasts?|projects?)(?=\s+(?:that|revenue|sales|income|profits?|earnings|eps|net|operating))|anticipates?|guides?\s+for|guidance\s+(?:of|for)|(?:will|could)\s+(?:report|grow|rise|fall|reach|be))\b/gi
const reportedClause = /\b(?:reported|recorded|posted|totaled|totalled|was|were|rose|fell|grew|climbed|came\s+in\s+at)\b/gi
const comparableNumber = (value: string) => value.replace(/[,+\-−\s]/g, "").replace(/^0+(?=\d)/, "").replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")

function clearlyForecast(prefix: string): boolean {
	const clause = prefix.split(/;|,(?!\d)|\b(?:but|while|whereas)\b/i).at(-1) ?? prefix
	const qualified = Array.from(clause.matchAll(forecastClause)).at(-1)
	const reported = Array.from(clause.matchAll(reportedClause)).at(-1)
	return qualified !== undefined && (reported === undefined || qualified.index > reported.index)
}

/** Scan the original text for financial mentions that lack a matching extracted number. */
export function unmatchedFinancialMentions(run: Pick<RunView, "article" | "claims">): FinancialMention[] {
	const { text } = run.article
	const covered = new Map<string, { start: number; end: number; unit: string }[]>()
	for (const claim of run.claims) {
		const key = comparableNumber(claim.interpretation.statedNumber)
		const ranges = covered.get(key) ?? []
		for (const span of claim.location.spans) ranges.push({ ...span, unit: claim.interpretation.statedUnit })
		covered.set(key, ranges)
	}

	const mentions: FinancialMention[] = []
	for (const sentence of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
		const { segment, index } = sentence
		const financial = financialContext.test(segment)
		const add = (match: RegExpMatchArray, forecast: boolean) => {
			const leading = segment.slice(0, match.index)
			const trailing = segment.slice(match.index! + match[0].length)
			mentions.push({
				value: match[0],
				start: index + match.index!,
				before: (leading.length > 105 ? "…" : "") + leading.slice(-105).trimStart(),
				after: trailing.slice(0, 105).trimEnd() + (trailing.length > 105 ? "…" : ""),
				forecast,
			})
		}

		for (const match of segment.matchAll(explicitAmount)) {
			const { currency, number, unit } = match.groups!
			if (!currency && !unit) continue
			const prefix = segment.slice(0, match.index)
			const suffix = segment.slice(match.index! + match[0].length)
			if (!currency && !financial) continue
			if (!currency && /^\s+(?:customers?|users?|subscribers?|employees?|devices?|units?|people|shares?)\b/i.test(suffix)) continue
			const expectedUnit = /^\s*(?:[%]|percent|per\s+cent|pp|basis points?|bps)/i.test(unit ?? "") ? ["percent"]
				: /^\s*(?:[×]|times)/i.test(unit ?? "") ? ["multiple"]
				: /per\s+share/i.test(unit ?? "") ? ["per_share"] : currency ? ["money", "per_share"] : ["money"]
			const start = index + match.index! + match[0].indexOf(number)
			const end = start + number.length
			if (covered.get(comparableNumber(number))?.some(span => span.start <= start && span.end >= end && expectedUnit.includes(span.unit))) continue
			add(match, clearlyForecast(prefix))
		}

		if (!financial) continue
		for (const match of segment.matchAll(roughRate)) {
			if (clearlyForecast(segment.slice(0, match.index))) add(match, true)
		}
	}
	return mentions.sort((a, b) => a.start - b.start)
}
