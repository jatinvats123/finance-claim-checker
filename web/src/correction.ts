import type { RunView, ClaimView } from "../../src/web/types"

/** The editor receives a claim-specific draft, with every input source retained for derived figures. */
export function correctionText(run: RunView, c: ClaimView): string | undefined {
	if (c.verdict !== "MISMATCH" || c.review.status !== "complete" || !c.calc?.actualDisplay || !c.calc.inputs.length) return
	const sources = [...new Set(c.calc.inputs.map(input => {
		const document = input.url || input.accn
		return input.location ? `${document} · page ${input.location.page}, ${input.location.row}, ${input.location.column}` : `${input.form} · ${input.accn} · ${document}`
	}))]
	const current = c.calc.inputs.find(input => input.role === "current")
	if (!current) return
	const metric = c.metricLabel.replace(/^[A-Z][a-z]+/, word => word.toLowerCase())
	const label = c.interpretation.consolidation === "standalone" ? "standalone " + metric : metric
	const date = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(current.end + "T00:00:00Z"))
	const period = { FY: "year", Q1: "quarter", Q2: "quarter", Q3: "quarter", Q4: "quarter", H1: "six months", "9M": "nine months" }[c.interpretation.fiscalPeriod]
	const when = `for the ${period} ended ${date}`
	const change = c.interpretation.kind === "change"
	const basis = c.interpretation.comparison === "yoy" ? "year-over-year" : c.interpretation.comparison === "qoq" ? "quarter-over-quarter" : undefined
	if (change && !basis) return
	const edit = change ? `a ${basis} change of ${c.calc.actualDisplay} in ${label}` : `${label} of ${c.calc.actualDisplay}`
	return [`Original: “${c.quote}”`, `Suggested edit: ${run.reference.entityName} reported ${edit} ${when}.`, ...sources.map(source => "Source: " + source)].join("\n")
}
