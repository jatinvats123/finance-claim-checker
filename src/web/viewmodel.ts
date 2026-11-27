/**
 * Turns live engine state (CheckerState, TaskTracker, runner call records, Mozaik events) into the
 * RunView the browser renders. Labels and review completeness are decided here, once, from the
 * engine's own statuses — the frontend only displays them.
 */
import type { SemanticEvent } from "@mozaik-ai/core"
import { toInput } from "../domain/calculator.js"
import type { CheckerState } from "../domain/store.js"
import type { Claim, ClaimInterpretation, NumericVerdict } from "../domain/types.js"
import type { CallRecord } from "../llm/runner.js"
import type { AgentRole, TaskTracker } from "../runtime/tasks.js"
import type { AgentName, AgentView, ClaimView, ProvenanceView, ReferenceView, RunStatus, RunView, TimelineEntry, TimelineTone } from "./types.js"

/**
 * Display only: show the stated number with the article's own digit grouping ("₹15,172.1 crore",
 * "₹1,51,271 crore") when the quote contains exactly that number. Engine strings (and so model prompts
 * and replay keys) keep the normalized number.
 */
export function asWritten(display: string, c: Pick<ClaimInterpretation, "quote" | "statedNumber">): string {
	const n = c.statedNumber.replace(/^[+-]/, "")
	if (!n || n.includes(",") || !display.includes(n)) return display
	for (const m of c.quote.matchAll(/\d{1,3}(?:,\d{2,3})+(?:\.\d+)?/g)) if (m[0].replace(/,/g, "") === n) return display.replace(n, m[0])
	return display
}

export const VERDICT_LABEL: Record<NumericVerdict | "PENDING", string> = {
	MATCH: "Figures match",
	MISMATCH: "Figures differ",
	NOT_COMPUTABLE: "Cannot calculate",
	NOT_VERIFIABLE: "Cannot verify",
	REFERENCE_NOT_YET_FILED: "No statement for this period in the reference",
	PENDING: "Checking",
}

const METRIC_LABEL: Record<ClaimInterpretation["metric"], string> = {
	revenue: "Revenue",
	net_income: "Net income",
	gross_profit: "Gross profit",
	operating_income: "Operating income",
	eps_diluted: "Diluted EPS",
	eps_basic: "Basic EPS",
	other: "Other metric",
}

export function periodText(fy: number, fp: string): string {
	return fp === "FY" ? `Full year FY${fy}` : fp === "H1" ? `First half FY${fy}` : fp === "9M" ? `Nine months FY${fy}` : `${fp} FY${fy}`
}

function kindText(c: ClaimInterpretation): string {
	if (c.kind === "level") return "Reported figure"
	const basis = c.comparison === "yoy" ? "year over year" : c.comparison === "qoq" ? "quarter over quarter" : "comparison basis not stated"
	return `Change, ${basis}`
}

const ACCOUNTING_LABEL = { gaap: "Reported (GAAP/IFRS)", non_gaap: "Adjusted (non-GAAP)", unspecified: "Reported or adjusted not stated" } as const

// ---------- quote location (exact offsets into the original article text) ----------

function normalizeWithMap(s: string): { norm: string; map: number[] } {
	let norm = ""
	const map: number[] = []
	for (let i = 0; i < s.length; i++) {
		let ch = s[i]
		if (/\s/.test(ch)) {
			if (norm.length === 0 || norm[norm.length - 1] === " ") continue
			ch = " "
		} else if (ch === "‘" || ch === "’") ch = "'"
		else if (ch === "“" || ch === "”") ch = '"'
		norm += ch
		map.push(i)
	}
	return { norm, map }
}

/** All places a quote occurs in the article. Matching tolerates whitespace/curly-quote differences, offsets refer to the original text. */
export function locateQuote(text: string, quote: string): { start: number; end: number }[] {
	const { norm, map } = normalizeWithMap(text)
	const q = normalizeWithMap(quote).norm.trim()
	if (!q) return []
	const spans: { start: number; end: number }[] = []
	for (let i = norm.indexOf(q); i >= 0; i = norm.indexOf(q, i + 1)) spans.push({ start: map[i], end: map[i + q.length - 1] + 1 })
	return spans
}

