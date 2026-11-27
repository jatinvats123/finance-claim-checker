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
import { createReader } from "../agents/reader.js"
import type { ReportIssuer } from "../docs/issuer.js"
import type { ReportDoc } from "../docs/pdf.js"
import { documentBasis, documentCurrency, documentFiscalYearEnd } from "../docs/verify.js"
import { CheckerState } from "../domain/store.js"
import type { ClaimInterpretation } from "../domain/types.js"
import type { InferenceRunner, SemanticEvent } from "@mozaik-ai/core"
import { EvidenceRegistry, type ReferenceInfo } from "../sec/evidence.js"
import type { SecSnapshot } from "../sec/types.js"
import { AnyEvent, EV, handler, makeCtx } from "./context.js"
import { CheckerRunner } from "../llm/runner.js"
import { TaskTracker, type Task } from "./tasks.js"
import { noRecovery, planRecovery, summarizeRecovery, type RecoveryWork } from "./recovery.js"

export type { RecoveryWork } from "./recovery.js"

/** A supplied report (PDF) with printed issuer evidence for its usable statement pages. */
export type PreparedReport = { doc: ReportDoc; company: { name: string; ticker?: string }; issuer: ReportIssuer }

export function reportInfo(r: PreparedReport): ReferenceInfo {
	const where = r.doc.url ?? (r.doc.fileName ? `uploaded file "${r.doc.fileName}"` : "uploaded PDF")
	return {
		kind: "report",
		entityName: r.company.name,
		ticker: r.company.ticker,
		fetchedAt: r.doc.fetchedAt,
		label: `Supplied report PDF: ${where}`,
		sources: [{ label: r.doc.url ? "Report PDF" : `Uploaded PDF (sha256 ${r.doc.sha256.slice(0, 12)}…)${r.doc.statedSourceUrl ? `, stated source ${r.doc.statedSourceUrl} (not fetched)` : ""}`, url: r.doc.url ?? r.doc.statedSourceUrl ?? "" }],
		note: `Issuer name matched "${r.issuer.printedName}" on page ${r.issuer.page}. Source authenticity remains unverified. ${r.doc.pageCount} pages, ${(r.doc.bytes / 1e6).toFixed(2)} MB, sha256 ${r.doc.sha256}`,
	}
}

export type RunOptions = {
	article: { title: string; text: string; ticker: string }
	/** Reference: SEC data for the company, or an official report. Exactly one. */
	snapshot?: SecSnapshot
	report?: PreparedReport
	runner: InferenceRunner
	tasks: TaskTracker
	model: string
	serial?: boolean
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
	reviewMention: (interpretation: ClaimInterpretation, timeoutMs?: number) => Promise<{ timedOut: boolean }>
	/** Any old agent work must drain before recovery can start. */
	readonly recoveryPending: boolean
	recoveryWork: () => RecoveryWork
	recover: (options?: { timeoutMs?: number; model?: string }) => Promise<{ timedOut: boolean; work: RecoveryWork }>
}

