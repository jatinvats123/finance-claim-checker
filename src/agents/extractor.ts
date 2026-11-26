/** Extractor agent (LLM): turns article sentences into structured claims, and fixes a claim when the auditor asks. */
import { createAgent, type Agent, type Tool } from "@mozaik-ai/core"
import { parseStated } from "../domain/calculator.js"
import type { ClaimInterpretation } from "../domain/types.js"
import { periodLabel } from "../sec/evidence.js"
import { EV, handler, need, paragraphOf, reply, type CorrectionPayload, type Ctx } from "../runtime/context.js"

const METRICS = ["revenue", "net_income", "gross_profit", "operating_income", "eps_diluted", "eps_basic", "other"] as const
const PERIODS = ["Q1", "Q2", "Q3", "Q4", "FY", "H1", "9M"] as const

const INSTRUCTION = `You extract checkable financial claims from a news article about one company's reported results.
For every statement of a number about revenue, net income, gross profit, operating income or earnings per share (a level, or a change), call submit_claim — one tool call per message, one claim per call. A sentence can hold several claims: "more than doubled from a year earlier, rising 126%" is two claims (a multiple and a percentage). Submit every such number, including ones you think cannot be verified (for example a period with no filing yet) — verification is not your job.
Record what the article says, not what you think is true: never change a number, unit or scale to make it plausible.
Field rules:
- quote: copy the words verbatim from the article (the clause that contains the number).
- statedNumber: the number exactly as written, digits and decimal point only ("96.2", "126", "2.46"). For "doubled" use statedUnit "multiple" and statedNumber "2"; "tripled" → "3".
- statedUnit: usd | usd_per_share | percent | multiple. scale: units | thousand | million | billion | trillion, exactly as written ("$177.8 million" → million, even if it looks wrong — the calculator decides).
- qualifier: exact | about ("about", "roughly", "nearly") | more_than ("more than") | less_than | at_least.
- accounting: non_gaap if the article says adjusted, non-GAAP or excluding items; gaap if it says GAAP; otherwise unspecified.
- comparison (change claims only): yoy for "from a year earlier / year over year / vs. the same quarter last year"; qoq for "from the previous quarter / sequentially"; unspecified if the sentence does not say. Never guess a basis the text does not state.
- fiscalYear/fiscalPeriod: the company's fiscal labels, using the fiscal calendar in the task message. H1 = first half (6 months), 9M = nine months, FY = full fiscal year.
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
	statedUnit: { type: "string", enum: ["usd", "usd_per_share", "percent", "multiple"] },
	scale: { type: "string", enum: ["units", "thousand", "million", "billion", "trillion"] },
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
		statedUnit: need(args, "statedUnit", ["usd", "usd_per_share", "percent", "multiple"] as const),
		scale: need(args, "scale", ["units", "thousand", "million", "billion", "trillion"] as const),
		qualifier: need(args, "qualifier", ["exact", "about", "more_than", "less_than", "at_least"] as const),
	}
	if (!Number.isInteger(c.fiscalYear)) throw new Error("fiscalYear must be an integer")
	parseStated(c.statedNumber)
	if (!norm(articleText).includes(norm(c.quote))) throw new Error("quote does not appear verbatim in the article")
	if (c.statedUnit !== "multiple" && !norm(c.quote).replace(/,/g, "").includes(c.statedNumber)) throw new Error(`statedNumber "${c.statedNumber}" does not appear in the quote`)
	if (c.kind === "change") {
		c.comparison = need(args, "comparison", ["yoy", "qoq", "unspecified"] as const)
		c.direction = need(args, "direction", ["increase", "decrease"] as const)
		if (c.statedUnit !== "percent" && c.statedUnit !== "multiple") throw new Error("change claims use statedUnit percent or multiple")
	} else if (c.statedUnit !== "usd" && c.statedUnit !== "usd_per_share") {
		throw new Error("level claims use statedUnit usd or usd_per_share")
	}
	checkAnchoring(c, articleText)
	return c
}

const SCALE_WORDS: [RegExp, ClaimInterpretation["scale"]][] = [
	[/^(thousand|k)\b/i, "thousand"],
	[/^(million|mln|mn|m)\b/i, "million"],
	[/^(billion|bn|b)\b/i, "billion"],
	[/^(trillion|tn|t)\b/i, "trillion"],
]
const YOY_WORDS = /year[- ](over|on)[- ]year|year (earlier|ago|before)|year-ago|\by\/y\b|\byoy\b|(last|prior|previous) year|same (quarter|period)/i
const QOQ_WORDS = /quarter[- ](over|on)[- ]quarter|sequential|(previous|prior|last|preceding) quarter|\bq\/q\b|\bqoq\b|from the (first|second|third|fourth) quarter/i
const MULTIPLE_WORDS = /doubl|tripl|quadrupl|\btimes\b|-fold|\bfold\b/i

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
	const quote = norm(c.quote).replace(/,/g, "")
	if (c.statedUnit === "multiple") {
		if (!MULTIPLE_WORDS.test(quote)) throw new Error('statedUnit "multiple" needs wording like "doubled", "tripled" or "N times" in the quote')
	} else {
		const esc = c.statedNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const re = new RegExp(`(?<![\\d.])${esc}(?!\\d|\\.\\d)`, "g")
		const followers = [...quote.matchAll(re)].map((m) => quote.slice(m.index! + m[0].length).trimStart())
		if (!followers.length) throw new Error(`statedNumber "${c.statedNumber}" does not appear as a number in the quote`)
		const ok = followers.some((rest) => {
			if (c.statedUnit === "percent") return /^(%|percent|per cent|pct)/i.test(rest)
			const word = SCALE_WORDS.find(([w]) => w.test(rest))?.[1] ?? "units"
			return c.statedUnit === "usd_per_share" ? c.scale === "units" : word === c.scale
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
			handler(EV.ARTICLE_SUBMITTED, () => {
				const reg = state.registry
				const cal = reg.calendar
					.slice(-8)
					.map((c) => `- ${periodLabel(c.fy, c.fp === "FY" ? "FY" : (c.fp as any))}: period ended ${c.periodEnd} (${c.form} filed ${c.filed})`)
					.join("\n")
				ctx.startTask(agent, {
					role: "extractor",
					key: "extractor:article",
					message: `Company: ${reg.snapshot.entityName} (${reg.snapshot.ticker}).
Fiscal calendar (periods covered by 10-Q/10-K filings on record; Q4 ends with the fiscal year; the next quarters follow at ~13-week steps):
${cal}

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
