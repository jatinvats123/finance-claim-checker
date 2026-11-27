import type { SemanticEvent } from "@mozaik-ai/core"
import { fmtExact } from "../domain/calculator.js"
import type { CheckerState } from "../domain/store.js"
import type { AuditState, Calculation, Claim } from "../domain/types.js"
import type { UsageSummary } from "../llm/limits.js"
import type { Trace } from "../runtime/trace.js"
import type { CallRecord } from "../llm/runner.js"
import type { RunResult } from "../runtime/pipeline.js"
import { describeClaim } from "../agents/extractor.js"

export const DISCLAIMER =
	"Not financial advice. This tool checks whether numbers in a text match a company's official financial statements (SEC filings or the company's published report); it does not evaluate the company or recommend any action."

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = c(2),
	red = c(31),
	green = c(32),
	yellow = c(33),
	blue = c(34),
	magenta = c(35),
	cyan = c(36),
	bold = c(1)
const AGENT_COLOR: Record<string, (s: string) => string> = { Reader: cyan, Extractor: cyan, Evidence: blue, Context: magenta, Calculator: yellow, Auditor: green, Desk: dim, Supervisor: dim }

export function verdictBadge(v?: string): string {
	switch (v) {
		case "MATCH":
			return green("✔ MATCH")
		case "MISMATCH":
			return red("✘ MISMATCH")
		case "NOT_COMPUTABLE":
			return yellow("∅ NOT COMPUTABLE")
		case "NOT_VERIFIABLE":
			return yellow("? NOT VERIFIABLE")
		case "REFERENCE_NOT_YET_FILED":
			return yellow("⧗ NO STATEMENT FOR PERIOD")
		default:
			return dim("… pending")
	}
}

const auditText = (a?: AuditState) =>
	!a ? "pending" : a.status === "approved" ? `approved by ${a.by}` : a.status === "investigating" ? `investigating (${a.target})` : a.status === "unresolved" ? `UNRESOLVED: ${a.reason}` : a.status === "failed" ? `FAILED: ${a.reason}` : "pending"

