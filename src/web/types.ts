/**
 * Shapes the web server sends to the browser. Pure types (no runtime imports) so the frontend can
 * share them. All values are produced by the engine/view model; the UI does no financial logic.
 */
import type { CalcInput, ClaimInterpretation, ContextWarning, NumericVerdict } from "../domain/types.js"
import type { HistoryEntry } from "../domain/store.js"

export type { CalcInput, ClaimInterpretation, ContextWarning, NumericVerdict, HistoryEntry }

export type VerdictCode = NumericVerdict | "PENDING"

/** complete = current calculation audited/approved AND context review finished for the current revision. */
export type ReviewStatus = "complete" | "in_progress" | "correcting" | "incomplete" | "unresolved" | "not_completed"

export type ClaimView = {
	id: string
	revision: number
	quote: string
	interpretation: ClaimInterpretation
	metricLabel: string
	periodLabel: string
	kindLabel: string
	accountingLabel: string
	statedDisplay: string
	verdict: VerdictCode
	verdictLabel: string
	/** Present once a calculation exists for the current revision. Values straight from the calculator. */
	calc?: {
		evidenceRevision: number
		actualDisplay?: string
		statedDisplay: string
		difference?: string
		toleranceRule?: string
		formula: string
		substituted: string
		notes: string[]
		inputs: CalcInput[]
	}
	evidence?: {
		evidenceRevision: number
		boundBy: string
		currentFactId?: string
		baseFactId?: string
		/** Shown as context only (comparison basis not stated). */
		alternate?: CalcInput
		reference?: { status: string; detail: string; earningsReleases: { accn: string; filed: string; url: string }[] }
	}
	warnings: ContextWarning[]
	audit: { status: "none" | "pending" | "investigating" | "approved" | "unresolved" | "failed"; by?: string; note?: string; reason?: string; target?: string }
	context: { status: "pending" | "done" | "failed"; reason?: string }
	review: { status: ReviewStatus; label: string; detail: string }
	corrections: { at: number; by: string; target: string; reason: string; claimRevision: number; evidenceRevision: number }[]
	history: HistoryEntry[]
	/** Where the quote sits in article.text (offsets into the exact string sent in RunView.article.text). */
	location: { spans: { start: number; end: number }[]; note?: string }
	order: number
}

export type AgentName = "Extractor" | "Evidence" | "Context" | "Calculator" | "Auditor"

export type AgentView = {
	name: AgentName
	kind: string
	running: number
	queued: number
	finished: number
	failed: number
	lastAction?: string
	lastAt?: number
}

export type TimelineTone = "info" | "good" | "bad" | "warn" | "stale" | "tool"
export type TimelineEntry = { at: number; agent: string; text: string; tone: TimelineTone; claimId?: string; kind: string }

export type ProvenanceView = {
	kind: "none" | "live" | "recorded" | "fixture" | "mixed"
	label: string
	counts: Record<string, number>
	/** true unless every response came from a live provider: timings then reflect replay/fixture delays. */
	simulatedTiming: boolean
}

export type RunStatus = "running" | "done" | "cache_miss" | "failed" | "timed_out"

export type RunView = {
	id: string
	status: RunStatus
	source: "example" | "custom"
	mode: "replay" | "live"
	startedAt: string
	elapsedMs: number
	article: { title: string; text: string }
	company: { ticker: string; name: string; cik: string }
	snapshotFetchedAt: string
	extraction: { status: "running" | "done" | "failed"; error?: string }
	claims: ClaimView[]
	agents: AgentView[]
	timeline: TimelineEntry[]
	provenance: ProvenanceView
	progress: { discovered: number; settled: number; reviewed: number; extractionDone: boolean }
	summary: { match: number; mismatch: number; notComputable: number; notVerifiable: number; referenceUnavailable: number; pending: number; reviewComplete: number; reviewIncomplete: number }
	staleRejections: HistoryEntry[]
	error?: string
}

export type MetaView = {
	product: { name: string; tagline: string; disclaimer: string }
	company: { ticker: string; name: string; cik: string }
	companies: { ticker: string; name: string }[]
	snapshotFetchedAt: string
	example: { title: string; text: string; path: string; label: string }
	replaySources: { path: string; provenance: string; description: string }[]
	live: { configured: boolean; model?: string; hint: string }
	mozaikVersion: string
	activeRunId?: string
}
