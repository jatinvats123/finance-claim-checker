/**
 * Shared, versioned state for all participants (a Mozaik RuntimeState).
 *
 * Every derived result (evidence binding, calculation, audit, context warning) is stamped with the
 * claim revision — and where relevant the evidence revision — it was computed from. Writes stamped
 * with an outdated revision are rejected and logged, so a slow agent can never overwrite newer work.
 * Revising one claim never touches another claim's results.
 */
import { RuntimeState } from "@mozaik-ai/core"
import type { PdfPage, ReportDoc } from "../docs/pdf.js"
import type { EvidenceRegistry, RawFact, ReferenceInfo } from "../sec/evidence.js"
import type { AuditState, Calculation, Claim, ClaimInterpretation, ContextWarning, EvidenceBinding } from "./types.js"

/** An official report being read for this run: facts are added only after code verified them on their page. */
export type ReportState = {
	doc: ReportDoc
	info: ReferenceInfo
	pages: PdfPage[]
	basis: string
	docCurrency?: string
	accepted: RawFact[]
	rejected: { proposed: unknown; reason: string }[]
	status: "reading" | "ready" | "failed"
	error?: string
}

export type Accepted<T> = { ok: true; value: T }
export type Rejected = { ok: false; stale: boolean; reason: string; retainedForReview?: boolean; dismissed?: boolean }
export type WriteResult<T> = Accepted<T> | Rejected

export type HistoryEntry = { at: number; claimId?: string; kind: string; detail: string }

export const MAX_CORRECTIONS = 2

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })
const normalizeWording = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()
const historicalWording = /\b(?:reported|posted|recorded|generated|recognized|earned|came in at|totaled|amounted to)\b/i
const historicalEpsLevel = /\b(?:earnings per share|eps)\b[^.!?;\n]{0,60}\b(?:was|were)\s+(?:about\s+|around\s+|approximately\s+)?(?:[+-]\s*)?(?:(?:[A-Z]{1,3}\$|[\$₹€£¥]|Rs\.?|[A-Z]{3})\s*)?\d/i
const conditionalWording = /\b(?:if|unless|assuming|assumptions?|provided that|so long as|hypothetical|scenarios?|(?:was|were) to)\b/i

function hasForecastWording(text: string): boolean {
	const wording = text.replace(/\bMay(?=\s+(?:\d|of\b))|\b(?:in|last|this|during|through)\s+May\b/gi, "")
	return /\b(?:guidance|forecasts?|projects?|projected|projection|expects?|expected|anticipat\w*|estimat\w*|outlook|targets?|predict\w*|will|would|could|may|might|on track|aims?|plans?|sees|set to)\b/i.test(wording)
}

export class CheckerState extends RuntimeState {
	/** Set when the reference is ready (immediately for SEC data; after the Reader for a report). */
	registry!: EvidenceRegistry
	/** What the run checks against, known from the start (company, source, fetch date). */
	referenceInfo!: ReferenceInfo
	report?: ReportState
	article?: { title: string; text: string; ticker: string }
	readonly claims = new Map<string, Claim>()
	readonly bindings = new Map<string, EvidenceBinding>()
	readonly calcs = new Map<string, Calculation>()
	readonly audits = new Map<string, { claimRevision: number; evidenceRevision: number; state: AuditState }>()
	readonly warnings = new Map<string, ContextWarning[]>()
	/** claimId -> claim revision the context review finished for */
	readonly contextDone = new Map<string, number>()
	/** claimId -> why the context review for that revision did not complete (provider error, cache miss) */
	readonly contextFailures = new Map<string, { claimRevision: number; reason: string }>()
	/** claimId -> evidence-correction attempts for the current claim revision */
	readonly evidenceAttempts = new Map<string, number>()
	readonly history: HistoryEntry[] = []
	readonly staleRejections: HistoryEntry[] = []
	/** Every correction request (rule gate or LLM review), in order. */
	readonly corrections: { claimId: string; at: number; by: string; target: "claim" | "evidence"; reason: string; claimRevision: number; evidenceRevision: number }[] = []
	extraction: "running" | "done" | "failed" = "running"
	extractionError?: string
	private nextClaim = 1
	private evidenceCounter = new Map<string, number>()
	private readonly t0 = Date.now()

