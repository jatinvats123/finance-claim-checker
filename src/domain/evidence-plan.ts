/**
 * Deterministic evidence triage, before any model call.
 *
 *   bind          one unambiguous statement figure for the claim's metric, period, currency and
 *                 consolidation: code binds it (no model call); calculator, auditor and corrections
 *                 run exactly as for an agent binding.
 *   no_reference  no statement in the reference covers the claim's period: code records that.
 *   agent         anything that needs judgement — change claims (the comparison base), conflicting or
 *                 restated figures, a line item the article names, a missing consolidation basis —
 *                 goes to the Evidence agent with the candidates preloaded in its first prompt.
 */
import { basePeriod, EvidenceRegistry, periodLabel, type EvidenceFact, type FiscalPeriod } from "../sec/evidence.js"
import { isVerifiableMetric, type VerifiableMetric } from "../sec/types.js"
import { factChoice } from "./checks.js"
import type { Claim } from "./types.js"

export type Shortlist = { label: string; facts: EvidenceFact[] }[]
export type EvidencePlan =
	| { kind: "bind"; currentFactId: string; reason: string }
	| { kind: "no_reference"; reason: string }
	| { kind: "agent"; reason: string; shortlist: Shortlist }

const SHORTLIST = 6

/** Candidates for the claim's period and, for a change claim, its comparison periods (best first). */
export function shortlistFor(claim: Claim, registry: EvidenceRegistry): Shortlist {
	const c = claim.interpretation
	if (!isVerifiableMetric(c.metric)) return []
	const m = c.metric as VerifiableMetric
	const out: Shortlist = [{ label: `claim period ${periodLabel(c.fiscalYear, c.fiscalPeriod)}`, facts: registry.search(m, c.fiscalYear, c.fiscalPeriod).slice(0, SHORTLIST) }]
	if (c.kind === "change") {
		for (const basis of ["yoy", "qoq"] as const) {
			const b = basePeriod(c.fiscalYear, c.fiscalPeriod, basis)
			if (b) out.push({ label: `${basis.toUpperCase()} comparison period ${periodLabel(b.fy, b.fp)}`, facts: registry.search(m, b.fy, b.fp).slice(0, SHORTLIST) })
		}
	}
	return out
}

export function planEvidence(claim: Claim, registry: EvidenceRegistry): EvidencePlan {
	const c = claim.interpretation
	const label = periodLabel(c.fiscalYear, c.fiscalPeriod)
	const agent = (reason: string): EvidencePlan => ({ kind: "agent", reason, shortlist: shortlistFor(claim, registry) })
	if (!isVerifiableMetric(c.metric)) return agent("metric is not a statement line item")
	if (!registry.hasReferenceFor(c.fiscalYear, c.fiscalPeriod as FiscalPeriod)) return { kind: "no_reference", reason: `no statement in the reference covers ${label}` }
	if (c.kind === "change") return agent("change claim: the comparison base is chosen from the shortlist")

	const all = registry.search(c.metric, c.fiscalYear, c.fiscalPeriod)
	if (!all.length) return agent(`no ${c.metric} fact for ${label}`)
	// the article names a narrower line item ("net sales", "including non-controlling interests"): judgement
	if ((c.metric === "revenue" && /\bsales\b/i.test(c.quote)) || (c.metric === "net_income" && /non-?controlling|minority interest/i.test(c.quote))) return agent("the article names a specific line item")

	const wantCons = c.consolidation === "standalone" ? "standalone" : "consolidated"
	let pool = all.filter((f) => f.consolidation === wantCons)
	if (!pool.length) return agent(`no ${wantCons} figure for ${label}`)
	const cur = c.currency && c.currency !== "unspecified" ? c.currency : undefined
	const inCur = cur ? pool.filter((f) => f.currency === cur) : []
	// a stated currency the reference does not report is left to the calculator (not comparable); never a translation for an unstated one
	pool = inCur.length ? inCur : pool.filter((f) => !f.translated)
	if (!pool.length) return agent(`only convenience translations for ${label}`)
	const rank = Math.min(...pool.map((f) => EvidenceRegistry.conceptRank(c.metric as VerifiableMetric, f.concept)))
	pool = pool.filter((f) => EvidenceRegistry.conceptRank(c.metric as VerifiableMetric, f.concept) === rank)

	// conflicting or restated figures for the same line item and period: judgement (and a RESTATED warning)
	const values = [...new Set(pool.map((f) => f.value))]
	if (values.length > 1) return agent(`conflicting figures for ${label}: ${pool.map((f) => `${f.id} = ${f.value}`).join(", ")}`)
	const chosen = pool[0]
	const restated = registry.restatementsOf(chosen).filter((r) => r.value !== chosen.value)
	if (restated.length) return agent(`${chosen.id} is reported differently in another filing (${restated.map((r) => r.id).join(", ")})`)
	const objection = factChoice(claim, chosen, registry)
	if (objection) return agent(objection)
	return { kind: "bind", currentFactId: chosen.id, reason: `the only ${chosen.consolidation} ${chosen.currency} ${chosen.concept.split(":")[1]} figure for ${label}${pool.length > 1 ? ` (same value in ${pool.length} filings)` : ""}` }
}
