/**
 * Deterministic calculator. No model output is trusted for numbers: every value comes from an
 * EvidenceFact resolved by id from the SEC registry. The only model-supplied number is the
 * article's stated figure, which is what we are checking.
 */
import type { EvidenceFact } from "../sec/evidence.js"
import { periodLabel } from "../sec/evidence.js"
import type { CalcInput, Calculation, ClaimInterpretation, NumericVerdict, Scale } from "./types.js"

export const SCALE: Record<Scale, number> = { units: 1, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }
const PER_SHARE_METRICS = new Set(["eps_diluted", "eps_basic"])

export const decimalsOf = (s: string) => (s.includes(".") ? s.split(".")[1].length : 0)
/** Half a unit in the last stated digit: "96.2" -> 0.05, "106" -> 0.5. */
export const roundingTolerance = (s: string) => 0.5 * 10 ** -decimalsOf(s)

export function parseStated(s: string): number {
	const n = Number(s.replace(/,/g, ""))
	if (!Number.isFinite(n)) throw new Error(`stated number "${s}" is not a number`)
	return n
}

export function fmtUsd(v: number): string {
	const a = Math.abs(v)
	const sign = v < 0 ? "−" : ""
	if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(3)}T`
	if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(3)}B`
	if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(3)}M`
	return `${sign}$${a.toLocaleString("en-US")}`
}
export const fmtExact = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 4 })
const fmtPct = (v: number) => `${v.toFixed(2)}%`

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
	}
}

export function statedDisplay(c: ClaimInterpretation): string {
	const q = { exact: "", about: "about ", more_than: "more than ", less_than: "less than ", at_least: "at least " }[c.qualifier]
	const sign = c.kind === "change" && c.direction === "decrease" ? "−" : c.kind === "change" ? "+" : ""
	switch (c.statedUnit) {
		case "usd":
			return `${q}$${c.statedNumber}${c.scale === "units" ? "" : " " + c.scale}`
		case "usd_per_share":
			return `${q}$${c.statedNumber} per share`
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

export function calculate(meta: Meta, c: ClaimInterpretation, current?: EvidenceFact, base?: EvidenceFact): Calculation {
	if (c.accounting === "non_gaap" || c.metric === "other") {
		return result(meta, c, "NOT_VERIFIABLE", {
			notes: [c.accounting === "non_gaap" ? "Adjusted / non-GAAP figures are not part of the 10-Q/10-K financial statements; not compared with GAAP values." : "Metric is not one the checker can map to a financial-statement line."],
		})
	}
	if (!current) return result(meta, c, "NOT_COMPUTABLE", { notes: ["No current-period evidence bound."] })

	const perShare = PER_SHARE_METRICS.has(c.metric)
	const expectUnit = perShare ? "USD/shares" : "USD"
	if (current.unit !== expectUnit) return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: [`Unit mismatch: metric ${c.metric} needs ${expectUnit}, evidence is ${current.unit}.`] })

	const stated = parseStated(c.statedNumber)

	if (c.kind === "level") {
		if (c.statedUnit !== (perShare ? "usd_per_share" : "usd")) {
			return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: [`Stated unit ${c.statedUnit} does not fit a ${perShare ? "per-share" : "dollar"} level claim.`] })
		}
		const scale = perShare ? 1 : SCALE[c.scale]
		const statedAbs = stated * scale
		const tolBase = roundingTolerance(c.statedNumber) * scale
		const tol = c.qualifier === "about" ? Math.max(tolBase, 0.01 * Math.abs(statedAbs)) : tolBase
		const ok = compare(current.value, statedAbs, tol, c.qualifier)
		const notes: string[] = []
		if (!ok && !perShare) {
			for (const [name, f] of Object.entries(SCALE)) {
				if (f !== scale && compare(current.value, stated * f, roundingTolerance(c.statedNumber) * f, "exact")) notes.push(`Value matches if the scale were "${name}" instead of "${c.scale}" — likely a units error.`)
			}
		}
		const diff = current.value - statedAbs
		return result(meta, c, ok ? "MATCH" : "MISMATCH", {
			formula: `actual = ${current.id}`,
			substituted: `actual = ${fmtExact(current.value)} ${current.unit}`,
			actual: current.value,
			actualDisplay: perShare ? `$${current.value} per share` : fmtUsd(current.value),
			toleranceRule:
				c.qualifier === "about"
					? `"about": ±max(rounding of stated digits, 1%) = ±${perShare ? tol.toFixed(4) : fmtUsd(tol)}`
					: c.qualifier === "exact"
						? `rounding of stated digits: ±${perShare ? tol.toFixed(4) : fmtUsd(tol)}`
						: `qualifier "${c.qualifier.replace("_", " ")}"`,
			difference: ok ? undefined : `actual − stated = ${perShare ? diff.toFixed(4) : fmtUsd(diff)}`,
			inputs: [toInput(current, "current")],
			notes,
		})
	}

	// change claims
	if (!base) return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current")], notes: ["No comparison-period evidence bound."] })
	if (base.unit !== current.unit) return result(meta, c, "NOT_COMPUTABLE", { inputs: [toInput(current, "current"), toInput(base, "base")], notes: ["Current and base evidence have different units."] })
	const inputs = [toInput(current, "current"), toInput(base, "base")]
	const absChange = current.value - base.value
	const absDisplay = perShare ? `${absChange.toFixed(4)} USD/share` : fmtUsd(absChange)
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
		const ok = compare(pct, signed, tol, c.qualifier)
		return result(meta, c, ok ? "MATCH" : "MISMATCH", {
			formula: `change% = (${current.id} − ${base.id}) / abs(${base.id}) × 100`,
			substituted: `(${fmtExact(current.value)} − ${fmtExact(base.value)}) / ${fmtExact(Math.abs(base.value))} × 100 = ${fmtPct(pct)}`,
			actual: pct,
			actualDisplay: `${pct >= 0 ? "+" : ""}${fmtPct(pct)}`,
			toleranceRule: c.qualifier === "exact" ? `rounding of stated digits: ±${tol} pp` : c.qualifier === "about" ? `"about": ±${tol} pp` : `qualifier "${c.qualifier.replace("_", " ")}"`,
			difference: ok ? undefined : `actual − stated = ${(pct - signed).toFixed(2)} pp`,
			inputs,
			notes: [],
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
