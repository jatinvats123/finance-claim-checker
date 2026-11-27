import { useMemo, useState } from "react"
import { fmtDate, type ClaimView, type RunView } from "../api"
import { editorStatus, notVerifiableReason, unmatchedFinancialMentions, type EditorStatus } from "../editorResults"
import { IconCorrection, IconLocate } from "./icons"
import { ReviewLine, VerdictBadge, warningLabel } from "./status"

type Filter = "all" | EditorStatus

type Props = {
	run: RunView
	recommended?: ClaimView
	selectedId?: string
	onSelect: (id: string) => void
	onLocate: (id: string) => void
	onCheckMention: (start: number) => Promise<void>
}

export function ResultsPanel({ run, recommended, selectedId, onSelect, onLocate, onCheckMention }: Props) {
	const [filter, setFilter] = useState<Filter>("all")
	const groups = useMemo(() => {
		const classified: Record<EditorStatus, ClaimView[]> = { fix: [], match: [], review: [] }
		for (const claim of run.claims) classified[editorStatus(run, claim)].push(claim)
		return classified
	}, [run])
	const shown = filter === "all" ? run.claims : groups[filter]
	const count = run.claims.length
	const manualCount = run.claims.filter(claim => claim.history.some(entry => entry.kind === "claim.editor_selected")).length
	const extracted = count - manualCount
	const refLabel = run.reference.kind === "sec" ? "Filings" : "Report"
	const processing = run.status === "running"
	return (
		<div className="panel-body results-scroll">
			<div className="summary" aria-label="Summary of results">
				<div className="summary-filters" role="group" aria-label="Filter extracted claims">
					<SummaryItem n={groups.fix.length} label="Ready to fix" tone="bad" active={filter === "fix"} onClick={() => setFilter("fix")} />
					<SummaryItem n={groups.match.length} label={run.reference.kind === "sec" ? "Matches filing" : "Matches report"} tone="good" active={filter === "match"} onClick={() => setFilter("match")} />
					<SummaryItem n={groups.review.length} label="Needs review" tone="warn" active={filter === "review"} onClick={() => setFilter("review")} />
				</div>
				<div className="summary-review">
					<span><strong className="num">{extracted}</strong> extracted {extracted === 1 ? "claim" : "claims"}{manualCount > 0 ? ` · ${manualCount} editor-selected` : ""} · <strong className="num">{run.summary.reviewComplete}</strong> fully reviewed{processing && !run.progress.extractionDone ? " · extraction in progress" : ""}</span>
					<button type="button" className="link-btn" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All claims</button>
				</div>
			</div>

			{recommended && (
				<div className="priority-correction">
					<div>
						<strong>Largest reviewed discrepancy</strong>
						<p>{recommended.metricLabel}, {recommended.periodLabel} · <span className="num">{recommended.calc?.statedDisplay} → {recommended.calc?.actualDisplay}</span></p>
					</div>
					<button className="btn btn-sm btn-secondary" onClick={() => onSelect(recommended.id)}>Open correction</button>
				</div>
			)}
			{filter === "review" && <p className="filter-help">These claims need a completed review, a comparable source, or an editor’s judgment.</p>}

			<MentionCoverage run={run} onCheckMention={onCheckMention} />

			<ol className="cards" aria-label="Claims, in article order">
				{shown.map((c) => (
					<li key={c.id}>
						<ClaimCard claim={c} selected={c.id === selectedId} snapshot={run.snapshotFetchedAt} refLabel={refLabel} onSelect={onSelect} onLocate={onLocate} />
					</li>
				))}
			</ol>
			{shown.length === 0 && <p className="empty-note">{count ? "No claims in this filter." : "No claims were extracted."}</p>}

		</div>
	)
}