/** One line per notable event for the live view; undefined to skip. */
export function liveLine(e: SemanticEvent, names: Map<string, string>, state: CheckerState, t0: number, taskKey?: (contextId: string) => string | undefined): string | undefined {
	const who = names.get(e.producerId) ?? "?"
	const tag = (AGENT_COLOR[who] ?? ((s: string) => s))(who.padEnd(10))
	const t = dim(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`)
	const p = e.payload as any
	const claim = (id: string) => state.claims.get(id)
	switch (e.type) {
		case "article.submitted":
			return `${t} ${tag} article submitted: ${p.title}`
		case "message_received.started": {
			const key = taskKey?.(p.input?.context?.id)
			return key ? `${t} ${tag} ${dim("▶ loop")} ${key}` : undefined
		}
		case "claim.revised": {
			const cl = claim(p.claimId)
			if (!cl) return undefined
			return `${t} ${tag} ${bold(`${p.claimId} r${p.claimRevision}`)} ${describeClaim(cl.interpretation)} ${dim(`“${cl.interpretation.quote}”`)}`
		}
		case "evidence.bound": {
			const b = state.bindings.get(p.claimId)
			if (!b) return undefined
			const what = b.noReference ? b.noReference.status : [b.currentFactId, b.baseFactId && `base ${b.baseFactId}`, b.alternateBaseFactId && `alt ${b.alternateBaseFactId}`].filter(Boolean).join(", ")
			return `${t} ${tag} ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision} bound ${what}`
		}
		case "calculation.completed": {
			const calc = state.calcs.get(p.claimId)
			if (!calc) return undefined
			return `${t} ${tag} ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision} ${verdictBadge(calc.verdict)}${calc.actualDisplay ? ` actual ${calc.actualDisplay} vs stated ${calc.statedDisplay}` : ""}`
		}
		case "audit.correction_requested":
			return `${t} ${tag} ${yellow(`⚑ ${p.claimId} r${p.claimRevision}.e${p.evidenceRevision} blocked → ${p.target === "claim" ? "Extractor" : "Evidence"}`)}: ${p.reason} ${dim(`(${p.by})`)}`
		case "audit.final": {
			const a = state.audits.get(p.claimId)
			return `${t} ${tag} ${p.claimId} ${a?.state.status === "approved" ? green("✔ " + auditText(a.state)) : red(auditText(a?.state))}`
		}
		case "context.warning":
			return `${t} ${tag} ${p.claimId} r${p.claimRevision} context: ${p.code}`
		case "result.stale_rejected":
			return `${t} ${tag} ${magenta("⟲ STALE")} ${p.reason}`
		case "task.failed":
			return `${t} ${tag} ${red("✘ task failed")} ${p.task}`
		case "reference.ready":
			return `${t} ${tag} reference ready (${p.facts} facts)`
		case "reference.failed":
			return `${t} ${tag} ${red("reference unavailable")}: ${p.reason}`
		case "report.progress":
			return `${t} ${tag} report facts verified: ${p.accepted} (proposals rejected: ${p.rejected})`
		case "extraction.done":
			return `${t} ${tag} extraction ${p.failed ? red("FAILED") : "finished"}`
		default:
			return undefined
	}
}

export type ReportMeta = {
	mode: string
	model: string
	articlePath: string
	mozaikVersion: string
	calls: CallRecord[]
	cassettes: { path: string; provenance: string; description: string }[]
	/** live/record runs: measured token usage and cost */
	usage?: UsageSummary
	/** Measured agent-loop lanes and peak concurrency */
	trace?: Trace
}

function provenanceSummary(calls: CallRecord[]) {
	const counts: Record<string, number> = {}
	for (const call of calls) counts[call.provenance] = (counts[call.provenance] ?? 0) + 1
	return counts
}

function receipt(claim: Claim, state: CheckerState): string {
	const calc = state.calcs.get(claim.id)
	const binding = state.bindings.get(claim.id)
	const audit = state.audits.get(claim.id)
	const warnings = state.warnings.get(claim.id) ?? []
	const i = claim.interpretation
	const out: string[] = []
	out.push(`### ${claim.id} — ${calc ? calc.verdict.replace(/_/g, " ") : "PENDING"}`)
	out.push(`> “${i.quote}”`)
	if (state.history.some(entry => entry.claimId === claim.id && entry.kind === "claim.editor_selected")) out.push("Selected by an editor after extraction. Reviewed through the same evidence and audit workflow.")
	out.push("")
	out.push(`**Numerical result** (revision r${claim.revision}${binding ? `.e${binding.evidenceRevision}` : ""}; audit: ${auditText(audit?.state)})`)
	out.push("")
	out.push(`| | |`)
	out.push(`|---|---|`)
	out.push(`| Claim read as | ${describeClaim(i)}; stated **${calc?.statedDisplay ?? i.statedNumber}** |`)
	if (calc?.actualDisplay) out.push(`| From the ${state.referenceInfo.kind === "sec" ? "filings" : "report"} | **${calc.actualDisplay}** |`)
	if (calc?.difference) out.push(`| Difference | ${calc.difference} |`)
	if (calc?.toleranceRule) out.push(`| Tolerance | ${calc.toleranceRule} |`)
	if (calc?.formula) out.push(`| Formula | \`${calc.formula}\` |`)
	if (calc?.substituted) out.push(`| Computed | \`${calc.substituted}\` |`)
	out.push("")
	if (calc?.inputs.length) {
		out.push(`**Evidence** (values resolved by id from the reference — SEC XBRL data or verified report pages; the model never supplies them)`)
		out.push("")
		out.push(`| Role | Evidence id | Line item | Period | Dates | Value | Unit | Source |`)
		out.push(`|---|---|---|---|---|---|---|---|`)
		for (const x of calc.inputs) {
			const src = x.location
				? `[official report p.${x.location.page}](${x.url}): row “${x.location.row}”, column “${x.location.column}”, printed ${x.location.printed} (${x.location.unitNote})`
				: `[${x.form} ${x.accn}, filed ${x.filed}](${x.url})`
			const cons = x.consolidation && x.consolidation !== "consolidated" ? ` (${x.consolidation})` : ""
			out.push(`| ${x.role} | \`${x.evidenceId}\` | ${x.concept} | ${x.period} | ${x.start} → ${x.end} | ${fmtExact(x.value)} | ${x.unit}${cons} | ${src}${x.derivation ? ` (derived: ${x.derivation})` : ""} |`)
		}
		out.push("")
	}
	if (binding?.noReference) {
		out.push(`**Reference:** ${binding.noReference.detail}`)
		for (const r of binding.noReference.earningsReleases ?? []) out.push(`- Not used (would be circular): earnings release [8-K accn ${r.accn}, filed ${r.filed}](${r.url})`)
		out.push("")
	}
	for (const n of calc?.notes ?? []) out.push(`- Note: ${n}`)
	if (calc?.notes.length) out.push("")
	out.push(`**Context warnings** (separate from the numerical result)`)
	out.push("")
	if (!warnings.length) out.push(`- none`)
	for (const w of warnings) out.push(`- \`${w.code}\` (${w.source}${w.source === "rule" ? "" : `, r${w.claimRevision}`}): ${w.message}`)
	out.push("")
	const hist = state.history.filter((h) => h.claimId === claim.id)
	if (hist.length) {
		out.push(`<details><summary>History (${hist.length} events)</summary>`)
		out.push("")
		for (const h of hist) out.push(`- ${(h.at / 1000).toFixed(2)}s \`${h.kind}\` ${h.detail}`)
		out.push("")
		out.push(`</details>`)
		out.push("")
	}
	return out.join("\n")
}

