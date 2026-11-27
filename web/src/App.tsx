import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fmtDate, fmtSeconds, useMedia, useMeta, useRun, type RunView } from "./api"
import { AgentStrip, CorrectionsBar, Lanes, Timeline } from "./components/Activity"
import { ArticlePanel, type ArticleHandle } from "./components/ArticlePanel"
import { CheckForm, emptyDraft, type Draft } from "./components/CheckForm"
import { ReferenceSummary } from "./components/Reference"
import { Modal } from "./components/Dialog"
import { IconAlert, IconChevron, IconDoc, IconDownload, IconPlay, IconSpinner } from "./components/icons"
import { Inspector } from "./components/Inspector"
import { MentionCoverage, ResultsPanel } from "./components/ResultsPanel"
import { priorityCorrection } from "./editorResults"
import { readSession, saveSession } from "./session"

type Tab = "article" | "results" | "evidence"
type Workspace = {
	draft?: Draft
	runId?: string
	selection?: { runId?: string; id?: string }
	tab: Tab
	historyOpen: boolean
	timelineOpen: boolean
	replayChoice?: "recorded" | "fixtures"
}

function isWorkspace(value: unknown): value is Workspace {
	if (!value || typeof value !== "object") return false
	const saved = value as Workspace
	const draft = saved.draft
	return ["article", "results", "evidence"].includes(saved.tab)
		&& typeof saved.historyOpen === "boolean" && typeof saved.timelineOpen === "boolean"
		&& (saved.runId === undefined || typeof saved.runId === "string")
		&& (saved.replayChoice === undefined || saved.replayChoice === "recorded" || saved.replayChoice === "fixtures")
		&& (saved.selection === undefined || (!!saved.selection && typeof saved.selection === "object"
			&& (saved.selection.runId === undefined || typeof saved.selection.runId === "string")
			&& (saved.selection.id === undefined || typeof saved.selection.id === "string")))
		&& (draft === undefined || (!!draft && typeof draft === "object"
			&& [draft.title, draft.text, draft.company, draft.reportUrl, draft.companyName].every(v => typeof v === "string")
			&& (draft.cik === undefined || typeof draft.cik === "string")
			&& (draft.mode === "live" || draft.mode === "replay")))
}

function progressText(run: RunView): string {
	const p = run.progress
	const timing = run.provenance.simulatedTiming ? " (replay timing)" : ""
	const action = run.recovering ? "Resuming" : "Checking"
	switch (run.status) {
		case "running":
			return p.extractionDone ? `${action} · ${p.discovered} claims found · ${p.reviewed} of ${p.discovered} fully reviewed` : `${action} · ${p.discovered} claim${p.discovered === 1 ? "" : "s"} found so far · ${p.reviewed} fully reviewed`
		case "done":
			if (run.recovery) return `Paused · ${p.reviewed} of ${p.discovered} claims fully reviewed`
			return `Finished · ${p.discovered} claims · ${p.reviewed} of ${p.discovered} fully reviewed · ${fmtSeconds(run.elapsedMs)}${timing}`
		case "cache_miss":
			return "Stopped: no replay data for this article (cache miss)"
		case "reference_unavailable":
			return "Stopped: the reference could not be established"
		case "timed_out":
			if (run.recoveryPending) return "Timed out · waiting for in-flight provider work to settle"
			return `Timed out · ${p.discovered} claims found · ${p.reviewed} fully reviewed`
		default:
			return `Failed · ${p.discovered} claims found · ${p.reviewed} fully reviewed`
	}
}

function RecoveryNotice({ recovery, resuming, error, resume }: {
	recovery?: RunView["recovery"]
	resuming: boolean
	error?: string
	resume: () => Promise<void>
}) {
	const unfinished = [
		recovery?.referenceIncomplete ? "read the report" : undefined,
		recovery?.extractionIncomplete ? "finish finding claims" : undefined,
		recovery?.pendingClaims ? `finish ${recovery.pendingClaims} claim review${recovery.pendingClaims === 1 ? "" : "s"}` : undefined,
	].filter((step): step is string => !!step)
	const work = new Intl.ListFormat("en", { type: "conjunction" }).format(unfinished)

	return (
		<section className="notice notice-warn recovery-notice" aria-labelledby="recovery-heading">
			<h3 id="recovery-heading">{resuming ? "Resuming this check" : "This check can resume"}</h3>
			<p className="small" role="status">
				{resuming ? "Completed reviews are still available while unfinished work runs." : `Resume to ${work}. Completed reviews stay in this run.`}
			</p>
			{error && <p className="form-error" role="alert">{error}</p>}
			{(recovery || resuming) && (
				<button type="button" className="btn btn-sm btn-secondary" disabled={resuming} onClick={() => void resume()}>
					{resuming ? <IconSpinner size={14} /> : <IconPlay size={14} />}
					{resuming ? "Resuming…" : "Resume unfinished work"}
				</button>
			)}
		</section>
	)
}

