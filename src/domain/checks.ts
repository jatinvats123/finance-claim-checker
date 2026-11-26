/** Deterministic rules: the auditor's hard gate, and the rule-based context warnings. */
import { basePeriod, expectedDuration, periodLabel, type EvidenceFact, type EvidenceRegistry } from "../sec/evidence.js"
import { METRIC_CONCEPTS, type VerifiableMetric } from "../sec/types.js"
import { fmtUsd, parseStated, roundingTolerance, SCALE } from "./calculator.js"
import type { Calculation, Claim, ContextWarning, EvidenceBinding } from "./types.js"

export type GateResult = { ok: true } | { ok: false; target: "claim" | "evidence"; reason: string }

const PROFIT_METRICS = new Set(["net_income", "operating_income", "eps_diluted", "eps_basic"])
const isVerifiable = (m: string): m is VerifiableMetric => m in METRIC_CONCEPTS

/** The comparison basis actually used for a change claim (unstated → YoY, the reporting convention). */
export const effectiveBasis = (claim: Claim) => (claim.interpretation.comparison === "qoq" ? "qoq" : "yoy")

/** Prefer the comparative as presented in the same filing as the current value (split-adjusted, reclassified). */
export function preferredBase(registry: EvidenceRegistry, current: EvidenceFact, fy: number, fp: EvidenceFact["fiscalPeriod"]): EvidenceFact | undefined {
	const candidates = registry.all().filter((f) => f.concept === current.concept && f.fiscalYear === fy && f.fiscalPeriod === fp)
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
			? { ok: false, target: "evidence", reason: `A 10-Q/10-K covering ${periodLabel(c.fiscalYear, c.fiscalPeriod)} is on file; bind it instead of reporting no reference.` }
			: { ok: true }
	}
	if (!isVerifiable(c.metric) || c.accounting === "non_gaap") return { ok: true }

	const cur = binding.currentFactId ? registry.get(binding.currentFactId) : undefined
	if (!cur) return { ok: false, target: "evidence", reason: "no valid current-period evidence id bound" }
	if (!/^10-[QK]/.test(cur.form)) return { ok: false, target: "evidence", reason: `${cur.id} comes from a ${cur.form}; only 10-Q/10-K statements are references` }
	if (!(METRIC_CONCEPTS[c.metric] as readonly string[]).includes(cur.concept)) return { ok: false, target: "evidence", reason: `${cur.id} is ${cur.concept}, which is not a ${c.metric} concept` }
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
		const preferred = preferredBase(registry, cur, wanted.fy, wanted.fp)
		if (preferred && preferred.id !== base.id && preferred.value !== base.value) {
			return { ok: false, target: "evidence", reason: `use the comparative as presented alongside the current figure: ${preferred.id} (${preferred.value}) instead of ${base.id} (${base.value})` }
		}
	}
	return { ok: true }
}

const relDiff = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12)

export function ruleWarnings(claim: Claim, binding: EvidenceBinding, calc: Calculation, registry: EvidenceRegistry): ContextWarning[] {
	const c = claim.interpretation
	const out: ContextWarning[] = []
	const w = (code: string, message: string) => out.push({ claimId: claim.id, claimRevision: claim.revision, evidenceRevision: binding.evidenceRevision, source: "rule", code, message })

	if (binding.noReference?.status === "REFERENCE_NOT_YET_FILED") {
		const rel = binding.noReference.earningsReleases ?? []
		const asOf = registry.snapshot.source.fetchedAt.slice(0, 10)
		w(
			"EARNINGS_RELEASE_ONLY",
			rel.length
				? `In the SEC data fetched ${asOf}, only the company's earnings release covers this period (${rel.map((r) => `8-K filed ${r.filed}, accn ${r.accn}`).join("; ")}). Checking a release against itself would be circular; a 10-Q/10-K may have been filed after ${asOf}.`
				: `No 10-Q/10-K in the SEC data fetched ${asOf} covers this period; one may have been filed since.`,
		)
	}
	if (c.accounting === "non_gaap") w("NON_GAAP", "Article cites an adjusted (non-GAAP) figure. Companies define these themselves; they are not line items in the 10-Q/10-K financial statements.")
	if (c.accounting === "unspecified" && PROFIT_METRICS.has(c.metric)) w("GAAP_OR_ADJUSTED_UNSTATED", "Article does not say whether this profit figure is GAAP or adjusted; it was checked against GAAP.")

	const cur = binding.currentFactId ? registry.get(binding.currentFactId) : undefined
	const base = binding.baseFactId ? registry.get(binding.baseFactId) : undefined

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
			.filter((f) => concepts.includes(f.concept) && f.isOriginal && Math.abs(f.value - target) <= tol && !(f.fiscalYear === c.fiscalYear && f.fiscalPeriod === c.fiscalPeriod))
		const seen = new Set<string>()
		for (const o of others) {
			const label = periodLabel(o.fiscalYear, o.fiscalPeriod)
			if (seen.has(label)) continue
			seen.add(label)
			w("VALUE_MATCHES_OTHER_PERIOD", `The stated figure matches ${label} (${o.durationClass}, ${perShare ? "$" + o.value : fmtUsd(o.value)}, ${o.id}) — possibly the wrong period (e.g. quarter vs. full year).`)
		}
	}
	return out
}