export function MentionCoverage({ run, onCheckMention }: Pick<Props, "run" | "onCheckMention">) {
	const [checking, setChecking] = useState<number>()
	const [checkError, setCheckError] = useState<{ start: number; message: string }>()
	async function checkNumber(start: number) {
		setChecking(start)
		setCheckError(undefined)
		try { await onCheckMention(start) }
		catch (err) { setCheckError({ start, message: (err as Error).message }) }
		finally { setChecking(undefined) }
	}
	const mentions = useMemo(() => run.status !== "running" && run.progress.extractionDone ? unmatchedFinancialMentions(run) : [], [run])
	const forecastCount = mentions.filter(mention => mention.forecast).length
	const checkedCount = mentions.filter(mention => !mention.forecast && run.manualChecks?.[mention.start]).length
	const uncheckedCount = mentions.length - forecastCount - checkedCount

	if (!mentions.length) return null
	return (
		<details className="coverage" open={run.status === "cache_miss" || undefined}>
			<summary>
				<span>{run.status === "cache_miss" ? "Check individual numbers against this source" : "Other mentions in the article"}</span>
				<span className="coverage-count">{[uncheckedCount ? uncheckedCount + " unchecked" : "", checkedCount ? checkedCount + " manually checked" : "", forecastCount ? forecastCount + (forecastCount === 1 ? " forecast" : " forecasts") : ""].filter(Boolean).join(" · ")}</span>
			</summary>
			<p className="small muted">Select an amount to check its metric and fiscal period against the source. Forecasts stay outside the comparison.</p>
			<ul className="coverage-list">
				{mentions.map(mention => {
					const receipt = run.manualChecks?.[mention.start]
					return (
						<li key={mention.start}>
							<strong className="coverage-status">{mention.forecast ? "Forecast" : receipt ? "Editor-selected lookup" : "Unchecked"}</strong>
							<p>“{mention.before}<mark>{mention.value}</mark>{mention.after}”</p>
							{!receipt && !mention.forecast && <button type="button" className="btn btn-sm btn-secondary" disabled={checking !== undefined || run.recoveryPending} onClick={() => checkNumber(mention.start)}>{checking === mention.start ? "Checking…" : "Check this number"}</button>}
							{receipt?.status === "needs_review" && <p role="status">Needs review. {receipt.reason}</p>}
							{receipt?.status === "compared" && <div role="status">
								<p><strong>{receipt.matches ? "Matches the source" : "Source figure differs"}</strong> · {receipt.metric}, {receipt.period}</p>
								<p>Draft {receipt.stated} · Source {receipt.filed} ({receipt.source.currency} {receipt.source.value.toLocaleString("en-US")}).</p>
								<p>{receipt.source.url ? <a href={receipt.source.url} target="_blank" rel="noreferrer">{receipt.source.form} · {receipt.source.accn}</a> : receipt.source.location ? "Report page " + receipt.source.location.page : receipt.source.evidenceId} · {receipt.source.concept}</p>
								<p className="small muted">Deterministic source lookup. Agent review is required for a copy-ready edit.</p>
							</div>}
							{checkError?.start === mention.start && <p role="alert">{checkError.message}</p>}
						</li>
				)
				})}
			</ul>
		</details>
	)
}

function SummaryItem({ n, label, tone, active, onClick }: { n: number; label: string; tone: string; active: boolean; onClick: () => void }) {
	return (
		<button type="button" className={"summary-item tone-text-" + tone} aria-pressed={active} onClick={onClick}>
			<span className="summary-n num">{n}</span>
			<span className="summary-label">{label}</span>
		</button>
	)
}

function ClaimCard({ claim: c, selected, snapshot, refLabel, onSelect, onLocate }: { claim: ClaimView; selected: boolean; snapshot: string; refLabel: string; onSelect: (id: string) => void; onLocate: (id: string) => void }) {
	return (
		<article className={`card${selected ? " is-selected" : ""}`} aria-labelledby={`card-${c.id}`}>
			<button className="card-main" onClick={() => onSelect(c.id)} aria-pressed={selected} aria-describedby={`card-${c.id}-quote`}>
				<span className="card-head">
					<span className="claim-id" id={`card-${c.id}`}>
						{c.id}
					</span>
					<span className="card-meta">
						{c.metricLabel} · {c.periodLabel}
						<span className="card-kind"> · {c.kindLabel}</span>
							{c.history.some(entry => entry.kind === "claim.editor_selected") && <span className="card-kind"> · Editor-selected</span>}
					</span>
					<VerdictBadge claim={c} />
				</span>
				<span className="card-quote" id={`card-${c.id}-quote`}>
					“{c.quote}”
				</span>
				{c.calc?.actualDisplay ? (
					<span className="figures">
						<span>
							<span className="fig-label">Article</span> <span className="fig num">{c.calc.statedDisplay}</span>
						</span>
						<span>
							<span className="fig-label">{refLabel}</span> <span className="fig num">{c.calc.actualDisplay}</span>
						</span>
					</span>
				) : c.verdict === "REFERENCE_NOT_YET_FILED" ? (
					<span className="card-note">No statement for {c.periodLabel} in the reference (fetched {fmtDate(snapshot)}).</span>
				) : c.verdict === "NOT_VERIFIABLE" ? (
					<span className="card-note">Article states {c.statedDisplay}. {notVerifiableReason(c)}</span>
				) : c.verdict === "NOT_COMPUTABLE" ? (
					<span className="card-note">{c.calc?.notes[0] ?? "The calculation could not be performed."}</span>
				) : null}
				{c.warnings.length > 0 && (
					<span className="warnings" aria-label="Context warnings">
						<span className="warnings-label">Context</span>
						{c.warnings.map((w, i) => (
							<span key={i} className="chip chip-warn" title={w.message}>
								{warningLabel(w.code)}
							</span>
						))}
					</span>
				)}
			</button>
			<div className="card-foot">
				<ReviewLine claim={c} />
				{c.corrections.length > 0 && (
					<span className="chip chip-correction">
						<IconCorrection size={13} /> {c.corrections.length} correction{c.corrections.length > 1 ? "s" : ""}
					</span>
				)}
				<button className="link-btn" onClick={() => onLocate(c.id)} disabled={c.location.spans.length === 0} aria-label={`Show ${c.id} in the article`}>
					<IconLocate size={14} /> Show in article
				</button>
			</div>
		</article>
	)
}