export async function runChecker(opts: RunOptions): Promise<RunResult> {
	const t0 = Date.now()
	const rt = defineRuntime<CheckerState>()
	const state = new CheckerState()
	if (opts.snapshot) {
		state.registry = new EvidenceRegistry(opts.snapshot)
		state.referenceInfo = state.registry.info
	} else if (opts.report) {
		const doc = opts.report.doc
		state.referenceInfo = reportInfo(opts.report)
		state.report = { doc, info: state.referenceInfo, pages: opts.report.issuer.pages, basis: documentBasis(doc), docCurrency: documentCurrency(doc), accepted: [], rejected: [], status: "reading" }
	} else throw new Error("runChecker needs a reference: snapshot (SEC) or report")
	state.article = opts.article
	rt.initializeRuntime({ state, inferenceRunnerConfig: { runner: opts.runner } })
	const archived = opts.runner instanceof CheckerRunner && opts.runner.usesArchivedPrompts(opts.article)
	const ctx = makeCtx(rt, state, opts.tasks, opts.model, archived, opts.serial)
	const names = new Map<string, string>()

	// The initial check and later reviewer operations reuse this completion barrier.
	const hasWork = () => ctx.hasDeferredWork() || opts.tasks.open().length > 0
	let editing = false
	let attempt = 0
	let preRecovery: { model: string; archivedPrompts: boolean } | undefined
	let waiters: ((timedOut: boolean) => void)[] = []
	const checkDone = () => {
		if (hasWork()) return
		if (preRecovery) {
			ctx.model = preRecovery.model
			ctx.archivedPrompts = preRecovery.archivedPrompts
			ctx.recoveryAttempt = undefined
			preRecovery = undefined
		}
		if (waiters.length && state.allSettled()) {
			const ws = waiters
			waiters = []
			for (const w of ws) w(false)
		}
	}
	ctx.onDeferredWorkDone = checkDone
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
			case "reader": {
				const r = state.report!
				// facts are verified by code as they are recorded, so they stand even if the Reader's last turn failed (e.g. a provider quota error)
				if (fail && r.accepted.length) state.log("reader.stopped", `the Reader stopped early (${fail}); using the ${r.accepted.length} facts already verified on their pages`)
				if (r.accepted.length) {
					// fiscal years from the report's annual columns, else from "year ended <date>" stated in the report
					state.registry = new EvidenceRegistry({ kind: "report", info: r.info, facts: r.accepted, fiscalYearEnd: documentFiscalYearEnd(r.doc) })
					const labelled = state.registry.all().filter((f) => !f.derivation).length
					if (labelled) {
						r.status = "ready"
						state.log("reference.ready", `${labelled} facts verified on pages ${[...new Set(r.accepted.map((f) => f.location?.page))].join(", ")} (${r.rejected.length} proposals rejected)`)
						ctx.emit(EV.REFERENCE_READY, ctx.deskId, { facts: labelled })
						break
					}
				}
				r.status = "failed"
				r.error = fail ?? (r.accepted.length ? "verified facts could not be placed in a fiscal year (the report has no annual column and states no \"year ended\" date)" : `no figure could be verified on the report's statement pages (${r.rejected.length} proposals rejected)`)
				state.extraction = "failed"
				state.extractionError = fail ?? `REFERENCE_UNAVAILABLE: ${r.error}`
				state.log("reference.failed", r.error)
				ctx.emit(EV.REFERENCE_FAILED, ctx.deskId, { reason: r.error })
				break
			}
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
				if (task && !task.done) ctx.later(() => {
					if (task.done) return
					finishTask(task)
					ctx.finishLoop()
				})
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

	const participants = [supervisor, desk, createReader(ctx), createExtractor(ctx), createEvidenceAgent(ctx), createContextAgent(ctx), createCalculator(ctx), createAuditor(ctx)]
	for (const p of participants) {
		names.set(p.getId(), p.getManifest().name)
		rt.join(p)
	}

	const done = waitSettled(opts.timeoutMs ?? 10 * 60_000)
	if (state.report && !state.report.pages.length) {
		// nothing that looks like a financial statement: say so instead of asking a model to guess
		state.report.status = "failed"
		state.report.error = `no financial-statement page (revenue, profit and EPS rows with a unit note and column dates) was found in the ${state.report.doc.pageCount}-page report`
		state.extraction = "failed"
		state.extractionError = `REFERENCE_UNAVAILABLE: ${state.report.error}`
		state.log("reference.failed", state.report.error)
		ctx.emit(EV.REFERENCE_FAILED, desk.getId(), { reason: state.report.error })
	} else {
		ctx.emit(EV.ARTICLE_SUBMITTED, desk.getId(), { title: opts.article.title, ticker: opts.article.ticker })
		if (!state.report) ctx.emit(EV.REFERENCE_READY, desk.getId(), { facts: state.registry.all().length })
	}
	const timedOut = await done
	const busy = () => editing || hasWork()
	const recoveryWork = () => summarizeRecovery(busy() ? noRecovery() : planRecovery(state, opts.tasks))

	async function recover({ timeoutMs = 5 * 60_000, model }: { timeoutMs?: number; model?: string } = {}): Promise<{ timedOut: boolean; work: RecoveryWork }> {
		if (busy()) throw new Error("the run still has active work; retry once those tasks finish")
		const plan = planRecovery(state, opts.tasks)
		const work = summarizeRecovery(plan)
		if (!work.reader && !work.extraction && !work.claimIds.length) throw new Error("the run has no recoverable checks")
		editing = true
		const started = Date.now()
		preRecovery = { model: ctx.model, archivedPrompts: ctx.archivedPrompts }
		ctx.model = model ?? ctx.model
		ctx.archivedPrompts = false
		ctx.recoveryAttempt = ++attempt
		const retry = waitSettled(timeoutMs)
		try {
			state.log("recovery.started", `attempt ${attempt}: ${JSON.stringify(work)}`)
			if (plan.reader) {
				state.report!.status = "reading"
				state.report!.error = undefined
				state.extraction = "running"
				state.extractionError = undefined
				ctx.emit(EV.ARTICLE_SUBMITTED, desk.getId(), { title: opts.article.title, ticker: opts.article.ticker })
			} else if (plan.extraction) {
				state.extraction = "running"
				state.extractionError = undefined
				ctx.emit(EV.EXTRACTION_RETRY, desk.getId(), { knownClaims: state.claims.size })
			}
			for (const item of plan.claims) {
				const { claimId, claimRevision } = item
				const ref = { claimId, claimRevision }
				if (item.context) {
					state.reopenContextForRecovery(claimId)
					ctx.emit(EV.CONTEXT_RETRY, desk.getId(), ref)
				}
				if (item.correction) {
					const { target, reason, by } = item.correction
					state.reopenForRecovery(claimId, { status: "investigating", target, reason, by })
					ctx.emit(EV.CORRECTION_REQUESTED, desk.getId(), item.correction)
				} else if (item.numeric) {
					state.reopenForRecovery(claimId, { status: "pending" })
					const refWithEvidence = { ...ref, evidenceRevision: state.bindings.get(claimId)?.evidenceRevision ?? 0 }
					if (item.numeric === "evidence") ctx.emit(EV.EVIDENCE_RETRY, desk.getId(), ref)
					if (item.numeric === "calculate") ctx.emit(EV.EVIDENCE_BOUND, desk.getId(), refWithEvidence)
					if (item.numeric === "audit") ctx.emit(EV.CALCULATION_COMPLETED, desk.getId(), refWithEvidence)
				}
			}
			result.timedOut = await retry
			result.elapsedMs += Date.now() - started
			state.log("recovery.finished", `attempt ${attempt}${result.timedOut ? " reached the run timeout" : " finished"}`)
			return { timedOut: result.timedOut, work }
		} finally {
			editing = false
		}
	}

	/** Reviewer challenge: reopen one settled claim, let the extractor answer, re-run only that claim's work. */
	async function challenge(claimId: string, reason: string, timeoutMs = 5 * 60_000, model?: string): Promise<{ timedOut: boolean }> {
		if (busy()) throw new Error("the run still has active work; retry once those tasks finish")
		const claim = state.claims.get(claimId)
		if (!claim) throw new Error(`unknown claim ${claimId}`)
		const reopened = state.reopenForChallenge(claimId, reason, "reviewer (human)")
		if (!reopened.ok) throw new Error(reopened.reason)
		editing = true
		try {
			if (model) {
				ctx.model = model
				ctx.archivedPrompts = false
			}
			const a = state.audits.get(claimId)!
			const wait = waitSettled(timeoutMs)
			ctx.emit(EV.CORRECTION_REQUESTED, desk.getId(), { claimId, claimRevision: claim.revision, evidenceRevision: a.evidenceRevision, target: "claim", reason, by: "reviewer (human)" })
			return { timedOut: await wait }
		} finally {
			editing = false
		}
	}

	// An editor supplies the anchor. Evidence, context, calculation and audit use their usual event handlers.
	async function reviewMention(interpretation: ClaimInterpretation, timeoutMs = 5 * 60_000) {
		if (busy() || state.extraction !== "done") throw new Error("Wait for this run to finish before selecting a number.")
		editing = true
		try {
			const claim = state.addClaim(interpretation, "editor")
			const wait = waitSettled(timeoutMs)
			ctx.emit(EV.CLAIM_REVISED, desk.getId(), { claimId: claim.id, claimRevision: claim.revision })
			result.timedOut = await wait
			return { timedOut: result.timedOut }
		} finally {
			editing = false
		}
	}

	const result: RunResult = { state, tasks: opts.tasks, timedOut, names, elapsedMs: Date.now() - t0, get recoveryPending() { return busy() }, recoveryWork, recover, challenge, reviewMention }
	return result
}
