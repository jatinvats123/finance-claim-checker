import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { parseArgs } from "node:util"
import type { Claim, Metric } from "../src/domain/types.js"
import type { CheckerState } from "../src/domain/store.js"
import { defaultModel, providerConfigured } from "../src/llm/cassettes.js"
import { CheckerRunner } from "../src/llm/runner.js"
import { EV } from "../src/runtime/context.js"
import { runChecker } from "../src/runtime/pipeline.js"
import { TaskTracker } from "../src/runtime/tasks.js"
import { LaneTracer } from "../src/runtime/trace.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry, type FiscalPeriod } from "../src/sec/evidence.js"
import { claimView, referenceView } from "../src/web/viewmodel.js"
import { correctionText } from "../web/src/correction.js"

type Expected = { anchor: string; truth: string } & (
	| { outcome: "MATCH" | "MISMATCH"; metric: Exclude<Metric, "other">; year: number; period: FiscalPeriod; value: number; currency: string; accessions: string[] }
	| { outcome: "SKIP" | "ABSTAIN" }
)
type Draft = { id: string; article: { ticker: string; title: string; text: string }; expected: Expected[] }

const { values } = parseArgs({ options: { out: { type: "string" }, case: { type: "string" }, "verify-only": { type: "boolean" } } })
const manifest = JSON.parse(readFileSync("eval/editor-deadline-cases.json", "utf8")) as { deadlineMs: number; snapshotHashes: Record<string, string>; cases: Draft[] }
const selected = [...manifest.cases.entries()].filter(([, draft]) => !values.case || draft.id === values.case)
if (!selected.length) throw new Error(`Unknown draft: ${values.case}. Choose from ${manifest.cases.map(draft => draft.id).join(", ")}.`)
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex")
const snapshots = new Map(Object.entries(manifest.snapshotHashes).map(([ticker, expected]) => {
	const snapshot = loadSnapshot(ticker)
	if (hash(snapshot) !== expected) throw new Error(`${ticker}: filing snapshot changed since the experiment was defined`)
	return [ticker, snapshot]
}))

function hasTruth(expected: Expected, registry: EvidenceRegistry): boolean {
	if (!("value" in expected)) return true
	return registry.search(expected.metric, expected.year, expected.period).some(fact => {
		const accessions = fact.derivation?.inputIds.map(id => registry.get(id)?.accn) ?? [fact.accn]
		return fact.value === expected.value && fact.currency === expected.currency && expected.accessions.every(accession => accessions.includes(accession))
	})
}

for (const draft of manifest.cases) {
	const snapshot = snapshots.get(draft.article.ticker)
	if (!snapshot) throw new Error(`${draft.id}: missing pinned filing snapshot`)
	const registry = new EvidenceRegistry(snapshot)
	for (const expected of draft.expected) {
		if (draft.article.text.split(expected.anchor).length !== 2 || !hasTruth(expected, registry)) {
			throw new Error(`${draft.id}: invalid frozen expectation for ${expected.anchor}`)
		}
	}
}

function readClaim(state: CheckerState, claim: Claim, finished: boolean, draft: Draft) {
	const view = claimView(state, claim, finished)
	const expected = draft.expected.find(item => view.quote.includes(item.anchor))
	const current = view.calc?.inputs.find(input => input.role === "current")
	const accessions = view.calc?.inputs.flatMap(input => (input.derivationInputs ?? [input]).map(fact => fact.accn)) ?? []
	const correction = correctionText({ reference: referenceView(state) }, view)
	const { interpretation } = view
	const reviewFinished = view.review.status === "complete"
	let correct = false
	if (expected && "value" in expected) {
		correct = reviewFinished && view.verdict === expected.outcome && interpretation.kind === "level" && interpretation.metric === expected.metric
			&& interpretation.fiscalYear === expected.year && interpretation.fiscalPeriod === expected.period && current?.value === expected.value
			&& current.currency === expected.currency && expected.accessions.every(accession => accessions.includes(accession))
	} else if (expected?.outcome === "ABSTAIN") {
		correct = reviewFinished && !correction && interpretation.accounting === "non_gaap" && ["NOT_COMPUTABLE", "NOT_VERIFIABLE"].includes(view.verdict)
	}
	return { anchor: expected?.anchor, claimId: claim.id, revision: claim.revision, evidenceRevision: view.calc?.evidenceRevision, quote: view.quote, interpretation,
		verdict: view.verdict, review: view.review, correct, correctCorrection: !!correction && correct && expected?.outcome === "MISMATCH", correction, inputs: view.calc?.inputs, history: view.history }
}

