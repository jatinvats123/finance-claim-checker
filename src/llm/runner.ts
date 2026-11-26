/**
 * The inference runner plugged into Mozaik (`initializeRuntime({ inferenceRunnerConfig: { runner } })`).
 *
 * Modes — every call is labelled with where its response came from:
 *   live    → real provider call                                  (provenance "live")
 *   record  → real provider call, saved to a cassette             (provenance "live", saved as "recorded")
 *   replay  → recorded cassette first, then hand-written fixtures (provenance "recorded" | "fixture")
 *   author  → hand-written script turns, sealed into fixtures     (provenance "fixture")
 *
 * Replay keys are a hash of the full request (instructions, task message, prior tool calls and the
 * exact tool outputs). Any divergence — another article, other SEC data, a changed prompt — is an
 * explicit CACHE_MISS, never a substituted answer. Provider errors and cache misses end the loop
 * cleanly and are recorded on the task, so one failure never crashes the run (Mozaik 6.0.0's runLoop
 * does not catch inference errors itself).
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
	defineRuntime,
	FunctionCallItem,
	ModelMessageItem,
	RuntimeState,
	supportedModels,
	type ContextItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type SemanticEvent,
} from "@mozaik-ai/core"
import type { TaskTracker } from "../runtime/tasks.js"
import { geminiEndpoint } from "./gemini.js"
import { DEFAULT_LIMITS, KNOWN_PRICES, LimitReached, Pacer, RequestTimeout, retryDelayMs, sleep, UsageMeter, withTimeout, type LiveLimits } from "./limits.js"

export type LlmMode = "live" | "record" | "replay" | "author"
export type Provenance = "live" | "recorded" | "fixture"

export type ScriptTurn = { call?: { name: string; args: Record<string, unknown> }; say?: string; delayMs?: number }
export type AuthorScript = { description: string; tasks: Record<string, ScriptTurn[]> }

export type CassetteEntry = {
	task: string
	turn: number
	/** Simulated latency (fixtures only), used to make concurrency and stale results visible. */
	delayMs?: number
	items: ({ type: "function_call"; name: string; args: Record<string, unknown> } | { type: "message"; text: string })[]
	model?: string
	recordedAt?: string
	/** Recordings only: measured wall time the agent waited for this response (provider latency + pacing + retries). */
	latencyMs?: number
}

/** Replay speed for recordings: recorded latency is divided by this, keeping the live run's ordering. */
export const DEFAULT_REPLAY_SPEED = 10
export type Cassette = { provenance: Provenance; description: string; createdAt: string; keyVersion?: number; model?: string; entries: Record<string, CassetteEntry> }

export type CallRecord = { task: string; turn: number; key: string; provenance: Provenance | "cache-miss" | "provider-error" | "limit-reached"; detail?: string }

export class CacheMiss extends Error {}

function itemShape(item: ContextItem): unknown {
	const any = item as any
	switch (item.type) {
		case "message":
			return { role: any.role, text: any.content?.text }
		case "function_call":
			return { call: any.name, args: canonical(safeParse(any.args)) }
		case "function_call_output":
			return { output: any.output?.text }
		default:
			return null // reasoning items are provider-specific; not part of the key
	}
}
const safeParse = (s: string) => {
	try {
		return JSON.parse(s)
	} catch {
		return s
	}
}
function canonical(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonical)
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])]))
	return v
}

/**
 * Replay cache policy, version 2:
 *  - the key hashes everything the model sees: every context item (instructions, task message, prior
 *    tool calls and exact tool outputs) and every model-visible tool definition (name, description,
 *    parameter schema, strict flag), canonicalised;
 *  - it excludes the model name, provider call ids and simulated delays;
 *  - a cassette records the key version it was sealed/recorded with; replay refuses a cassette from
 *    another version (explicit error, never a silent miss) — bump REPLAY_KEY_VERSION whenever the key
 *    shape changes, then reseal fixtures and re-record.
 */
export const REPLAY_KEY_VERSION = 2

