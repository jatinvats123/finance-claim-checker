import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
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

type Expected = { anchor: string; truth: string; statedNumber?: string } & (
	| { outcome: "MATCH" | "MISMATCH"; metric: Exclude<Metric, "other">; year: number; period: FiscalPeriod; value: number; currency: string; accessions: string[] }
	| { outcome: "SKIP" }
	| { outcome: "ABSTAIN"; reason?: "non-gaap" }
	| { outcome: "ABSTAIN"; reason: "unsupported-currency"; statedCurrency: string; metric: Exclude<Metric, "other">; year: number; period: FiscalPeriod }
)
type Draft = { id: string; article: { ticker: string; title: string; text: string }; expected: Expected[] }
type Scheduler = "serial" | "concurrent"
type CompletedArm = { case: string; scheduler: Scheduler; timedOut: boolean }
const armTimeoutMs = 180_000
const recoveryQuietMs = 60_000

const { values } = parseArgs({ options: { manifest: { type: "string" }, out: { type: "string" }, case: { type: "string" }, resume: { type: "boolean" }, "verify-only": { type: "boolean" } } })
const manifestPath = values.manifest ?? "eval/editor-deadline-cases.json"
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { deadlineMs: number; secondaryDeadlineMs?: number; snapshotHashes: Record<string, string>; cases: Draft[] }
if (!Number.isFinite(manifest.deadlineMs) || manifest.deadlineMs <= 0 || manifest.deadlineMs > armTimeoutMs || (manifest.secondaryDeadlineMs !== undefined && (!Number.isFinite(manifest.secondaryDeadlineMs) || manifest.secondaryDeadlineMs <= 0 || manifest.secondaryDeadlineMs >= manifest.deadlineMs))) throw new Error("The manifest cutoffs must be positive, strictly ordered and at most 180 seconds")
const selected = [...manifest.cases.entries()].filter(([, draft]) => !values.case || draft.id === values.case)
if (!selected.length) throw new Error(`Unknown draft: ${values.case}. Choose from ${manifest.cases.map(draft => draft.id).join(", ")}.`)
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex")
const snapshots = new Map(Object.entries(manifest.snapshotHashes).map(([ticker, expected]) => {
	const snapshot = loadSnapshot(ticker)
	if (hash(snapshot) !== expected) throw new Error(`${ticker}: filing snapshot changed since the experiment was defined`)
	return [ticker, snapshot]
}))

function hasTruth(expected: Expected, registry: EvidenceRegistry): boolean {
	if (expected.outcome === "ABSTAIN" && expected.reason === "unsupported-currency") {
		const facts = registry.search(expected.metric, expected.year, expected.period)
		return facts.length > 0 && facts.every(fact => fact.currency !== expected.statedCurrency)
	}
	if (!("value" in expected)) return true
	return registry.search(expected.metric, expected.year, expected.period).some(fact => {
		const accessions = fact.derivation?.inputIds.map(id => registry.get(id)?.accn) ?? [fact.accn]
		return fact.value === expected.value && fact.currency === expected.currency && expected.accessions.every(accession => accessions.includes(accession))
	})
}