async function live() {
	if (existsSync(".env")) process.loadEnvFile(".env")
	if (!providerConfigured()) throw new Error("Configure a live provider to run this benchmark.")
	const model = defaultModel()
	const limits = { maxCalls: 35, maxConcurrent: 4, rpm: 12, requestTimeoutMs: 30_000, retries: 1 }
	const pauseBetweenArmsMs = 5000
	const timeoutMs = 180_000
	const specHash = hash(manifest)
	const folder = values.out ?? (values.case ? join("out", "benchmark-editor-targeted", values.case) : "out/benchmark-editor-live")
	mkdirSync(folder, { recursive: true })
	const protocol = { mode: "live", scope: values.case ? "targeted" : "full", draftIds: selected.map(([, draft]) => draft.id), startedAt: new Date().toISOString(), model, limits, timeoutMs, pauseBetweenArmsMs, deadlineMs: manifest.deadlineMs, specHash, snapshotHashes: manifest.snapshotHashes }
	const write = (file: string, value: unknown) => writeFileSync(join(folder, file), JSON.stringify(value, null, 2) + "\n")
	write("protocol.json", protocol)
	const rows = []
	for (const [index, draft] of selected) {
		for (const serial of index % 2 === 0 ? [true, false] : [false, true]) {
			if (rows.length) await wait(pauseBetweenArmsMs)
			const scheduler = serial ? "serial" : "concurrent"
			console.log(`Starting live ${draft.id} / ${scheduler}`)
			const tasks = new TaskTracker()
			const tracer = new LaneTracer(tasks)
			const runner = new CheckerRunner({ mode: "live", tasks, model, limits })
			const offers = new Map<string, ReturnType<typeof readClaim> & { timeMs: number }>()
			const start = performance.now()
			const result = await runChecker({
				article: draft.article, snapshot: snapshots.get(draft.article.ticker), runner, tasks, model, serial, timeoutMs,
				onEvent(event, _, state) {
					tracer.onEvent(event)
					if (event.type !== EV.CALCULATION_COMPLETED && event.type !== EV.AUDIT_FINAL && event.type !== EV.CONTEXT_DONE) return
					const claim = state.claims.get((event.payload as { claimId: string }).claimId)
					if (!claim || !state.isSettled(claim.id)) return
					const receipt = readClaim(state, claim, false, draft)
					const key = `${receipt.claimId}/${receipt.revision}/${receipt.evidenceRevision}`
					if (receipt.correction && !offers.has(key)) offers.set(key, { ...receipt, timeMs: Math.round(performance.now() - start) })
				},
			})
			const claims = [...result.state.claims.values()].map(claim => readClaim(result.state, claim, true, draft))
			const expected = draft.expected.map(item => {
				const matching = claims.filter(claim => claim.anchor === item.anchor)
				const correct = item.outcome === "SKIP" ? matching.length === 0 && result.state.extraction === "done" : matching.some(claim => claim.correct)
				const unfinished = item.outcome !== "SKIP" && !matching.some(claim => claim.review.status === "complete")
				return { anchor: item.anchor, outcome: item.outcome, correct, unfinished }
			})
			const provenance: Record<string, number> = {}
			for (const call of runner.calls) provenance[call.provenance] = (provenance[call.provenance] ?? 0) + 1
			const trace = tracer.trace(provenance)
			const allOffers = [...offers.values()]
			const correctAtCutoff = new Set(allOffers.filter(offer => offer.correctCorrection && offer.timeMs <= manifest.deadlineMs).map(offer => offer.anchor))
			const row = {
				case: draft.id, scheduler, correctByCutoff: correctAtCutoff.size, expectedCorrections: expected.filter(item => item.outcome === "MISMATCH").length,
				falseCorrections: allOffers.filter(offer => !offer.correctCorrection).length + claims.filter(claim => claim.correction && !claim.correctCorrection && !offers.has(`${claim.claimId}/${claim.revision}/${claim.evidenceRevision}`)).length,
				unfinishedReviews: expected.filter(item => item.unfinished).length, correctOutcomes: expected.filter(item => item.correct).length, expectedOutcomes: expected.length,
				elapsedMs: result.elapsedMs, timedOut: result.timedOut, extraction: result.state.extraction, peakLoops: trace.peakActive, calls: provenance,
			}
			rows.push(row)
			write(`${draft.id}-${scheduler}.json`, { row, expected, claims, offers: allOffers.map(({ history: _, ...offer }) => offer), trace })
			write("results.json", { ...protocol, complete: rows.length === selected.length * 2, rows })
			console.log(JSON.stringify(row))
		}
	}
}

if (values["verify-only"]) console.log(`Verified ${manifest.cases.length} fixed drafts, ${snapshots.size} SEC snapshots and their evidence assertions. Spec: ${hash(manifest)}`)
else await live()
