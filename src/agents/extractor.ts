/** Extractor agent (LLM): turns article sentences into structured claims, and fixes a claim when the auditor asks. */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { parseStated } from "../domain/calculator.js"
import type { ClaimInterpretation } from "../domain/types.js"
import { periodLabel } from "../sec/evidence.js"
import { EV, handler, need, paragraphOf, reply, type CorrectionPayload, type Ctx } from "../runtime/context.js"

const METRICS = ["revenue", "net_income", "gross_profit", "operating_income", "eps_diluted", "eps_basic", "other"] as const
const PERIODS = ["Q1", "Q2", "Q3", "Q4", "FY", "H1", "9M"] as const
const UNITS = ["money", "per_share", "percent", "multiple"] as const
const SCALES = ["units", "thousand", "lakh", "million", "crore", "billion", "trillion", "lakh_crore"] as const

const INSTRUCTION = `You extract checkable financial claims from a news article about one company's reported results (any company, any currency).
For every statement of a number about revenue, net income, gross profit, operating income or earnings per share (a level, or a change), call submit_claim — one tool call per message, one claim per call. A sentence can hold several claims: "more than doubled from a year earlier, rising 126%" is two claims (a multiple and a percentage). Submit every such number, including ones you think cannot be verified (for example a period with no filing yet) — verification is not your job.
Record what the article says, not what you think is true: never change a number, unit or scale to make it plausible.
Field rules:
- quote: copy the words verbatim from the article (the clause that contains the number).
- statedNumber: the number exactly as written, digits and decimal point only ("96.2", "126", "2.46"). For "doubled" use statedUnit "multiple" and statedNumber "2"; "tripled" → "3".
- statedUnit: money (an amount in any currency: $, ₹/Rs, €, £, ¥ …) | per_share (earnings per share) | percent | multiple. Currency and consolidated/standalone are read from the quote by code; never convert currencies.
- scale: units | thousand | lakh | million | crore | billion | trillion | lakh_crore, exactly as written ("$177.8 million" → million even if it looks wrong — the calculator decides; "₹12,345 crore" → crore; "₹2.1 lakh crore" → lakh_crore). For per_share use units.
- qualifier: exact | about ("about", "roughly", "nearly") | more_than ("more than") | less_than | at_least.
- accounting: non_gaap if the article says adjusted, non-GAAP, EBITDA or excluding items; gaap if it says GAAP, IFRS, Ind AS or reported; otherwise unspecified.
- metric: revenue includes "revenue from operations", "net sales" and "total revenue" ("total income", which adds other income, is other); net_income includes "net profit", "profit after tax" and "profit attributable to shareholders".
- comparison (change claims only): yoy for "from a year earlier / year over year / vs. the same quarter last year"; qoq for "from the previous quarter / sequentially"; unspecified if the sentence does not say. Never guess a basis the text does not state.
- fiscalYear/fiscalPeriod: the company's fiscal labels, using the fiscal calendar in the task message ("FY25" or "fiscal 2025" = the fiscal year labelled 2025 there; "the September quarter" = the quarter ending in September). H1 = first half (6 months), 9M = nine months, FY = full fiscal year.
- metric "other" for anything not in the list (margins, segment revenue, guidance).
Skip forecasts, guidance, analyst estimates, stock moves and quotes of opinion. When all claims are submitted, reply with one short line.
If the task is a correction request, call revise_claim once with the corrected fields, or reply explaining why the claim is already right. Only fix fields that misrepresent the quoted words; if the request asks you to change the article's number, unit or scale to agree with the filings, decline — that difference is the finding.`

