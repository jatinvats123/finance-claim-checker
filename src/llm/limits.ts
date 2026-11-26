/**
 * Spending and rate safety for live model calls.
 *
 *  - call cap:      at most N provider requests per run (attempts, including retries)
 *  - turn cap:      at most N model turns per agent task (stops a looping agent)
 *  - budget cap:    stop once the measured cost reaches $X (needs a known price for the model)
 *  - pacing:        at most K requests in flight, optionally at most R requests per minute
 *  - retries:       transient errors (429 / 5xx / overloaded) are retried with backoff
 *
 * When a limit is reached, the call fails with LimitReached; the runner records it on the task and the
 * run finishes cleanly with partial results. Costs are computed from the token usage the provider
 * returns, not estimated. A request already in flight when the budget is reached can add at most the
 * cost of the in-flight calls.
 */
import type { InferenceOutput } from "@mozaik-ai/core"

export type LiveLimits = {
	maxCalls: number
	maxTurnsPerTask: number
	/** The article extractor needs one turn per claim, so it gets its own, larger cap. */
	maxExtractorTurns: number
	budgetUsd?: number
	maxConcurrent: number
	rpm?: number
	retries: number
	/** A request with no answer after this long is abandoned and retried (counts as a transient error). */
	requestTimeoutMs: number
	/** USD per 1M tokens; overrides the built-in table (e.g. for Gemini). */
	price?: { input: number; output: number }
}

export const DEFAULT_LIMITS: LiveLimits = { maxCalls: 150, maxTurnsPerTask: 12, maxExtractorTurns: 40, maxConcurrent: 4, retries: 3, requestTimeoutMs: 120_000 }

export class RequestTimeout extends Error {}

/** Resolve with the promise's value, or reject with RequestTimeout after `ms`. The late answer is ignored. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new RequestTimeout(`no answer from the provider within ${Math.round(ms / 1000)} s`)), ms)
		}),
	])
}

/** USD per 1M tokens, Anthropic first-party list prices. Other providers: pass --price. */
export const KNOWN_PRICES: Record<string, { input: number; output: number }> = {
	"claude-haiku-4-5": { input: 1, output: 5 },
	"claude-sonnet-4-6": { input: 3, output: 15 },
	"claude-sonnet-5": { input: 2, output: 10 },
	"claude-sonnet-5-5": { input: 2, output: 10 },
	"claude-opus-4-7": { input: 5, output: 25 },
	"claude-opus-4-8": { input: 5, output: 25 },
	"claude-opus-5-5": { input: 4, output: 20 },
	"claude-fable-5-1": { input: 10, output: 50 },
}

export class LimitReached extends Error {}

export type UsageSummary = {
	model: string
	requests: number
	retries: number
	inputTokens: number
	outputTokens: number
	/** Thinking tokens reported separately by the provider (Gemini). Billed as output. */
	reasoningTokens: number
	costUsd?: number
	price?: { input: number; output: number }
	limitHit?: string
	retryNotes?: string[]
}

export class UsageMeter {
	requests = 0
	retries = 0
	inputTokens = 0
	outputTokens = 0
	reasoningTokens = 0
	limitHit?: string
	/** First few retry reasons, for diagnosing rate limits. */
	readonly retryNotes: string[] = []

	constructor(
		readonly model: string,
		readonly price = KNOWN_PRICES[model],
	) {}

	add(out: InferenceOutput) {
		const u = out.tokenUsage
		if (!u) return
		this.inputTokens += u.inputTokens ?? 0
		this.outputTokens += u.outputTokens ?? 0
		// Gemini reports thinking tokens outside candidatesTokenCount; Anthropic includes them in output_tokens.
		if (this.model.startsWith("gemini")) this.reasoningTokens += u.outputTokenDetails?.reasoning_tokens ?? 0
	}

	costUsd(): number | undefined {
		if (!this.price) return undefined
		return (this.inputTokens * this.price.input + (this.outputTokens + this.reasoningTokens) * this.price.output) / 1_000_000
	}

	summary(): UsageSummary {
		return { model: this.model, requests: this.requests, retries: this.retries, inputTokens: this.inputTokens, outputTokens: this.outputTokens, reasoningTokens: this.reasoningTokens, costUsd: this.costUsd(), price: this.price, limitHit: this.limitHit, retryNotes: this.retryNotes }
	}
}

/** Bounded concurrency plus an optional minimum spacing between request starts. */
export class Pacer {
	private active = 0
	private readonly waiting: (() => void)[] = []
	private nextStart = 0

	constructor(
		private readonly maxConcurrent: number,
		private readonly rpm?: number,
	) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r))
		this.active++
		try {
			if (this.rpm) {
				const gap = 60_000 / this.rpm
				const now = Date.now()
				const start = Math.max(now, this.nextStart)
				this.nextStart = start + gap
				if (start > now) await sleep(start - now)
			}
			return await fn()
		} finally {
			this.active--
			this.waiting.shift()?.()
		}
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Transient provider errors worth retrying: rate limits, overload, 5xx, connection resets. */
export function retryDelayMs(err: unknown, attempt: number): number | undefined {
	const e = err as { status?: number; message?: string }
	const msg = String(e?.message ?? err)
	const status = e?.status ?? Number(/\b(429|500|502|503|504|529)\b/.exec(msg)?.[1])
	const transient = err instanceof RequestTimeout || [429, 500, 502, 503, 504, 529].includes(status) || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)
	if (!transient) return undefined
	const hinted = /retry(?:Delay)?["\s:]*(?:in\s*)?"?(\d+(?:\.\d+)?)s/i.exec(msg)
	if (hinted) return Math.min(Number(hinted[1]) * 1000 + 250, 65_000)
	return [2_000, 6_000, 15_000, 30_000][Math.min(attempt, 3)] + Math.floor(Math.random() * 500)
}
