/**
 * Wires the participants into one Mozaik runtime and runs a check to completion.
 *
 *   Desk (human) ──article.submitted──▶ Extractor ──claim.revised──▶ Evidence ┐   (per claim, concurrently)
 *                                                      └──────────▶ Context  │
 *   Evidence ──evidence.bound──▶ Calculator ──calculation.completed──▶ Auditor ┘
 *   Auditor ──audit.correction_requested──▶ Extractor | Evidence  (only the affected claim re-runs)
 *   Supervisor (observer): maps Mozaik loops to tasks, finalises tasks, detects completion.
 */
import { createHuman, defineRuntime } from "@mozaik-ai/core"
import { createAuditor } from "../agents/auditor.js"
import { createCalculator } from "../agents/calculator.js"
import { createContextAgent } from "../agents/context-agent.js"
import { createEvidenceAgent } from "../agents/evidence-agent.js"
import { createExtractor } from "../agents/extractor.js"
import { CheckerState } from "../domain/store.js"
import type { InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { EvidenceRegistry } from "../sec/evidence.js"
import type { SecSnapshot } from "../sec/types.js"
import { AnyEvent, EV, handler, makeCtx } from "./context.js"
import { TaskTracker, type Task } from "./tasks.js"

export type RunOptions = {
	article: { title: string; text: string; ticker: string }
	snapshot: SecSnapshot
	runner: InferenceRunner
	tasks: TaskTracker
	model: string
	timeoutMs?: number
	/** Live feed of every semantic event (for the terminal view). */
	onEvent?: (event: SemanticEvent, names: Map<string, string>, state: CheckerState) => void
}

export type RunResult = {
	state: CheckerState
	tasks: TaskTracker
	timedOut: boolean
	names: Map<string, string>
	elapsedMs: number
	/** Reviewer challenge of one settled claim (re-runs only that claim; never sets a verdict). */
	challenge: (claimId: string, reason: string, timeoutMs?: number, model?: string) => Promise<{ timedOut: boolean }>
}

export async function runChecker(opts: RunOptions): Promise<RunResult> {
	const t0 = Date.now()
	const rt = defineRuntime<CheckerState>()
	const state = new CheckerState()
	state.registry = new EvidenceRegistry(opts.snapshot)
	state.article = opts.article
	rt.initializeRuntime({ state, inferenceRunnerConfig: { runner: opts.runner } })
	const ctx = makeCtx(rt, state, opts.tasks, opts.model)
	const names = new Map<string, string>()

	// Completion is re-entrant: the first wait covers the run; a later challenge waits again.
	let waiters: ((timedOut: boolean) => void)[] = []
	const checkDone = () => {
		if (waiters.length && state.allSettled() && opts.tasks.open().length === 0) {
			const ws = waiters
			waiters = []
			for (const w of ws) w(false)
		}
	}
	const waitSettled = (ms: number) =>
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				waiters = waiters.filter((w) => w !== wake)
				resolve(true)
			}, ms)
			const wake = (timedOut: boolean) => {
				clearTimeout(timer)
				resolve(timedOut)
			}
			waiters.push(wake)
			setImmediate(checkDone)
		})

	/** Called when a task's loop ends (normally, or via a runner failure). Fills in any missing outcome. */
	function finishTask(task: Task) {
		task.done = true
		const fail = task.failure ? `${task.failure.kind}: ${task.failure.message}` : undefined
		const { claimId, claimRevision } = task
		switch (task.role) {
			case "extractor":
				state.extraction = fail ? "failed" : "done"
				state.extractionError = fail
				if (fail) state.log("extraction.failed", fail)
				ctx.emit(EV.EXTRACTION_DONE, ctx.deskId, { failed: !!fail })
				break
			case "evidence": {
				const b = state.bindings.get(claimId!)
				const producedBinding = b && b.claimRevision === claimRevision && b.evidenceRevision > (task.evidenceRevision ?? 0)
				if (!producedBinding) {
					const res = state.failClaim(claimId!, claimRevision!, fail ?? "evidence agent finished without binding evidence")
					if (res.ok) ctx.emit(EV.TASK_FAILED, ctx.deskId, { task: task.key, claimId })
				}
				break
			}
			case "context":
				state.finishContext(claimId!, claimRevision!, fail ? `context review unavailable (${fail})` : undefined)
				ctx.emit(EV.CONTEXT_DONE, ctx.deskId, { claimId, claimRevision })
				break
			case "auditor": {
				const a = state.audits.get(claimId!)
				if (a && a.claimRevision === claimRevision && a.evidenceRevision === task.evidenceRevision && a.state.status === "pending") {
					state.setAudit(claimId!, claimRevision!, task.evidenceRevision!, { status: "failed", reason: fail ? `auditor review unavailable (${fail}); numeric result shown unaudited` : "auditor gave no decision" })
					ctx.emit(EV.TASK_FAILED, ctx.deskId, { task: task.key, claimId })
				}
				break
			}
			case "extractor-fix": {
				const c = state.claims.get(claimId!)
				const unchanged = c && c.revision === claimRevision
				if (unchanged && state.challengeRestore.has(claimId!)) {
					// a reviewer's challenge the extractor did not accept: the earlier outcome stands
					if (state.declineChallenge(claimId!, fail ? `extractor could not answer (${fail})` : "extractor kept its interpretation")) {
						const a = state.audits.get(claimId!)!
						ctx.emit(EV.AUDIT_FINAL, ctx.deskId, { claimId, claimRevision, evidenceRevision: a.evidenceRevision })
					}
				} else if (unchanged && !state.auditFinal(claimId!)) {
					const a = state.audits.get(claimId!)!
					state.setAudit(claimId!, claimRevision!, a.evidenceRevision, { status: "unresolved", reason: fail ? `extractor could not revise (${fail})` : "extractor kept its interpretation; auditor's objection stands" })
					ctx.emit(EV.AUDIT_FINAL, ctx.deskId, { claimId, claimRevision, evidenceRevision: a.evidenceRevision })
				}
				break
			}
		}
	}

	const supervisor = createHuman({
		name: "Supervisor",
		capabilities: ["observer"],
		handlers: [
			handler("message_received.started", (p) => void opts.tasks.bindLoop(p.input?.context?.id, p.loopId)),
			handler("model.answer", (p) => {
				const task = opts.tasks.forLoop(p.loopId)
				if (task && !task.done) ctx.later(() => finishTask(task))
			}),
			{
				specification: new AnyEvent(),
				processor: {
					apply: ({ event }) => {
						opts.onEvent?.(event, names, state)
						setImmediate(checkDone)
					},
				},
			},
		],
	})
	const desk = createHuman({ name: "Desk", capabilities: ["submits-articles"], handlers: [] })
	ctx.deskId = desk.getId()

	const participants = [supervisor, desk, createExtractor(ctx), createEvidenceAgent(ctx), createContextAgent(ctx), createCalculator(ctx), createAuditor(ctx)]
	for (const p of participants) {
		names.set(p.getId(), p.getManifest().name)
		rt.join(p)
	}

	const done = waitSettled(opts.timeoutMs ?? 10 * 60_000)
	ctx.emit(EV.ARTICLE_SUBMITTED, desk.getId(), { title: opts.article.title, ticker: opts.article.ticker })
	const timedOut = await done

	/** Reviewer challenge: reopen one settled claim, let the extractor answer, re-run only that claim's work. */
	async function challenge(claimId: string, reason: string, timeoutMs = 5 * 60_000, model?: string): Promise<{ timedOut: boolean }> {
		if (model) ctx.model = model // a replayed run rechecks with the live model
		const claim = state.claims.get(claimId)
		if (!claim) throw new Error(`unknown claim ${claimId}`)
		const reopened = state.reopenForChallenge(claimId, reason, "reviewer (human)")
		if (!reopened.ok) throw new Error(reopened.reason)
		const a = state.audits.get(claimId)!
		const wait = waitSettled(timeoutMs)
		ctx.emit(EV.CORRECTION_REQUESTED, desk.getId(), { claimId, claimRevision: claim.revision, evidenceRevision: a.evidenceRevision, target: "claim", reason, by: "reviewer (human)" })
		return { timedOut: await wait }
	}

	return { state, tasks: opts.tasks, timedOut, names, elapsedMs: Date.now() - t0, challenge }
}
