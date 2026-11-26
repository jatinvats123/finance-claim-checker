/**
 * Execution lanes measured from Mozaik's own loop events: a lane opens on `message_received.started`
 * (the SDK starting an agent loop) and closes on that loop's `model.answer`. Each lane carries the
 * task, agent, claim and revision ids, so the trace shows which work overlapped. The deterministic
 * Calculator and the auditor's rule gate run inline in event handlers and do not appear as lanes.
 *
 * Timing honesty: in replay the durations come from fixture delays or recorded latency ÷ replay
 * speed, not from a live provider. `timing` says which.
 */
import type { SemanticEvent } from "@mozaik-ai/core"
import type { AgentRole, TaskTracker } from "./tasks.js"

export type Lane = {
	task: string
	role: AgentRole
	claimId?: string
	claimRevision?: number
	evidenceRevision?: number
	startMs: number
	endMs?: number
	failed?: boolean
}

export type Trace = {
	timing: "live" | "replay-fixture" | "replay-recorded" | "mixed"
	timingNote: string
	lanes: Lane[]
	peakActive: number
	peakAtMs: number
	totalMs: number
}

const AGENT: Record<AgentRole, string> = { extractor: "Extractor", "extractor-fix": "Extractor", evidence: "Evidence", context: "Context", auditor: "Auditor" }
export const agentOf = (role: AgentRole) => AGENT[role]

export class LaneTracer {
	private readonly lanes = new Map<string, Lane>() // by loop id
	private readonly t0 = Date.now()

	constructor(private readonly tasks: TaskTracker) {}

	onEvent(e: SemanticEvent) {
		const p = e.payload as any
		if (e.type === "message_received.started") {
			const task = this.tasks.forContext(p?.input?.context?.id)
			if (!task || !p.loopId) return
			this.lanes.set(p.loopId, { task: task.key, role: task.role, claimId: task.claimId, claimRevision: task.claimRevision, evidenceRevision: task.evidenceRevision, startMs: Date.now() - this.t0 })
		} else if (e.type === "model.answer") {
			const lane = this.lanes.get(p?.loopId)
			if (!lane || lane.endMs !== undefined) return
			lane.endMs = Date.now() - this.t0
			lane.failed = !!this.tasks.forLoop(p.loopId)?.failure
		}
	}

	trace(provenance: Record<string, number>): Trace {
		const lanes = [...this.lanes.values()].sort((a, b) => a.startMs - b.startMs)
		const now = Date.now() - this.t0
		const points = lanes.flatMap((l) => [
			{ at: l.startMs, d: 1 },
			{ at: l.endMs ?? now, d: -1 },
		])
		points.sort((a, b) => a.at - b.at || a.d - b.d) // ends before starts at the same instant
		let active = 0
		let peakActive = 0
		let peakAtMs = 0
		for (const pt of points) {
			active += pt.d
			if (active > peakActive) {
				peakActive = active
				peakAtMs = pt.at
			}
		}
		const kinds = ["live", "recorded", "fixture"].filter((k) => provenance[k])
		const timing = kinds.length !== 1 ? "mixed" : kinds[0] === "live" ? "live" : kinds[0] === "recorded" ? "replay-recorded" : "replay-fixture"
		const timingNote =
			timing === "live"
				? "Measured wall-clock times of live provider calls (including pacing and retries)."
				: timing === "replay-recorded"
					? "Replay of a recorded run: each response waits its recorded latency divided by the replay speed. Not live model latency."
					: timing === "replay-fixture"
						? "Replay of hand-written fixtures with simulated delays. Not model latency."
						: "Mixed response sources; durations are not comparable to live latency."
		return { timing, timingNote, lanes, peakActive, peakAtMs, totalMs: Math.max(now, ...lanes.map((l) => l.endMs ?? 0)) }
	}
}
