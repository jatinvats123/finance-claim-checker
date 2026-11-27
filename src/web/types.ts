/**
 * Shapes the web server sends to the browser. Pure types (no runtime imports) so the frontend can
 * share them. All values are produced by the engine/view model; the UI does no financial logic.
 */
import type { CalcInput, ClaimInterpretation, ContextWarning, NumericVerdict } from "../domain/types.js"
import type { HistoryEntry } from "../domain/store.js"
import type { Trace, Lane } from "../runtime/trace.js"

export type { Trace, Lane }

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

export type AgentName = "Reader" | "Extractor" | "Evidence" | "Context" | "Calculator" | "Auditor"

/** What a run checks against: SEC statements, or a company's official report (PDF) verified page by page. */
export type ReferenceView = {
	kind: "sec" | "report"
	entityName: string
	ticker?: string
	cik?: string
	label: string
	fetchedAt: string
	sources: { label: string; url: string }[]
	reportingCurrency?: string
	note?: string
	report?: {
		status: "reading" | "ready" | "failed"
		pageCount: number
		statementPages: number[]
		verified: { id?: string; metric: string; period: string; consolidation: string; page: number; row: string; column: string; printed: string; unitNote: string; value: number; unit: string }[]
		rejected: { proposed: unknown; reason: string }[]
		error?: string
	}
}

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

export type RunStatus = "running" | "done" | "cache_miss" | "reference_unavailable" | "failed" | "timed_out"

export type RunView = {
	id: string
	status: RunStatus
	source: "example" | "custom"
	mode: "replay" | "live"
	startedAt: string
	elapsedMs: number
	article: { title: string; text: string }
	company: { ticker?: string; name: string; cik?: string }
	snapshotFetchedAt: string
	reference: ReferenceView
	extraction: { status: "running" | "done" | "failed"; error?: string }
	claims: ClaimView[]
	agents: AgentView[]
	timeline: TimelineEntry[]
	provenance: ProvenanceView
	progress: { discovered: number; settled: number; reviewed: number; extractionDone: boolean }
	summary: { match: number; mismatch: number; notComputable: number; notVerifiable: number; referenceUnavailable: number; pending: number; reviewComplete: number; reviewIncomplete: number }
	staleRejections: HistoryEntry[]
	/** Agent loops measured from Mozaik start/end events (see src/runtime/trace.ts). */
	trace?: Trace
	error?: string
}

export type MetaView = {
	product: { name: string; tagline: string; disclaimer: string }
	/** The optional NVIDIA example's company (custom articles resolve their own). */
	company: { ticker: string; name: string; cik: string }
	companies: { ticker: string; name: string }[]
	/** SEC's list of filers that custom articles are resolved against. */
	companyIndex?: { count: number; fetchedAt: string; source: string }
	/** Fresh articles about other companies, with genuine recorded runs where available. */
	samples: { id: string; label: string; title: string; text: string; company?: string; reportUrl?: string; note: string }[]
	snapshotFetchedAt: string
	example: { title: string; text: string; path: string; label: string }
	replaySources: { path: string; provenance: string; description: string }[]
	/** The included example can replay either source, never both mixed. Default = first available. */
	replayOptions: { id: "recorded" | "fixtures"; label: string; short: string; available: boolean; detail: string }[]
	defaultReplay: "recorded" | "fixtures"
	live: { configured: boolean; model?: string; hint: string }
	mozaikVersion: string
}

export type Candidate = { cik: string; name: string; tickers: string[]; score: number; why: string[] }
export type Resolution =
	| { status: "resolved"; company: Candidate; candidates: Candidate[]; method: "ticker" | "name" | "detected"; reason: string }
	| { status: "ambiguous"; candidates: Candidate[]; reason: string }
	| { status: "not_found"; candidates: Candidate[]; reason: string }
export type ReferencePreview =
	| { kind: "sec"; entityName: string; ticker: string; cik: string; source: "committed" | "live"; fetchedAt: string; forms: string[]; reportingCurrency?: string; latest?: string; facts: number; concepts: number }
	| { kind: "unavailable"; code: string; reason: string; needsReport?: boolean }
export type ResolveView = { resolution: Resolution; reference?: ReferencePreview; companyIndex: { count: number; fetchedAt: string } }