// ---------- review status ----------

function reviewOf(state: CheckerState, claim: Claim, runFinished: boolean): ClaimView["review"] & { audit: ClaimView["audit"]; context: ClaimView["context"] } {
	const a = state.audits.get(claim.id)
	const current = a && a.claimRevision === claim.revision ? a.state : undefined
	const audit: ClaimView["audit"] = !current
		? { status: "none" }
		: current.status === "approved"
			? { status: "approved", by: current.by, note: current.note }
			: current.status === "investigating"
				? { status: "investigating", by: current.by, reason: current.reason, target: current.target }
				: current.status === "unresolved" || current.status === "failed"
					? { status: current.status, reason: current.reason }
					: { status: "pending" }
	const ctxFail = state.contextFailures.get(claim.id)
	const context: ClaimView["context"] =
		ctxFail && ctxFail.claimRevision === claim.revision ? { status: "failed", reason: ctxFail.reason } : state.contextDone.get(claim.id) === claim.revision ? { status: "done" } : { status: "pending" }

	let status: ClaimView["review"]["status"]
	let label: string
	let detail: string
	if (audit.status === "failed") {
		status = "incomplete"
		label = "Review incomplete"
		detail = audit.reason ?? "The audit did not complete."
	} else if (audit.status === "unresolved") {
		status = "unresolved"
		label = "Unresolved"
		detail = audit.reason ?? "The auditor's objection was not resolved."
	} else if (context.status === "failed") {
		status = "incomplete"
		label = "Review incomplete"
		detail = context.reason ?? "The context review did not complete."
	} else if (audit.status === "approved" && context.status === "done") {
		status = "complete"
		label = "Reviewed"
		detail = `Audit approved by ${audit.by}; context review finished.`
	} else if (audit.status === "investigating") {
		status = "correcting"
		label = "Correction in progress"
		detail = `${audit.by} asked the ${audit.target === "claim" ? "extractor" : "evidence agent"} to fix it: ${audit.reason}`
	} else {
		status = runFinished ? "not_completed" : "in_progress"
		label = runFinished ? "Review did not complete" : "In review"
		const waiting = [audit.status !== "approved" ? "audit" : "", context.status !== "done" ? "context review" : ""].filter(Boolean).join(" and ")
		detail = runFinished ? `The run ended before the ${waiting} finished.` : `Waiting for ${waiting}.`
	}
	return { status, label, detail, audit, context }
}

// ---------- claims ----------

export function claimView(state: CheckerState, claim: Claim, runFinished: boolean): ClaimView {
	const c = claim.interpretation
	const calcRaw = state.calcs.get(claim.id)
	const calc = calcRaw && calcRaw.claimRevision === claim.revision ? calcRaw : undefined
	const b = state.bindings.get(claim.id)
	const binding = b && b.claimRevision === claim.revision ? b : undefined
	const verdict = calc?.verdict ?? "PENDING"
	const r = reviewOf(state, claim, runFinished)
	const spans = locateQuote(state.article!.text, c.quote)
	const alt = binding?.alternateBaseFactId ? state.registry.get(binding.alternateBaseFactId) : undefined
	const history = state.history.filter((h) => h.claimId === claim.id)
	const corrections = state.corrections.filter((x) => x.claimId === claim.id).map(({ claimId: _, ...rest }) => rest)

	return {
		id: claim.id,
		revision: claim.revision,
		quote: c.quote,
		interpretation: c,
		metricLabel: METRIC_LABEL[c.metric],
		periodLabel: periodText(c.fiscalYear, c.fiscalPeriod),
		kindLabel: kindText(c),
		accountingLabel: ACCOUNTING_LABEL[c.accounting],
		statedDisplay: asWritten(calc?.statedDisplay ?? c.statedNumber, c),
		verdict,
		verdictLabel: VERDICT_LABEL[verdict],
		calc: calc && {
			evidenceRevision: calc.evidenceRevision,
			actualDisplay: calc.actualDisplay,
			statedDisplay: asWritten(calc.statedDisplay, c),
			difference: calc.difference,
			toleranceRule: calc.toleranceRule,
			formula: calc.formula,
			substituted: calc.substituted,
			notes: calc.notes,
			inputs: calc.inputs.map(input => {
				if (!input.derivation) return input
				const derivation = state.registry.get(input.evidenceId)?.derivation
				const operands = derivation?.inputIds.map(id => state.registry.get(id))
				if (!operands?.every(fact => fact !== undefined)) return input
				return { ...input, derivationInputs: operands.map(fact => toInput(fact, input.role)) }
			}),
		},
		evidence: binding && {
			evidenceRevision: binding.evidenceRevision,
			boundBy: binding.boundBy,
			currentFactId: binding.currentFactId,
			baseFactId: binding.baseFactId,
			alternate: alt ? toInput(alt, "base") : undefined,
			reference: binding.noReference && { status: binding.noReference.status, detail: binding.noReference.detail, earningsReleases: binding.noReference.earningsReleases ?? [] },
		},
		warnings: state.warnings.get(claim.id) ?? [],
		audit: r.audit,
		context: r.context,
		review: { status: r.status, label: r.label, detail: r.detail },
		corrections,
		history,
		location: {
			spans,
			note: spans.length === 0 ? "This quotation was not found verbatim in the article text." : spans.length > 1 ? `This quotation appears ${spans.length} times in the article; every occurrence is marked because the engine does not record which one was meant.` : undefined,
		},
		order: spans[0]?.start ?? Number.MAX_SAFE_INTEGER,
	}
}