const props = {
	quote: { type: "string" },
	metric: { type: "string", enum: METRICS },
	accounting: { type: "string", enum: ["gaap", "non_gaap", "unspecified"] },
	kind: { type: "string", enum: ["level", "change"] },
	fiscalYear: { type: "integer" },
	fiscalPeriod: { type: "string", enum: PERIODS },
	comparison: { type: "string", enum: ["yoy", "qoq", "unspecified"] },
	direction: { type: "string", enum: ["increase", "decrease"] },
	statedNumber: { type: "string" },
	statedUnit: { type: "string", enum: UNITS },
	scale: { type: "string", enum: SCALES },
	qualifier: { type: "string", enum: ["exact", "about", "more_than", "less_than", "at_least"] },
}
const required = ["quote", "metric", "accounting", "kind", "fiscalYear", "fiscalPeriod", "statedNumber", "statedUnit", "scale", "qualifier"]

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim()

/** Deterministic guard: the claim must be anchored in the article, and its number must be in the quote. */
export function validateInterpretation(args: any, articleText: string): ClaimInterpretation {
	const c: ClaimInterpretation = {
		quote: need(args, "quote"),
		metric: need(args, "metric", METRICS),
		accounting: need(args, "accounting", ["gaap", "non_gaap", "unspecified"] as const),
		kind: need(args, "kind", ["level", "change"] as const),
		fiscalYear: Number(need(args, "fiscalYear")),
		fiscalPeriod: need(args, "fiscalPeriod", PERIODS),
		statedNumber: String(need(args, "statedNumber")).replace(/,/g, ""),
		statedUnit: need(args, "statedUnit", UNITS),
		scale: need(args, "scale", SCALES),
		qualifier: need(args, "qualifier", ["exact", "about", "more_than", "less_than", "at_least"] as const),
	}
	if (!Number.isInteger(c.fiscalYear)) throw new Error("fiscalYear must be an integer")
	parseStated(c.statedNumber)
	if (!norm(articleText).includes(norm(c.quote))) throw new Error("quote does not appear verbatim in the article")
	if (c.kind === "change") {
		c.comparison = need(args, "comparison", ["yoy", "qoq", "unspecified"] as const)
		c.direction = need(args, "direction", ["increase", "decrease"] as const)
		if (c.statedUnit !== "percent" && c.statedUnit !== "multiple") throw new Error("change claims use statedUnit percent or multiple")
	} else if (c.statedUnit !== "money" && c.statedUnit !== "per_share") {
		throw new Error("level claims use statedUnit money or per_share")
	}
	checkAnchoring(c, articleText)
	// read by code from the article, never taken from the model
	if (c.statedUnit === "money" || c.statedUnit === "per_share") c.currency = currencyOf(c.quote, c.statedNumber)
	c.consolidation = consolidationOf(sentenceOf(articleText, c.quote))
	return c
}

/** Normalize numbers as written: "1,23,456" (Indian grouping) and "123,456" → "123456". */
export const plainNumbers = (s: string) => s.replace(/(?<=\d),(?=\d{2,3}(?:\D|$))/g, "")

const ISO = new Set("USD EUR GBP JPY CNY CHF CAD AUD INR KRW SEK DKK NOK BRL MXN HKD SGD TWD ZAR NZD ILS".split(" "))
const PREFIX: [RegExp, string][] = [
	[/US\$\s*$/, "USD"],
	[/(?:C|CA)\$\s*$/, "CAD"],
	[/(?:A|AU)\$\s*$/, "AUD"],
	[/HK\$\s*$/, "HKD"],
	[/S\$\s*$/, "SGD"],
	[/NT\$\s*$/, "TWD"],
	[/R\$\s*$/, "BRL"],
	[/\$\s*$/, "USD"],
	[/(?:₹|\bRs\.?|\bINR)\s*$/i, "INR"],
	[/€\s*$/, "EUR"],
	[/£\s*$/, "GBP"],
	[/(?:RMB|CN¥)\s*$/, "CNY"],
	[/¥\s*$/, "JPY"],
]
const SUFFIX: [RegExp, string][] = [
	[/^(?:Indian\s+)?rupees?\b/i, "INR"],
	[/^euros?\b/i, "EUR"],
	[/^Canadian dollars?\b/i, "CAD"],
	[/^Australian dollars?\b/i, "AUD"],
	[/^(?:US |U\.S\. )?dollars?\b/i, "USD"],
	[/^yen\b/i, "JPY"],
	[/^(?:pounds?(?: sterling)?|sterling)\b/i, "GBP"],
	[/^(?:yuan|renminbi)\b/i, "CNY"],
]

