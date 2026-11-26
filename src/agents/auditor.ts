/**
 * Auditor. Two layers:
 *  1. Deterministic gate (code): source form, concept, period, duration, comparison base, same-filing
 *     comparatives, revisions. A failure blocks the result and sends a correction request to the
 *     agent that owns the faulty part (evidence or claim) — which triggers re-binding and recalculation.
 *  2. LLM review: does the interpretation faithfully represent the sentence? It can approve, or
 *     request a correction; it cannot change numbers.
 * Only the affected claim waits; every other claim keeps moving.
 */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { auditGate } from "../domain/checks.js"
import { MAX_CORRECTIONS } from "../domain/store.js"
import type { Calculation } from "../domain/types.js"
import { EV, handler, need, paragraphOf, reply, type Ctx, type EvidenceRef } from "../runtime/context.js"

const INSTRUCTION = `You are the auditor. Deterministic checks have already passed: the evidence comes from 10-Q/10-K statements, matches the claim's metric, fiscal period and duration, and the comparison base is the correct period from the same filing.
Your job is what code cannot check: does the claim interpretation faithfully represent the quoted sentence? Check metric, period, comparison basis (a basis the sentence does not state must be "unspecified"), GAAP vs adjusted, the stated number, its scale and qualifier.
- If the interpretation misreads the sentence, call request_correction with target "claim" and say exactly what to change.
- If the evidence is the wrong line item, call request_correction with target "evidence".
- Otherwise call approve with a one-sentence note. A MISMATCH verdict is a valid outcome to approve — you approve the check, not the article.
You cannot change any number. One tool call, then reply "done".`

