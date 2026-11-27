import {
	DeveloperMessageItem,
	ModelContext,
	SemanticEvent,
	SituationSpecification,
	type Agent,
	type SituationContext,
	type SituationHandler,
	type defineRuntime,
} from "@mozaik-ai/core"
import type { CheckerState } from "../domain/store.js"
import type { AgentRole, TaskTracker } from "./tasks.js"

/** Custom semantic events the participants publish and react to. */
export const EV = {
	ARTICLE_SUBMITTED: "article.submitted",
	/** The reference (SEC statements, or an official report verified by the Reader) is ready for evidence search. */
	REFERENCE_READY: "reference.ready",
	REFERENCE_FAILED: "reference.failed",
	REPORT_PROGRESS: "report.progress",
	CLAIM_REVISED: "claim.revised",
	EXTRACTION_DONE: "extraction.done",
	EVIDENCE_BOUND: "evidence.bound",
	CALCULATION_COMPLETED: "calculation.completed",
	CORRECTION_REQUESTED: "audit.correction_requested",
	AUDIT_FINAL: "audit.final",
	CONTEXT_WARNING: "context.warning",
	CONTEXT_DONE: "context.done",
	STALE_REJECTED: "result.stale_rejected",
	TASK_FAILED: "task.failed",
} as const

export type ClaimRef = { claimId: string; claimRevision: number }
export type EvidenceRef = ClaimRef & { evidenceRevision: number }
export type CorrectionPayload = EvidenceRef & { target: "claim" | "evidence"; reason: string; by: string }

export type Runtime = ReturnType<typeof defineRuntime<CheckerState>>

export type Ctx = {
	rt: Runtime
	state: CheckerState
	tasks: TaskTracker
	model: string
	archivedPrompts: boolean
	finishLoop: () => void
	/** id of the participant that publishes system events (the desk); set once the desk joins */
	deskId: string
	emit: (type: string, producerId: string, payload: object) => void
	/** Run one agent task in its own Mozaik loop with a fresh context (instruction + task message). */
	startTask: (agent: Agent, t: { role: AgentRole; key: string; message: string; claimId?: string; claimRevision?: number; evidenceRevision?: number }) => void
	/** Defer deterministic work so event fan-out never blocks or re-enters a producer. */
	later: (fn: () => void) => void
}

export function makeCtx(rt: Runtime, state: CheckerState, tasks: TaskTracker, model: string, archivedPrompts = false, serial = false): Ctx {
	const queued: (() => void)[] = []
	let active = false
	const ctx: Ctx = {
		rt,
		state,
		tasks,
		model,
		archivedPrompts,
		finishLoop: () => {
			if (!serial) return
			const next = queued.shift()
			if (next) next()
			else active = false
		},
		deskId: "",
		emit: (type, producerId, payload) => rt.sendEvent(SemanticEvent.create(type, producerId, payload), producerId),
		startTask: (agent, t) => {
			const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
			tasks.register({ key: t.key, role: t.role, claimId: t.claimId, claimRevision: t.claimRevision, evidenceRevision: t.evidenceRevision, contextId: context.id })
			// maxOutputTokens is required: Mozaik 6.0.0's Anthropic mapper sends max_tokens with no default.
			const launch = () => rt.runLoop(agent.getId(), t.message, { model: ctx.model, context, tools: agent.getTools(), maxOutputTokens: 4096 })
			if (!serial) launch()
			else if (active) queued.push(launch)
			else {
				active = true
				launch()
			}
		},
		later: (fn) =>
			setImmediate(() => {
				try {
					fn()
				} catch (err) {
					state.log("internal.error", err instanceof Error ? (err.stack ?? err.message) : String(err))
				}
			}),
	}
	return ctx
}

export class On extends SituationSpecification {
	constructor(private readonly types: string[]) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return this.types.includes(event.type)
	}
}

export class AnyEvent extends SituationSpecification {
	isSatisfiedBy(): boolean {
		return true
	}
}

export const handler =(types: string | string[], apply: (payload: any, event: SemanticEvent) => void): SituationHandler => ({
	specification: new On(Array.isArray(types) ? types : [types]),
	processor: { apply: ({ event }) => apply(event.payload, event) },
})

/** Tool result helper: tools always return text to the model. */
export const reply = (obj: unknown) => (typeof obj === "string" ? obj : JSON.stringify(obj))

/** Minimal argument validation (providers differ in strict-schema support, so tools validate themselves). */
export function need<T extends string>(args: any, field: string, allowed?: readonly T[]): T {
	const v = args?.[field]
	if (v === undefined || v === null || v === "") throw new Error(`missing "${field}"`)
	if (allowed && !allowed.includes(v)) throw new Error(`"${field}" must be one of ${allowed.join(", ")}`)
	return v as T
}

export function paragraphOf(text: string, quote: string): string {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim()
	return text.split(/\n\s*\n/).map(norm).find((p) => p.includes(norm(quote))) ?? norm(quote)
}
