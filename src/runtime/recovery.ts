import type { CheckerState } from "../domain/store.js"
import type { ClaimRef, CorrectionPayload } from "./context.js"
import type { AgentRole, Task, TaskTracker } from "./tasks.js"

export type RecoveryWork = { extraction: boolean; reader: boolean; claimIds: string[] }

type ClaimRecovery = ClaimRef & {
	context: boolean
	numeric?: "evidence" | "calculate" | "audit"
	correction?: CorrectionPayload
}

export type RecoveryPlan = Omit<RecoveryWork, "claimIds"> & { claims: ClaimRecovery[] }

export const noRecovery = (): RecoveryPlan => ({ extraction: false, reader: false, claims: [] })

export function summarizeRecovery(plan: RecoveryPlan): RecoveryWork {
	return { extraction: plan.extraction, reader: plan.reader, claimIds: plan.claims.map((claim) => claim.claimId) }
}

function canRetry(task?: Task): boolean {
	const failure = task?.failure
	return !failure || failure.kind === "PROVIDER_ERROR" || (failure.kind === "LIMIT_REACHED" && failure.message.includes("reached the turn cap"))
}

export function planRecovery(state: CheckerState, tasks: TaskTracker): RecoveryPlan {
	const plan = noRecovery()
	const current = new Map<string, Task>()
	for (const task of tasks.all()) {
		if (task.claimId && state.claims.get(task.claimId)?.revision !== task.claimRevision) continue
		current.set(`${task.role}:${task.claimId ?? ""}`, task)
	}
	const corrections = new Map<string, CheckerState["corrections"][number]>()
	for (const correction of state.corrections) {
		corrections.set(`${correction.claimId}:${correction.claimRevision}:${correction.evidenceRevision}`, correction)
	}
	const latest = (role: AgentRole, claimId = "") => current.get(`${role}:${claimId}`)
	if (state.report?.status === "failed") {
		const reader = latest("reader")
		// Reader failures after verifying enough facts have a usable registry. Keep those results stable.
		plan.reader = !!reader?.failure && canRetry(reader)
		return plan
	}
	if (!state.registry) return plan
	const extractor = latest("extractor")
	plan.extraction = (state.extraction === "running" || (state.extraction === "failed" && !!extractor?.failure)) && canRetry(extractor)
	for (const claim of state.claims.values()) {
		const claimId = claim.id
		const claimRevision = claim.revision
		const contextTask = latest("context", claimId)
		const context = (state.contextDone.get(claimId) !== claimRevision || !!contextTask?.failure) && canRetry(contextTask)
		const retry: ClaimRecovery = { claimId, claimRevision, context }
		const audit = state.audits.get(claimId)
		const binding = state.bindings.get(claimId)
		const calc = state.calcs.get(claimId)
		const evidenceTask = latest("evidence", claimId)
		const evidenceRevision = binding?.evidenceRevision ?? 0
		const previousCorrection = corrections.get(`${claimId}:${claimRevision}:${evidenceRevision}`)
		const correction = previousCorrection && previousCorrection.by !== "reviewer (human)" ? previousCorrection : undefined
		const fix = latest("extractor-fix", claimId)

		if (!audit || audit.state.status === "pending" || audit.state.status === "failed") {
			if (!binding || (audit?.state.status === "failed" && evidenceTask?.evidenceRevision === evidenceRevision)) {
				if (canRetry(evidenceTask)) {
					if (correction?.target === "evidence") retry.correction = correction
					else retry.numeric = "evidence"
				}
			} else if (!calc) retry.numeric = "calculate"
			else {
				const auditor = latest("auditor", claimId)
				if (auditor?.evidenceRevision !== evidenceRevision || canRetry(auditor)) retry.numeric = "audit"
			}
		}
		// A correction-request tool result survives a provider interruption. Repeat only that unfinished work.
		if (audit?.state.status === "unresolved" && correction?.target === "claim" && fix?.failure && canRetry(fix)) retry.correction = correction
		if (retry.context || retry.numeric || retry.correction) plan.claims.push(retry)
	}
	return plan
}
