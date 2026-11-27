import { EditorCorrection, FilingReceipt } from "./FilingReceipt"
import { notVerifiableReason } from "../editorResults"
import { useEffect, useRef, useState } from "react"
import { fmtDate, fmtNumber, fmtSeconds, type CalcInput, type ClaimView, type RunView } from "../api"
import { IconChevron, IconClose, IconExternal, IconLocate } from "./icons"
import { ReviewLine, VerdictBadge, warningLabel } from "./status"

type Props = {
	run: RunView
	claim: ClaimView
	onClose: () => void
	onSelect: (id: string) => void
	onLocate: (id: string) => void
	/** Open the revision history (used by "View correction"). */
	historyOpen: boolean
	onHistoryToggle: (open: boolean) => void
	headingRef?: React.Ref<HTMLHeadingElement>
	liveConfigured: boolean
	liveHint: string
	onChallenge: (claimId: string, reason: string) => Promise<void>
}

function conclusion(c: ClaimView): string {
	switch (c.verdict) {
		case "MATCH":
			return `The article's ${c.calc?.statedDisplay} agrees with the official statements (${c.calc?.actualDisplay}) within the stated precision.`
		case "MISMATCH":
			return `The article states ${c.calc?.statedDisplay}; the official statements give ${c.calc?.actualDisplay}.${c.calc?.difference ? ` ${c.calc.difference.replace(/^actual − stated = /, "Difference: ")}.` : ""}`
		case "NOT_COMPUTABLE":
			return c.calc?.notes[0] ?? "The calculation could not be performed with the bound evidence."
		case "NOT_VERIFIABLE":
			return notVerifiableReason(c)
		case "REFERENCE_NOT_YET_FILED":
			return "No financial statement covering this period is in the reference used for this run."
		default:
			return "The agents are still working on this claim."
	}
}

const ROLE_LABEL: Record<string, string> = { current: "Current period", base: "Comparison period", alternate: "Alternative basis (context only)" }

function EvidenceRow({ x, role }: { x: CalcInput; role: string }) {
	return (
		<tr>
			<th scope="row">
				{ROLE_LABEL[role] ?? role}
				<div className="cell-sub">{x.concept.replace(/^(us-gaap|ifrs-full|report):/, "")}</div>
				{x.consolidation === "standalone" && <div className="cell-sub">Standalone</div>}
			</th>
			<td>
				<div>{x.period.replace(/^(\w+)-FY(\d+)$/, "$1 FY$2")}</div>
				<div className="cell-sub num">
					{x.start} → {x.end}
				</div>
			</td>
			<td className="num right">
				{fmtNumber(x.value)}
				<div className="cell-sub">{x.unit}</div>
			</td>
			<td>
				{x.location ? (
					<>
						<a href={x.url} target="_blank" rel="noreferrer noopener" className="ext-link">
							Report p.{x.location.page} <IconExternal size={12} />
						</a>
						<div className="cell-sub">
							Row “{x.location.row}” · column “{x.location.column}”
						</div>
						<div className="cell-sub num">
							Printed {x.location.printed} ({x.location.unitNote})
						</div>
					</>
				) : (
					<>
						<a href={x.url} target="_blank" rel="noreferrer noopener" className="ext-link">
							{x.form} <IconExternal size={12} />
						</a>
						<div className="cell-sub num">
							{x.accn} · filed {x.filed}
						</div>
					</>
				)}
				{x.derivation && <div className="cell-sub">Derived: {x.derivation}</div>}
			</td>
		</tr>
	)
}

