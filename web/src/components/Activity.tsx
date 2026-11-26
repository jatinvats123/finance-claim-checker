import { useMemo, useState } from "react"
import { fmtSeconds, type RunView } from "../api"
import { IconCorrection, IconSpinner } from "./icons"

/** Compact strip of the five participants, from actual task records and runtime events. */
export function AgentStrip({ run }: { run?: RunView }) {
	const agents = run?.agents ?? (["Extractor", "Evidence", "Context", "Calculator", "Auditor"] as const).map((name) => ({ name, kind: name === "Calculator" ? "code" : name === "Auditor" ? "rule gate (code) + LLM review" : "LLM", running: 0, queued: 0, finished: 0, failed: 0, lastAction: undefined as string | undefined }))
	return (
		<ul className="agents" aria-label="Agent activity">
			{agents.map((a) => {
				const state = a.running > 0 ? "running" : a.queued > 0 ? "queued" : a.failed > 0 ? "failed" : a.finished > 0 ? "finished" : "idle"
				return (
					<li key={a.name} className={`agent agent-${state}`}>
						<div className="agent-head">
							<span className="agent-name">{a.name}</span>
							<span className="agent-kind">{a.kind === "code" ? "code" : a.kind.startsWith("rule") ? "code + LLM" : "LLM"}</span>
						</div>
						<div className="agent-counts num" aria-label={`${a.name}: ${a.running} running, ${a.queued} queued, ${a.finished} finished, ${a.failed} failed`}>
							{a.running > 0 && (
								<span className="count count-running">
									<IconSpinner size={12} /> {a.running} running
								</span>
							)}
							{a.queued > 0 && <span className="count">{a.queued} queued</span>}
							{a.finished > 0 && <span className="count">{a.finished} done</span>}
							{a.failed > 0 && <span className="count count-failed">{a.failed} failed</span>}
							{state === "idle" && <span className="count muted">idle</span>}
						</div>
						<div className="agent-action" title={a.lastAction}>
							{a.lastAction ?? " "}
						</div>
					</li>
				)
			})}
		</ul>
	)
}

export function Timeline({ run, onSelect }: { run: RunView; onSelect: (id: string, history?: boolean) => void }) {
	const [tools, setTools] = useState(false)
	const [query, setQuery] = useState("")
	const entries = useMemo(
		() => run.timeline.filter((t) => (tools || t.tone !== "tool") && (!query || `${t.agent} ${t.text} ${t.claimId ?? ""}`.toLowerCase().includes(query.toLowerCase()))),
		[run.timeline, tools, query],
	)
	return (
		<div className="timeline">
			<div className="timeline-controls">
				<label className="check">
					<input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} /> Show tool calls
				</label>
				<label className="sr-only" htmlFor="timeline-filter">
					Filter timeline
				</label>
				<input id="timeline-filter" className="input input-sm" placeholder="Filter, e.g. c4 or Auditor" value={query} onChange={(e) => setQuery(e.target.value)} />
				<span className="muted small">
					{entries.length} of {run.timeline.length} events{run.provenance.simulatedTiming ? " · replay timing, not live model latency" : ""}
				</span>
			</div>
			<ol className="timeline-list">
				{entries.map((t, i) => (
					<li key={i} className={`tl tl-${t.tone}`}>
						<span className="tl-at num">{fmtSeconds(t.at)}</span>
						<span className="tl-agent">{t.agent}</span>
						<span className="tl-text">
							{t.claimId ? (
								<button className="link-btn inline" onClick={() => onSelect(t.claimId!, t.tone === "warn" || t.tone === "stale")}>
									{t.text}
								</button>
							) : (
								t.text
							)}
						</span>
					</li>
				))}
			</ol>
		</div>
	)
}

/** Genuine corrections from this run (from the engine's correction records). */
export function CorrectionsBar({ run, onView }: { run: RunView; onView: (id: string) => void }) {
	const corrected = run.claims.filter((c) => c.corrections.length > 0)
	const stale = run.staleRejections.length
	if (!corrected.length && !stale) return null
	return (
		<div className="corrections-bar" role="region" aria-label="Corrections during this run">
			<IconCorrection size={15} />
			<span>
				{corrected.length > 0 ? `${corrected.reduce((n, c) => n + c.corrections.length, 0)} auditor correction${corrected.length > 1 ? "s" : ""} in this run:` : "No auditor corrections."}
			</span>
			{corrected.map((c) => (
				<button key={c.id} className="btn btn-sm btn-quiet" onClick={() => onView(c.id)}>
					View correction · {c.id} ({c.corrections.map((k) => (k.target === "claim" ? "claim reading" : "evidence")).join(", ")})
				</button>
			))}
			{stale > 0 && (
				<span className="muted small">
					{stale} stale result{stale > 1 ? "s" : ""} rejected
				</span>
			)}
		</div>
	)
}
