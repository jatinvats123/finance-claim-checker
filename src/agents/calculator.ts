/**
 * Calculator participant (deterministic, no model). Reacts to every evidence binding, resolves the
 * values from evidence ids, computes, attaches rule-based context warnings, and publishes the result.
 * A binding superseded while it computed is rejected by the store's revision check.
 */
import { createHuman, type Human } from "@mozaik-ai/core"
import { calculate, statedDisplay } from "../domain/calculator.js"
import { ruleWarnings } from "../domain/checks.js"
import type { Calculation } from "../domain/types.js"
import { EV, handler, type Ctx, type EvidenceRef } from "../runtime/context.js"

export function createCalculator(ctx: Ctx): Human {
	const { state } = ctx
	const self: Human = createHuman({
		name: "Calculator",
		capabilities: ["deterministic-calculation"],
		handlers: [
			handler(EV.EVIDENCE_BOUND, (p: EvidenceRef) =>
				ctx.later(() => {
					const claim = state.claims.get(p.claimId)
					const binding = state.bindings.get(p.claimId)
					if (!claim || !binding) return
					const meta = { claimId: p.claimId, claimRevision: p.claimRevision, evidenceRevision: p.evidenceRevision }
					let calc: Calculation
					if (binding.noReference) {
						calc = {
							...meta,
							verdict: binding.noReference.status === "REFERENCE_NOT_YET_FILED" ? "REFERENCE_NOT_YET_FILED" : "NOT_VERIFIABLE",
							formula: "",
							substituted: "",
							statedDisplay: statedDisplay(claim.interpretation),
							inputs: [],
							notes: [], // the reason is carried on the binding and shown once as "Reference"
						}
					} else {
						const reg = state.registry
						calc = calculate(meta, claim.interpretation, binding.currentFactId ? reg.get(binding.currentFactId) : undefined, binding.baseFactId ? reg.get(binding.baseFactId) : undefined)
					}
					const res = state.acceptCalculation(calc, ruleWarnings(claim, binding, calc, state.registry))
					if (!res.ok) {
						ctx.emit(EV.STALE_REJECTED, self.getId(), { claimId: p.claimId, reason: res.reason })
						return
					}
					ctx.emit(EV.CALCULATION_COMPLETED, self.getId(), meta)
				}),
			),
		],
	})
	return self
}
