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
	type ContextItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type SemanticEvent,
} from "@mozaik-ai/core"
import type { TaskTracker } from "../runtime/tasks.js"

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
}
export type Cassette = { provenance: Provenance; description: string; createdAt: string; entries: Record<string, CassetteEntry> }

export type CallRecord = { task: string; turn: number; key: string; provenance: Provenance | "cache-miss" | "provider-error"; detail?: string }

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

/** Hash of everything the model sees, excluding the model name and random ids. */
export function requestKey(input: InferenceInput): string {
	const shape = {
		items: input.context.getItems().map(itemShape).filter(Boolean),
		tools: (input.tools ?? []).map((t) => t.name).sort(),
	}
	return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 24)
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
		},
	) {
		this.inner = opts.inner ?? mozaikDefaultRunner()
		if (opts.mode === "author") this.sealed = { provenance: "fixture", description: opts.script?.description ?? "", createdAt: new Date().toISOString(), entries: {} }
		if (opts.mode === "record") this.recorded = { provenance: "recorded", description: "Live model responses recorded by --mode record", createdAt: new Date().toISOString(), entries: {} }
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
						if (e.delayMs) await new Promise((r) => setTimeout(r, e.delayMs))
						this.calls.push({ task: taskKey, turn, key, provenance: c.provenance })
						return toOutput(e)
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
					const out = await this.inner.run(input)
					if (this.recorded) this.recorded.entries[key] = { task: taskKey, turn, items: fromOutput(out), model: input.model, recordedAt: new Date().toISOString() }
					this.calls.push({ task: taskKey, turn, key, provenance: "live" })
					return out
				}
			}
		} catch (err) {
			const kind = err instanceof CacheMiss ? "CACHE_MISS" : "PROVIDER_ERROR"
			const message = err instanceof Error ? err.message : String(err)
			if (task) task.failure = { kind, message }
			this.calls.push({ task: taskKey, turn, key, provenance: kind === "CACHE_MISS" ? "cache-miss" : "provider-error", detail: message })
			return { items: [ModelMessageItem.rehydrate({ text: `[runner ${kind}] ${message}` })], tokenUsage: undefined, rowResponse: null }
		}
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
 */
function mozaikDefaultRunner(): InferenceRunner {
	class Throwaway extends RuntimeState {}
	return defineRuntime<Throwaway>().initializeRuntime({ state: new Throwaway() }).getInferenceRunner()
}
