import { validateInterpretation } from "../agents/extractor.js"
import { calculate } from "../domain/calculator.js"
import { auditGate, ruleWarnings } from "../domain/checks.js"
import { planEvidence } from "../domain/evidence-plan.js"
import type { Claim, ClaimInterpretation, Metric } from "../domain/types.js"
import type { EvidenceRegistry, FiscalPeriod } from "../sec/evidence.js"
import { periodText } from "./viewmodel.js"
import type { FinancialMention } from "./mentions.js"
import type { ManualReceipt } from "./types.js"

const metrics: Record<string, Metric> = {
	revenue: "revenue", "net income": "net_income", "net profit": "net_income", "gross profit": "gross_profit",
	"operating income": "operating_income", "operating profit": "operating_income",
	"diluted eps": "eps_diluted", "basic eps": "eps_basic",
}
const dollarPrefixes: Record<string, string> = { "US$": "USD", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD", "HK$": "HKD", "S$": "SGD", "NT$": "TWD", "R$": "BRL" }

type ManualResult = { receipt: ManualReceipt; interpretation?: ClaimInterpretation }
const review = (reason: string): ManualResult => ({ receipt: { status: "needs_review", reason } })
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Restrict one-click lookup to explicit, historical statement levels. Every input comes from the original draft. */
export function compareMention(text: string, mention: FinancialMention, registry: EvidenceRegistry): ManualResult {
	if (mention.forecast) return review("This is forecast language. A forecast cannot be checked as a reported result.")
	const sentence = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text).containing(mention.start)
	if (!sentence || !text.startsWith(mention.value, mention.start)) return review("The selected number could not be located in this draft.")
	const at = mention.start - sentence.index
	const wording = sentence.segment.slice(0, at) + " FIGURE " + sentence.segment.slice(at + mention.value.length)
	const periods = [...wording.matchAll(/\b(?:(Q[1-4]|H1|9M)\s+)?(?:FY\s*|fiscal\s+year\s+)(\d{4})(?:\s+(Q[1-4]|H1|9M))?\b/gi)]
	const items = [...wording.matchAll(/\b(?:operating profit|operating income|gross profit|net income|net profit|revenue|diluted EPS|basic EPS)\b/gi)]
	if (periods.length !== 1 || items.length !== 1 || (periods[0][1] && periods[0][3])) return review("Identify one statement metric and one explicit fiscal period in this sentence before comparing it.")
	const item = items[0][0].toLowerCase()
	if (!/\b(?:disclosed|reported|recorded|posted|gives|states|was|were)\b/i.test(wording)) return review("This sentence must identify the amount as a reported result.")
	const period = periods[0]
	const fiscalPeriod = (period[1] || period[3] || "FY").toUpperCase() as FiscalPeriod
	let remainder = wording.replace(items[0][0], " METRIC ").replace(period[0], " PERIOD ")
	// Ignore only the selected issuer and the language of a direct assertion. Scope modifiers,
	// other entities, forecasts, negatives, comparatives and additional amounts must remain for human review.
	const shortName = registry.info.entityName.replace(/\s+(?:incorporated|inc\.?|limited|ltd\.?|corporation|corp\.?|plc)\.?$/i, "").trim()
	const issuerNames = [registry.info.entityName, shortName, registry.info.ticker].filter((name): name is string => !!name)
	for (const name of issuerNames) remainder = remainder.replace(new RegExp("\\b" + escape(name) + "(?=\\b|\\s)", "gi"), " ")
	remainder = remainder.replace(/’s\b|'s\b/g, " ").replace(/\b(?:METRIC|PERIOD|FIGURE|the same paragraph|the company|consolidated|standalone|disclosed|reported|recorded|posted|gives|states|was|were|of|as|at|for|in|its|a|the)\b/gi, " ").trim()
	if (!/^[\s.,:]*$/.test(remainder)) return review("This wording may qualify the amount, issuer or reporting basis. Have an editor review the original sentence.")
	const amount = /^(?:[A-Z]{1,3}\$|[\p{Sc}]|USD|INR|EUR|GBP|CAD|AUD|JPY|Rs\.?)\s*(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|lakh crore|crores?|lakhs?|per share)?$/iu.exec(mention.value)
	if (!amount) return review("This lookup needs an explicit currency and an unambiguous amount and scale.")
	const scaleWord = (amount[2] ?? "units").toLowerCase()
	const scale = scaleWord === "per share" ? "units" : scaleWord.replace(/^(crore|lakh)s$/, "$1").replace(" ", "_")
	let c: ClaimInterpretation
	try {
		c = validateInterpretation({ quote: sentence.segment.trim(), metric: metrics[item], accounting: "unspecified",
			kind: "level", fiscalYear: Number(period[2]), fiscalPeriod, statedNumber: amount[1],
			statedUnit: /eps$/.test(item) ? "per_share" : "money", scale, qualifier: "exact" }, text)
	} catch {
		return review("The amount or unit could not be anchored unambiguously to the wording of this sentence.")
	}
	if (c.currency === "unspecified") return review("The currency of the selected amount is unclear.")
	const dollar = /^([A-Z]{0,3}\$)/i.exec(mention.value)?.[1]
	if (dollar === "$" && (registry.info.reportingCurrency !== "USD" || registry.calendar.some(row => /^(20-F|40-F)(\/A)?$/.test(row.form)))) {
		return review("The dollar symbol alone does not establish which dollar this draft uses. Check the currency against the filing.")
	}
	if (dollar && dollar !== "$" && dollarPrefixes[dollar.toUpperCase()] !== c.currency) {
		return review("The currency prefix cannot be matched to the filing. No exchange rate has been assumed.")
	}
	if (/^¥/.test(mention.value)) return review("The ¥ symbol can denote yen or yuan. An explicit currency is required.")
	const claim: Claim = { id: "manual", interpretation: c, reason: "selected by editor", revision: 1, correctionsUsed: 0 }
	const plan = planEvidence(claim, registry)
	if (plan.kind !== "bind") return review(plan.reason)
	const fact = registry.get(plan.currentFactId)!
	if (fact.derivation) return review("This figure requires a calculation from multiple source rows. Use the full review workflow.")
	const binding = { claimId: claim.id, claimRevision: 1, evidenceRevision: 1, currentFactId: fact.id, boundBy: "manual filing lookup" }
	const calc = calculate(binding, c, fact)
	if (calc.verdict !== "MATCH" && calc.verdict !== "MISMATCH") return review(calc.notes[0] ?? "The selected amount and source are not comparable.")
	const gate = auditGate(claim, binding, calc, registry)
	if (!gate.ok) return review(gate.reason)
	const warnings = ruleWarnings(claim, binding, calc, registry)
	const blocking = warnings.find(warning => warning.code !== "GAAP_OR_ADJUSTED_UNSTATED")
	if (blocking) return review(blocking.message)
	return { interpretation: c, receipt: { status: "compared", matches: calc.verdict === "MATCH", metric: item,
		stated: mention.value, period: periodText(c.fiscalYear, c.fiscalPeriod), filed: calc.actualDisplay!, source: calc.inputs[0] } }
}