// ---------- agent activity & timeline (from actual Mozaik events) ----------

const ROLE_AGENT: Record<AgentRole, AgentName> = { reader: "Reader", extractor: "Extractor", "extractor-fix": "Extractor", evidence: "Evidence", context: "Context", auditor: "Auditor" }

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

function toolAction(name: string, args: any): string {
	switch (name) {
		case "submit_claim":
			return `Submitting claim “${short(String(args?.quote ?? ""))}”`
		case "revise_claim":
			return `Revising ${args?.claimId} (from r${args?.fromRevision})`
		case "search_facts":
			return `Searching statement facts: ${args?.metric} ${periodText(args?.fiscalYear, args?.fiscalPeriod)}`
		case "record_facts":
			return `Recording ${Array.isArray(args?.facts) ? args.facts.length : "?"} report facts for verification`
		case "bind_evidence":
			return `Binding evidence to ${args?.claimId} r${args?.claimRevision}`
		case "report_no_reference":
			return `Reporting no statement for ${args?.claimId}'s period`
		case "add_context_warning":
			return `Adding context warning ${args?.code} to ${args?.claimId} r${args?.claimRevision}`
		case "approve":
			return `Approving ${args?.claimId} r${args?.claimRevision}.e${args?.evidenceRevision}`
		case "request_correction":
			return `Requesting ${args?.target} correction for ${args?.claimId}`
		default:
			return `Calling ${name}`
	}
}

export class ActivityLog {
	readonly timeline: TimelineEntry[] = []
	private readonly last = new Map<AgentName, { text: string; at: number }>()
	private calculations = 0
	private ruleDecisions = 0
	private readonly t0 = Date.now()

	private push(agent: string, text: string, tone: TimelineTone, kind: string, claimId?: string) {
		const at = Date.now() - this.t0
		this.timeline.push({ at, agent, text, tone, kind, claimId })
		if (["Reader", "Extractor", "Evidence", "Context", "Calculator", "Auditor"].includes(agent)) this.last.set(agent as AgentName, { text, at })
	}

