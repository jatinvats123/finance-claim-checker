/**
 * Deterministic calculator. No model output is trusted for numbers: every value comes from an
 * EvidenceFact resolved by id from the reference registry (SEC XBRL or a verified report page). The
 * only model-supplied number is the article's stated figure, which is what we are checking.
 * Amounts are compared only in the same currency: there is no currency conversion anywhere.
 */
import type { EvidenceFact } from "../sec/evidence.js"
import { periodLabel } from "../sec/evidence.js"
import type { CalcInput, Calculation, ClaimInterpretation, NumericVerdict, Scale } from "./types.js"

import { SCALE } from "./scales.js"
export { SCALE }
const PER_SHARE_METRICS = new Set(["eps_diluted", "eps_basic"])
const SCALE_WORD: Record<Scale, string> = { units: "", thousand: "thousand", lakh: "lakh", million: "million", crore: "crore", billion: "billion", trillion: "trillion", lakh_crore: "lakh crore" }

export const decimalsOf = (s: string) => (s.includes(".") ? s.split(".")[1].length : 0)
/** Half a unit in the last stated digit: "96.2" -> 0.05, "106" -> 0.5. */
export const roundingTolerance = (s: string) => 0.5 * 10 ** -decimalsOf(s)

export function parseStated(s: string): number {
	const n = Number(s.replace(/,/g, ""))
	if (!Number.isFinite(n)) throw new Error(`stated number "${s}" is not a number`)
	return n
}

const SYMBOL: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥" }
export const currencySymbol = (cur?: string) => (cur && SYMBOL[cur]) ?? (cur && cur !== "unspecified" ? `${cur} ` : "")

/** Display an amount in its currency: "$96.221B", "₹12,345.67 crore", "€1.234B". */
export function fmtMoney(v: number, currency = "USD"): string {
	const a = Math.abs(v)
	const sign = v < 0 ? "−" : ""
	const sym = currencySymbol(currency)
	if (currency === "INR") {
		if (a >= 1e7) return `${sign}${sym}${(a / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} crore`
		if (a >= 1e5) return `${sign}${sym}${(a / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} lakh`
		return `${sign}${sym}${a.toLocaleString("en-IN")}`
	}
	if (a >= 1e12) return `${sign}${sym}${(a / 1e12).toFixed(3)}T`
	if (a >= 1e9) return `${sign}${sym}${(a / 1e9).toFixed(3)}B`
	if (a >= 1e6) return `${sign}${sym}${(a / 1e6).toFixed(3)}M`
	return `${sign}${sym}${a.toLocaleString("en-US")}`
}
export const fmtUsd = (v: number) => fmtMoney(v, "USD")
export const fmtExact = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 4 })
const fmtPct = (v: number) => `${v.toFixed(2)}%`
export const fmtPerShare = (v: number, currency = "USD") => `${currencySymbol(currency)}${v} per share`
export const fmtFact = (f: Pick<EvidenceFact, "value" | "currency" | "perShare">) => (f.perShare ? fmtPerShare(f.value, f.currency) : fmtMoney(f.value, f.currency))

export function toInput(f: EvidenceFact, role: "current" | "base"): CalcInput {
	return {
		evidenceId: f.id,
		role,
		concept: f.concept,
		value: f.value,
		unit: f.unit,
		period: periodLabel(f.fiscalYear, f.fiscalPeriod),
		start: f.start,
		end: f.end,
		form: f.form,
		accn: f.accn,
		filed: f.filed,
		url: f.documentUrl,
		derivation: f.derivation?.formula,
		currency: f.currency,
		consolidation: f.consolidation,
		location: f.location ? { page: f.location.page, row: f.location.row, column: f.location.column, printed: f.location.printed, unitNote: f.location.unitNote } : undefined,
	}
}

const claimCurrency = (c: ClaimInterpretation) => (c.currency && c.currency !== "unspecified" ? c.currency : undefined)

export function statedDisplay(c: ClaimInterpretation): string {
	const q = { exact: "", about: "about ", more_than: "more than ", less_than: "less than ", at_least: "at least " }[c.qualifier]
	const sign = c.kind === "change" && c.direction === "decrease" ? "−" : c.kind === "change" ? "+" : ""
	const sym = currencySymbol(claimCurrency(c))
	switch (c.statedUnit) {
		case "money":
			return `${q}${sym}${c.statedNumber}${c.scale === "units" ? "" : " " + SCALE_WORD[c.scale]}`
		case "per_share":
			return `${q}${sym}${c.statedNumber} per share`
		case "percent":
			return `${q}${sign}${c.statedNumber}%`
		case "multiple":
			return `${q}${c.statedNumber}× (${c.direction ?? "increase"})`
	}
}

