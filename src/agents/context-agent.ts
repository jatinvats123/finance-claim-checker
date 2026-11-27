/** Context agent (LLM): flags framing problems — separate from the numeric verdict, never a number. */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { EV, handler, need, paragraphOf, reply, type ClaimRef, type Ctx } from "../runtime/context.js"

const CODES = ["CHERRY_PICKED", "RECORD_OR_SUPERLATIVE", "FORWARD_LOOKING", "PERIOD_AMBIGUOUS", "ATTRIBUTION", "MISLEADING_FRAMING", "OTHER"] as const

const INSTRUCTION = `You review how one claim is framed in its paragraph. You do not check arithmetic — a deterministic calculator does that, and GAAP-vs-adjusted, comparison basis, units and periods are checked by rules.
Flag only real framing issues with add_context_warning (one call per message): cherry-picked comparisons, unsupported "record"/superlative language, forward-looking statements presented as results, an ambiguous period, a figure attributed to the wrong source, or other misleading framing.
Each warning: a code and one plain sentence. Do not include any numbers that are not in the quote. If there is nothing to flag, reply "no context issues". When finished, reply "done".`

export function createContextAgent(ctx: Ctx): Agent {
	const { state } = ctx
	let selfId = ""

	const addWarning: Tool = {
		type: "function",
		name: "add_context_warning",
		description: "Attach a framing/context warning to a claim revision.",
		parameters: {
			type: "object",
			properties: { claimId: { type: "string" }, claimRevision: { type: "integer" }, code: { type: "string", enum: CODES }, message: { type: "string" } },
			required: ["claimId", "claimRevision", "code", "message"],
			additionalProperties: false,
		},
		strict: false,
		invoke: async (args) => {
			try {
				const w = { claimId: need(args, "claimId"), claimRevision: Number(need(args, "claimRevision")), source: "context-agent" as const, code: need(args, "code", CODES), message: need(args, "message") }
				const res = state.addWarning(w, ctx.archivedPrompts)
				if (!res.ok) {
					// Preserve the original recorded receipt for a proposal retained in the audit log.
					if (ctx.archivedPrompts && res.retainedForReview) return reply("recorded")
					if (res.dismissed) return reply(`DISMISSED: ${res.reason} Continue with any other supported framing issue or finish the review.`)
					if (res.stale) ctx.emit(EV.STALE_REJECTED, selfId, { claimId: w.claimId, reason: res.reason })
					return reply(`REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`)
				}
				ctx.emit(EV.CONTEXT_WARNING, selfId, { claimId: w.claimId, claimRevision: w.claimRevision, code: w.code })
				return reply("recorded")
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const agent: Agent = createAgent({
		name: "Context",
		capabilities: ["inference", "framing-review"],
		instruction: INSTRUCTION,
		tools: [addWarning],
		handlers: [
			handler(EV.CLAIM_REVISED, (p: ClaimRef) => {
				const claim = state.claims.get(p.claimId)
				if (!claim || claim.revision !== p.claimRevision) return
				const filed = state.registry.filedPeriod(claim.interpretation.fiscalYear, claim.interpretation.fiscalPeriod)
				const reference = `Reference as of ${state.registry.asOf()}. ${filed ? `Period ended ${filed.end}. ${filed.form} filed ${filed.filed}.` : "No SEC filing date established for this period."} Distinguish explicit forecasts in the quotation from historical results. Article publication date is unknown.`
				ctx.startTask(agent, {
					role: "context",
					key: `context:${claim.id}@r${claim.revision}`,
					claimId: claim.id,
					claimRevision: claim.revision,
					message: `Claim ${claim.id} revision ${claim.revision}: "${claim.interpretation.quote}"
Interpretation: ${JSON.stringify(claim.interpretation)}
Paragraph: "${paragraphOf(state.article!.text, claim.interpretation.quote)}"
Article title: ${state.article!.title}${ctx.archivedPrompts ? "" : "\n" + reference}`,
				})
			}),
		],
	})
	selfId = agent.getId()
	return agent
}
