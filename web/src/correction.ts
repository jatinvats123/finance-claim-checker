import type { CalcInput, ClaimView, RunView } from "../../src/web/types"
import { SCALE } from "../../src/domain/scales.js"

type Input = NonNullable<ClaimView["calc"]>["inputs"][number]

/** Printed labels were checked against the statements at these accessions. XBRL facts alone
 * do not encode the printed row, reporting scale, or the physical position in a filing. */
const printedRows = [
	{ accn: "0000950170-25-076303", concept: "ifrs-full:ProfitLossFromOperatingActivities", start: "2024-04-01", end: "2025-03-31", unit: "INR", value: 151271000000, row: "Results from operating activities", printed: "151,271", units: "₹ in millions", statement: "Consolidated statements of income, printed p. 113", tableUrl: "https://www.wipro.com/content/dam/nexus/en/investor/annual-reports/2024-2025/20-f-fy24-25.pdf#page=115" },
	{ accn: "0001628280-16-017809", concept: "us-gaap:NetIncomeLoss", start: "2016-03-27", end: "2016-06-25", unit: "USD", value: 7796000000, row: "Net income", printed: "7,796", units: "USD in millions", statement: "Condensed consolidated statements of operations, p. 3", tableUrl: "https://www.sec.gov/Archives/edgar/data/320193/000162828016017809/R2.htm" },
]

export function filingRow(fact: CalcInput) {
	if (fact.location) {
		const loc = fact.location
		return { row: loc.row, printed: loc.printed, units: loc.unitNote, statement: `Report page ${loc.page} · ${loc.column}`, tableUrl: undefined }
	}
	if (fact.derivation || fact.consolidation !== "consolidated") return undefined
	return printedRows.find(row => row.accn === fact.accn && row.concept === fact.concept && row.start === fact.start && row.end === fact.end && row.value === fact.value && row.unit === fact.unit)
}

export function correctionSources(inputs: Input[]) {
	const sources = new Map<string, { label: string; detail: string; url: string }>()
	for (const input of inputs.flatMap(fact => fact.derivationInputs ?? [fact])) {
		const document = input.url || input.accn
		const label = input.location ? `Report p.${input.location.page}` : `${input.form} · ${input.filed}`
		const row = filingRow(input)
		const id = input.location ? label : `${input.form} · ${input.accn}`
		const locator = row ? `${row.statement} · ${row.row} · ${row.printed} (${row.units})` : input.concept
		const detail = [id, locator, `${input.start} to ${input.end}`, `${input.unit} ${exactValue(input.value)}`, document, row?.tableUrl].filter(Boolean).join(" · ")
		sources.set(detail, { label, detail, url: input.url })
	}
	return [...sources.values()]
}

export function exactValue(value: number): string {
	return value.toLocaleString("en-US", { maximumFractionDigits: 20 })
}

/** Show the unit conversion from the bound fact, with the original filing units when known. */
export function receiptConversion(claim: ClaimView, input: Input): string | undefined {
	const { kind, statedUnit, scale } = claim.interpretation
	if (kind !== "level" || statedUnit !== "money" || scale === "units" || input.role !== "current") return
	const label = scale.replace("_", " ")
	const row = filingRow(input)
	const printedMillions = row?.tableUrl && Number(row.printed.replace(/,/g, "")) * 1e6 === input.value
	const from = printedMillions ? input.value / 1e6 : input.value
	const divisor = SCALE[scale] / (printedMillions ? 1e6 : 1)
	const amount = `${input.unit} ${exactValue(from)}${printedMillions ? " million" : ""}`
	return `${amount} ÷ ${exactValue(divisor)} = ${input.unit} ${exactValue(input.value / SCALE[scale])} ${label}`
}

// A quote may contain several valid figures. Copying it whole as a verified edit could carry
// another unchecked assertion into print; use the isolated alternative in that case.
const anotherAmount = /(?:[$€£₹¥]|\b(?:USD|INR|EUR|GBP|JPY|Rs\.?))\s*[+−-]?\s*\d|\d[\d,.]*\s*(?:%|×|(?:lakh\s+crore|crores?|lakhs?|thousands?|millions?|billions?|trillions?|mn|bn|per\s+share|percent)\b)/iu
const scaleWords = /^(lakh\s+crores?|lacs?\s+crores?|crores?|cr|lakhs?|lacs?|thousands?|k|millions?|mln|mn|m|billions?|bn|b|trillions?|tn|t)\b/i
function attachedScale(tail: string): ClaimView["interpretation"]["scale"] {
	const text = scaleWords.exec(tail.trimStart())?.[1].toLowerCase()
	if (!text) return "units"
	if (text.includes(" ")) return "lakh_crore"
	if (text.startsWith("cr")) return "crore"
	if (text.startsWith("la")) return "lakh"
	if (text.startsWith("k") || text.startsWith("th")) return "thousand"
	if (text.startsWith("m")) return "million"
	return text.startsWith("b") ? "billion" : "trillion"
}

/** Only replace one explicitly printed amount. Directional and bounded claims can need changes
 * to surrounding words. Keep those separate from edits which are safe as a number substitution. */