	record(e: SemanticEvent, names: Map<string, string>, state: CheckerState) {
		const who = names.get(e.producerId) ?? "?"
		const p = e.payload as any
		switch (e.type) {
			case "article.submitted":
				return this.push("Desk", `Article submitted: ${p.title}`, "info", e.type)
			case "function_call.started": {
				let args: any = {}
				try {
					args = JSON.parse(p.call?.args ?? "{}")
				} catch {
					/* keep empty */
				}
				return this.push(who, toolAction(p.call?.name, args), "tool", e.type, args?.claimId)
			}
			case "claim.revised": {
				const c = state.claims.get(p.claimId)
				return this.push(who, p.claimRevision === 1 ? `Found ${p.claimId}: “${short(c?.interpretation.quote ?? "")}”` : `Revised ${p.claimId} to r${p.claimRevision}`, "info", e.type, p.claimId)
			}
			case "evidence.bound": {
				const b = state.bindings.get(p.claimId)
				const what = b?.noReference ? b.noReference.status.replace(/_/g, " ").toLowerCase() : [b?.currentFactId, b?.baseFactId].filter(Boolean).join(" vs ")
				return this.push(who, `Bound evidence ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision}: ${what}`, "info", e.type, p.claimId)
			}
			case "calculation.completed": {
				this.calculations++
				const calc = state.calcs.get(p.claimId)
				return this.push("Calculator", `Calculated ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision}: ${calc ? VERDICT_LABEL[calc.verdict] : "?"}${calc?.actualDisplay ? ` (${calc.actualDisplay} vs stated ${calc.statedDisplay})` : ""}`, "info", e.type, p.claimId)
			}
			case "audit.correction_requested":
				if (String(p.by).includes("rule")) this.ruleDecisions++
				return this.push("Auditor", `Correction requested (${p.by}) for ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision} → ${p.target === "claim" ? "Extractor" : "Evidence"}: ${p.reason}`, "warn", e.type, p.claimId)
			case "audit.final": {
				const a = state.audits.get(p.claimId)?.state
				if (a?.status === "approved" && a.by.includes("rule")) this.ruleDecisions++
				const text = a?.status === "approved" ? `Approved ${p.claimId} (${a.by})` : `${a?.status === "unresolved" ? "Unresolved" : "Audit ended"}: ${p.claimId}${a && "reason" in a ? ` — ${a.reason}` : ""}`
				return this.push(who === "Desk" ? "Auditor" : who, text, a?.status === "approved" ? "good" : "bad", e.type, p.claimId)
			}
			case "context.warning":
				return this.push("Context", `Context warning ${p.code} on ${p.claimId} r${p.claimRevision}`, "info", e.type, p.claimId)
			case "result.stale_rejected":
				return this.push(who, `Stale result rejected: ${p.reason}`, "stale", e.type, p.claimId)
			case "task.failed":
				return this.push("Supervisor", `Task failed: ${p.task}`, "bad", e.type, p.claimId)
			case "extraction.done":
				return this.push("Extractor", p.failed ? "Extraction failed" : "Extraction finished", p.failed ? "bad" : "good", e.type)
			case "report.progress":
				return this.push("Reader", `Report facts verified by code: ${p.accepted} (proposals rejected: ${p.rejected})`, "info", e.type)
			case "reference.ready":
				return state.report ? this.push("Reader", `Report ready: ${p.facts} verified facts`, "good", e.type) : undefined
			case "reference.failed":
				return this.push(state.report ? "Reader" : "Desk", `Reference unavailable: ${p.reason}`, "bad", e.type)
		}
	}

	agents(tasks: TaskTracker): AgentView[] {
		const base = (name: AgentName, kind: string): AgentView => ({ name, kind, running: 0, queued: 0, finished: 0, failed: 0, lastAction: this.last.get(name)?.text, lastAt: this.last.get(name)?.at })
		const views: Partial<Record<AgentName, AgentView>> = {
			...(tasks.all().some((t) => t.role === "reader") ? { Reader: base("Reader", "LLM + page checks (code)") } : {}),
			Extractor: base("Extractor", "LLM"),
			Evidence: base("Evidence", "LLM"),
			Context: base("Context", "LLM"),
			Calculator: base("Calculator", "code"),
			Auditor: base("Auditor", "rule gate (code) + LLM review"),
		}
		for (const t of tasks.all()) {
			const v = views[ROLE_AGENT[t.role]]
			if (!v) continue
			if (!t.done) t.loopId ? v.running++ : v.queued++
			else t.failure ? v.failed++ : v.finished++
		}
		views.Calculator!.finished = this.calculations
		views.Auditor!.finished += this.ruleDecisions
		return Object.values(views) as AgentView[]
	}
}

// ---------- provenance ----------

