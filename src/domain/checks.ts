/** Deterministic rules: the auditor's hard gate, and the rule-based context warnings. */
import { basePeriod, EvidenceRegistry, expectedDuration, periodLabel, type EvidenceFact } from "../sec/evidence.js"
import { isStatementForm, METRIC_CONCEPTS, type VerifiableMetric } from "../sec/types.js"
import { fmtFact, parseStated, roundingTolerance, SCALE } from "./calculator.js"
import type { Calculation, Claim, ContextWarning, EvidenceBinding } from "./types.js"

export type GateResult = { ok: true } | { ok: false; target: "claim" | "evidence"; reason: string }

const PROFIT_METRICS = new Set(["net_income", "operating_income", "eps_diluted", "eps_basic"])
const isVerifiable = (m: string): m is VerifiableMetric => m in METRIC_CONCEPTS

/** The comparison basis actually used for a change claim (unstated → YoY, the reporting convention). */
export const effectiveBasis = (claim: Claim) => (claim.interpretation.comparison === "qoq" ? "qoq" : "yoy")

/** Prefer the comparative as presented in the same filing as the current value (split-adjusted, reclassified). */
export function preferredBase(registry: EvidenceRegistry, current: EvidenceFact, fy: number, fp: EvidenceFact["fiscalPeriod"]): EvidenceFact | undefined {
	const candidates = registry.all().filter((f) => f.concept === current.concept && f.fiscalYear === fy && f.fiscalPeriod === fp && f.currency === current.currency && f.consolidation === current.consolidation)
	return candidates.find((f) => f.accn === current.accn) ?? candidates.sort((a, b) => b.filed.localeCompare(a.filed))[0]
}

export function auditGate(claim: Claim, binding: EvidenceBinding, calc: Calculation, registry: EvidenceRegistry): GateResult {
	const c = claim.interpretation
	if (calc.claimRevision !== claim.revision || calc.evidenceRevision !== binding.evidenceRevision) {
		return { ok: false, target: "evidence", reason: "calculation does not match current claim/evidence revision" }
	}
	if (calc.notes.some((n) => n.startsWith("Stated unit"))) return { ok: false, target: "claim", reason: calc.notes.find((n) => n.startsWith("Stated unit"))! }

	if (binding.noReference) {
		if (binding.noReference.status === "NOT_IN_STATEMENTS") {
			return c.accounting === "non_gaap" || c.metric === "other" ? { ok: true } : { ok: false, target: "evidence", reason: `"${c.metric}" (${c.accounting}) is a statement line item; bind 10-Q/10-K evidence instead of NOT_IN_STATEMENTS.` }
		}
		return registry.hasReferenceFor(c.fiscalYear, c.fiscalPeriod)
			? { ok: false, target: "evidence", reason: `A statement covering ${periodLabel(c.fiscalYear, c.fiscalPeriod)} is in the reference; bind it instead of reporting no reference.` }
			: { ok: true }
	}
	if (!isVerifiable(c.metric) || c.accounting === "non_gaap") return { ok: true }

	const cur = binding.currentFactId ? registry.get(binding.currentFactId) : undefined
	if (!cur) return { ok: false, target: "evidence", reason: "no valid current-period evidence id bound" }
	if (cur.source === "sec-xbrl" && !isStatementForm(cur.form)) return { ok: false, target: "evidence", reason: `${cur.id} comes from a ${cur.form}; only 10-Q/10-K/20-F/40-F statements are references` }
	if (!(METRIC_CONCEPTS[c.metric] as readonly string[]).includes(cur.concept)) return { ok: false, target: "evidence", reason: `${cur.id} is ${cur.concept}, which is not a ${c.metric} concept` }
	const choice = factChoice(claim, cur, registry)
	if (choice) return { ok: false, target: "evidence", reason: choice }
	if (cur.fiscalYear !== c.fiscalYear || cur.fiscalPeriod !== c.fiscalPeriod) {
		return { ok: false, target: "evidence", reason: `${cur.id} covers ${periodLabel(cur.fiscalYear, cur.fiscalPeriod)}, but the claim is about ${periodLabel(c.fiscalYear, c.fiscalPeriod)}` }
	}
	if (cur.durationClass !== expectedDuration(c.fiscalPeriod)) {
		return { ok: false, target: "evidence", reason: `${cur.id} spans ${cur.days} days (${cur.durationClass}); ${c.fiscalPeriod} needs a ${expectedDuration(c.fiscalPeriod)} figure` }
	}

	if (c.kind === "change") {
		const wanted = basePeriod(c.fiscalYear, c.fiscalPeriod, effectiveBasis(claim))
		if (!wanted) return { ok: false, target: "claim", reason: `a ${effectiveBasis(claim).toUpperCase()} comparison is not defined for ${c.fiscalPeriod}` }
		const base = binding.baseFactId ? registry.get(binding.baseFactId) : undefined
		if (!base) return { ok: false, target: "evidence", reason: `change claim needs base evidence for ${periodLabel(wanted.fy, wanted.fp)}` }
		if (base.fiscalYear !== wanted.fy || base.fiscalPeriod !== wanted.fp) {
			return { ok: false, target: "evidence", reason: `${effectiveBasis(claim).toUpperCase()} base must be ${periodLabel(wanted.fy, wanted.fp)}, got ${periodLabel(base.fiscalYear, base.fiscalPeriod)} (${base.id})` }
		}
		if (base.concept !== cur.concept) return { ok: false, target: "evidence", reason: `base ${base.id} uses a different concept than ${cur.id}` }
		if (base.currency !== cur.currency || base.consolidation !== cur.consolidation) return { ok: false, target: "evidence", reason: `base ${base.id} (${base.currency}, ${base.consolidation}) must match ${cur.id} (${cur.currency}, ${cur.consolidation})` }
		const preferred = preferredBase(registry, cur, wanted.fy, wanted.fp)
		if (preferred && preferred.id !== base.id && preferred.value !== base.value) {
			return { ok: false, target: "evidence", reason: `use the comparative as presented alongside the current figure: ${preferred.id} (${preferred.value}) instead of ${base.id} (${base.value})` }
		}
	}
	const misdated = priorPeriodAttribution(claim, calc, registry)
	if (misdated) return { ok: false, target: "claim", reason: misdated }
	return { ok: true }
}