	log(kind: string, detail: string, claimId?: string) {
		this.history.push({ at: Date.now() - this.t0, claimId, kind, detail })
	}

	private stale<T>(kind: string, claimId: string, reason: string): WriteResult<T> {
		const e = { at: Date.now() - this.t0, claimId, kind: `stale:${kind}`, detail: reason }
		this.staleRejections.push(e)
		this.history.push(e)
		return { ok: false, stale: true, reason }
	}

	private checkClaimRev<T>(kind: string, claimId: string, rev: number): WriteResult<T> | undefined {
		const claim = this.claims.get(claimId)
		if (!claim) return { ok: false, stale: false, reason: `unknown claim ${claimId}` }
		if (rev !== claim.revision) return this.stale(kind, claimId, `${kind} for ${claimId}@r${rev} rejected: claim is now at r${claim.revision}`)
		return undefined
	}

	addClaim(interpretation: ClaimInterpretation): Claim {
		const claim: Claim = { id: `c${this.nextClaim++}`, revision: 1, interpretation, reason: "extracted", correctionsUsed: 0 }
		this.claims.set(claim.id, claim)
		this.log("claim.extracted", `r1 ${interpretation.quote}`, claim.id)
		return claim
	}

	/** New claim revision: invalidates only this claim's evidence, calculation, audit and context. */
	reviseClaim(claimId: string, fromRevision: number, interpretation: ClaimInterpretation, reason: string): WriteResult<Claim> {
		const bad = this.checkClaimRev<Claim>("claim revision", claimId, fromRevision)
		if (bad) return bad
		const old = this.claims.get(claimId)!
		const claim: Claim = { ...old, revision: old.revision + 1, interpretation, reason }
		this.claims.set(claimId, claim)
		this.bindings.delete(claimId)
		this.calcs.delete(claimId)
		this.audits.delete(claimId)
		this.warnings.delete(claimId)
		this.contextDone.delete(claimId)
		this.contextFailures.delete(claimId)
		this.evidenceAttempts.delete(claimId)
		this.challengeRestore.delete(claimId)
		this.log("claim.revised", `r${old.revision} → r${claim.revision}: ${reason} (evidence, calculation, audit and context for r${old.revision} invalidated)`, claimId)
		return { ok: true, value: claim }
	}

	/** New evidence revision: invalidates this claim's calculation, audit and rule warnings. */
	bindEvidence(b: Omit<EvidenceBinding, "evidenceRevision">): WriteResult<EvidenceBinding> {
		const bad = this.checkClaimRev<EvidenceBinding>("evidence", b.claimId, b.claimRevision)
		if (bad) return bad
		for (const id of [b.currentFactId, b.baseFactId, b.alternateBaseFactId]) {
			if (id && !this.registry.get(id)) return { ok: false, stale: false, reason: `unknown evidence id "${id}" — use ids exactly as returned by search_facts` }
		}
		const evidenceRevision = (this.evidenceCounter.get(b.claimId) ?? 0) + 1
		this.evidenceCounter.set(b.claimId, evidenceRevision)
		const binding: EvidenceBinding = { ...b, evidenceRevision }
		const replaced = this.bindings.get(b.claimId)
		this.bindings.set(b.claimId, binding)
		this.calcs.delete(b.claimId)
		this.audits.set(b.claimId, { claimRevision: b.claimRevision, evidenceRevision, state: { status: "pending" } })
		this.warnings.set(
			b.claimId,
			(this.warnings.get(b.claimId) ?? []).filter((w) => w.source !== "rule"),
		)
		const what = b.noReference ? b.noReference.status : [b.currentFactId, b.baseFactId].filter(Boolean).join(" vs ")
		this.log("evidence.bound", `r${b.claimRevision}.e${evidenceRevision} ${what}${replaced ? ` (replaces e${replaced.evidenceRevision})` : ""}`, b.claimId)
		return { ok: true, value: binding }
	}

	private checkEvidenceRev<T>(kind: string, claimId: string, claimRevision: number, evidenceRevision: number): WriteResult<T> | undefined {
		const bad = this.checkClaimRev<T>(kind, claimId, claimRevision)
		if (bad) return bad
		const cur = this.bindings.get(claimId)
		if (!cur || cur.evidenceRevision !== evidenceRevision) {
			return this.stale(kind, claimId, `${kind} for ${claimId}@r${claimRevision}.e${evidenceRevision} rejected: evidence is now at e${cur?.evidenceRevision ?? "–"}`)
		}
		return undefined
	}