export function Inspector({ run, claim: c, onClose, onSelect, onLocate, historyOpen, onHistoryToggle, headingRef, liveConfigured, liveHint, onChallenge }: Props) {
	const idx = run.claims.findIndex((x) => x.id === c.id)
	const prev = run.claims[idx - 1]
	const next = run.claims[idx + 1]
	const historyRef = useRef<HTMLDetailsElement>(null)
	const timing = run.provenance.simulatedTiming ? " (replay timing, not live model latency)" : ""

	useEffect(() => {
		if (historyOpen) historyRef.current?.scrollIntoView({ block: "start", behavior: "auto" })
	}, [historyOpen, c.id])

	const i = c.interpretation
	const inputs = c.calc?.inputs ?? []

	return (
		<div className="inspector">
			<div className="inspector-head">
				<h2 className="inspector-title" tabIndex={-1} ref={headingRef} id="inspector-title">
					<span className="claim-id">{c.id}</span> Evidence inspector
				</h2>
				<div className="inspector-nav">
					<button className="icon-btn" onClick={() => prev && onSelect(prev.id)} disabled={!prev} aria-label="Previous claim">
						<IconChevron dir="left" />
					</button>
					<button className="icon-btn" onClick={() => next && onSelect(next.id)} disabled={!next} aria-label="Next claim">
						<IconChevron dir="right" />
					</button>
					<button className="icon-btn" onClick={onClose} aria-label="Close evidence inspector">
						<IconClose />
					</button>
				</div>
			</div>

			<div className="inspector-body">
				<section className="conclusion" aria-label="Conclusion">
					<VerdictBadge claim={c} large />
					<p className="conclusion-text">{conclusion(c)}</p>
					<ReviewLine claim={c} />
					<p className="muted small">{c.review.detail}</p>
					<EditorCorrection key={c.id + "-" + c.revision + "-" + c.calc?.evidenceRevision} run={run} claim={c} />
				</section>

				<FilingReceipt claim={c} />

				<section>
					<h3>Quotation</h3>
					<blockquote className="quote">“{c.quote}”</blockquote>
					<button className="link-btn" onClick={() => onLocate(c.id)} disabled={c.location.spans.length === 0}>
						<IconLocate size={14} /> Show in article
					</button>
					{c.location.note && <p className="note">{c.location.note}</p>}
					<h4>How the agents read it</h4>
					<p className="muted small">The extractor's structured reading, checked by the auditor. The article wording above is unchanged.</p>
					<dl className="facts">
						<dt>Metric</dt>
						<dd>{c.metricLabel}</dd>
						<dt>Period</dt>
						<dd>{c.periodLabel}</dd>
						<dt>Type</dt>
						<dd>{c.kindLabel}</dd>
						<dt>Accounting</dt>
						<dd>{c.accountingLabel}</dd>
						<dt>Stated</dt>
						<dd className="num">{c.calc?.statedDisplay ?? `${i.statedNumber} (${i.statedUnit}, ${i.scale})`}</dd>
						{i.currency && (
							<>
								<dt>Currency</dt>
								<dd>{i.currency === "unspecified" ? "not stated (compared in the reference's currency)" : `${i.currency} (read from the text)`}</dd>
							</>
						)}
						{i.consolidation && (
							<>
								<dt>Basis</dt>
								<dd>{i.consolidation === "unspecified" ? "consolidated or standalone not stated" : `${i.consolidation} (read from the text)`}</dd>
							</>
						)}
					</dl>
				</section>

				<section>
					<h3>Evidence</h3>
					{inputs.length > 0 ? (
						<>
							<p className="muted small">
								{run.reference.kind === "sec"
									? "Values from SEC XBRL financial statements (10-Q, 10-K, 20-F, 40-F), looked up by evidence id. Links open the original filing."
									: "Values read from the company's official report and verified by code on the page (row, value on that row, column date, unit note, consolidated/standalone heading). Links open the report at that page."}
							</p>
							<div className="table-wrap">
								<table className="evidence-table">
									<thead>
										<tr>
											<th scope="col">Role</th>
											<th scope="col">Period</th>
											<th scope="col" className="right">
												Value
											</th>
											<th scope="col">Source</th>
										</tr>
									</thead>
									<tbody>
										{inputs.map((x) => (
											<EvidenceRow key={x.evidenceId + x.role} x={x} role={x.role} />
										))}
										{c.evidence?.alternate && <EvidenceRow x={c.evidence.alternate} role="alternate" />}
									</tbody>
								</table>
							</div>
						</>
					) : c.evidence?.reference ? (
						<div className="reference">
							<p>
								{c.evidence.reference.status === "REFERENCE_NOT_YET_FILED"
									? run.reference.kind === "sec"
										? `No 10-Q/10-K/20-F covering ${c.periodLabel} is in the SEC data fetched ${fmtDate(run.snapshotFetchedAt)}. This does not establish that no filing exists today.`
										: `The official report used for this run has no column for ${c.periodLabel}.`
									: c.evidence.reference.detail}
							</p>
							{c.evidence.reference.earningsReleases.length > 0 && (
								<>
									<p className="muted small">Found but deliberately not used as a reference (checking a company's release against itself would be circular):</p>
									<ul className="plain">
										{c.evidence.reference.earningsReleases.map((r) => (
											<li key={r.accn}>
												<a href={r.url} target="_blank" rel="noreferrer noopener" className="ext-link">
													8-K earnings release, filed {r.filed} <IconExternal size={12} />
												</a>{" "}
												<span className="num muted small">{r.accn}</span>
											</li>
										))}
									</ul>
								</>
							)}
						</div>
					) : (
						<p className="muted">No evidence bound yet.</p>
					)}
				</section>

				{c.calc && (c.calc.formula || c.calc.notes.length > 0) && (
					<section>
						<h3>Calculation</h3>
						{c.calc.formula && (
							<>
								<div className="label">Formula</div>
								<pre className="mono-block">{c.calc.formula}</pre>
								<div className="label">With the evidence values</div>
								<pre className="mono-block">{c.calc.substituted}</pre>
							</>
						)}
						{c.calc.toleranceRule && (
							<p className="small">
								<span className="label-inline">Tolerance:</span> {c.calc.toleranceRule}
							</p>
						)}
						{c.calc.difference && <p className="small num">{c.calc.difference}</p>}
						{c.calc.notes.map((n, k) => (
							<p key={k} className="note">
								{n}
							</p>
						))}
					</section>
				)}

				<section>
					<h3>Context warnings</h3>
					<p className="muted small">Framing and comparability issues. They are separate from the numerical result above.</p>
					{c.warnings.length === 0 ? (
						<p className="muted">{c.context.status === "pending" ? "Context review in progress." : "None."}</p>
					) : (
						<ul className="warning-list">
							{c.warnings.map((w, k) => (
								<li key={k}>
									<div className="warning-head">
										<span className="chip chip-warn">{warningLabel(w.code)}</span>
										<span className="muted small">{w.source === "rule" ? "rule" : `context agent · r${w.claimRevision}`}</span>
									</div>
									<p>{w.message}</p>
								</li>
							))}
						</ul>
					)}
					{c.context.status === "failed" && <p className="note note-bad">Context review failed: {c.context.reason}</p>}
				</section>

				<section>
					<h3>Audit and agent revisions</h3>
					<Recheck run={run} claim={c} liveConfigured={liveConfigured} liveHint={liveHint} onChallenge={onChallenge} />
					<dl className="facts">
						<dt>Audit</dt>
						<dd>
							{c.audit.status === "approved" ? `Approved by ${c.audit.by}` : c.audit.status === "investigating" ? `Blocked: correction requested by ${c.audit.by}` : c.audit.status === "none" ? "Not started" : c.audit.status[0].toUpperCase() + c.audit.status.slice(1)}
							{(c.audit.note || c.audit.reason) && <div className="cell-sub">{c.audit.note ?? c.audit.reason}</div>}
						</dd>
						<dt>Context review</dt>
						<dd>{c.context.status === "done" ? "Finished" : c.context.status === "failed" ? "Failed" : "In progress"}</dd>
						<dt>Revision</dt>
						<dd className="num">
							claim r{c.revision}
							{c.evidence ? `, evidence e${c.evidence.evidenceRevision}` : ""}
						</dd>
					</dl>
					{c.corrections.length > 0 ? (
						<ol className="corrections">
							{c.corrections.map((k, n) => (
								<li key={n}>
									<div className="correction-head">
										<strong>
											Revision request {n + 1}: {k.target === "claim" ? "claim reading" : "evidence"}
										</strong>
										<span className="muted small num">
											r{k.claimRevision}.e{k.evidenceRevision} · {fmtSeconds(k.at)}
										</span>
									</div>
									<p className="small">
										Requested by <strong>{k.by}</strong>: {k.reason}
									</p>
								</li>
							))}
						</ol>
					) : (
						<p className="muted small">No agent revisions were requested for this claim.</p>
					)}
					<details ref={historyRef} open={historyOpen} onToggle={(e) => onHistoryToggle((e.currentTarget as HTMLDetailsElement).open)}>
						<summary>Revision history ({c.history.length} events)</summary>
						<p className="muted small">Times are from the start of the run{timing}.</p>
						<ol className="history">
							{c.history.map((h, k) => (
								<li key={k} className={h.kind.startsWith("stale") ? "history-stale" : h.kind === "audit.investigating" || h.kind === "claim.revised" ? "history-correction" : ""}>
									<span className="num history-at">{fmtSeconds(h.at)}</span>
									<span className="history-kind">{h.kind}</span>
									<span className="history-detail">{h.detail}</span>
								</li>
							))}
						</ol>
					</details>
				</section>

				<details className="technical">
					<summary>Technical details</summary>
					<dl className="facts mono-facts">
						{inputs.map((x) => (
							<div key={x.evidenceId + x.role} className="contents">
								<dt>{x.role} evidence id</dt>
								<dd className="mono">{x.evidenceId}</dd>
							</div>
						))}
						{c.evidence?.alternate && (
							<>
								<dt>alternate evidence id</dt>
								<dd className="mono">{c.evidence.alternate.evidenceId}</dd>
							</>
						)}
						<dt>bound by</dt>
						<dd className="mono">{c.evidence?.boundBy ?? "–"}</dd>
						<dt>interpretation</dt>
						<dd>
							<pre className="mono-block">{JSON.stringify(i, null, 2)}</pre>
						</dd>
					</dl>
				</details>
			</div>
		</div>
	)
}

/**
 * "Challenge interpretation": sends a reviewer's concern to the extractor. A change the code validates
 * becomes a new claim revision and only this claim is re-checked; the verdict still comes from the
 * calculator. Needs a live model on the server.
 */
function Recheck({ run, claim: c, liveConfigured, liveHint, onChallenge }: { run: RunView; claim: ClaimView; liveConfigured: boolean; liveHint: string; onChallenge: (claimId: string, reason: string) => Promise<void> }) {
	const [open, setOpen] = useState(false)
	const [reason, setReason] = useState("")
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const settled = run.status !== "running" && !run.recoveryPending && (c.review.status === "complete" || c.review.status === "unresolved" || c.review.status === "incomplete")
	const incomplete = c.review.status === "incomplete"
	const rechecking = run.status === "running" && c.corrections.some((k) => k.by === "reviewer (human)") && c.review.status !== "complete"
	if (rechecking) return <p className="note">Recheck in progress: the extractor is reconsidering this claim; other claims are unchanged.</p>
	if (!open)
		return (
			<div className="recheck">
				<button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)} disabled={!settled || !liveConfigured} aria-describedby={`recheck-help-${c.id}`}>
					{incomplete ? "Recheck this claim" : "Challenge interpretation"}
				</button>
				<p className="muted small" id={`recheck-help-${c.id}`}>
					{!liveConfigured ? `Recheck asks the extractor and auditor again, so it needs a live model. ${liveHint}` : !settled ? "Available once this claim's review has settled." : incomplete ? "Ask the extractor to revisit this claim. If its interpretation changes, the checker runs the evidence, context, and audit steps again for this claim." : "Ask the extractor to reconsider how this sentence was read. A validated change creates a new revision and re-checks only this claim; the verdict always comes from the calculator."}
				</p>
			</div>
		)
	return (
		<form
			className="recheck-form"
			onSubmit={async (e) => {
				e.preventDefault()
				setBusy(true)
				setError(undefined)
				try {
					await onChallenge(c.id, reason)
					setOpen(false)
					setReason("")
				} catch (err) {
					setError((err as Error).message)
				} finally {
					setBusy(false)
				}
			}}
		>
			<label htmlFor={`recheck-${c.id}`} className="label">
				{incomplete ? "What should the extractor reconsider about this claim?" : `What looks wrong about how “${c.quote}” was read?`}
			</label>
			<textarea id={`recheck-${c.id}`} className="input textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={600} required placeholder="e.g. The sentence does not say whether this is GAAP or adjusted profit." />
			{error && (
				<p className="form-error" role="alert">
					{error}
				</p>
			)}
			<div className="dialog-actions">
				<button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
					Cancel
				</button>
				<button type="submit" className="btn btn-sm btn-primary" disabled={busy || reason.trim().length < 5}>
					{busy ? "Sending…" : "Recheck this claim"}
				</button>
			</div>
		</form>
	)
}