/** Hash of everything the model sees, excluding the model name and random ids. */
export function requestKey(input: InferenceInput): string {
	const shape = {
		v: REPLAY_KEY_VERSION,
		items: input.context.getItems().map(itemShape).filter(Boolean),
		tools: (input.tools ?? [])
			.map((t) => canonical({ name: t.name, description: t.description, parameters: t.parameters, strict: t.strict }))
			.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))),
	}
	return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 24)
}

export class IncompatibleCassette extends Error {}

export function assertCompatible(c: Cassette, path = "cassette") {
	if (c.keyVersion !== REPLAY_KEY_VERSION) {
		throw new IncompatibleCassette(`${path} was made with replay key version ${c.keyVersion ?? 1}; this build uses version ${REPLAY_KEY_VERSION}. Reseal fixtures (npm run fixtures:seal) or re-record.`)
	}
}

export const turnOf = (input: InferenceInput) => input.context.getItems().filter((i) => i.type === "function_call_output").length

function toOutput(entry: CassetteEntry): InferenceOutput {
	let n = 0
	const items = entry.items.map((i) =>
		i.type === "function_call"
			? FunctionCallItem.rehydrate({ callId: `${entry.task}-t${entry.turn}-${n++}`, name: i.name, args: JSON.stringify(i.args) })
			: ModelMessageItem.rehydrate({ text: i.text }),
	)
	return { items, tokenUsage: undefined, rowResponse: null }
}

function fromOutput(out: InferenceOutput): CassetteEntry["items"] {
	return out.items.flatMap((i): CassetteEntry["items"] => {
		if (i.type === "function_call") return [{ type: "function_call", name: (i as FunctionCallItem).name, args: safeParse((i as FunctionCallItem).args) }]
		if (i.type === "message") return [{ type: "message", text: (i as ModelMessageItem).content.text }]
		return []
	})
}

export function loadCassette(path: string): Cassette | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Cassette) : undefined
}

export class CheckerRunner implements InferenceRunner {
	readonly calls: CallRecord[] = []
	private readonly inner: InferenceRunner
	private sealed?: Cassette
	private recorded?: Cassette
	readonly limits: LiveLimits
	readonly usage: UsageMeter
	private readonly pacer: Pacer