export function provenanceOf(calls: CallRecord[]): ProvenanceView {
	const counts: Record<string, number> = {}
	for (const c of calls) counts[c.provenance] = (counts[c.provenance] ?? 0) + 1
	const sources = (["live", "recorded", "fixture"] as const).filter((k) => counts[k])
	const kind: ProvenanceView["kind"] = sources.length === 0 ? "none" : sources.length > 1 ? "mixed" : sources[0]
	const label =
		kind === "fixture"
			? "Hand-written fixture responses"
			: kind === "recorded"
				? "Recorded model responses"
				: kind === "live"
					? "Live provider responses"
					: kind === "mixed"
						? `Mixed sources: ${sources.map((s) => `${counts[s]} ${s}`).join(", ")}`
						: "No model responses yet"
	return { kind, label, counts, simulatedTiming: kind !== "live" }
}

// ---------- reference ----------

export function referenceView(state: CheckerState): ReferenceView {
	const ref = state.referenceInfo
	const r = state.report
	return {
		...ref,
		report: r
			? {
					status: r.status,
					pageCount: r.doc.pageCount,
					statementPages: r.pages.map((p) => p.n),
					verified: r.accepted.map((f) => {
						const ev = state.registry?.all().find((e) => e.location && e.location.page === f.location?.page && e.start === f.start && e.end === f.end && e.concept === f.concept && e.consolidation === f.consolidation)
						return {
							id: ev?.id,
							metric: f.concept.replace("report:", ""),
							period: ev ? `${ev.fiscalPeriod}-FY${ev.fiscalYear}` : `${f.start} → ${f.end}`,
							consolidation: f.consolidation,
							page: f.location!.page,
							row: f.location!.row,
							column: f.location!.column,
							printed: f.location!.printed,
							unitNote: f.location!.unitNote,
							value: f.value,
							unit: f.unit,
						}
					}),
					rejected: r.rejected.slice(0, 50),
					error: r.error,
				}
			: undefined,
	}
}

// ---------- whole run ----------

export function runView(args: {
	id: string
	source: "example" | "custom"
	mode: "replay" | "live"
	startedAt: Date
	status: RunStatus
	state: CheckerState
	tasks: TaskTracker
	calls: CallRecord[]
	activity: ActivityLog
	error?: string
	trace?: import("../runtime/trace.js").Trace
}): RunView {
	const { state } = args
	const finished = args.status !== "running"
	const claims = [...state.claims.values()].map((c) => claimView(state, c, finished)).sort((a, b) => a.order - b.order || Number(a.id.slice(1)) - Number(b.id.slice(1)))
	const count = (v: string) => claims.filter((c) => c.verdict === v).length
	const ref = state.referenceInfo
	return {
		id: args.id,
		status: args.status,
		source: args.source,
		mode: args.mode,
		startedAt: args.startedAt.toISOString(),
		elapsedMs: Date.now() - args.startedAt.getTime(),
		article: { title: state.article!.title, text: state.article!.text },
		company: { ticker: ref.ticker, name: ref.entityName, cik: ref.cik },
		snapshotFetchedAt: ref.fetchedAt,
		reference: referenceView(state),
		extraction: { status: state.extraction, error: state.extractionError },
		claims,
		agents: args.activity.agents(args.tasks),
		timeline: args.activity.timeline,
		provenance: provenanceOf(args.calls),
		progress: {
			discovered: claims.length,
			settled: claims.filter((c) => state.isSettled(c.id)).length,
			reviewed: claims.filter((c) => c.review.status === "complete").length,
			extractionDone: state.extraction !== "running",
		},
		summary: {
			match: count("MATCH"),
			mismatch: count("MISMATCH"),
			notComputable: count("NOT_COMPUTABLE"),
			notVerifiable: count("NOT_VERIFIABLE"),
			referenceUnavailable: count("REFERENCE_NOT_YET_FILED"),
			pending: count("PENDING"),
			reviewComplete: claims.filter((c) => c.review.status === "complete").length,
			reviewIncomplete: claims.filter((c) => ["incomplete", "unresolved", "not_completed"].includes(c.review.status)).length,
		},
		staleRejections: state.staleRejections,
		error: args.error,
		trace: args.trace,
	}
}
