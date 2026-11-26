/**
 * Shared, versioned state for all participants (a Mozaik RuntimeState).
 *
 * Every derived result (evidence binding, calculation, audit, context warning) is stamped with the
 * claim revision — and where relevant the evidence revision — it was computed from. Writes stamped
 * with an outdated revision are rejected and logged, so a slow agent can never overwrite newer work.
 * Revising one claim never touches another claim's results.
 */
import { RuntimeState } from "@mozaik-ai/core"
import type { EvidenceRegistry } from "../sec/evidence.js"
import type { AuditState, Calculation, Claim, ClaimInterpretation, ContextWarning, EvidenceBinding } from "./types.js"

export type Accepted<T> = { ok: true; value: T }
export type Rejected = { ok: false; stale: boolean; reason: string }
export type WriteResult<T> = Accepted<T> | Rejected

export type HistoryEntry = { at: number; claimId?: string; kind: string; detail: string }

export const MAX_CORRECTIONS = 2

export class CheckerState extends RuntimeState {
	registry!: EvidenceRegistry
	article?: { title: string; text: string; ticker: string }
	readonly claims = new Map<string, Claim>()
	readonly bindings = new Map<string, EvidenceBinding>()
	readonly calcs = new Map<string, Calculation>()
	readonly audits = new Map<string, { claimRevision: number; evidenceRevision: number; state: AuditState }>()
	readonly warnings = new Map<string, ContextWarning[]>()
	/** claimId -> claim revision the context review finished for */
	readonly contextDone = new Map<string, number>()
	/** claimId -> evidence-correction attempts for the current claim revision */
	readonly evidenceAttempts = new Map<string, number>()
	readonly history: HistoryEntry[] = []
	readonly staleRejections: HistoryEntry[] = []
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
		this.evidenceAttempts.delete(claimId)
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
		const d = state.status === "approved" ? state.note : state.status === "investigating" ? `${state.target}: ${state.reason}` : "reason" in state ? state.reason : ""
		this.log(`audit.${state.status}`, `r${claimRevision}.e${evidenceRevision} ${d}`, claimId)
		return { ok: true, value: state }
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

	addWarning(w: ContextWarning): WriteResult<ContextWarning> {
		const bad = this.checkClaimRev<ContextWarning>("context warning", w.claimId, w.claimRevision)
		if (bad) return bad
		this.warnings.set(w.claimId, [...(this.warnings.get(w.claimId) ?? []), w])
		this.log("context.warning", `r${w.claimRevision} [${w.code}] ${w.message}`, w.claimId)
		return { ok: true, value: w }
	}

	finishContext(claimId: string, claimRevision: number, note?: string): WriteResult<number> {
		const bad = this.checkClaimRev<number>("context review", claimId, claimRevision)
		if (bad) return bad
		this.contextDone.set(claimId, claimRevision)
		if (note) this.log("context.unavailable", `r${claimRevision} ${note}`, claimId)
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
