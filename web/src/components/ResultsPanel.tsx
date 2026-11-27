import { useMemo, useState } from "react"
import { fmtDate, type ClaimView, type RunView } from "../api"
import { IconCorrection, IconLocate } from "./icons"
import { ReviewLine, VerdictBadge, warningLabel } from "./status"

export type Filter = "all" | "mismatch" | "review" | "match"

/** Claims that could not be settled numerically, or whose review is not complete. */
export const needsReview = (c: ClaimView) => ["NOT_COMPUTABLE", "NOT_VERIFIABLE", "REFERENCE_NOT_YET_FILED", "PENDING"].includes(c.verdict) || c.review.status !== "complete"

const FILTERS: { id: Filter; label: string; test: (c: ClaimView) => boolean }[] = [
	{ id: "all", label: "All", test: () => true },
	{ id: "mismatch", label: "Mismatches", test: (c) => c.verdict === "MISMATCH" },
	{ id: "review", label: "Needs review", test: needsReview },
	{ id: "match", label: "Matches", test: (c) => c.verdict === "MATCH" },
]

type Props = {
	run: RunView
	selectedId?: string
	onSelect: (id: string) => void
	onLocate: (id: string) => void
}

export function ResultsPanel({ run, selectedId, onSelect, onLocate }: Props) {
	const [filter, setFilter] = useState<Filter>("all")
	const shown = useMemo(() => run.claims.filter(FILTERS.find((f) => f.id === filter)!.test), [run.claims, filter])
	const s = run.summary
	const finished = run.status !== "running"

	return (
		<div className="panel-body results-scroll">
			<div className="summary" aria-label="Summary of results">
				<SummaryItem n={s.match} label="figures match" tone="good" />
				<SummaryItem n={s.mismatch} label="figures differ" tone="bad" />
				{s.notComputable > 0 && <SummaryItem n={s.notComputable} label="cannot calculate" tone="warn" />}
				{s.notVerifiable > 0 && <SummaryItem n={s.notVerifiable} label="cannot verify" tone="warn" />}
				{s.referenceUnavailable > 0 && <SummaryItem n={s.referenceUnavailable} label="reference unavailable" tone="neutral" />}
				{s.pending > 0 && <SummaryItem n={s.pending} label="still checking" tone="pending" />}
				<div className="summary-review">
					Review complete for <strong className="num">{s.reviewComplete}</strong> of <strong className="num">{run.claims.length}</strong> claims
					{s.reviewIncomplete > 0 && (
						<>
							{" "}
							· <span className="text-bad">{s.reviewIncomplete} incomplete</span>
						</>
					)}
					{!finished && !run.progress.extractionDone && " · more claims may still be found"}
				</div>
			</div>

			<div className="filters" role="group" aria-label="Filter claims">
				{FILTERS.map((f) => {
					const n = run.claims.filter(f.test).length
					return (
						<button key={f.id} className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
							{f.label} <span className="num filter-count">{n}</span>
						</button>
					)
				})}
			</div>
			{filter === "review" && <p className="filter-help">Claims that could not be settled numerically, or whose audit or context review is not complete.</p>}

			<ol className="cards" aria-label="Claims, in article order">
				{shown.map((c) => (
					<li key={c.id}>
						<ClaimCard claim={c} selected={c.id === selectedId} snapshot={run.snapshotFetchedAt} refLabel={run.reference.kind === "sec" ? "Filings" : "Report"} onSelect={onSelect} onLocate={onLocate} />
					</li>
				))}
			</ol>
			{shown.length === 0 && run.claims.length > 0 && <p className="empty-note">No claims in this filter.</p>}
		</div>
	)
}

function SummaryItem({ n, label, tone }: { n: number; label: string; tone: string }) {
	return (
		<div className={`summary-item tone-text-${tone}`}>
			<span className="summary-n num">{n}</span>
			<span className="summary-label">{label}</span>
		</div>
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
					<span className="card-note">Article states {c.statedDisplay}. Adjusted figures are not in the financial statements.</span>
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