function replaceFigure(c: ClaimView, current: Input) {
	const i = c.interpretation
	if (i.kind !== "level" || !["exact", "about"].includes(i.qualifier) || current.value < 0 || !Number.isFinite(current.value)) return
	const stated = Number(i.statedNumber.replace(/,/g, ""))
	const candidates = [...c.quote.matchAll(/\d+(?:,\d{2,3})*(?:\.\d+)?/g)].filter(match => Number(match[0].replace(/,/g, "")) === stated)
	if (candidates.length !== 1) return
	const token = candidates[0]
	const before = c.quote.slice(0, token.index)
	const after = c.quote.slice(token.index! + token[0].length)
	if (/[\d.,]$/.test(before) || /^[.,]\d/.test(after) || /(?:[-−+(]\s*[$€£₹¥]?\s*|[$€£₹¥]\s*[-−+]\s*)$/.test(before)) return
	if (/^\s*(?:%|×|percent\b)/iu.test(after)) return
	if (anotherAmount.test(before) || anotherAmount.test(after) || /\b(?:net|operating|per[- ]share)\s+loss(?:es)?\b|\bloss\s+per\s+share\b/i.test(c.quote)) return
	if (attachedScale(after) !== i.scale || i.statedUnit === "per_share" && i.scale !== "units") return
	if (i.statedUnit !== "money" && i.statedUnit !== "per_share") return
	const hasQualifier = /\b(?:over|under|more than|less than|at least|at most|up to|exceed(?:ed|ing)?)\s*[$€£₹¥]?\s*$/i.test(before)
	if (hasQualifier) return
	const scaled = current.value / SCALE[i.scale]
	const decimals = token[0].split(".")[1]?.length ?? 0
	if (decimals > 20) return
	const options = { useGrouping: token[0].includes(",") }
	const locale = /,\d{2},/.test(token[0]) || i.scale === "crore" || i.scale === "lakh" || i.scale === "lakh_crore" ? "en-IN" : "en-US"
	const rounded = scaled.toLocaleString(locale, { ...options, minimumFractionDigits: decimals, maximumFractionDigits: decimals })
	const exact = scaled.toLocaleString(locale, { ...options, minimumFractionDigits: decimals, maximumFractionDigits: 20 })
	// Suppress a rounded edit that would hide a non-zero result or leave the original digits unchanged.
	const roundedToZero = scaled !== 0 && Number(rounded.replace(/,/g, "")) === 0
	const preciseOnly = roundedToZero || rounded === token[0]
	const replacement = preciseOnly ? exact : rounded
	return { before, old: token[0], after, replacement, exact, suggestion: before + replacement + after }
}

export function correctionPreview(run: Pick<RunView, "reference">, c: ClaimView) {
	if (c.verdict !== "MISMATCH" || c.review.status !== "complete" || !c.calc?.actualDisplay || !c.calc.inputs.length) return
	if (c.warnings.some(warning => warning.code === "FORWARD_LOOKING")) return
	const inputs = c.calc.inputs
	const derived = inputs.filter(input => input.derivation)
	if (derived.some(input => input.derivationInputs?.length !== 2)) return
	const current = inputs.find(input => input.role === "current")
	if (!current) return
	const change = c.interpretation.kind === "change"
	const basis = c.interpretation.comparison === "yoy" ? "year-over-year" : c.interpretation.comparison === "qoq" ? "quarter-over-quarter" : undefined
	if (change && !basis) return
	const sources = correctionSources(inputs)
	const calculations = derived.map(input => {
		const [annual, nineMonths] = input.derivationInputs!
		const amount = (fact: CalcInput) => `${fact.unit} ${exactValue(fact.value)}`
		return `${input.period} calculated from its financial statements: ${amount(annual)} full year − ${amount(nineMonths)} first nine months = ${amount(input)}.`
	})
	const replacement = replaceFigure(c, current)
	if (replacement) return { replacement, suggestion: replacement.suggestion, sources, calculations, current }

	const metric = c.metricLabel.replace(/^[A-Z][a-z]+/, word => word.toLowerCase())
	const label = c.interpretation.consolidation === "standalone" ? "standalone " + metric : metric
	const date = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(current.end + "T00:00:00Z"))
	const period = { FY: "year", Q1: "quarter", Q2: "quarter", Q3: "quarter", Q4: "quarter", H1: "six months", "9M": "nine months" }[c.interpretation.fiscalPeriod]
	const edit = change ? `a ${basis} change of ${c.calc.actualDisplay} in ${label}` : `${label} of ${c.calc.actualDisplay}`
	const verb = derived.length ? "had" : "reported"
	const suggestion = `${run.reference.entityName} ${verb} ${edit} for the ${period} ended ${date}.`
	return { replacement: undefined, suggestion, sources, calculations, current }
}

export function correctionText(run: Pick<RunView, "reference">, c: ClaimView, precision: "article" | "filing" = "article"): string | undefined {
	const preview = correctionPreview(run, c)
	if (!preview) return
	const r = preview.replacement
	const suggestion = r && precision === "filing" ? r.before + r.exact + r.after : preview.suggestion
	const exactNote = r && r.exact !== r.replacement ? `Full precision: ${r.before + r.exact + r.after}` : undefined
	return [`Original: “${c.quote}”`, `${r ? "Suggested edit" : "Standalone alternative"}: ${suggestion}`, exactNote, ...preview.calculations, ...preview.sources.map(source => "Source: " + source.detail)].filter(Boolean).join("\n")
}