/**
 * Which of several facts for the same period must be bound: the claim's consolidation (consolidated by
 * convention when unstated), the claim's currency (the reporting currency when unstated, never a
 * convenience translation), and the metric's primary line item. Returns a correction reason, or undefined.
 */
export function factChoice(claim: Claim, cur: EvidenceFact, registry: EvidenceRegistry): string | undefined {
	const c = claim.interpretation
	if (!isVerifiable(c.metric)) return undefined
	const peers = registry.search(c.metric, cur.fiscalYear, cur.fiscalPeriod).filter((f) => !f.derivation === !cur.derivation)
	const wantCons = c.consolidation === "standalone" ? "standalone" : "consolidated"
	if (cur.consolidation !== wantCons) {
		const better = peers.find((f) => f.consolidation === wantCons)
		if (better) return `the claim ${c.consolidation === "unspecified" || !c.consolidation ? "does not say standalone, so the consolidated figure is the reference" : `is a ${wantCons} figure`}: bind ${better.id} instead of the ${cur.consolidation} ${cur.id}`
	}
	const wantCur = c.currency && c.currency !== "unspecified" ? c.currency : undefined
	if (wantCur && cur.currency !== wantCur) {
		const better = peers.find((f) => f.currency === wantCur && f.consolidation === cur.consolidation)
		if (better) return `the article states ${wantCur}: bind ${better.id} instead of ${cur.id} (${cur.currency})`
	}
	if (!wantCur && cur.translated) {
		const better = peers.find((f) => !f.translated && f.consolidation === cur.consolidation)
		if (better) return `${cur.id} is a convenience translation; bind the reporting-currency figure ${better.id}`
	}
	// the article may name a narrower line item: "net sales" (revenue from contracts with customers) or net income including non-controlling interests
	const named = (c.metric === "revenue" && /\bsales\b/i.test(c.quote) && /RevenueFromContract|SalesRevenue/.test(cur.concept)) || (c.metric === "net_income" && /non-?controlling|minority interest/i.test(c.quote) && /:ProfitLoss$/.test(cur.concept))
	const primary = registry.primaryFor(c.metric, cur)
	if (!named && primary && primary.concept !== cur.concept && EvidenceRegistry.conceptRank(c.metric, primary.concept) < EvidenceRegistry.conceptRank(c.metric, cur.concept)) {
		return `${cur.concept} is not the primary ${c.metric} line item in this filing; bind ${primary.id} (${primary.concept})`
	}
	return undefined
}

/**
 * "up 85% from $44.1 billion a year earlier": the article attaches the figure itself to the prior
 * year. If such a level figure was labelled with the current period, mismatches it, and exactly
 * matches the same period one fiscal year earlier, the period was misread — not the article.
 * Only fires when "a year earlier/ago" (or "year-ago …") directly follows the number, so
 * "$44.1 billion, up 85% from a year earlier" (a genuine wrong-period figure) is left alone.
 */