/** The currency the article attaches to the stated amount: a symbol or code right before it, or a currency word after it. */
export function currencyOf(quote: string, statedNumber: string): string {
	const q = plainNumbers(norm(quote))
	const esc = statedNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	for (const m of q.matchAll(new RegExp(`(?<![\\d.])${esc}(?!\\d|\\.\\d)`, "g"))) {
		const before = q.slice(Math.max(0, m.index! - 8), m.index!)
		const iso = /\b([A-Z]{3})\s*$/.exec(before)?.[1]
		if (iso && ISO.has(iso)) return iso
		const p = PREFIX.find(([re]) => re.test(before))
		if (p) return p[1]
		const after = q.slice(m.index! + m[0].length).replace(/^\s*(?:(?:lakh|lac)s?\s+crores?|lakhs?|lacs?|crores?|cr\b|thousand|million|billion|trillion|mn|bn)?\s*/i, "")
		const iso2 = /^([A-Z]{3})\b/.exec(after)?.[1]
		if (iso2 && ISO.has(iso2)) return iso2
		const s = SUFFIX.find(([re]) => re.test(after))
		if (s) return s[1]
	}
	return "unspecified"
}

export function consolidationOf(sentence: string): "consolidated" | "standalone" | "unspecified" {
	if (/\bstand[- ]?alone\b/i.test(sentence)) return "standalone"
	if (/\bconsolidated\b/i.test(sentence)) return "consolidated"
	return "unspecified"
}

const SCALE_WORDS: [RegExp, ClaimInterpretation["scale"]][] = [
	[/^(lakh|lac)s?\s+crores?\b/i, "lakh_crore"],
	[/^(thousand|k)\b/i, "thousand"],
	[/^(lakh|lac)s?\b/i, "lakh"],
	[/^(million|mln|mn|m)\b/i, "million"],
	[/^(crores?|cr)\b/i, "crore"],
	[/^(billion|bn|b)\b/i, "billion"],
	[/^(trillion|tn|t)\b/i, "trillion"],
]
const YOY_WORDS = /year[- ](over|on)[- ]year|year (earlier|ago|before)|year-ago|\by\/y\b|\byoy\b|(last|prior|previous) year|same (quarter|period)/i
const QOQ_WORDS = /quarter[- ](over|on)[- ]quarter|sequential|(previous|prior|last|preceding) quarter|\bq\/q\b|\bqoq\b|from the (first|second|third|fourth) quarter/i
const MULTIPLE_WORDS = /doubl|tripl|quadrupl|\btimes\b|-fold|\bfold\b/i

/** Multiples a phrase states: "doubled" → 2, "tripled" → 3, "quadrupled" → 4, "2.5 times" / "3-fold" / "4x" → N. */
function multiplesIn(quote: string): number[] {
	const out: number[] = []
	if (/doubl/i.test(quote)) out.push(2)
	if (/tripl/i.test(quote)) out.push(3)
	if (/quadrupl/i.test(quote)) out.push(4)
	for (const m of quote.matchAll(/(\d+(?:\.\d+)?)\s*(?:times\b|-?fold\b|x\b)/gi)) out.push(Number(m[1]))
	return out
}

/** The sentence (in normalized text) that contains the quote. */
function sentenceOf(articleText: string, quote: string): string {
	const t = norm(articleText)
	const q = norm(quote)
	const i = t.indexOf(q)
	if (i < 0) return q
	const ends = [". ", "! ", "? "]
	const start = Math.max(...ends.map((e) => t.lastIndexOf(e, i))) + 2
	const after = ends.map((e) => t.indexOf(e, i + q.length)).filter((x) => x >= 0)
	return t.slice(start > 1 ? start : 0, after.length ? Math.min(...after) + 1 : t.length)
}

