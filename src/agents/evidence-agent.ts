/**
 * Evidence: binds the statement facts a claim must be checked against, by id only — values are resolved
 * from the registry by the calculator. A clear case (one unambiguous figure, or no statement for the
 * period) is bound by code with no model call (src/domain/evidence-plan.ts). Everything else goes to the
 * LLM agent with the candidate facts preloaded in its first prompt; search_facts remains available.
 */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { planEvidence, shortlistFor, type Shortlist } from "../domain/evidence-plan.js"
import { periodLabel, type EvidenceFact, type FiscalPeriod } from "../sec/evidence.js"
import { METRIC_CONCEPTS, type VerifiableMetric } from "../sec/types.js"
import { EV, handler, need, paragraphOf, reply, type ClaimRef, type CorrectionPayload, type Ctx } from "../runtime/context.js"
import type { Claim, EvidenceBinding } from "../domain/types.js"

const INSTRUCTION = `You attach official financial-statement evidence to one claim. Work one tool call per message.
1. The task message lists candidate facts for the claim's period (and, for a change claim, its comparison periods), best first. When the right facts are there, call bind_evidence with their ids straight away. Call search_facts only if the shortlist lacks the right fact.
2. Bind fact ids exactly as listed — never numbers.
Rules:
- The current figure must cover exactly the claim's period: a quarter claim needs a ~91-day quarterly fact, not a six- or nine-month year-to-date figure; FY needs the ~364-day annual fact.
- Use the metric's primary line item (listed first) unless the claim's wording names another one.
- Consolidated vs standalone: if the claim says standalone, bind a standalone fact; otherwise bind the consolidated one. Bind a fact in the currency the claim states when one exists; never pick a convenience translation over the reporting currency for an unstated currency.
- Change claims: comparison "yoy" → same fiscal period one fiscal year earlier; "qoq" → the immediately preceding quarter (Q1's previous quarter is Q4 of the prior fiscal year). If comparison is "unspecified", bind the year-over-year base as baseFactId AND the quarter-over-quarter base as alternateBaseFactId.
- Prefer the comparative presented in the same filing or report as the current figure; it reflects splits and reclassifications.
- Evidence comes only from financial statements (10-Q/10-K/20-F/40-F, or the company's official report given for this run). If no statement covers the period, call report_no_reference. Never use earnings releases.
- Bind the fact for the claim's period even when its value differs from the article: the calculator reports the difference.
When the evidence is bound, reply "done".`

const PERIODS = ["Q1", "Q2", "Q3", "Q4", "FY", "H1", "9M"] as const

function view(f: EvidenceFact) {
	return {
		id: f.id,
		concept: f.concept,
		period: periodLabel(f.fiscalYear, f.fiscalPeriod),
		dates: `${f.start}..${f.end}`,
		days: f.days,
		value: f.value,
		unit: f.unit,
		consolidation: f.consolidation,
		basis: f.basis,
		...(f.translated ? { note: "convenience translation, not the reporting currency" } : {}),
		source: f.location ? `official report p.${f.location.page}, row "${f.location.row}", column "${f.location.column}"` : `${f.form} accn ${f.accn} filed ${f.filed}`,
		presented: f.derivation ? `derived: ${f.derivation.formula}` : f.isOriginal ? "original filing for this period" : "comparative in a later filing",
	}
}