export function priorPeriodAttribution(claim: Claim, calc: Calculation, registry: EvidenceRegistry): string | undefined {
	const c = claim.interpretation
	if (c.kind !== "level" || calc.verdict !== "MISMATCH" || !isVerifiable(c.metric) || c.accounting === "non_gaap") return undefined
	const quote = c.quote.replace(/\s+/g, " ").replace(/(?<=\d),(?=\d{2,3}(?:\D|$))/g, "")
	const esc = c.statedNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const attached = new RegExp(
		`(?<![\\d.])${esc}(?!\\d|\\.\\d)\\s*(?:lakh crore|thousand|lakh|million|crore|billion|trillion|bn|mn|cr|m|b)?\\s*,?\\s*(?:a year (?:earlier|ago|before)|in the year-ago (?:quarter|period)|the year before|in the prior[- ]year (?:quarter|period)|(?:in|for) the same (?:quarter|period|half|six months|nine months)(?: of)? (?:last|the previous|the prior|a) (?:fiscal )?year(?: ago| earlier)?|(?:in|for) the (?:previous|prior|preceding) (?:fiscal )?year|last (?:fiscal )?year)`,
		"i",
	)
	if (!attached.test(quote)) return undefined
	const perShare = c.metric.startsWith("eps")
	const scale = perShare ? 1 : SCALE[c.scale]
	const target = parseStated(c.statedNumber) * scale
	const tol = roundingTolerance(c.statedNumber) * scale
	const cur = calc.inputs[0]
	const prior = registry.search(c.metric, c.fiscalYear - 1, c.fiscalPeriod).find((f) => Math.abs(f.value - target) <= tol && (!cur || (f.currency === cur.currency && f.consolidation === cur.consolidation)))
	if (!prior) return undefined
	return `The quote attaches ${c.statedNumber} to a year earlier, and it matches ${periodLabel(prior.fiscalYear, prior.fiscalPeriod)} (${prior.id}) exactly; the claim is labelled ${periodLabel(c.fiscalYear, c.fiscalPeriod)}. Set fiscalYear to ${prior.fiscalYear} if the sentence means the year-earlier figure.`
}

const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12)