	constructor(
		private readonly opts: {
			mode: LlmMode
			tasks: TaskTracker
			/** replay: cassettes to read, in priority order (recorded first, then fixtures) */
			cassettes?: Cassette[]
			/** record: where to write recordings; author: where to write sealed fixtures */
			writeTo?: string
			script?: AuthorScript
			inner?: InferenceRunner
			/** live/record: model id, used for pricing the measured token usage */
			model?: string
			limits?: Partial<LiveLimits>
			/** replay: recorded latency ÷ replaySpeed (default 10). Fixtures use their own simulated delays. */
			replaySpeed?: number
		},
	) {
		this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
		this.usage = new UsageMeter(opts.model ?? "unknown", this.limits.price ?? KNOWN_PRICES[opts.model ?? ""])
		if (this.limits.budgetUsd !== undefined && !this.usage.price && (opts.mode === "live" || opts.mode === "record")) {
			throw new Error(`No price known for model "${opts.model}", so a USD budget cannot be enforced. Pass --price <input>,<output> (USD per 1M tokens), or drop --budget-usd and rely on --max-calls.`)
		}
		this.pacer = new Pacer(this.limits.maxConcurrent, this.limits.rpm)
		this.inner = opts.inner ?? mozaikDefaultRunner()
		if (opts.mode === "author") this.sealed = { provenance: "fixture", description: opts.script?.description ?? "", createdAt: new Date().toISOString(), keyVersion: REPLAY_KEY_VERSION, entries: {} }
		if (opts.mode === "record")
			this.recorded = { provenance: "recorded", description: `Genuine responses from ${opts.model ?? "the configured model"}, recorded by --mode record`, createdAt: new Date().toISOString(), keyVersion: REPLAY_KEY_VERSION, model: opts.model, entries: {} }
		if (opts.mode === "replay") for (const c of opts.cassettes ?? []) assertCompatible(c)
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const key = requestKey(input)
		const turn = turnOf(input)
		const task = this.opts.tasks.forContext(input.context.id)
		const taskKey = task?.key ?? "unknown-task"
		try {
			switch (this.opts.mode) {
				case "replay": {
					for (const c of this.opts.cassettes ?? []) {
						const e = c.entries[key]
						if (!e) continue
						const wait = e.latencyMs !== undefined ? e.latencyMs / (this.opts.replaySpeed ?? DEFAULT_REPLAY_SPEED) : e.delayMs
						if (wait) await new Promise((r) => setTimeout(r, wait))
						this.calls.push({ task: taskKey, turn, key, provenance: c.provenance })
						return toOutput(e)
					}
					if (this.liveFallback) {
						// only after an explicit reviewer recheck on a finished replay run; labelled "live"
						const out = await this.liveCall(input, turn, taskKey)
						this.calls.push({ task: taskKey, turn, key, provenance: "live" })
						return out
					}
					throw new CacheMiss(`no recorded or fixture response for ${taskKey} turn ${turn} (request ${key}). Run with a provider key (--mode live or record) to check new input.`)
				}
				case "author": {
					const t = this.opts.script?.tasks[taskKey]?.[turn]
					if (!t) throw new CacheMiss(`fixture script has no turn ${turn} for task ${taskKey}`)
					const entry: CassetteEntry = {
						task: taskKey,
						turn,
						delayMs: t.delayMs,
						items: t.call ? [{ type: "function_call", name: t.call.name, args: t.call.args }] : [{ type: "message", text: t.say ?? "done" }],
					}
					this.sealed!.entries[key] = entry
					if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs))
					this.calls.push({ task: taskKey, turn, key, provenance: "fixture" })
					return toOutput(entry)
				}
				default: {
					const started = Date.now()
					const out = await this.liveCall(input, turn, taskKey)
					if (this.recorded) this.recorded.entries[key] = { task: taskKey, turn, items: fromOutput(out), model: input.model, recordedAt: new Date().toISOString(), latencyMs: Date.now() - started }
					this.calls.push({ task: taskKey, turn, key, provenance: "live" })
					return out
				}
			}
		} catch (err) {
			const kind = err instanceof CacheMiss ? "CACHE_MISS" : err instanceof LimitReached ? "LIMIT_REACHED" : "PROVIDER_ERROR"
			const message = err instanceof Error ? err.message : String(err)
			if (task) task.failure = { kind, message }
			this.calls.push({ task: taskKey, turn, key, provenance: kind === "CACHE_MISS" ? "cache-miss" : kind === "LIMIT_REACHED" ? "limit-reached" : "provider-error", detail: message })
			return { items: [ModelMessageItem.rehydrate({ text: `[runner ${kind}] ${message}` })], tokenUsage: undefined, rowResponse: null }
		}
	}

	private liveFallback = false

	/**
	 * Allow replay misses to go to the live provider from now on. Used only when a reviewer asks to
	 * recheck a claim of a finished replay run; those calls are recorded with provenance "live", so the
	 * run's provenance becomes visibly mixed.
	 */
	enableLiveFallback(model: string) {
		this.liveFallback = true
		if (this.usage.model === "unknown") Object.assign(this.usage, { model })
	}

	/** One provider request under the call/turn/budget caps, pacing and transient-error retries. */
	private async liveCall(input: InferenceInput, turn: number, taskKey: string): Promise<InferenceOutput> {
		const { limits, usage } = this
		const stop = (why: string): never => {
			usage.limitHit ??= why
			throw new LimitReached(why)
		}
		const turnCap = taskKey === "extractor:article" ? limits.maxExtractorTurns : limits.maxTurnsPerTask
		if (turn >= turnCap) stop(`task ${taskKey} reached the turn cap (${turnCap} model turns)`)
		for (let attempt = 0; ; attempt++) {
			const out = await this.pacer.run(async () => {
				if (usage.requests >= limits.maxCalls) stop(`call cap reached (${limits.maxCalls} requests)`)
				const cost = usage.costUsd()
				if (limits.budgetUsd !== undefined && cost !== undefined && cost >= limits.budgetUsd) stop(`budget reached ($${cost.toFixed(4)} of $${limits.budgetUsd})`)
				usage.requests++
				// Two independent guards: a per-request timeout, and the watchdog (see watch()) that can
				// abandon a request through `abandon` even if that timer never fires.
				const entry = { task: taskKey, turn, startedAt: Date.now(), abandon: (_e: Error) => {} }
				const watchdog = new Promise<never>((_, reject) => (entry.abandon = reject))
				this.inFlight.add(entry)
				this.watch()
				try {
					const res = await Promise.race([withTimeout(this.inner.run(input), limits.requestTimeoutMs), watchdog])
					if (!res.items.length) throw new Error("provider returned an empty response (no text and no tool call)")
					return res
				} catch (err) {
					return err instanceof Error ? err : new Error(String(err))
				} finally {
					this.inFlight.delete(entry)
				}
			})
			if (!(out instanceof Error)) {
				usage.add(out)
				return out
			}
			const wait = attempt < limits.retries ? retryDelayMs(out, attempt) : undefined
			if (wait === undefined) throw out
			usage.retries++
			if (usage.retryNotes.length < 5) usage.retryNotes.push(`${taskKey}: ${out.message.slice(0, 140)}`)
			await sleep(wait)
		}
	}

	private readonly inFlight = new Set<{ task: string; turn: number; startedAt: number; abandon: (e: Error) => void }>()
	private watchTimer?: NodeJS.Timeout

	/** Watchdog: every few seconds, abandon requests older than the request timeout (+ grace) and note them. */
	private watch() {
		if (this.watchTimer) return
		const grace = 5_000
		this.watchTimer = setInterval(() => {
			const now = Date.now()
			for (const e of this.inFlight) {
				if (now - e.startedAt > this.limits.requestTimeoutMs + grace) {
					this.inFlight.delete(e)
					this.usage.stalled.push(`${e.task} turn ${e.turn}: no answer after ${Math.round((now - e.startedAt) / 1000)} s (abandoned by watchdog)`)
					e.abandon(new RequestTimeout(`watchdog: no answer from the provider within ${Math.round((now - e.startedAt) / 1000)} s`))
				}
			}
			if (!this.inFlight.size) {
				clearInterval(this.watchTimer)
				this.watchTimer = undefined
			}
		}, Math.min(5_000, Math.max(50, this.limits.requestTimeoutMs / 4)))
		this.watchTimer.unref?.()
	}

	// Streaming is not used by the checker.
	// eslint-disable-next-line require-yield
	async *stream(): AsyncGenerator<SemanticEvent> {
		throw new Error("streaming is not used by the claim checker")
	}

	/** Persist sealed fixtures (author) or recordings (record). */
	save() {
		const data = this.sealed ?? this.recorded
		if (!data || !this.opts.writeTo) return
		mkdirSync(dirname(this.opts.writeTo), { recursive: true })
		writeFileSync(this.opts.writeTo, JSON.stringify(data, null, 1))
	}
}

/**
 * Mozaik's DefaultInferenceRunner with its built-in request validation. The validator class is not
 * exported in 6.0.0, so obtain the runner the runtime itself would build, via public API only.
 * Google models use our signature-preserving Gemini mapper (see gemini.ts); everything else is stock.
 */
function mozaikDefaultRunner(): InferenceRunner {
	class Throwaway extends RuntimeState {}
	const models = supportedModels.map((m) => (m.specification.provider === "google" ? { ...m, endpoint: geminiEndpoint() } : m))
	return defineRuntime<Throwaway>().initializeRuntime({ state: new Throwaway(), inferenceRunnerConfig: { supportedModels: models } }).getInferenceRunner()
}
