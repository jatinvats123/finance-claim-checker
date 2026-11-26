/**
 * HAND-WRITTEN model responses for the keyless NVIDIA demo. These are NOT recorded model output.
 *
 * They script what each agent "says" so the full workflow — extraction, evidence binding, the
 * deterministic calculator, the auditor's rule gate, an LLM-review correction, revision control and a
 * stale late result — can run with no API key. Everything else runs for real: SEC evidence lookup,
 * calculations, validation, revision checks.
 *
 * Two mistakes are scripted on purpose so the correction paths run:
 *  - c3: the evidence agent first binds the previous quarter as a year-over-year base (caught by the rule gate)
 *  - c4: the extractor first labels the profit figure "GAAP" although the sentence does not say so (caught by
 *        the LLM review; code cannot tell whether an article's "net income" means GAAP)
 * The c4 r1 context review is given a long simulated delay so its late result arrives after r2 exists.
 *
 * Seal into replay fixtures with:  npm run fixtures:seal
 */
import type { AuthorScript, ScriptTurn } from "../src/llm/runner.js"

const LATENCY = 120 // simulated model latency per turn (ms), so concurrency is visible in the live view
const call = (name: string, args: Record<string, unknown>, delayMs = LATENCY): ScriptTurn => ({ call: { name, args }, delayMs })
const say = (text: string, delayMs = LATENCY): ScriptTurn => ({ say: text, delayMs })

const claim = (o: Record<string, unknown>) => ({ accounting: "unspecified", qualifier: "exact", scale: "units", ...o })
const search = (metric: string, fiscalYear: number, fiscalPeriod: string) => call("search_facts", { metric, fiscalYear, fiscalPeriod })
const bind = (claimId: string, claimRevision: number, currentFactId: string, extra: Record<string, string> = {}) => call("bind_evidence", { claimId, claimRevision, currentFactId, ...extra })
const approve = (claimId: string, claimRevision: number, evidenceRevision: number, note: string) => [call("approve", { claimId, claimRevision, evidenceRevision, note }), say("done")]

const C4_R1 = claim({
	quote: "Net income climbed 18% to $59.7 billion",
	metric: "net_income",
	accounting: "gaap",
	kind: "change",
	fiscalYear: 2027,
	fiscalPeriod: "Q2",
	comparison: "unspecified",
	direction: "increase",
	statedNumber: "18",
	statedUnit: "percent",
})

