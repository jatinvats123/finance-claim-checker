/**
 * Reader agent (LLM): reads the statement pages of a company's official report (PDF) and proposes
 * facts — metric, page, row label, column, value as printed. It never computes or converts anything:
 * every proposal is verified against the page by code (src/docs/verify.ts) before it becomes evidence.
 */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { pageForModel, verifyProposed, type ProposedFact } from "../docs/verify.js"
import { EV, handler, reply, type Ctx } from "../runtime/context.js"
import { VERIFIABLE_METRICS } from "../sec/types.js"

const INSTRUCTION = `You read the financial statements in a company's official results report and record where each figure is printed. Code verifies every fact you record against the page (row, value on that row, column date, unit note, consolidated/standalone heading); rejected facts come back with a reason.
For every statement table on the pages given (consolidated and standalone separately), and for every period column in it (quarter, half year, nine months, year), record these rows when the table has them:
- revenue: "Revenue from operations", "Total revenue(s)" or "Net sales" (never "Total income" or "Other income").
- net_income: profit attributable to owners/shareholders of the company if the table shows it; otherwise "Net profit / Profit for the period".
- eps_basic and eps_diluted: the "Basic" and "Diluted" earnings-per-share rows.
- gross_profit and operating_income: only rows literally labelled gross profit / operating profit (or income from operations).
Fields: page (number), row (the row label exactly as printed, e.g. "Revenue from operations" or "(a) Basic"), column (the column header as printed), periodType (quarter | half | nine_months | year), periodEnd (YYYY-MM-DD from the column header), value (exactly as printed, with its commas, decimals and parentheses), consolidation (consolidated | standalone, from the statement heading), metric.
Call record_facts once with all facts. If some are rejected and the reason shows a fixable reading error, call record_facts once more with only the corrected ones. Never compute, convert or round a value, and never record a row that is not printed. Then reply "done".`

const FACT = {
	type: "object",
	properties: {
		metric: { type: "string", enum: VERIFIABLE_METRICS },
		consolidation: { type: "string", enum: ["consolidated", "standalone"] },
		page: { type: "integer" },
		row: { type: "string" },
		column: { type: "string" },
		periodType: { type: "string", enum: ["quarter", "half", "nine_months", "year"] },
		periodEnd: { type: "string" },
		value: { type: "string" },
	},
	required: ["metric", "consolidation", "page", "row", "column", "periodType", "periodEnd", "value"],
}

export function createReader(ctx: Ctx): Agent {
	const { state } = ctx
	let selfId = ""

	const recordFacts: Tool = {
		type: "function",
		name: "record_facts",
		description: "Record facts read from the report's statement pages. Each one is verified against its page by code.",
		parameters: { type: "object", properties: { facts: { type: "array", items: FACT } }, required: ["facts"], additionalProperties: false },
		strict: false,
		invoke: async (args) => {
			const r = state.report
			if (!r) return reply("REJECTED: no report in this run")
			const list: ProposedFact[] = Array.isArray(args?.facts) ? args.facts.slice(0, 120) : []
			if (!list.length) return reply("REJECTED: facts must be a non-empty array")
			const rejected: { i: number; reason: string }[] = []
			let accepted = 0
			list.forEach((p, i) => {
				const v = verifyProposed(r.doc, p, { basis: r.basis, docCurrency: r.docCurrency })
				if (!v.ok) {
					rejected.push({ i, reason: v.reason })
					r.rejected.push({ proposed: p, reason: v.reason })
					return
				}
				const f = v.fact
				const dup = r.accepted.find((a) => a.concept === f.concept && a.start === f.start && a.end === f.end && a.consolidation === f.consolidation && a.unit === f.unit)
				if (dup && dup.value !== f.value) {
					rejected.push({ i, reason: `conflicts with an accepted fact for the same row/period (${dup.location?.printed} on page ${dup.location?.page})` })
					return
				}
				if (!dup) r.accepted.push(f)
				accepted++
			})
			state.log("report.facts", `${accepted} verified, ${rejected.length} rejected`)
			ctx.emit(EV.REPORT_PROGRESS, selfId, { accepted: r.accepted.length, rejected: r.rejected.length })
			return reply({ accepted, rejected: rejected.slice(0, 30) })
		},
	}

	const agent: Agent = createAgent({
		name: "Reader",
		capabilities: ["inference", "report-reading"],
		instruction: INSTRUCTION,
		tools: [recordFacts],
		handlers: [
			handler(EV.ARTICLE_SUBMITTED, () => {
				const r = state.report
				if (!r) return // SEC reference: nothing to read
				ctx.startTask(agent, {
					role: "reader",
					key: "reader:report",
					message: `Company: ${r.info.entityName}.
Report: ${r.doc.url ?? r.doc.fileName ?? "uploaded PDF"} (${r.doc.pageCount} pages). Code selected these statement pages: ${r.pages.map((p) => p.n).join(", ")}.
Each line below is one printed row; " | " separates cells.

${r.pages.map((p) => pageForModel(p)).join("\n\n")}`,
				})
			}),
		],
	})
	selfId = agent.getId()
	return agent
}