export function ruleWarnings(claim: Claim, binding: EvidenceBinding, calc: Calculation, registry: EvidenceRegistry): ContextWarning[] {
	const c = claim.interpretation
	const out: ContextWarning[] = []
	const w = (code: string, message: string) => out.push({ claimId: claim.id, claimRevision: claim.revision, evidenceRevision: binding.evidenceRevision, source: "rule", code, message })

	if (binding.noReference?.status === "REFERENCE_NOT_YET_FILED") {
		const rel = binding.noReference.earningsReleases ?? []
		const asOf = registry.info.fetchedAt.slice(0, 10)
		if (registry.info.kind === "sec")
			w(
				"EARNINGS_RELEASE_ONLY",
				rel.length
					? `In the SEC data fetched ${asOf}, only the company's earnings release covers this period (${rel.map((r) => `8-K filed ${r.filed}, accn ${r.accn}`).join("; ")}). Checking a release against itself would be circular; a 10-Q/10-K may have been filed after ${asOf}.`
					: `No 10-Q/10-K/20-F in the SEC data fetched ${asOf} covers this period; one may have been filed since.`,
			)
		else w("REPORT_PERIOD_MISSING", `The official report provided for this run has no column for this period; provide the report that covers it.`)
	}
	if (c.accounting === "non_gaap") w("NON_GAAP", "Article cites an adjusted (non-GAAP) figure. Companies define these themselves; they are not line items in the financial statements.")
	if (c.accounting === "unspecified" && PROFIT_METRICS.has(c.metric)) w("GAAP_OR_ADJUSTED_UNSTATED", "Article does not say whether this profit figure is reported (GAAP/IFRS) or adjusted; it was checked against the reported statements.")

	const cur = binding.currentFactId ? registry.get(binding.currentFactId) : undefined
	const base = binding.baseFactId ? registry.get(binding.baseFactId) : undefined

	if (cur && c.kind === "level" && (!c.currency || c.currency === "unspecified")) w("CURRENCY_UNSTATED", `The article gives no currency for this amount; it was compared in ${cur.currency}, the reference's currency.`)
	if (cur) {
		// the article names an accounting basis that differs from the statements' (e.g. "under US GAAP" vs IFRS / Ind AS statements)
		const q = c.quote
		const says = /\bIFRS\b/i.test(q) ? "IFRS" : /\bInd[\s-]?AS\b/i.test(q) ? "Ind AS" : /(?<!non-)\bGAAP\b/i.test(q) ? "US GAAP" : undefined
		if (says && cur.basis !== "as reported" && says !== cur.basis) w("ACCOUNTING_BASIS_DIFFERS", `The article cites a ${says} figure; ${cur.id} comes from ${cur.basis} statements.`)
	}
	if (cur?.translated) w("CONVENIENCE_TRANSLATION", `${cur.id} is a convenience translation into ${cur.currency}, not the filing's reporting currency (${registry.info.reportingCurrency}).`)
	if (cur && isVerifiable(c.metric) && (!c.consolidation || c.consolidation === "unspecified")) {
		const other = registry.search(c.metric, cur.fiscalYear, cur.fiscalPeriod).find((f) => f.consolidation !== cur.consolidation && f.currency === cur.currency)
		if (other && other.value !== cur.value) w("CONSOLIDATION_UNSTATED", `The article does not say consolidated or standalone; the ${cur.consolidation} figure was used. The ${other.consolidation} figure is ${fmtFact(other)} (${other.id}).`)
	}
	if (cur && isVerifiable(c.metric) && calc.verdict === "MISMATCH" && c.kind === "level") {
		// another line item for the same metric and period (e.g. ProfitLoss incl. non-controlling interests) that does match
		const scale = cur.perShare ? 1 : SCALE[c.scale]
		const target = parseStated(c.statedNumber) * scale
		const tol = roundingTolerance(c.statedNumber) * scale
		const alt = registry.search(c.metric, cur.fiscalYear, cur.fiscalPeriod).find((f) => f.concept !== cur.concept && f.currency === cur.currency && f.consolidation === cur.consolidation && Math.abs(f.value - target) <= tol)
		if (alt) w("OTHER_LINE_ITEM_MATCHES", `The stated figure matches ${alt.concept} (${alt.id}), a different line item than the primary ${cur.concept}.`)
	}

	if (c.kind === "change" && c.comparison === "unspecified") {
		const alt = binding.alternateBaseFactId ? registry.get(binding.alternateBaseFactId) : undefined
		const altPct = cur && alt && alt.value > 0 ? (((cur.value - alt.value) / alt.value) * 100).toFixed(2) : undefined
		w("BASIS_UNSTATED", `Article does not say what the change is measured against; year-over-year was assumed.${altPct ? ` Quarter-over-quarter it would be ${Number(altPct) >= 0 ? "+" : ""}${altPct}% (${alt!.id}).` : ""}`)
	}
	if (base && base.value < 0) w("NEGATIVE_BASE", "The comparison period was a loss; describing the swing as percentage growth is misleading.")
	for (const f of [cur, base]) {
		if (!f) continue
		if (f.derivation) w("DERIVED_Q4", `${f.id} is not reported on its own; it is derived as ${f.derivation.formula}.`)
		const re = registry.restatementsOf(f)
		const material = re.filter((r) => relDiff(r.value, f.value) >= 0.001)
		if (material.length) w("RESTATED", `${f.id} is reported differently in a later filing (${material.map((r) => `${r.id}: ${r.value}`).join(", ")}), e.g. split-adjusted or restated.`)
	}
	if (calc.verdict === "MISMATCH" && c.kind === "level" && cur && isVerifiable(c.metric)) {
		const perShare = c.metric.startsWith("eps")
		const scale = perShare ? 1 : SCALE[c.scale]
		const target = parseStated(c.statedNumber) * scale
		const tol = roundingTolerance(c.statedNumber) * scale
		const concepts: readonly string[] = METRIC_CONCEPTS[c.metric]
		const others = registry
			.all()
			.filter((f) => concepts.includes(f.concept) && f.isOriginal && f.currency === cur.currency && f.consolidation === cur.consolidation && Math.abs(f.value - target) <= tol && !(f.fiscalYear === c.fiscalYear && f.fiscalPeriod === c.fiscalPeriod))
		const seen = new Set<string>()
		for (const o of others) {
			const label = periodLabel(o.fiscalYear, o.fiscalPeriod)
			if (seen.has(label)) continue
			seen.add(label)
			w("VALUE_MATCHES_OTHER_PERIOD", `The stated figure matches ${label} (${o.durationClass}, ${fmtFact(o)}, ${o.id}) — possibly the wrong period (e.g. quarter vs. full year).`)
		}
	}
	return out
}