type Meta = { claimId: string; claimRevision: number; evidenceRevision: number }

function result(meta: Meta, c: ClaimInterpretation, verdict: NumericVerdict, rest: Partial<Calculation>): Calculation {
	return { ...meta, verdict, formula: "", substituted: "", statedDisplay: statedDisplay(c), inputs: [], notes: [], ...rest }
}

function compare(actual: number, stated: number, tol: number, qualifier: ClaimInterpretation["qualifier"]): boolean {
	const eps = 1e-9 * Math.max(1, Math.abs(stated))
	switch (qualifier) {
		case "more_than":
			return actual > stated
		case "less_than":
			return actual < stated
		case "at_least":
			return actual >= stated - eps
		default:
			return Math.abs(actual - stated) <= tol + eps
	}
}

/** Why a fact cannot be compared with this claim (currency, consolidation, per-share), or undefined. */
export function incomparability(c: ClaimInterpretation, f: EvidenceFact): string | undefined {
	const perShare = PER_SHARE_METRICS.has(c.metric)
	if (perShare !== f.perShare) return `Unit mismatch: metric ${c.metric} needs ${perShare ? "a per-share amount" : "a total amount"}, evidence ${f.id} is ${f.unit}.`
	const cur = claimCurrency(c)
	if (c.kind === "level" && cur && cur !== f.currency) {
		return `Currency mismatch: the article states ${cur}, the reference reports ${f.currency} (${f.id}). Amounts in different currencies are not compared; no exchange rate is applied.`
	}
	if (c.consolidation && c.consolidation !== "unspecified" && c.consolidation !== f.consolidation) {
		return `The article gives a ${c.consolidation} figure; ${f.id} is ${f.consolidation}. ${c.consolidation === "standalone" ? "Standalone" : "Consolidated"} figures are not available in this reference.`
	}
	return undefined
}

