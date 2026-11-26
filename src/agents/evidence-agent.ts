/**
 * Evidence agent (LLM): finds the 10-Q/10-K facts a claim must be checked against and binds them by id.
 * It never types a number — values are resolved from the SEC registry by the calculator.
 */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { basePeriod, periodLabel, type EvidenceFact, type FiscalPeriod } from "../sec/evidence.js"
import { METRIC_CONCEPTS, type VerifiableMetric } from "../sec/types.js"
import { EV, handler, need, paragraphOf, reply, type ClaimRef, type CorrectionPayload, type Ctx } from "../runtime/context.js"
import type { Claim } from "../domain/types.js"

const INSTRUCTION = `You attach SEC evidence to one claim. Work one tool call per message.
1. Call search_facts for the claim's metric and fiscal period. For a change claim, also search the comparison period.
2. Call bind_evidence with fact ids exactly as returned — never numbers.
Rules:
- The current figure must cover exactly the claim's period: a quarter claim needs a ~91-day quarterly fact, not a six- or nine-month year-to-date figure; FY needs the ~364-day annual fact.
- Change claims: comparison "yoy" → same fiscal period one fiscal year earlier; "qoq" → the immediately preceding quarter (Q1's previous quarter is Q4 of the prior fiscal year). If comparison is "unspecified", bind the year-over-year base as baseFactId AND the quarter-over-quarter base as alternateBaseFactId.
- Prefer the comparative presented in the same filing (same accession) as the current figure; it reflects splits and reclassifications.
- Evidence comes only from 10-Q/10-K financial statements. If search_facts reports that no 10-Q/10-K covers the period, call report_no_reference. Never use earnings releases.
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
		source: `${f.form} accn ${f.accn} filed ${f.filed}`,
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
		description: "List 10-Q/10-K XBRL facts for a metric and fiscal period, with stable evidence ids.",
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
					status: reg().hasReferenceFor(fy, fp) ? "NO_FACT_FOR_METRIC" : "NO_10Q_10K_FOR_PERIOD",
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

	const reportNoReference: Tool = {
		type: "function",
		name: "report_no_reference",
		description: "Declare that no 10-Q/10-K covers the claim's period yet. Verified deterministically before it is accepted.",
		parameters: { type: "object", properties: { claimId: { type: "string" }, claimRevision: { type: "integer" } }, required: ["claimId", "claimRevision"], additionalProperties: false },
		strict: false,
		invoke: async (args) => {
			try {
				const claimId = need(args, "claimId")
				const claim = state.claims.get(claimId)
				if (!claim) return reply(`REJECTED: unknown claim ${claimId}`)
				const { fiscalYear: fy, fiscalPeriod: fp } = claim.interpretation
				if (reg().hasReferenceFor(fy, fp)) return reply(`REJECTED: a 10-Q/10-K covering ${periodLabel(fy, fp)} is on file; search again and bind it`)
				const releases = reg()
					.earningsReleasesAfterLatestReport()
					.map((r) => ({ accn: r.accessionNumber, filed: r.filingDate, url: reg().filingUrlFor(r.accessionNumber, r.primaryDocument) }))
				const latest = reg().latestReportedPeriod()
				return bind({
					claimId,
					claimRevision: Number(need(args, "claimRevision")),
					noReference: {
						status: "REFERENCE_NOT_YET_FILED",
						detail: `No 10-Q/10-K covers ${periodLabel(fy, fp)} as of the SEC data fetched ${reg().snapshot.source.fetchedAt.slice(0, 10)}. Latest statements: ${latest ? `${periodLabel(latest.fy, latest.fp as FiscalPeriod)} (${latest.form} filed ${latest.filed})` : "none"}.`,
						earningsReleases: releases,
					},
					boundBy: "evidence-agent",
				})
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const describe = (claim: Claim) => {
		const c = claim.interpretation
		const lines = [`Claim ${claim.id} revision ${claim.revision}: "${c.quote}"`, `Interpretation: ${JSON.stringify(c)}`]
		if (c.kind === "change") {
			const yoy = basePeriod(c.fiscalYear, c.fiscalPeriod, "yoy")
			const qoq = basePeriod(c.fiscalYear, c.fiscalPeriod, "qoq")
			lines.push(`Comparison periods: yoy → ${yoy ? periodLabel(yoy.fy, yoy.fp) : "n/a"}, qoq → ${qoq ? periodLabel(qoq.fy, qoq.fp) : "n/a"}`)
		}
		return lines.join("\n")
	}

	const start = (claim: Claim, extra = "") => {
		const attempt = (state.evidenceAttempts.get(claim.id) ?? 0) + 1
		state.evidenceAttempts.set(claim.id, attempt)
		ctx.startTask(agent, {
			role: "evidence",
			key: `evidence:${claim.id}@r${claim.revision}#${attempt}`,
			claimId: claim.id,
			claimRevision: claim.revision,
			evidenceRevision: state.bindings.get(claim.id)?.evidenceRevision ?? 0,
			message: `${describe(claim)}\nContext: "${paragraphOf(state.article!.text, claim.interpretation.quote)}"${extra}`,
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
							noReference: { status: "NOT_IN_STATEMENTS", detail: c.accounting === "non_gaap" ? "Adjusted (non-GAAP) figure: not reported in 10-Q/10-K statements." : "Metric not mapped to a statement line item." },
							boundBy: "evidence (rule)",
						})
						return
					}
					start(claim)
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