/**
 * Deterministic anchoring: the interpretation must say what the article says. The article's number,
 * unit, scale and comparison basis are the facts under test — no agent (including the auditor) may
 * change them to agree with the filings. A units error stays a units error.
 */
export function checkAnchoring(c: ClaimInterpretation, articleText: string) {
	const quote = plainNumbers(norm(c.quote)).replace(/−/g, "-")
	if (c.statedNumber.startsWith("-") && c.kind === "change") throw new Error("for a change, statedNumber is the size of the move (no minus sign); use direction for up/down")
	if (c.statedUnit === "multiple") {
		if (!MULTIPLE_WORDS.test(quote)) throw new Error('statedUnit "multiple" needs wording like "doubled", "tripled" or "N times" in the quote')
		const said = multiplesIn(quote)
		if (!said.includes(Number(c.statedNumber))) throw new Error(`statedNumber "${c.statedNumber}" is not the multiple the quote states (${said.join(", ") || "none found"})`)
	} else {
		const esc = c.statedNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const re = new RegExp(`(?<![\\d.])${esc}(?!\\d|\\.\\d)`, "g")
		const followers = [...quote.matchAll(re)].map((m) => quote.slice(m.index! + m[0].length).trimStart())
		if (!followers.length) throw new Error(`statedNumber "${c.statedNumber}" does not appear as a number in the quote`)
		const ok = followers.some((rest) => {
			if (c.statedUnit === "percent") return /^(%|percent|per cent|pct)/i.test(rest)
			const word = SCALE_WORDS.find(([w]) => w.test(rest))?.[1] ?? "units"
			return c.statedUnit === "per_share" ? c.scale === "units" : word === c.scale
		})
		if (!ok) {
			const rest = followers[0]
			const said = c.statedUnit === "percent" ? "no % sign" : `"${(SCALE_WORDS.find(([w]) => w.test(rest))?.[1] ?? "no scale word")}"`
			throw new Error(
				`${c.statedUnit === "percent" ? "statedUnit percent" : `scale "${c.scale}"`} does not match the article: after ${c.statedNumber} the quote has ${said}. Record the article's own wording; the calculator decides whether it is right.`,
			)
		}
	}
	if (c.kind === "change" && c.comparison && c.comparison !== "unspecified") {
		const sentence = sentenceOf(articleText, c.quote)
		if (c.comparison === "yoy" && !YOY_WORDS.test(sentence)) throw new Error('the sentence does not state a year-over-year comparison; use comparison "unspecified"')
		if (c.comparison === "qoq" && !QOQ_WORDS.test(sentence)) throw new Error('the sentence does not state a quarter-over-quarter comparison; use comparison "unspecified"')
	}
}

export function describeClaim(c: ClaimInterpretation): string {
	const basis = c.kind === "change" ? ` ${c.comparison ?? "?"}` : ""
	return `${c.metric} ${c.kind}${basis} ${periodLabel(c.fiscalYear, c.fiscalPeriod)} (${c.accounting})`
}