const script: AuthorScript = {
	description:
		"Hand-written model responses for the NVIDIA Q2 FY2027 demo article (not recorded model output). Includes simulated latency and two deliberate agent mistakes to exercise the auditor's correction paths.",
	tasks: {
		"extractor:article": [
			call("submit_claim", claim({ quote: "Nvidia reported revenue of $96.2 billion for its fiscal second quarter of 2027", metric: "revenue", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "96.2", statedUnit: "usd", scale: "billion" })),
			call("submit_claim", claim({ quote: "Revenue more than doubled from a year earlier", metric: "revenue", kind: "change", fiscalYear: 2027, fiscalPeriod: "Q2", comparison: "yoy", direction: "increase", statedNumber: "2", statedUnit: "multiple", qualifier: "more_than" })),
			call("submit_claim", claim({ quote: "Revenue more than doubled from a year earlier, rising 126%", metric: "revenue", kind: "change", fiscalYear: 2027, fiscalPeriod: "Q2", comparison: "yoy", direction: "increase", statedNumber: "126", statedUnit: "percent" })),
			call("submit_claim", C4_R1),
			call("submit_claim", claim({ quote: "Net income climbed 18% to $59.7 billion", metric: "net_income", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "59.7", statedUnit: "usd", scale: "billion" })),
			call("submit_claim", claim({ quote: "diluted earnings per share came in at $2.46", metric: "eps_diluted", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "2.46", statedUnit: "usd_per_share" })),
			call("submit_claim", claim({ quote: "Excluding one-time items, adjusted net income was $54.0 billion", metric: "net_income", accounting: "non_gaap", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q2", statedNumber: "54.0", statedUnit: "usd", scale: "billion" })),
			call("submit_claim", claim({ quote: "For the first half of fiscal 2027, revenue totaled $177.8 million", metric: "revenue", kind: "level", fiscalYear: 2027, fiscalPeriod: "H1", statedNumber: "177.8", statedUnit: "usd", scale: "million" })),
			call("submit_claim", claim({ quote: "That compares with revenue of $57.0 billion for all of fiscal 2026", metric: "revenue", kind: "level", fiscalYear: 2026, fiscalPeriod: "FY", statedNumber: "57.0", statedUnit: "usd", scale: "billion" })),
			call("submit_claim", claim({ quote: "Last week Nvidia said third-quarter revenue reached $115.8 billion", metric: "revenue", kind: "level", fiscalYear: 2027, fiscalPeriod: "Q3", statedNumber: "115.8", statedUnit: "usd", scale: "billion" })),
			say("Submitted 10 claims."),
		],

		// ---- evidence agent ----
		"evidence:c1@r1#1": [search("revenue", 2027, "Q2"), bind("c1", 1, "Revenues/Q2-FY2027/26-000075"), say("done")],
		"evidence:c2@r1#1": [search("revenue", 2027, "Q2"), search("revenue", 2026, "Q2"), bind("c2", 1, "Revenues/Q2-FY2027/26-000075", { baseFactId: "Revenues/Q2-FY2026/26-000075" }), say("done")],
		// Deliberate mistake: previous quarter used as a year-over-year base. The rule gate blocks it.
		"evidence:c3@r1#1": [search("revenue", 2027, "Q2"), search("revenue", 2027, "Q1"), bind("c3", 1, "Revenues/Q2-FY2027/26-000075", { baseFactId: "Revenues/Q1-FY2027/26-000052" }), say("done")],
		"evidence:c3@r1#2": [search("revenue", 2026, "Q2"), bind("c3", 1, "Revenues/Q2-FY2027/26-000075", { baseFactId: "Revenues/Q2-FY2026/26-000075" }), say("Rebound with the year-over-year comparative from the same 10-Q.")],
		"evidence:c4@r1#1": [
			search("net_income", 2027, "Q2"),
			search("net_income", 2026, "Q2"),
			search("net_income", 2027, "Q1"),
			bind("c4", 1, "NetIncomeLoss/Q2-FY2027/26-000075", { baseFactId: "NetIncomeLoss/Q2-FY2026/26-000075", alternateBaseFactId: "NetIncomeLoss/Q1-FY2027/26-000052" }),
			say("done"),
		],
		"evidence:c4@r2#1": [
			search("net_income", 2027, "Q2"),
			search("net_income", 2026, "Q2"),
			search("net_income", 2027, "Q1"),
			bind("c4", 2, "NetIncomeLoss/Q2-FY2027/26-000075", { baseFactId: "NetIncomeLoss/Q2-FY2026/26-000075", alternateBaseFactId: "NetIncomeLoss/Q1-FY2027/26-000052" }),
			say("done"),
		],
		"evidence:c5@r1#1": [search("net_income", 2027, "Q2"), bind("c5", 1, "NetIncomeLoss/Q2-FY2027/26-000075"), say("done")],
		"evidence:c6@r1#1": [search("eps_diluted", 2027, "Q2"), bind("c6", 1, "EarningsPerShareDiluted/Q2-FY2027/26-000075"), say("done")],
		"evidence:c8@r1#1": [search("revenue", 2027, "H1"), bind("c8", 1, "Revenues/H1-FY2027/26-000075"), say("done")],
		"evidence:c9@r1#1": [search("revenue", 2026, "FY"), bind("c9", 1, "Revenues/FY-FY2026/26-000021"), say("done")],
		"evidence:c10@r1#1": [search("revenue", 2027, "Q3"), call("report_no_reference", { claimId: "c10", claimRevision: 1 }), say("done")],

		// ---- auditor (LLM review; runs only after the rule gate passes) ----
		"auditor:c1@r1.e1": approve("c1", 1, 1, "Quarterly GAAP revenue for Q2 FY2027 read correctly."),
		"auditor:c2@r1.e1": approve("c2", 1, 1, '"More than doubled from a year earlier" is a year-over-year multiple above 2×; reading is faithful.'),
		"auditor:c3@r1.e2": approve("c3", 1, 2, "Interpretation faithful (year-over-year, 126%); the article's figure does not match the filings."),
		"auditor:c4@r1.e1": [
			call("request_correction", {
				claimId: "c4",
				claimRevision: 1,
				evidenceRevision: 1,
				target: "claim",
				reason: 'The sentence "Net income climbed 18% to $59.7 billion" does not say whether this is GAAP or adjusted net income. accounting must be "unspecified", not "gaap".',
			}),
			say("done"),
		],
		"auditor:c4@r2.e2": approve("c4", 2, 2, "Accounting basis now correctly unspecified; checked against GAAP net income, year-over-year by convention, with the quarter-over-quarter figure shown as context."),
		"auditor:c5@r1.e1": approve("c5", 1, 1, "GAAP net income level for Q2 FY2027 read correctly."),
		"auditor:c6@r1.e1": approve("c6", 1, 1, "Diluted EPS for Q2 FY2027 read correctly."),
		"auditor:c8@r1.e1": approve("c8", 1, 1, 'The article literally says "million"; interpretation is faithful, the article is off by a factor of 1,000.'),
		"auditor:c9@r1.e1": approve("c9", 1, 1, '"All of fiscal 2026" is the full fiscal year; interpretation is faithful.'),

		// ---- extractor correction ----
		"extractor-fix:c4@r1": [call("revise_claim", { claimId: "c4", fromRevision: 1, reason: "the sentence does not say GAAP or adjusted", ...C4_R1, accounting: "unspecified" }), say("done")],

		// ---- context agent ----
		"context:c1@r1": [say("no context issues")],
		"context:c2@r1": [say("no context issues")],
		"context:c3@r1": [
			call("add_context_warning", { claimId: "c3", claimRevision: 1, code: "MISLEADING_FRAMING", message: 'The headline-style growth rate is attached to revenue, but "126%" is the kind of figure that is easily transposed from another line of an earnings table.' }),
			say("done"),
		],
		// Slow review of the first revision: its warning arrives after c4 has moved to r2 and is rejected as stale.
		"context:c4@r1": [
			call("add_context_warning", { claimId: "c4", claimRevision: 1, code: "MISLEADING_FRAMING", message: "The growth rate is placed next to the dollar figure without saying what it is measured against." }, 2500),
			say("done"),
		],
		"context:c4@r2": [
			call("add_context_warning", { claimId: "c4", claimRevision: 2, code: "MISLEADING_FRAMING", message: "The growth rate is placed next to the dollar figure without saying what it is measured against, so readers will assume a year-over-year comparison." }),
			say("done"),
		],
		"context:c5@r1": [say("no context issues")],
		"context:c6@r1": [say("no context issues")],
		"context:c7@r1": [
			call("add_context_warning", { claimId: "c7", claimRevision: 1, code: "MISLEADING_FRAMING", message: '"One-time items" is the article\'s phrase; the adjustments are defined by the company, not by accounting standards.' }),
			say("done"),
		],
		"context:c8@r1": [say("no context issues")],
		"context:c9@r1": [say("no context issues")],
		"context:c10@r1": [
			call("add_context_warning", { claimId: "c10", claimRevision: 1, code: "ATTRIBUTION", message: "The figure comes from the company's own announcement; the sentence does not tell readers it has not yet appeared in filed financial statements." }),
			say("done"),
		],
	},
}

export default script