const draftIds = new Set<string>()
for (const draft of manifest.cases) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.id) || draftIds.has(draft.id)) throw new Error(`Invalid or duplicate draft ID: ${draft.id}`)
	draftIds.add(draft.id)
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
	const { interpretation } = view
	const candidates = draft.expected.filter(item => view.quote.includes(item.anchor))
	const sameNumber = (item: Expected) => item.statedNumber === undefined || Number(item.statedNumber.replaceAll(",", "")) === Number(interpretation.statedNumber.replaceAll(",", ""))
	const expected = candidates.find(sameNumber) ?? (candidates.length === 1 ? candidates[0] : undefined)
	const current = view.calc?.inputs.find(input => input.role === "current")
	const accessions = view.calc?.inputs.flatMap(input => (input.derivationInputs ?? [input]).map(fact => fact.accn)) ?? []
	const correction = correctionText({ reference: referenceView(state) }, view)
	const reviewFinished = view.review.status === "complete"
	let correct = false
	if (expected && "value" in expected) {
		correct = sameNumber(expected) && reviewFinished && view.verdict === expected.outcome && interpretation.kind === "level" && interpretation.metric === expected.metric
			&& interpretation.fiscalYear === expected.year && interpretation.fiscalPeriod === expected.period && current?.value === expected.value
			&& current.currency === expected.currency && expected.accessions.every(accession => accessions.includes(accession))
	} else if (expected?.outcome === "ABSTAIN") {
		const correctReason = expected.reason === "unsupported-currency"
			? interpretation.currency === expected.statedCurrency && interpretation.metric === expected.metric && interpretation.fiscalYear === expected.year && interpretation.fiscalPeriod === expected.period
			: interpretation.accounting === "non_gaap"
		correct = sameNumber(expected) && reviewFinished && !correction && correctReason && ["NOT_COMPUTABLE", "NOT_VERIFIABLE"].includes(view.verdict)
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
	const timeoutMs = armTimeoutMs
	const specHash = hash(manifest)
	const defaultFolder = values.manifest ? join("out", "benchmark-editor-manifests", basename(manifestPath, ".json"), ...(values.case ? [values.case] : []))
		: values.case ? join("out", "benchmark-editor-targeted", values.case) : "out/benchmark-editor-live"
	const folder = values.out ?? defaultFolder
	mkdirSync(folder, { recursive: true })
	const protocol = { mode: "live", scope: values.case ? "targeted" : "full", ...(values.manifest ? { manifest: basename(manifestPath) } : {}), draftIds: selected.map(([, draft]) => draft.id), startedAt: new Date().toISOString(), model, limits, timeoutMs, pauseBetweenArmsMs, deadlineMs: manifest.deadlineMs, secondaryDeadlineMs: manifest.secondaryDeadlineMs, specHash, snapshotHashes: manifest.snapshotHashes }
	const schedule = selected.flatMap(([index, draft]) => {
		const modes: Scheduler[] = index % 2 === 0 ? ["serial", "concurrent"] : ["concurrent", "serial"]
		return modes.map(scheduler => ({ draft, scheduler }))
	})
	const write = (file: string, value: unknown) => writeFileSync(join(folder, file), JSON.stringify(value, null, 2) + "\n")
	const read = (file: string) => JSON.parse(readFileSync(join(folder, file), "utf8")) as unknown
	if (values.manifest && !values.resume && existsSync(join(folder, "results.json"))) throw new Error(`Benchmark results already exist in ${folder}; select a fresh folder or resume the matching run`)
	const previous = values.resume ? read("results.json") as typeof protocol & { rows: CompletedArm[]; resumedAt?: string[] } : undefined
	if (previous) {
		for (const [key, value] of Object.entries(protocol)) {
			if (key !== "startedAt" && JSON.stringify(previous[key as keyof typeof protocol]) !== JSON.stringify(value)) throw new Error(`Cannot resume: ${key} differs from the original protocol`)
		}
		if (!Array.isArray(previous.rows) || previous.rows.length > schedule.length || !Number.isFinite(Date.parse(previous.startedAt))) throw new Error("Cannot resume: invalid saved benchmark summary")
		for (const [index, row] of previous.rows.entries()) {
			if (row.case !== schedule[index].draft.id || row.scheduler !== schedule[index].scheduler) throw new Error(`Cannot resume: saved arm ${index + 1} differs from the declared order`)
			const receipt = read(`${row.case}-${row.scheduler}.json`) as { row: CompletedArm }
			if (JSON.stringify(receipt.row) !== JSON.stringify(row)) throw new Error(`Cannot resume: receipt differs for ${row.case} / ${row.scheduler}`)
		}
		if (previous.rows.length === schedule.length) {
			console.log("All scheduled benchmark arms are already complete")
			return
		}
		console.log(`Resuming after ${previous.rows.length} saved arms. Waiting 60 seconds before sending requests.`)
		await wait(recoveryQuietMs)
	}
	const runProtocol = previous ? { ...protocol, startedAt: previous.startedAt, resumedAt: [...(previous.resumedAt ?? []), protocol.startedAt] } : protocol
	write("protocol.json", runProtocol)
	const rows: CompletedArm[] = previous?.rows ?? []
	for (const { draft, scheduler } of schedule.slice(rows.length)) {
		if (rows.length) await wait(pauseBetweenArmsMs)
		console.log(`Starting live ${draft.id} / ${scheduler}`)
		const startedAt = new Date().toISOString()
		const tasks = new TaskTracker()
		const tracer = new LaneTracer(tasks)
		const runner = new CheckerRunner({ mode: "live", tasks, model, limits })
		const offers = new Map<string, ReturnType<typeof readClaim> & { timeMs: number }>()
		const start = performance.now()
		const result = await runChecker({
			article: draft.article, snapshot: snapshots.get(draft.article.ticker), runner, tasks, model, serial: scheduler === "serial", timeoutMs,
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
		const correctAt = (cutoff: number) => new Set(allOffers.filter(offer => offer.correctCorrection && offer.timeMs <= cutoff).map(offer => offer.anchor)).size
		const row = {
			case: draft.id, scheduler, correctByCutoff: correctAt(manifest.deadlineMs),
			...(manifest.secondaryDeadlineMs === undefined ? {} : { correctBySecondaryCutoff: correctAt(manifest.secondaryDeadlineMs) }),
			expectedCorrections: expected.filter(item => item.outcome === "MISMATCH").length,
			falseCorrections: allOffers.filter(offer => !offer.correctCorrection).length + claims.filter(claim => claim.correction && !claim.correctCorrection && !offers.has(`${claim.claimId}/${claim.revision}/${claim.evidenceRevision}`)).length,
			unfinishedReviews: expected.filter(item => item.unfinished).length, correctOutcomes: expected.filter(item => item.correct).length, expectedOutcomes: expected.length,
			elapsedMs: result.elapsedMs, timedOut: result.timedOut, extraction: result.state.extraction, peakLoops: trace.peakActive, calls: provenance,
		}
		rows.push(row)
		write(`${draft.id}-${scheduler}.json`, { startedAt, row, expected, claims, offers: allOffers.map(({ history: _, ...offer }) => offer), trace })
		write("results.json", { ...runProtocol, complete: rows.length === schedule.length, rows })
		console.log(JSON.stringify(row))
		if (result.timedOut && rows.length < schedule.length) {
			console.log("Timed-out arm saved. Waiting for its task loops to close before the next arm.")
			const drainStarted = performance.now()
			while (!result.state.allSettled() || result.tasks.open().length > 0) {
				if (performance.now() - drainStarted >= armTimeoutMs) throw new Error(`Timed-out arm has outstanding work after the drain window. Restart with --resume after stopping this process.`)
				await wait(250)
			}
			await wait(recoveryQuietMs)
		}
	}
}

if (values["verify-only"]) console.log(`Verified ${manifest.cases.length} fixed drafts, ${snapshots.size} SEC snapshots and their evidence assertions. Spec: ${hash(manifest)}`)
else await live()