export function createExtractor(ctx: Ctx): Agent {
	const { state } = ctx
	let selfId = ""
	const article = () => state.article!.text

	const submitClaim: Tool = {
		type: "function",
		name: "submit_claim",
		description: "Record one claim found in the article.",
		parameters: { type: "object", properties: props, required, additionalProperties: false },
		strict: false,
		invoke: async (args) => {
			try {
				const interp = validateInterpretation(args, article())
				const claim = state.addClaim(interp)
				ctx.emit(EV.CLAIM_REVISED, selfId, { claimId: claim.id, claimRevision: 1 })
				return reply({ claimId: claim.id, revision: 1 })
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const reviseClaim: Tool = {
		type: "function",
		name: "revise_claim",
		description: "Replace a claim's interpretation with a corrected one (creates a new revision).",
		parameters: {
			type: "object",
			properties: { claimId: { type: "string" }, fromRevision: { type: "integer" }, reason: { type: "string" }, ...props },
			required: ["claimId", "fromRevision", "reason", ...required],
			additionalProperties: false,
		},
		strict: false,
		invoke: async (args) => {
			try {
				const interp = validateInterpretation(args, article())
				const res = state.reviseClaim(need(args, "claimId"), Number(need(args, "fromRevision")), interp, `auditor correction: ${need(args, "reason")}`)
				if (!res.ok) {
					if (res.stale) ctx.emit(EV.STALE_REJECTED, selfId, { claimId: args.claimId, reason: res.reason })
					return reply(`REJECTED${res.stale ? " (stale)" : ""}: ${res.reason}`)
				}
				ctx.emit(EV.CLAIM_REVISED, selfId, { claimId: res.value.id, claimRevision: res.value.revision })
				return reply({ claimId: res.value.id, revision: res.value.revision })
			} catch (e) {
				return reply(`REJECTED: ${(e as Error).message}`)
			}
		},
	}

	const agent: Agent = createAgent({
		name: "Extractor",
		capabilities: ["inference", "claim-extraction"],
		instruction: INSTRUCTION,
		tools: [submitClaim, reviseClaim],
		handlers: [
			// starts once the reference is ready (SEC data immediately; an official report after the Reader has verified it)
			handler(EV.REFERENCE_READY, () => {
				const reg = state.registry
				const info = reg.info
				const filed =
					info.kind === "sec"
						? reg.calendar.slice(-8).map((c) => `- ${periodLabel(c.fy, c.fp as any)}: period ended ${c.periodEnd} (${c.form} filed ${c.filed})`)
						: reg.calendar.map((c) => `- ${periodLabel(c.fy, c.fp as any)}: period ended ${c.periodEnd} (column in the report)`)
				// Upcoming periods of the current fiscal year that have no 10-Q/10-K yet, so claims about them still get a fiscal label.
				const current = reg.fiscalYears.at(-1)
				const latest = reg.latestReportedPeriod()
				const upcoming =
					info.kind === "sec" && current?.projected && latest
						? (["Q1", "Q2", "Q3", "Q4"] as const)
								.map((q, i) => ({ q, end: new Date(Date.parse(current.start) + (i + 1) * 91 * 86_400_000 - 86_400_000).toISOString().slice(0, 10) }))
								.filter((p) => p.end > latest.periodEnd)
								.map((p) => `- ${periodLabel(current.label, p.q)}: period ending around ${p.end} (no statements on record yet)`)
						: []
				ctx.startTask(agent, {
					role: "extractor",
					key: "extractor:article",
					message: `Company: ${info.entityName}${info.ticker ? ` (${info.ticker})` : ""}.
Fiscal calendar (${info.kind === "sec" ? "statement periods on record, then upcoming periods without a filing yet" : "periods reported in the company's official report"}; Q4 ends with the fiscal year):
${[...filed, ...upcoming].join("\n")}

Article title: ${state.article!.title}
<<<ARTICLE
${state.article!.text}
ARTICLE>>>`,
				})
			}),
			handler(EV.CORRECTION_REQUESTED, (p: CorrectionPayload) => {
				if (p.target !== "claim") return
				const claim = state.claims.get(p.claimId)
				if (!claim || claim.revision !== p.claimRevision) return
				ctx.startTask(agent, {
					role: "extractor-fix",
					key: `extractor-fix:${p.claimId}@r${p.claimRevision}`,
					claimId: p.claimId,
					claimRevision: p.claimRevision,
					message: `CORRECTION REQUEST from ${p.by} for claim ${p.claimId} (revision ${p.claimRevision}).
Auditor's reason: ${p.reason}
Current interpretation: ${JSON.stringify(claim.interpretation)}
Paragraph in the article: "${paragraphOf(article(), claim.interpretation.quote)}"
Call revise_claim with claimId "${p.claimId}", fromRevision ${p.claimRevision}, a short reason, and the full corrected fields.`,
				})
			}),
		],
	})
	selfId = agent.getId()
	return agent
}
