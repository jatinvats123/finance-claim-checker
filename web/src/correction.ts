import type { RunView, ClaimView } from "../../src/web/types"

/** The editor receives a claim-specific draft with a reproducible source trail. */
export function correctionText(run: Pick<RunView, "reference">, c: ClaimView): string | undefined {
	if (c.verdict !== "MISMATCH" || c.review.status !== "complete" || !c.calc?.actualDisplay || !c.calc.inputs.length) return
	if (c.warnings.some(warning => warning.code === "FORWARD_LOOKING")) return
	const inputs = c.calc.inputs
	const derived = inputs.filter(input => input.derivation)
	if (derived.some(input => input.derivationInputs?.length !== 2)) return
	const sources = [...new Set(inputs.flatMap(input => input.derivationInputs ?? [input]).map(input => {
		const document = input.url || input.accn
		return input.location ? `${document} · page ${input.location.page}, ${input.location.row}, ${input.location.column}` : `${input.form} · ${input.accn} · ${document}`
	}))]
	const current = inputs.find(input => input.role === "current")
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
	const suggestion = derived.length
		? `${run.reference.entityName} had ${edit} ${when}, calculated from its financial statements.`
		: `${run.reference.entityName} reported ${edit} ${when}.`
	const calculations = derived.map(input => {
		const [annual, nineMonths] = input.derivationInputs!
		const amount = (fact: typeof annual) => `${fact.unit} ${fact.value.toLocaleString("en-US")}`
		return `Calculation (${input.period}): ${amount(annual)} full year − ${amount(nineMonths)} first nine months = ${amount(input)}.`
	})
	return [`Original: “${c.quote}”`, `Suggested edit: ${suggestion}`, ...calculations, ...sources.map(source => "Source: " + source)].join("\n")
}