export function calculate(meta: Meta, c: ClaimInterpretation, current?: EvidenceFact, base?: EvidenceFact): Calculation {
	if (c.accounting === "non_gaap" || c.metric === "other") {
		return result(meta, c, "NOT_VERIFIABLE", {
			notes: [c.accounting === "non_gaap" ? "Adjusted / non-GAAP figures are not line items of the financial statements; not compared with reported values." : "Metric is not one the checker can map to a financial-statement line."],
		})
	}
	if (!current) return result(meta, c, "NOT_COMPUTABLE", { notes: ["No current-period evidence bound."] })

	const perShare = PER_SHARE_METRICS.has(c.metric)
	const why = incomparability(c, current)
	if (why) return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: [why] })

	const stated = parseStated(c.statedNumber)
	const money = (v: number) => (perShare ? fmtPerShare(Number(v.toFixed(4)), current.currency) : fmtMoney(v, current.currency))

	if (c.kind === "level") {
		if (c.statedUnit !== (perShare ? "per_share" : "money")) {
			return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: [`Stated unit ${c.statedUnit} does not fit a ${perShare ? "per-share" : "total amount"} level claim.`] })
		}
		const scale = perShare ? 1 : SCALE[c.scale]
		const statedAbs = stated * scale
		const tolBase = roundingTolerance(c.statedNumber) * scale
		const tol = c.qualifier === "about" ? Math.max(tolBase, 0.01 * Math.abs(statedAbs)) : tolBase
		const ok = compare(current.value, statedAbs, tol, c.qualifier)
		const notes: string[] = []
		if (!ok && !perShare) {
			for (const [name, f] of Object.entries(SCALE)) {
				if (f !== scale && compare(current.value, stated * f, roundingTolerance(c.statedNumber) * f, "exact")) notes.push(`Value matches if the scale were "${SCALE_WORD[name as Scale]}" instead of "${SCALE_WORD[c.scale] || "units"}" — likely a units error.`)
			}
		}
		const diff = current.value - statedAbs
		return result(meta, c, ok ? "MATCH" : "MISMATCH", {
			formula: `actual = ${current.id}`,
			substituted: `actual = ${fmtExact(current.value)} ${current.unit}`,
			actual: current.value,
			actualDisplay: perShare ? fmtPerShare(current.value, current.currency) : fmtMoney(current.value, current.currency),
			toleranceRule:
				c.qualifier === "about"
					? `"about": ±max(rounding of stated digits, 1%) = ±${perShare ? tol.toFixed(4) : fmtMoney(tol, current.currency)}`
					: c.qualifier === "exact"
						? `rounding of stated digits: ±${perShare ? tol.toFixed(4) : fmtMoney(tol, current.currency)}`
						: `qualifier "${c.qualifier.replace("_", " ")}"`,
			difference: ok ? undefined : `actual − stated = ${perShare ? diff.toFixed(4) : fmtMoney(diff, current.currency)}`,
			inputs: [toInput(current, "current")],
			notes,
		})
	}

	// change claims
	if (!base) return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: ["No comparison-period evidence bound."] })
	const inputs = [toInput(current, "current"), toInput(base, "base")]
	if (base.unit !== current.unit || base.consolidation !== current.consolidation) return result(meta, c, "NOT_COMPUTABLE", { inputs, notes: ["Current and base evidence differ in unit, currency or consolidation."] })
	const absChange = current.value - base.value
	const absDisplay = money(absChange)
	if (base.value === 0) return result(meta, c, "NOT_COMPUTABLE", { inputs, notes: [`Base period value is zero; a percentage change is undefined. Absolute change: ${absDisplay}.`] })
	if (base.value < 0) {
		return result(meta, c, "NOT_COMPUTABLE", {
			inputs,
			formula: "change = current − base",
			substituted: `change = ${fmtExact(current.value)} − (${fmtExact(base.value)}) = ${fmtExact(absChange)}`,
			notes: [`Base period is negative (a loss); a percentage change from a negative base is not meaningful. Absolute change: ${absDisplay}.`],
		})
	}

	if (c.statedUnit === "percent") {
		const pct = ((current.value - base.value) / Math.abs(base.value)) * 100
		const signed = c.direction === "decrease" ? -stated : stated
		const tol = c.qualifier === "about" ? Math.max(roundingTolerance(c.statedNumber), 1) : roundingTolerance(c.statedNumber)
		// Qualifiers apply to the size of the move in the stated direction: "fell more than 20%" means a
		// decline larger than 20%, i.e. pct < −20. A move the other way never satisfies the claim.
		const moved = c.direction === "decrease" ? -pct : pct
		const wrongWay = moved < -tol
		const ok = !wrongWay && compare(moved, stated, tol, c.qualifier)
		return result(meta, c, ok ? "MATCH" : "MISMATCH", {
			formula: `change% = (${current.id} − ${base.id}) / abs(${base.id}) × 100`,
			substituted: `(${fmtExact(current.value)} − ${fmtExact(base.value)}) / ${fmtExact(Math.abs(base.value))} × 100 = ${fmtPct(pct)}`,
			actual: pct,
			actualDisplay: `${pct >= 0 ? "+" : ""}${fmtPct(pct)}`,
			toleranceRule: c.qualifier === "exact" ? `rounding of stated digits: ±${tol} pp` : c.qualifier === "about" ? `"about": ±${tol} pp` : `qualifier "${c.qualifier.replace("_", " ")}"`,
			difference: ok ? undefined : `actual − stated = ${(pct - signed).toFixed(2)} pp`,
			inputs,
			notes: wrongWay ? [`The article says the figure ${c.direction === "decrease" ? "fell" : "rose"}, but it ${pct < 0 ? "fell" : "rose"} ${fmtPct(Math.abs(pct))}.`] : [],
		})
	}
	if (c.statedUnit === "multiple") {
		const ratio = current.value / base.value
		const tol = 0.05 * stated
		const ok = c.direction === "decrease" ? false : compare(ratio, stated, tol, c.qualifier)
		return result(meta, c, ok ? "MATCH" : "MISMATCH", {
			formula: `ratio = ${current.id} / ${base.id}`,
			substituted: `${fmtExact(current.value)} / ${fmtExact(base.value)} = ${ratio.toFixed(3)}×`,
			actual: ratio,
			actualDisplay: `${ratio.toFixed(3)}×`,
			toleranceRule: c.qualifier === "exact" ? `multiples: ±5% of stated multiple (±${tol.toFixed(3)})` : `qualifier "${c.qualifier.replace("_", " ")}"`,
			difference: ok ? undefined : `actual ratio ${ratio.toFixed(3)}× vs stated ${stated}×`,
			inputs,
			notes: [],
		})
	}
	return result(meta, c, "NOT_COMPUTABLE", { inputs, notes: [`Stated unit ${c.statedUnit} does not fit a change claim.`] })
}
