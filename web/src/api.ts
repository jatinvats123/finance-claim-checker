import { useCallback, useEffect, useRef, useState } from "react"
import type { MetaView, ResolveView, RunView } from "../../src/web/types"
import { readSession, saveSession } from "./session"

export type { MetaView, RunView, ResolveView }
export type { ClaimView, AgentView, TimelineEntry, CalcInput, ContextWarning, HistoryEntry, ReviewStatus, VerdictCode, Candidate, ReferenceView, ReferencePreview } from "../../src/web/types"

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: Record<string, unknown> = {},
	) {
		super(message)
	}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
	const body = await res.json().catch(() => ({}))
	if (!res.ok) throw new ApiError((body as any).error ?? `Request failed (${res.status})`, res.status, body as any)
	return body as T
}

export function useMeta() {
	const [meta, setMeta] = useState<MetaView>()
	const [error, setError] = useState<string>()
	useEffect(() => {
		let alive = true
		api<MetaView>("/api/meta")
			.then((m) => alive && setMeta(m))
			.catch((e) => alive && setError(e.message))
		return () => {
			alive = false
		}
	}, [])
	return { meta, error }
}

export type StartBody =
	| { source: "example"; sample?: "wipro"; replay?: "recorded" | "fixtures" }
	| {
			source: "custom"
			mode: "live" | "replay"
			title: string
			text: string
			company?: { cik?: string; query?: string; name?: string }
			report?: { url?: string; file?: { name: string; base64: string } }
	  }

/** Identify the company and preview its reference (no run, no model call). */
export function resolveArticle(body: { title: string; text: string; company?: { cik?: string; query?: string }; mode: "live" | "replay" }, signal?: AbortSignal) {
	return api<ResolveView>("/api/resolve", { method: "POST", body: JSON.stringify(body), signal })
}

/**
 * Starts runs only on explicit calls (never on mount), streams RunView snapshots over SSE.
 * A second click while a run is active attaches to the running check instead of starting another.
 */
export function useRun() {
	const [savedRunId] = useState(() => readSession("active-run", (value): value is string => typeof value === "string" && /^run-[\w-]+$/.test(value)))
	const [restoring, setRestoring] = useState(!!savedRunId)
	const [run, setRun] = useState<RunView>()
	const [starting, setStarting] = useState(false)
	const [error, setError] = useState<string>()
	const [resumePending, setResumePending] = useState(false)
	const [resumeError, setResumeError] = useState<string>()
	const source = useRef<EventSource>()
	const busy = useRef(!!savedRunId)
	const selectionEpoch = useRef(0)

	const attach = useCallback((id: string) => {
		source.current?.close()
		saveSession("active-run", id)
		const es = new EventSource(`/api/runs/${id}/events`)
		source.current = es
		es.addEventListener("state", (e) => {
			if (source.current !== es) return
			setRun(JSON.parse((e as MessageEvent).data))
			setResumePending(false)
		})
		es.addEventListener("end", () => {
			es.close()
			if (source.current !== es) return
			source.current = undefined
			busy.current = false
			setResumePending(false)
		})
		es.onerror = () => {
			// The browser retries automatically; the server re-sends the latest state on reconnect.
		}
	}, [])

	// Fetch and reconnect to an existing run. Refresh never starts another check or model call.
	useEffect(() => {
		if (!savedRunId) return
		const controller = new AbortController()
		api<RunView>(`/api/runs/${savedRunId}`, { signal: controller.signal })
			.then((existing) => {
				if (controller.signal.aborted) return
				if (existing.article) setRun(existing)
				attach(savedRunId)
			})
			.catch((e) => {
				if (controller.signal.aborted) return
				busy.current = false
				if (e instanceof ApiError && e.status === 404) {
					saveSession("active-run", undefined)
					setError("The previous check is no longer available on the server. You can check your saved article again.")
				} else setError(`Could not restore the previous check: ${(e as Error).message}. Refresh to retry.`)
			})
			.finally(() => { if (!controller.signal.aborted) setRestoring(false) })
		return () => controller.abort()
	}, [attach, savedRunId])

	const start = useCallback(
		async (body: StartBody) => {
			if (busy.current) return
			selectionEpoch.current++
			busy.current = true
			setStarting(true)
			setError(undefined)
			setResumeError(undefined)
			try {
				const { id } = await api<{ id: string }>("/api/runs", { method: "POST", body: JSON.stringify(body) })
				setRun(undefined)
				attach(id)
			} catch (e) {
				if (e instanceof ApiError && e.status === 409 && typeof e.body.runId === "string") {
					attach(e.body.runId)
				} else {
					busy.current = false
					setError((e as Error).message)
					throw e
				}
			} finally {
				setStarting(false)
			}
		},
		[attach],
	)

	const reset = useCallback(() => {
		selectionEpoch.current++
		saveSession("active-run", undefined)
		source.current?.close()
		source.current = undefined
		busy.current = false
		setRun(undefined)
		setError(undefined)
		setResumePending(false)
		setResumeError(undefined)
	}, [])

	useEffect(() => () => source.current?.close(), [])
	/** Reviewer recheck of one claim; streams the run again while that claim is re-run. */
	const challenge = useCallback(
		async (claimId: string, reason: string) => {
			if (!run) return
			await api(`/api/runs/${run.id}/claims/${claimId}/challenge`, { method: "POST", body: JSON.stringify({ reason }) })
			busy.current = true
			attach(run.id)
		},
		[run, attach],
	)

	/** Recover unfinished work by subscribing again without clearing the current run. */
	const resume = useCallback(async () => {
		if (!run?.recovery || run.status === "running" || resumePending || (busy.current && !source.current)) return
		source.current?.close()
		source.current = undefined
		busy.current = true
		setResumePending(true)
		setResumeError(undefined)
		try {
			await api(`/api/runs/${run.id}/resume`, { method: "POST", body: "{}" })
			attach(run.id)
		} catch (e) {
			if (e instanceof ApiError && e.body.code === "RUN_BUSY") {
				attach(run.id)
				return
			}
			busy.current = false
			setResumePending(false)
			setResumeError((e as Error).message)
		}
	}, [attach, resumePending, run])

	const checkMention = useCallback(async (start: number) => {
		if (!run) return
		const epoch = selectionEpoch.current
		const response = await api<{ run?: RunView; id?: string }>(`/api/runs/${run.id}/mentions`, { method: "POST", body: JSON.stringify({ start }) })
		if (selectionEpoch.current !== epoch) return
		if (response.run) setRun(current => current?.id === response.run?.id ? response.run : current)
		else if (response.id) {
			busy.current = true
			attach(response.id)
		}
	}, [attach, run])
	const resuming = resumePending || run?.recovering === true
	const running = restoring || starting || resuming || run?.status === "running" || run?.recoveryPending === true
	return { run, start, starting, restoring, error, reset, challenge, resume, resumeError, resuming, running, checkMention }
}

export function useMedia(query: string): boolean {
	const [match, setMatch] = useState(() => window.matchMedia(query).matches)
	useEffect(() => {
		const m = window.matchMedia(query)
		const on = () => setMatch(m.matches)
		m.addEventListener("change", on)
		on()
		return () => m.removeEventListener("change", on)
	}, [query])
	return match
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
export const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`
export const fmtNumber = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 })
