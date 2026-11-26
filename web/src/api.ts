import { useCallback, useEffect, useRef, useState } from "react"
import type { MetaView, RunView } from "../../src/web/types"

export type { MetaView, RunView }
export type { ClaimView, AgentView, TimelineEntry, CalcInput, ContextWarning, HistoryEntry, ReviewStatus, VerdictCode } from "../../src/web/types"

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

export type StartBody = { source: "example" } | { source: "custom"; mode: "live" | "replay"; title: string; text: string }

/**
 * Starts runs only on explicit calls (never on mount), streams RunView snapshots over SSE.
 * A second click while a run is active attaches to the running check instead of starting another.
 */
export function useRun() {
	const [run, setRun] = useState<RunView>()
	const [starting, setStarting] = useState(false)
	const [error, setError] = useState<string>()
	const source = useRef<EventSource>()
	const busy = useRef(false)

	const attach = useCallback((id: string) => {
		source.current?.close()
		const es = new EventSource(`/api/runs/${id}/events`)
		source.current = es
		es.addEventListener("state", (e) => setRun(JSON.parse((e as MessageEvent).data)))
		es.addEventListener("end", () => {
			es.close()
			busy.current = false
		})
		es.onerror = () => {
			// The browser retries automatically; the server re-sends the latest state on reconnect.
		}
	}, [])

	const start = useCallback(
		async (body: StartBody) => {
			if (busy.current) return
			busy.current = true
			setStarting(true)
			setError(undefined)
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
		source.current?.close()
		busy.current = false
		setRun(undefined)
		setError(undefined)
	}, [])

	useEffect(() => () => source.current?.close(), [])
	return { run, start, starting, error, reset, running: starting || run?.status === "running" }
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