export function renderMarkdown(result: RunResult, meta: ReportMeta): string {
	const { state } = result
	const ref = state.referenceInfo
	const claims = [...state.claims.values()]
	const count = (v: string) => claims.filter((cl) => state.calcs.get(cl.id)?.verdict === v).length
	const prov = provenanceSummary(meta.calls)
	const out: string[] = []
	out.push(`# Claim check: ${state.article!.title}`)
	out.push("")
	out.push(`> ${DISCLAIMER}`)
	out.push("")
	const ids = [ref.ticker, ref.cik && `CIK ${ref.cik}`].filter(Boolean).join(", ")
	out.push(`**Company:** ${ref.entityName}${ids ? ` (${ids})` : ""} · **Article:** \`${meta.articlePath}\``)
	out.push("")
	if (ref.kind === "sec") {
		out.push(
			`**Reference documents:** financial statements filed with the SEC — 10-Q (quarterly, unaudited), 10-K (annual, audited) and, for foreign issuers, 20-F/40-F annual reports — as XBRL facts from SEC EDGAR fetched ${ref.fetchedAt}${ref.reportingCurrency ? ` (reporting currency ${ref.reportingCurrency})` : ""}. Earnings releases (8-K/6-K) are never used as the reference: checking a release against itself would be circular. Supported metrics: revenue, net income, gross profit, operating income, diluted and basic EPS.`,
		)
	} else {
		const r = state.report
		const pages = r ? [...new Set(r.accepted.map((f) => f.location?.page))].join(", ") || "none" : "none"
		out.push(
			`**Reference document:** ${ref.label}, fetched ${ref.fetchedAt} (${ref.note ?? ""}). Every figure used was read by the Reader agent and verified by code on its page (row, value on that row, column date, unit note, consolidated/standalone heading)${r ? `: ${r.accepted.length} facts verified on pages ${pages}, ${r.rejected.length} proposals rejected` : ""}.${r?.error ? ` **Reference unavailable:** ${r.error}.` : ""}`,
		)
	}
	out.push("")
	out.push(`| Verdict | Claims |`)
	out.push(`|---|---|`)
	const label: Record<string, string> = { REFERENCE_NOT_YET_FILED: `REFERENCE UNAVAILABLE (${ref.kind === "sec" ? `SEC data as of ${ref.fetchedAt.slice(0, 10)}` : "not in the report"})` }
	for (const v of ["MATCH", "MISMATCH", "NOT_COMPUTABLE", "NOT_VERIFIABLE", "REFERENCE_NOT_YET_FILED"]) out.push(`| ${label[v] ?? v.replace(/_/g, " ")} | ${count(v)} |`)
	out.push("")
	out.push(`| Claim | Quote | Numerical result | Context warnings | Audit |`)
	out.push(`|---|---|---|---|---|`)
	for (const cl of claims) {
		const calc = state.calcs.get(cl.id)
		const w = (state.warnings.get(cl.id) ?? []).map((x) => x.code)
		out.push(`| ${cl.id} r${cl.revision} | ${cl.interpretation.quote} | ${calc?.verdict ?? "PENDING"}${calc?.actualDisplay ? ` (actual ${calc.actualDisplay}, stated ${calc.statedDisplay})` : ""} | ${w.join(", ") || "–"} | ${auditText(state.audits.get(cl.id)?.state)} |`)
	}
	out.push("")
	if (state.extraction === "failed") out.push(`**Extraction failed:** ${state.extractionError}\n`)
	if (result.timedOut) out.push(`**Run timed out** before every claim settled; pending claims are shown as such.\n`)
	out.push(`## Receipts`)
	out.push("")
	for (const cl of claims) out.push(receipt(cl, state))
	out.push(`## Run provenance`)
	out.push("")
	out.push(`- Mode: \`${meta.mode}\`${meta.mode === "replay" ? " (no API key used)" : ""}; model setting: \`${meta.model}\`; Mozaik \`@mozaik-ai/core@${meta.mozaikVersion}\``)
	out.push(`- Model calls by source: ${Object.entries(prov).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}`)
	if (meta.usage) {
		const u = meta.usage
		const cost = u.costUsd !== undefined ? `$${u.costUsd.toFixed(4)}` : "cost not computed (no price for this model)"
		out.push(`- Measured usage (${u.model}): ${u.requests} requests, ${u.inputTokens} input + ${u.outputTokens + u.reasoningTokens} output tokens, ${cost}${u.limitHit ? `; stopped by limit: ${u.limitHit}` : ""}`)
	}
	if (meta.trace) out.push(`- Concurrency (measured from Mozaik loop start/end events): peak ${meta.trace.peakActive} agent loops active at once across ${meta.trace.lanes.length} loops. ${meta.trace.timingNote}`)
	for (const cs of meta.cassettes) out.push(`- Cassette \`${cs.path}\` — provenance **${cs.provenance}**: ${cs.description}`)
	out.push(`- Reference: ${ref.sources.map((x) => (x.url ? `[${x.label}](${x.url})` : x.label)).join(", ")}, fetched ${ref.fetchedAt}.`)
	if (state.report?.rejected.length) {
		out.push(`- Report facts proposed by the Reader and rejected by code (${state.report.rejected.length}):`)
		for (const r of state.report.rejected.slice(0, 40)) out.push(`  - ${JSON.stringify(r.proposed)} — ${r.reason}`)
	}
	out.push(`- Calculations, period/unit checks, evidence validation and revision control ran for real in this mode; only model responses are replayed when the mode is \`replay\`.`)
	out.push(`- Stale results rejected: ${state.staleRejections.length}`)
	for (const s of state.staleRejections) out.push(`  - ${(s.at / 1000).toFixed(2)}s ${s.detail}`)
	out.push(`- Elapsed: ${(result.elapsedMs / 1000).toFixed(2)}s`)
	out.push("")
	return out.join("\n")
}