export default function App() {
	const { meta, error: metaError } = useMeta()
	const { run, start, running, restoring, error: runError, reset, challenge, resume, resumeError, resuming, checkMention } = useRun()
	const [saved] = useState(() => readSession("workspace", isWorkspace))
	const [selection, setSelection] = useState(saved?.selection)
	const [historyOpen, setHistoryOpen] = useState(saved?.historyOpen ?? false)
	const [tab, setTab] = useState<Tab>(saved?.tab ?? "article")
	const [timelineOpen, setTimelineOpen] = useState(saved?.timelineOpen ?? false)
	const [draft, setDraft] = useState<Draft | undefined>(saved?.draft)
	const [replayChoice, setReplayChoice] = useState(saved?.replayChoice)
	const article = useRef<ArticleHandle>(null)
	const inspectorHeading = useRef<HTMLHeadingElement>(null)
	const openAuditorTimeline = useRef(false)
	const wide = useMedia("(min-width: 1400px)")
	const desktop = useMedia("(min-width: 960px)")
	const layout = wide ? "wide" : desktop ? "desktop" : "mobile"
	const runId = run?.id
	const previousRunId = useRef(saved?.runId)

	useEffect(() => {
		if (restoring) return
		// PDF uploads can exceed browser storage limits. Keep their existing in-memory handling.
		const storedDraft = draft ? { ...draft, reportFile: undefined } : undefined
		saveSession("workspace", { draft: storedDraft, runId, selection, tab, historyOpen, timelineOpen, replayChoice } satisfies Workspace)
	}, [draft, runId, selection, tab, historyOpen, timelineOpen, replayChoice, restoring])

	// A new run starts with a clean selection.
	useEffect(() => {
		if (restoring || previousRunId.current === runId) return
		previousRunId.current = runId
		setHistoryOpen(false)
		setTimelineOpen(!!runId && openAuditorTimeline.current)
		if (runId) openAuditorTimeline.current = false
	}, [runId, restoring])

	useEffect(() => {
		if (!restoring && !run && runError) setTab("article")
	}, [restoring, run, runError])

	const recommended = useMemo(() => run ? priorityCorrection(run) : undefined, [run])
	const autoSelect = wide && (!running || resuming) ? recommended?.id : undefined
	const selectedId = selection?.runId === runId ? selection?.id : autoSelect
	const selected = run?.claims.find((c) => c.id === selectedId)

	const closeInspector = useCallback(() => {
		setSelection({ runId })
		if (layout === "mobile") setTab("results")
	}, [layout, runId])

	const select = useCallback(
		(id: string, openHistory = false) => {
			setSelection({ runId, id })
			setHistoryOpen(openHistory)
			if (layout === "mobile") setTab("evidence")
		},
		[layout, runId],
	)

	const locate = useCallback(
		(id: string) => {
			setSelection({ runId, id })
			if (layout === "mobile") {
				setTab("article")
				setTimeout(() => article.current?.locate(id), 60)
			} else article.current?.locate(id)
		},
		[layout, runId],
	)

	const replay = replayChoice ?? meta?.defaultReplay ?? "fixtures"
	const runNvidia = (replaySource: typeof replay, showTimeline = false) => {
		openAuditorTimeline.current = showTimeline
		setTab("results")
		start({ source: "example", replay: replaySource }).catch(() => undefined)
	}
	const runExample = () => runNvidia(replay)
	const runAuditorDemo = () => {
		setReplayChoice("fixtures")
		runNvidia("fixtures", true)
	}

	useEffect(() => {
		if (meta && !draft) setDraft(emptyDraft(meta))
	}, [meta, draft])

	if (metaError) return <div className="fatal">Could not reach the checker server: {metaError}</div>
	if (!meta || !draft || restoring) return <div className="loading" aria-busy="true">{restoring ? "Restoring your check…" : "Loading…"}</div>

	const featured = meta.samples.find(sample => sample.id === "wipro")
	const runFeatured = () => {
		if (!featured) return
		openAuditorTimeline.current = false
		setTab("results")
		start({ source: "example", sample: "wipro", replay: "recorded" }).catch(() => undefined)
	}
	const replayOption = meta.replayOptions.find((o) => o.id === replay)
	const articleTitle = run?.article.title ?? meta.example.title
	const articleText = run?.article.text ?? meta.example.text
	const finished = run && run.status !== "running"
	const showInspectorColumn = layout === "wide" && selected
	const drawer = layout === "desktop" && selected

	const startCustom = async (b: Parameters<typeof start>[0]) => {
		openAuditorTimeline.current = false
		await start(b)
		setTab("results")
	}
	const articlePanel = !run ? (
		<section className="panel panel-form" aria-label="Check an article">
			<CheckForm meta={meta} draft={draft} setDraft={setDraft} busy={running} onStart={startCustom} onRunExample={runExample} />
		</section>
	) : (
		<section className="panel" aria-label="Article">
			<div className="panel-head">
				<h2 className="panel-title">
					<IconDoc size={15} /> Article
				</h2>
				<span className="muted small">{run ? `${run.claims.length} claims highlighted` : "Claims are highlighted after a run"}</span>
			</div>
			<ArticlePanel
				ref={article}
				title={articleTitle}
				text={articleText}
				claims={run?.claims ?? []}
				selectedId={selectedId}
				onSelect={(id) => select(id)}
				note={run.source === "example" ? <p className="synthetic-note">Synthetic test article written for this demo. It mixes the company’s real reported figures with deliberate, realistic errors.</p> : undefined}
			/>
		</section>
	)

	const resultsPanel = (
		<section className="panel" aria-label="Results">
			<div className="panel-head">
				<h2 className="panel-title">Results</h2>
				{run && <span className="muted small">Article order</span>}
			</div>
			{run && (run.recovery || resuming) && (
				<RecoveryNotice recovery={run.recovery} resuming={resuming} error={resumeError} resume={resume} />
			)}
			{run?.status === "cache_miss" ? (
				<div className="panel-body">
					{run.reference.kind === "sec" && <MentionCoverage key={run.id} run={run} onCheckMention={checkMention} />}
					<div className="notice notice-warn" role="alert">
						<h3>No replay data for this article</h3>
						<p>
							The replay sources have no recorded or fixture response for this exact text, so the check stopped at extraction. <strong>Nothing was substituted.</strong>
						</p>
						<p className="small mono">{run.error}</p>
						<p>{meta.live.configured ? "Run it again in live mode to check new text." : meta.live.hint}</p>
						<div className="notice-actions">
							<button className="btn btn-primary" onClick={runExample}>
								Run the included example
							</button>
							<button className="btn btn-secondary" onClick={() => reset()}>
								Edit article
							</button>
						</div>
					</div>
				</div>
			) : run?.status === "reference_unavailable" ? (
				<div className="panel-body">
					<ReferenceSummary run={run} open />
					<div className="notice notice-warn" role="alert">
						<h3>The reference could not be established</h3>
						<p>{run.reference.report?.error ?? run.error}</p>
						<p>
							<strong>Nothing was substituted:</strong> no figure is checked without a verified source.
						</p>
						<div className="notice-actions">
							<button className="btn btn-secondary" onClick={() => reset()} disabled={running}>
								Edit article or report
							</button>
						</div>
					</div>
				</div>
			) : run ? (
				<>
					<ReferenceSummary run={run} />
					{!run.recovery && !resuming && (run.status === "failed" || run.status === "timed_out") && (
						<div className="notice notice-bad" role="alert">
							<strong>{run.status === "timed_out" ? "The run timed out." : "The run failed."}</strong> {run.error} Partial results are shown below; claims without a finished review are marked as such.
						</div>
					)}
					{run.claims.length === 0 && run.status === "running" ? (
						<div className="panel-body empty">
							<IconSpinner size={20} />
							<p>{run.reference.report && run.reference.report.status === "reading" ? "Reader is reading the report's statement pages; code verifies each figure on its page…" : "Extractor is reading the article…"}</p>
						</div>
					) : (
						<ResultsPanel key={run.id} run={run} recommended={recommended} selectedId={selectedId} onSelect={(id) => select(id)} onLocate={locate} onCheckMention={checkMention} />
					)}
				</>
			) : (
				<div className="panel-body empty-state">
					{featured && <section className="notice notice-warn">
						<h3>Did Wipro really earn ₹1,51,271 crore in operating profit?</h3>
						<p>Check the units in the draft against the FY2025 filing, then copy the correction for your editor.</p>
					</section>}
					<h3>How a check works</h3>
					<ol className="steps small">
						<li>
							<strong>Company.</strong> Identified from the article (or what you type) against SEC's full list of filers. If the text fits several companies, you choose.
						</li>
						<li>
							<strong>Reference.</strong> SEC financial statements (10-Q, 10-K, 20-F, 40-F), or statement pages from a supplied PDF whose issuer heading matches the company.
						</li>
						<li>
							<strong>Concurrent agents.</strong> Extractor, Evidence, Context and Auditor agents (plus a Reader for reports) work on every claim at once; a deterministic calculator computes each verdict from evidence ids.
						</li>
						<li>
							<strong>Checks.</strong> Currency, scale (thousand, lakh, million, crore, billion), fiscal period, reported vs adjusted, and consolidated vs standalone are validated by code. Missing data is reported, not invented.
						</li>
					</ol>
					<p className="small muted">Or watch it on the included NVIDIA example. Model responses: {replayOption?.label}. No API key is needed.</p>
					<div className="demo-actions">
						<button className="btn btn-secondary" onClick={runExample} disabled={running}>
							<IconPlay size={14} /> Run included example
						</button>
						{meta.replayOptions.some(option => option.id === "fixtures" && option.available) && (
							<button className="btn btn-secondary" onClick={runAuditorDemo} disabled={running}>
								<IconPlay size={14} /> See scripted auditor correction
							</button>
						)}
					</div>
				</div>
			)}
		</section>
	)

	const inspector = selected && run && (
		<Inspector
			run={run}
			claim={selected}
			onClose={closeInspector}
			onSelect={(id) => select(id)}
			onLocate={locate}
			historyOpen={historyOpen}
			onHistoryToggle={setHistoryOpen}
			headingRef={inspectorHeading}
			liveConfigured={meta.live.configured}
			liveHint={meta.live.hint}
			onChallenge={(id, reason) => {
				setSelection({ runId, id })
				return challenge(id, reason)
			}}
		/>
	)

	return (
		<div className="app">
			<a href="#workspace" className="skip-link">
				Skip to workspace
			</a>
			<header className="header">
				<div className="brand">
					<span className="logo" aria-hidden="true">
						✓
					</span>
					<div>
						<h1 className="product">{meta.product.name}</h1>
						<p className="tagline">{meta.product.tagline}</p>
					</div>
				</div>
				<div className="header-meta">
					{run ? (
						<>
							<span className="pill pill-dark">
								{run.reference.entityName}
								{run.reference.ticker ? ` · ${run.reference.ticker}` : ""}
							</span>
							<span className="pill pill-dark">{run.reference.kind === "sec" ? `SEC data as of ${fmtDate(run.reference.fetchedAt)}` : `Official report · fetched ${fmtDate(run.reference.fetchedAt)}`}</span>
						</>
					) : (
						<span className="pill pill-dark">Any SEC filer, or a company's official report (PDF)</span>
					)}
				</div>
			</header>

			<div className="runbar">
				<div className="runbar-actions">
					{!running && <a className="btn btn-primary" href="/newsroom">Apple newsroom case &amp; 60-second demo</a>}
					{featured && <button className="btn btn-secondary" onClick={runFeatured} disabled={running}>
						<IconPlay size={14} /> Check the Wipro example · recorded
					</button>}
					<button className="btn btn-secondary" onClick={() => reset()} disabled={running || !run}>
						{running ? <IconSpinner size={14} /> : <IconDoc size={14} />} {running ? "Running…" : "Check your article"}
					</button>
					<button className="btn btn-secondary" onClick={runExample} disabled={running} aria-describedby="example-label">
						<IconPlay size={14} /> Run NVIDIA example
					</button>
					{meta.replayOptions.filter((o) => o.available).length > 1 && (
						<label className="replay-select">
							<span className="sr-only">Model responses for the included example</span>
							<select className="input input-sm" value={replay} onChange={(e) => setReplayChoice(e.target.value as "recorded" | "fixtures")} disabled={running} title={replayOption?.detail}>
								{meta.replayOptions
									.filter((o) => o.available)
									.map((o) => (
										<option key={o.id} value={o.id}>
											{o.label}
										</option>
									))}
							</select>
						</label>
					)}
					{(run?.source === "example") && (
						<span className="label-chip" id="example-label" >
							Synthetic article · {run.provenance.label} · Real calculations
						</span>
					)}
				</div>
				<div className="runbar-status">
					<span className="status-text" aria-live="polite">
						{resuming && !run?.recovering ? "Resuming unfinished work…" : run ? progressText(run) : runError ? <span className="text-bad">{runError}</span> : "Ready · paste an article to check"}
					</span>
					{run && run.provenance.kind !== "none" && (
						<span className={`pill prov prov-${run.provenance.kind}`} title={Object.entries(run.provenance.counts).map(([k, v]) => `${k}: ${v}`).join(", ")}>
							{run.provenance.label} · {Object.values(run.provenance.counts).reduce((a, b) => a + b, 0)} model calls
						</span>
					)}
					{finished && run.status !== "cache_miss" && (
						<span className="downloads">
							<a className="btn btn-sm btn-quiet" href={`/api/runs/${run.id}/report.md`} download>
								<IconDownload size={14} /> Markdown
							</a>
							<a className="btn btn-sm btn-quiet" href={`/api/runs/${run.id}/report.json`} download>
								<IconDownload size={14} /> JSON
							</a>
							<a className="btn btn-sm btn-quiet" href={`/api/runs/${run.id}/trace.json`} download>
								<IconDownload size={14} /> Trace
							</a>
						</span>
					)}
				</div>
			</div>

			<div className="activity">
				<AgentStrip run={run} />
				{run && (
					<button className="btn btn-sm btn-quiet timeline-toggle" aria-expanded={timelineOpen} aria-controls="timeline" onClick={() => setTimelineOpen((o) => !o)}>
						<IconChevron dir={timelineOpen ? "down" : "right"} size={14} /> Timeline ({run.timeline.length})
					</button>
				)}
			</div>
			{run && timelineOpen && (
				<div id="timeline" className="timeline-wrap">
					<Lanes run={run} onSelect={(id) => select(id)} />
					<Timeline run={run} onSelect={(id, h) => select(id, h)} />
				</div>
			)}
			{run && finished && <CorrectionsBar run={run} onView={(id) => select(id, true)} />}

			<main id="workspace" className={`workspace layout-${layout}${showInspectorColumn ? " has-inspector" : ""}`}>
				{layout === "mobile" ? (
					<>
						<div className="tabs" role="tablist" aria-label="Workspace views">
							{(["article", "results", "evidence"] as Tab[]).map((t) => (
								<button
									key={t}
									role="tab"
									id={`tab-${t}`}
									aria-selected={tab === t}
									aria-controls={`tabpanel-${t}`}
									tabIndex={tab === t ? 0 : -1}
									disabled={t === "evidence" && !selected}
									onClick={() => setTab(t)}
									onKeyDown={(e) => {
										const order: Tab[] = selected ? ["article", "results", "evidence"] : ["article", "results"]
										const i = order.indexOf(tab)
										if (e.key === "ArrowRight") setTab(order[(i + 1) % order.length])
										if (e.key === "ArrowLeft") setTab(order[(i - 1 + order.length) % order.length])
									}}
								>
									{t === "article" ? "Article" : t === "results" ? `Results${run ? ` (${run.claims.length})` : ""}` : selected ? `Evidence · ${selected.id}` : "Evidence"}
								</button>
							))}
						</div>
						<div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel">
							{tab === "article" ? articlePanel : tab === "results" ? resultsPanel : inspector ? <section className="panel">{inspector}</section> : null}
						</div>
					</>
				) : (
					<>
						{articlePanel}
						{resultsPanel}
						{showInspectorColumn && (
							<section className="panel panel-inspector" aria-labelledby="inspector-title">
								{inspector}
							</section>
						)}
					</>
				)}
			</main>

			{drawer && (
				<Modal labelledBy="inspector-title" variant="drawer" onClose={closeInspector} initialFocus={inspectorHeading}>
					{inspector}
				</Modal>
			)}

			<footer className="footer">
				<IconAlert size={13} /> {meta.product.disclaimer} · Mozaik @mozaik-ai/core {meta.mozaikVersion}
			</footer>
		</div>
	)
}