export function createEvidenceAgent(ctx: Ctx): Agent {
	const { state } = ctx
	let selfId = ""
	const reg = () => state.registry

	const searchFacts: Tool = {
		type: "function",
		name: "search_facts",
		description: "List financial-statement facts for a metric and fiscal period, with stable evidence ids.",
		parameters: {
			type: "object",
			properties: { metric: { type: "string", enum: Object.keys(METRIC_CONCEPTS) }, fiscalYear: { type: "integer" }, fiscalPeriod: { type: "string", enum: PERIODS } },
			required: ["metric", "fiscalYear", "fiscalPeriod"],
			additionalProperties: false,
		},
		strict: false,
		invoke: async (args) => {
			try {
				const metric = need(args, "metric", Object.keys(METRIC_CONCEPTS) as VerifiableMetric[])
				const fy = Number(need(args, "fiscalYear"))
				const fp = need(args, "fiscalPeriod", PERIODS)
				const hits = reg().search(metric, fy, fp).slice(0, 6).map(view)
				if (hits.length) return reply({ facts: hits })
				const latest = reg().latestReportedPeriod()
				return reply({
					facts: [],
					status: reg().hasReferenceFor(fy, fp) ? "NO_FACT_FOR_METRIC" : "NO_STATEMENT_FOR_PERIOD",
					latestReportedPeriod: latest ? `${periodLabel(latest.fy, latest.fp as FiscalPeriod)} ended ${latest.periodEnd} (${latest.form} filed ${latest.filed})` : null,
				})
			} catch (e) {
				return reply(`ERROR: ${(e as Error).message}`)
			}
		},
	}

	const bind = (b: Parameters<typeof state.bindEvidence>[0]) => {
		const res = state.bindEvidence(b)
		if (!res.ok) {
			if (res.stale) ctx.emit(EV.STALE_REJECTED, selfId, { claimId: b.claimId, reason: res.reason })
			return reply(`REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`)
		}
		ctx.emit(EV.EVIDENCE_BOUND, selfId, { claimId: b.claimId, claimRevision: b.claimRevision, evidenceRevision: res.value.evidenceRevision })
		return reply(`bound as ${b.claimId}@r${b.claimRevision}.e${res.value.evidenceRevision}; the calculator will compute from these ids`)
	}

	const bindEvidence: Tool = {
		type: "function",
		name: "bind_evidence",
		description: "Bind evidence ids to a claim revision. Values are looked up from the ids; do not pass numbers.",
		parameters: {
			type: "object",
			properties: {
				claimId: { type: "string" },
				claimRevision: { type: "integer" },
				currentFactId: { type: "string" },
				baseFactId: { type: "string" },
				alternateBaseFactId: { type: "string" },
			},
			required: ["claimId", "claimRevision", "currentFactId"],
			additionalProperties: false,
		},
		strict: false,
		invoke: async (args) => {
			try {
				return bind({
					claimId: need(args, "claimId"),
					claimRevision: Number(need(args, "claimRevision")),
					currentFactId: need(args, "currentFactId"),
					baseFactId: args.baseFactId || undefined,
					alternateBaseFactId: args.alternateBaseFactId || undefined,
					boundBy: "evidence-agent",
				})
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	/** The binding for "no statement in the reference covers this period" (verified: the period has no facts at all). */
	const noReferenceBinding = (claim: Claim, boundBy: string): Omit<EvidenceBinding, "evidenceRevision"> => {
		const { fiscalYear: fy, fiscalPeriod: fp } = claim.interpretation
		const releases = reg()
			.earningsReleasesAfterLatestReport()
			.map((r) => ({ accn: r.accessionNumber, filed: r.filingDate, url: reg().filingUrlFor(r.accessionNumber, r.primaryDocument) }))
		const latest = reg().latestReportedPeriod()
		return {
			claimId: claim.id,
			claimRevision: claim.revision,
			noReference: {
				status: "REFERENCE_NOT_YET_FILED",
				detail:
					reg().info.kind === "sec"
						? `No 10-Q/10-K/20-F covers ${periodLabel(fy, fp)} as of ${reg().asOf()}. Latest statements: ${latest ? `${periodLabel(latest.fy, latest.fp as FiscalPeriod)} (${latest.form} filed ${latest.filed})` : "none"}.`
						: `The official report provided does not cover ${periodLabel(fy, fp)}. Periods in the report: ${reg().calendar.map((c) => periodLabel(c.fy, c.fp as FiscalPeriod)).join(", ") || "none"}.`,
				earningsReleases: releases,
			},
			boundBy,
		}
	}

	const reportNoReference: Tool = {
		type: "function",
		name: "report_no_reference",
		description: "Declare that no financial statement in the reference covers the claim's period. Verified deterministically before it is accepted.",
		parameters: { type: "object", properties: { claimId: { type: "string" }, claimRevision: { type: "integer" } }, required: ["claimId", "claimRevision"], additionalProperties: false },
		strict: false,
		invoke: async (args) => {
			try {
				const claimId = need(args, "claimId")
				const claim = state.claims.get(claimId)
				if (!claim) return reply(`REJECTED: unknown claim ${claimId}`)
				const { fiscalYear: fy, fiscalPeriod: fp } = claim.interpretation
				if (reg().hasReferenceFor(fy, fp)) {
					const metric = claim.interpretation.metric
					const ids = metric in METRIC_CONCEPTS ? reg().search(metric as VerifiableMetric, fy, fp).slice(0, 3).map((f) => f.id) : []
					return reply(
						`REJECTED: ${periodLabel(fy, fp)} is covered by the reference${ids.length ? `: ${ids.join(", ")}` : ""}. Call bind_evidence with the fact for the claim's period even if its value differs from the article; the calculator reports the difference.`,
					)
				}
				return bind({ ...noReferenceBinding(claim, "evidence-agent"), claimRevision: Number(need(args, "claimRevision")) })
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	/** The claim, then the candidate facts (preloaded so a clear choice needs no search). */
	const describe = (claim: Claim, shortlist: Shortlist, why?: string) => {
		const c = claim.interpretation
		const lines = [`Claim ${claim.id} revision ${claim.revision}: "${c.quote}"`, `Interpretation: ${JSON.stringify(c)}`]
		if (why) lines.push(`Why this needs your judgement: ${why}`)
		lines.push("Candidate facts from the reference (best first; bind by id):")
		for (const s of shortlist) {
			lines.push(`- ${s.label}:${s.facts.length ? "" : " no facts for this metric"}`)
			for (const f of s.facts) lines.push(`  ${JSON.stringify(view(f))}`)
		}
		return lines.join("\n")
	}

	const start = (claim: Claim, extra = "", why?: string) => {
		const attempt = (state.evidenceAttempts.get(claim.id) ?? 0) + 1
		state.evidenceAttempts.set(claim.id, attempt)
		ctx.startTask(agent, {
			role: "evidence",
			key: `evidence:${claim.id}@r${claim.revision}#${attempt}`,
			claimId: claim.id,
			claimRevision: claim.revision,
			evidenceRevision: state.bindings.get(claim.id)?.evidenceRevision ?? 0,
			message: `${describe(claim, shortlistFor(claim, reg()), why)}\nContext: "${paragraphOf(state.article!.text, claim.interpretation.quote)}"${extra}`,
		})
	}

	const agent: Agent = createAgent({
		name: "Evidence",
		capabilities: ["inference", "sec-evidence"],
		instruction: INSTRUCTION,
		tools: [searchFacts, bindEvidence, reportNoReference],
		handlers: [
			handler(EV.CLAIM_REVISED, (p: ClaimRef) =>
				ctx.later(() => {
					const claim = state.claims.get(p.claimId)
					if (!claim || claim.revision !== p.claimRevision) return
					const c = claim.interpretation
					if (c.accounting === "non_gaap" || c.metric === "other") {
						// Deterministic routing: nothing in the statements to bind. No model call.
						bind({
							claimId: claim.id,
							claimRevision: claim.revision,
							noReference: { status: "NOT_IN_STATEMENTS", detail: c.accounting === "non_gaap" ? "Adjusted (non-GAAP) figure: not a line item of the financial statements." : "Metric not mapped to a statement line item." },
							boundBy: "evidence (rule)",
						})
						return
					}
					// Clear cases are bound by code (no model call); the calculator, auditor and corrections run as usual.
					const plan = planEvidence(claim, reg())
					if (plan.kind === "bind") {
						state.log("evidence.direct", `${plan.currentFactId}: ${plan.reason}`, claim.id)
						bind({ claimId: claim.id, claimRevision: claim.revision, currentFactId: plan.currentFactId, boundBy: "evidence (code: single statement figure)" })
						return
					}
					if (plan.kind === "no_reference") {
						state.log("evidence.direct", plan.reason, claim.id)
						bind(noReferenceBinding(claim, "evidence (code: no statement for the period)"))
						return
					}
					start(claim, "", plan.reason)
				}),
			),
			handler(EV.CORRECTION_REQUESTED, (p: CorrectionPayload) => {
				if (p.target !== "evidence") return
				const claim = state.claims.get(p.claimId)
				if (!claim || claim.revision !== p.claimRevision) return
				const prev = state.bindings.get(p.claimId)
				start(
					claim,
					`\n\nCORRECTION REQUEST from ${p.by}: ${p.reason}\nPrevious binding (e${prev?.evidenceRevision}): current=${prev?.currentFactId ?? "-"} base=${prev?.baseFactId ?? "-"} alternate=${prev?.alternateBaseFactId ?? "-"}`,
				)
			}),
		],
	})
	selfId = agent.getId()
	return agent
}