export function renderTerminalSummary(result: RunResult, meta: ReportMeta): string {
	const { state } = result
	const out: string[] = ["", bold("Results") + dim("  (numerical result | context warnings | audit)")]
	for (const cl of state.claims.values()) {
		const calc: Calculation | undefined = state.calcs.get(cl.id)
		const w = (state.warnings.get(cl.id) ?? []).map((x) => x.code)
		out.push(`${bold(cl.id.padEnd(4))} ${verdictBadge(calc?.verdict).padEnd(tty ? 30 : 21)} ${dim("“" + cl.interpretation.quote + "”")}`)
		if (calc?.actualDisplay) out.push(`      actual ${calc.actualDisplay} vs stated ${calc.statedDisplay}${calc.inputs.length ? dim(`  [${calc.inputs.map((x) => x.evidenceId).join(", ")}]`) : ""}`)
		for (const n of calc?.notes ?? []) out.push(`      ${yellow("note:")} ${n}`)
		if (w.length) out.push(`      ${yellow("context:")} ${w.join(", ")}`)
		out.push(`      ${dim("audit:")} ${auditText(state.audits.get(cl.id)?.state)}`)
	}
	const prov = provenanceSummary(meta.calls)
	out.push("")
	out.push(dim(`Model calls: ${Object.entries(prov).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} · stale results rejected: ${state.staleRejections.length} · ${(result.elapsedMs / 1000).toFixed(2)}s`))
	if (state.extraction === "failed") out.push(red(`Extraction failed: ${state.extractionError}`))
	out.push("")
	out.push(dim(DISCLAIMER))
	return out.join("\n")
}

export function toJson(result: RunResult, meta: ReportMeta) {
	const { state } = result
	return {
		disclaimer: DISCLAIMER,
		article: { title: state.article!.title, path: meta.articlePath },
		company: { ticker: state.referenceInfo.ticker, cik: state.referenceInfo.cik, name: state.referenceInfo.entityName },
		reference: state.referenceInfo,
		secSource: state.registry?.snapshot?.source,
		report: state.report
			? {
					url: state.report.doc.url,
					fileName: state.report.doc.fileName,
					sha256: state.report.doc.sha256,
					pages: state.report.doc.pageCount,
					statementPages: state.report.pages.map((p) => p.n),
					status: state.report.status,
					error: state.report.error,
					verifiedFacts: state.report.accepted,
					rejectedProposals: state.report.rejected,
				}
			: undefined,
		run: { mode: meta.mode, model: meta.model, mozaik: meta.mozaikVersion, timedOut: result.timedOut, elapsedMs: result.elapsedMs, modelCalls: meta.calls, cassettes: meta.cassettes, usage: meta.usage, trace: meta.trace },
		claims: [...state.claims.values()].map((cl) => ({
			...cl,
			evidence: state.bindings.get(cl.id),
			numericalResult: state.calcs.get(cl.id),
			contextWarnings: state.warnings.get(cl.id) ?? [],
			audit: state.audits.get(cl.id),
		})),
		staleRejections: state.staleRejections,
		history: state.history,
	}
}
