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

export { unmatchedFinancialMentions } from "../../src/web/mentions"