export function createAuditor(ctx: Ctx): Agent {
	const { state } = ctx
	let selfId = ""

	const final = (ref: EvidenceRef) => ctx.emit(EV.AUDIT_FINAL, selfId, ref)

	/** Block the result and route a correction, within the claim's correction budget. */
	function requestCorrection(ref: EvidenceRef, target: "claim" | "evidence", reason: string, by: string): string {
		const claim = state.claims.get(ref.claimId)
		if (!claim) return `REJECTED: unknown claim ${ref.claimId}`
		if (claim.correctionsUsed >= MAX_CORRECTIONS) {
			const res = state.setAudit(ref.claimId, ref.claimRevision, ref.evidenceRevision, { status: "unresolved", reason: `${reason} — still failing after ${MAX_CORRECTIONS} corrections` })
			if (!res.ok) return `REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`
			final(ref)
			return "correction budget exhausted; claim marked UNRESOLVED"
		}
		const res = state.setAudit(ref.claimId, ref.claimRevision, ref.evidenceRevision, { status: "investigating", target, reason, by })
		if (!res.ok) {
			if (res.stale) ctx.emit(EV.STALE_REJECTED, selfId, { claimId: ref.claimId, reason: res.reason })
			return `REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`
		}
		state.useCorrection(ref.claimId)
		ctx.emit(EV.CORRECTION_REQUESTED, selfId, { ...ref, target, reason, by })
		return `correction requested from the ${target === "claim" ? "extractor" : "evidence agent"}; result blocked until then`
	}

	const refArgs = (args: any): EvidenceRef => ({ claimId: need(args, "claimId"), claimRevision: Number(need(args, "claimRevision")), evidenceRevision: Number(need(args, "evidenceRevision")) })
	const refProps = { claimId: { type: "string" }, claimRevision: { type: "integer" }, evidenceRevision: { type: "integer" } }

	const approve: Tool = {
		type: "function",
		name: "approve",
		description: "Approve the check for this claim/evidence revision.",
		parameters: { type: "object", properties: { ...refProps, note: { type: "string" } }, required: ["claimId", "claimRevision", "evidenceRevision", "note"], additionalProperties: false },
		strict: false,
		invoke: async (args) => {
			try {
				const ref = refArgs(args)
				const res = state.setAudit(ref.claimId, ref.claimRevision, ref.evidenceRevision, { status: "approved", note: need(args, "note"), by: "auditor (LLM review)" })
				if (!res.ok) {
					if (res.stale) ctx.emit(EV.STALE_REJECTED, selfId, { claimId: ref.claimId, reason: res.reason })
					return reply(`REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`)
				}
				final(ref)
				return reply("approved")
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const correct: Tool = {
		type: "function",
		name: "request_correction",
		description: "Block this result and ask the extractor (target claim) or evidence agent (target evidence) to fix it. Triggers recalculation.",
		parameters: {
			type: "object",
			properties: { ...refProps, target: { type: "string", enum: ["claim", "evidence"] }, reason: { type: "string" } },
			required: ["claimId", "claimRevision", "evidenceRevision", "target", "reason"],
			additionalProperties: false,
		},
		strict: false,
		invoke: async (args) => {
			try {
				return reply(requestCorrection(refArgs(args), need(args, "target", ["claim", "evidence"] as const), need(args, "reason"), "auditor (LLM review)"))
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const receipt = (calc: Calculation) =>
		[
			`Verdict: ${calc.verdict}`,
			calc.formula && `Formula: ${calc.formula}`,
			calc.substituted && `Computed: ${calc.substituted}`,
			calc.actualDisplay && `Actual ${calc.actualDisplay} vs stated ${calc.statedDisplay}${calc.toleranceRule ? ` (${calc.toleranceRule})` : ""}`,
			...calc.inputs.map((i) => `Input ${i.role}: ${i.evidenceId} = ${i.value} ${i.unit}, ${i.period} ${i.start}..${i.end}, ${i.form} accn ${i.accn}`),
			...calc.notes.map((n) => `Note: ${n}`),
		]
			.filter(Boolean)
			.join("\n")

	const agent: Agent = createAgent({
		name: "Auditor",
		capabilities: ["inference", "audit"],
		instruction: INSTRUCTION,
		tools: [approve, correct],
		handlers: [
			handler(EV.CALCULATION_COMPLETED, (p: EvidenceRef) =>
				ctx.later(() => {
					const claim = state.claims.get(p.claimId)
					const binding = state.bindings.get(p.claimId)
					const calc = state.calcs.get(p.claimId)
					if (!claim || !binding || !calc) return
					if (claim.revision !== p.claimRevision || binding.evidenceRevision !== p.evidenceRevision || calc.evidenceRevision !== p.evidenceRevision) return // superseded
					const gate = auditGate(claim, binding, calc, state.registry)
					if (!gate.ok) {
						requestCorrection(p, gate.target, gate.reason, "auditor (rule)")
						return
					}
					if (calc.verdict === "NOT_VERIFIABLE" || calc.verdict === "REFERENCE_NOT_YET_FILED") {
						const res = state.setAudit(p.claimId, p.claimRevision, p.evidenceRevision, { status: "approved", note: "rule gate passed; nothing in the financial statements to compute against", by: "auditor (rule)" })
						if (res.ok) final(p)
						return
					}
					const warnings = (state.warnings.get(p.claimId) ?? []).filter((w) => w.source === "rule").map((w) => `[${w.code}] ${w.message}`)
					ctx.startTask(agent, {
						role: "auditor",
						key: `auditor:${p.claimId}@r${p.claimRevision}.e${p.evidenceRevision}`,
						claimId: p.claimId,
						claimRevision: p.claimRevision,
						evidenceRevision: p.evidenceRevision,
						message: `Audit claim ${p.claimId} revision ${p.claimRevision}, evidence revision ${p.evidenceRevision}.
Quote: "${claim.interpretation.quote}"
Paragraph: "${paragraphOf(state.article!.text, claim.interpretation.quote)}"
Interpretation: ${JSON.stringify(claim.interpretation)}
${receipt(calc)}
Rule warnings: ${warnings.length ? warnings.join(" | ") : "none"}`,
					})
				}),
			),
		],
	})
	selfId = agent.getId()
	return agent
}