	acceptCalculation(calc: Calculation, rules: ContextWarning[]): WriteResult<Calculation> {
		const bad = this.checkEvidenceRev<Calculation>("calculation", calc.claimId, calc.claimRevision, calc.evidenceRevision)
		if (bad) return bad
		this.calcs.set(calc.claimId, calc)
		this.warnings.set(calc.claimId, [...(this.warnings.get(calc.claimId) ?? []).filter((w) => w.source !== "rule"), ...rules])
		this.log("calculation", `r${calc.claimRevision}.e${calc.evidenceRevision} ${calc.verdict}${calc.actualDisplay ? ` (actual ${calc.actualDisplay} vs stated ${calc.statedDisplay})` : ""}`, calc.claimId)
		return { ok: true, value: calc }
	}

	setAudit(claimId: string, claimRevision: number, evidenceRevision: number, state: AuditState): WriteResult<AuditState> {
		const bad = this.checkEvidenceRev<AuditState>("audit", claimId, claimRevision, evidenceRevision)
		if (bad) return bad
		const current = this.audits.get(claimId)
		if (state.status !== "pending" && current && ["approved", "unresolved", "failed"].includes(current.state.status)) {
			return { ok: false, stale: false, reason: `audit for ${claimId}@r${claimRevision}.e${evidenceRevision} already final (${current.state.status})` }
		}
		if (state.status === "approved" && !this.calcs.has(claimId)) return { ok: false, stale: false, reason: "nothing to approve: no calculation for the current revision" }
		this.audits.set(claimId, { claimRevision, evidenceRevision, state })
		if (state.status === "investigating") this.corrections.push({ claimId, at: Date.now() - this.t0, by: state.by, target: state.target, reason: state.reason, claimRevision, evidenceRevision })
		const d =state.status === "approved" ? state.note : state.status === "investigating" ? `${state.target}: ${state.reason}` : "reason" in state ? state.reason : ""
		this.log(`audit.${state.status}`, `r${claimRevision}.e${evidenceRevision} ${d}`, claimId)
		return { ok: true, value: state }
	}

	/** Audits reopened by a reviewer's challenge, kept so a declined challenge restores the prior outcome. */
	readonly challengeRestore = new Map<string, { claimRevision: number; evidenceRevision: number; state: AuditState }>()

	/**
	 * A human reviewer challenges the interpretation of a settled claim. The audit is reopened (blocking
	 * the claim until the extractor answers); nothing else changes. Numbers are never set here.
	 */
	reopenForChallenge(claimId: string, reason: string, by: string): WriteResult<AuditState> {
		const claim = this.claims.get(claimId)
		const a = this.audits.get(claimId)
		if (!claim || !a || a.claimRevision !== claim.revision) return { ok: false, stale: false, reason: `claim ${claimId} has no current audit to reopen` }
		if (!this.isSettled(claimId)) return { ok: false, stale: false, reason: `claim ${claimId} is still being checked` }
		this.challengeRestore.set(claimId, { ...a })
		const state: AuditState = { status: "investigating", target: "claim", reason, by }
		this.audits.set(claimId, { ...a, state })
		this.corrections.push({ claimId, at: Date.now() - this.t0, by, target: "claim", reason, claimRevision: a.claimRevision, evidenceRevision: a.evidenceRevision })
		this.log("review.challenged", `r${a.claimRevision}.e${a.evidenceRevision} ${by}: ${reason}`, claimId)
		return { ok: true, value: state }
	}

	/** The extractor kept its interpretation: restore the audit outcome the challenge reopened. */
	declineChallenge(claimId: string, why: string): boolean {
		const prev = this.challengeRestore.get(claimId)
		const claim = this.claims.get(claimId)
		if (!prev || !claim || prev.claimRevision !== claim.revision) return false
		this.challengeRestore.delete(claimId)
		this.audits.set(claimId, prev)
		this.log("challenge.declined", `r${prev.claimRevision}: ${why}; previous audit outcome (${prev.state.status}) restored`, claimId)
		return true
	}

