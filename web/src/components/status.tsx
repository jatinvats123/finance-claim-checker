import type { ClaimView, VerdictCode } from "../api"
import { IconAlert, IconCheck, IconClock, IconCorrection, IconHelp, IconSpinner, IconX } from "./icons"

export type Tone = "good" | "bad" | "warn" | "neutral" | "pending"

export function verdictTone(v: VerdictCode): Tone {
	switch (v) {
		case "MATCH":
			return "good"
		case "MISMATCH":
			return "bad"
		case "PENDING":
			return "pending"
		case "REFERENCE_NOT_YET_FILED":
			return "neutral"
		default:
			return "warn"
	}
}

function VerdictIcon({ v }: { v: VerdictCode }) {
	switch (v) {
		case "MATCH":
			return <IconCheck />
		case "MISMATCH":
			return <IconX />
		case "PENDING":
			return <IconSpinner />
		case "REFERENCE_NOT_YET_FILED":
			return <IconClock />
		case "NOT_VERIFIABLE":
			return <IconHelp />
		default:
			return <IconAlert />
	}
}

/** Numerical status — the label text comes from the server. */
export function VerdictBadge({ claim, large }: { claim: Pick<ClaimView, "verdict" | "verdictLabel">; large?: boolean }) {
	return (
		<span className={`badge tone-${verdictTone(claim.verdict)}${large ? " badge-lg" : ""}`}>
			<VerdictIcon v={claim.verdict} />
			{claim.verdictLabel}
		</span>
	)
}

export function reviewTone(s: ClaimView["review"]["status"]): Tone {
	return s === "complete" ? "good" : s === "incomplete" || s === "unresolved" || s === "not_completed" ? "bad" : "pending"
}

/** Review status — kept visually separate from the numerical status. */
export function ReviewLine({ claim }: { claim: ClaimView }) {
	const s = claim.review.status
	const icon = s === "complete" ? <IconCheck size={14} /> : s === "correcting" ? <IconCorrection size={14} /> : s === "in_progress" ? <IconSpinner size={14} /> : <IconAlert size={14} />
	return (
		<span className={`review review-${reviewTone(s)}`} title={claim.review.detail}>
			{icon}
			<span>
				<span className="review-kicker">Review:</span> {claim.review.label}
			</span>
		</span>
	)
}

export const WARNING_LABEL: Record<string, string> = {
	BASIS_UNSTATED: "Comparison basis not stated",
	GAAP_OR_ADJUSTED_UNSTATED: "Reported or adjusted not stated",
	NON_GAAP: "Adjusted (non-GAAP) figure",
	NEGATIVE_BASE: "Loss in comparison period",
	DERIVED_Q4: "Derived Q4 value",
	RESTATED: "Restated in a later filing",
	VALUE_MATCHES_OTHER_PERIOD: "Figure matches another period",
	EARNINGS_RELEASE_ONLY: "Only an earnings release found",
	REPORT_PERIOD_MISSING: "Period not in the report",
	CURRENCY_UNSTATED: "Currency not stated",
	CONVENIENCE_TRANSLATION: "Convenience translation",
	CONSOLIDATION_UNSTATED: "Consolidated or standalone not stated",
	OTHER_LINE_ITEM_MATCHES: "Matches a different line item",
	ACCOUNTING_BASIS_DIFFERS: "Different accounting basis",
	CHERRY_PICKED: "Cherry-picked comparison",
	RECORD_OR_SUPERLATIVE: "Unsupported superlative",
	FORWARD_LOOKING: "Forward-looking",
	PERIOD_AMBIGUOUS: "Ambiguous period",
	ATTRIBUTION: "Attribution",
	MISLEADING_FRAMING: "Misleading framing",
	OTHER: "Other",
}
export const warningLabel = (code: string) => WARNING_LABEL[code] ?? code.replace(/_/g, " ").toLowerCase()