	/** Count a correction request against the claim's budget (shared across revisions). */
	useCorrection(claimId: string): number {
		const c = this.claims.get(claimId)!
		this.claims.set(claimId, { ...c, correctionsUsed: c.correctionsUsed + 1 })
		return c.correctionsUsed + 1
	}

	/** Finalise a claim that never got evidence (agent failure). Checked against the claim revision only. */
	failClaim(claimId: string, claimRevision: number, reason: string): WriteResult<AuditState> {
		const bad = this.checkClaimRev<AuditState>("failure", claimId, claimRevision)
		if (bad) return bad
		if (this.auditFinal(claimId)) return { ok: false, stale: false, reason: "already final" }
		const ev = this.bindings.get(claimId)?.evidenceRevision ?? 0
		const state: AuditState = { status: "failed", reason }
		this.audits.set(claimId, { claimRevision, evidenceRevision: ev, state })
		this.log("audit.failed", `r${claimRevision} ${reason}`, claimId)
		return { ok: true, value: state }
	}

	addWarning(w: ContextWarning, archived = false): WriteResult<ContextWarning> {
		const bad = this.checkClaimRev<ContextWarning>("context warning", w.claimId, w.claimRevision)
		if (bad) return bad
		const interpretation = this.claims.get(w.claimId)!.interpretation
		if (w.source === "context-agent" && w.code === "FORWARD_LOOKING") {
			const filed = this.registry?.filedPeriod(interpretation.fiscalYear, interpretation.fiscalPeriod)
			// A previously issued forecast can still be quoted after filing. Check the actual words.
			if (filed && !hasForecastWording(interpretation.quote)) {
				const reason = `Forecast warning conflicts with the reference. The period ended ${filed.end} and was reported in ${filed.form} on ${filed.filed}. Check the article wording.`
				if (!archived && !conditionalWording.test(interpretation.quote)) {
					const quote = normalizeWording(interpretation.quote)
					const sentences = [...sentenceSegmenter.segment(this.article?.text ?? "")].filter(({ segment }) => normalizeWording(segment).includes(quote))
					// Copular EPS wording needs a containing sentence to distinguish results from a conditional excerpt.
					const epsLevel = interpretation.kind === "level" && (interpretation.metric === "eps_basic" || interpretation.metric === "eps_diluted")
					const historical = historicalWording.test(interpretation.quote) || (epsLevel && sentences.length > 0 && historicalEpsLevel.test(interpretation.quote))
					if (historical && sentences.every(({ segment }) => !hasForecastWording(segment) && !conditionalWording.test(segment))) {
						const detail = reason + " The quoted wording explicitly reports historical results."
						this.log("context.dismissed", detail + " Proposed warning: " + w.message, w.claimId)
						return { ok: false, stale: false, reason: detail, dismissed: true }
					}
				}
				this.contextFailures.set(w.claimId, { claimRevision: w.claimRevision, reason })
				this.log("context.disputed", reason + " Proposed warning: " + w.message, w.claimId)
				return { ok: false, stale: false, reason, retainedForReview: true }
			}
		}
		this.warnings.set(w.claimId, [...(this.warnings.get(w.claimId) ?? []), w])
		this.log("context.warning", `r${w.claimRevision} [${w.code}] ${w.message}`, w.claimId)
		return { ok: true, value: w }
	}

	finishContext(claimId: string, claimRevision: number, note?: string): WriteResult<number> {
		const bad = this.checkClaimRev<number>("context review", claimId, claimRevision)
		if (bad) return bad
		this.contextDone.set(claimId, claimRevision)
		if (note) {
			this.contextFailures.set(claimId, { claimRevision, reason: note })
			this.log("context.unavailable", `r${claimRevision} ${note}`, claimId)
		}
		return { ok: true, value: claimRevision }
	}

	auditFinal(claimId: string): boolean {
		const a = this.audits.get(claimId)
		const claim = this.claims.get(claimId)
		return !!a && !!claim && a.claimRevision === claim.revision && ["approved", "unresolved", "failed"].includes(a.state.status)
	}

	isSettled(claimId: string): boolean {
		const claim = this.claims.get(claimId)
		return !!claim && this.auditFinal(claimId) && this.contextDone.get(claimId) === claim.revision
	}

	allSettled(): boolean {
		if (this.extraction === "failed") return true
		return this.extraction === "done" && [...this.claims.keys()].every((id) => this.isSettled(id))
	}
}
