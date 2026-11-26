import { useCallback, useEffect, useRef, useState } from "react"
import { fmtDate, fmtSeconds, useMedia, useMeta, useRun, type RunView } from "./api"
import { AgentStrip, CorrectionsBar, Lanes, Timeline } from "./components/Activity"
import { ArticlePanel, type ArticleHandle } from "./components/ArticlePanel"
import { CustomArticleDialog } from "./components/CustomArticle"
import { Modal } from "./components/Dialog"
import { IconAlert, IconChevron, IconDoc, IconDownload, IconPlay, IconSpinner } from "./components/icons"
import { Inspector } from "./components/Inspector"
import { ResultsPanel } from "./components/ResultsPanel"

type Tab = "article" | "results" | "evidence"

function progressText(run: RunView): string {
	const p = run.progress
	const timing = run.provenance.simulatedTiming ? " (replay timing)" : ""
	switch (run.status) {
		case "running":
			return p.extractionDone ? `Checking · ${p.discovered} claims found · ${p.reviewed} of ${p.discovered} fully reviewed` : `Checking · ${p.discovered} claim${p.discovered === 1 ? "" : "s"} found so far · ${p.reviewed} fully reviewed`
		case "done":
			return `Finished · ${p.discovered} claims · ${p.reviewed} of ${p.discovered} fully reviewed · ${fmtSeconds(run.elapsedMs)}${timing}`
		case "cache_miss":
			return "Stopped: no replay data for this article (cache miss)"
		case "timed_out":
			return `Timed out · ${p.discovered} claims found · ${p.reviewed} fully reviewed`
		default:
			return `Failed · ${p.discovered} claims found · ${p.reviewed} fully reviewed`
	}
}

export default function App() {
	const { meta, error: metaError } = useMeta()
	const { run, start, running, error: runError, reset, challenge } = useRun()
	const [selectedId, setSelectedId] = useState<string>()
	const [historyOpen, setHistoryOpen] = useState(false)
	const [tab, setTab] = useState<Tab>("article")
	const [timelineOpen, setTimelineOpen] = useState(false)
	const [customOpen, setCustomOpen] = useState<false | { title: string; text: string } | true>(false)
	const [replayChoice, setReplayChoice] = useState<"recorded" | "fixtures">()
	const article = useRef<ArticleHandle>(null)
	const inspectorHeading = useRef<HTMLHeadingElement>(null)
	const wide = useMedia("(min-width: 1400px)")
	const desktop = useMedia("(min-width: 960px)")
	const layout = wide ? "wide" : desktop ? "desktop" : "mobile"
	const runId = run?.id

	// A new run starts with a clean selection.
	useEffect(() => {
		setSelectedId(undefined)
		setHistoryOpen(false)
		setTimelineOpen(false)
	}, [runId])

	const selected = run?.claims.find((c) => c.id === selectedId)

	const select = useCallback(
		(id: string, openHistory = false) => {
			setSelectedId(id)
			setHistoryOpen(openHistory)
			if (layout === "mobile") setTab("evidence")
		},
		[layout],
	)

	const locate = useCallback(
		(id: string) => {
			setSelectedId(id)
			if (layout === "mobile") {
				setTab("article")
				setTimeout(() => article.current?.locate(id), 60)
			} else article.current?.locate(id)
		},
		[layout],
	)

	const replay = replayChoice ?? meta?.defaultReplay ?? "fixtures"
	const runExample = () => {
		setTab("results")
		start({ source: "example", replay }).catch(() => undefined)
	}

	if (metaError) return <div className="fatal">Could not reach the checker server: {metaError}</div>
	if (!meta) return <div className="loading" aria-busy="true">Loading…</div>

	const replayOption = meta.replayOptions.find((o) => o.id === replay)
	const articleTitle = run?.article.title ?? meta.example.title
	const articleText = run?.article.text ?? meta.example.text
	const finished = run && run.status !== "running"
	const showInspectorColumn = layout === "wide" && selected
	const drawer = layout === "desktop" && selected

	const articlePanel = (
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
				note={!run || run.source === "example" ? <p className="synthetic-note">Synthetic test article written for this demo. It mixes NVIDIA's real reported figures with deliberate, realistic errors.</p> : undefined}
			/>
		</section>
	)

	const resultsPanel = (
		<section className="panel" aria-label="Results">
			<div className="panel-head">
				<h2 className="panel-title">Results</h2>
				{run && <span className="muted small">Article order</span>}
			</div>
			{run?.status === "cache_miss" ? (
				<div className="panel-body">
					<div className="notice notice-warn" role="alert">
						<h3>No replay data for this article</h3>
						<p>
							The replay sources have no recorded or fixture response for this exact text, so the check stopped at extraction. <strong>Nothing was substituted.</strong>
						</p>
						<p className="small mono">{run.error}</p>
						<p>{meta.live.configured ? "Run it again in live mode to check new text." : meta.live.hint}</p>
						<div className="notice-actions">
							<button className="btn btn-primary" onClick={() => reset()}>
								Restore included example
							</button>
							<button className="btn btn-secondary" onClick={() => setCustomOpen({ title: run.article.title, text: run.article.text })}>
								Edit article
							</button>
						</div>
					</div>
				</div>
			) : run ? (
				<>
					{(run.status === "failed" || run.status === "timed_out") && (
						<div className="notice notice-bad" role="alert">
							<strong>{run.status === "timed_out" ? "The run timed out." : "The run failed."}</strong> {run.error} Partial results are shown below; claims without a finished review are marked as such.
						</div>
					)}
					{run.claims.length === 0 && run.status === "running" ? (
						<div className="panel-body empty">
							<IconSpinner size={20} />
							<p>Extractor is reading the article…</p>
						</div>
					) : (
						<ResultsPanel run={run} selectedId={selectedId} onSelect={(id) => select(id)} onLocate={locate} />
					)}
				</>
			) : (
				<div className="panel-body empty-state">
					<h3>Run the included example</h3>
					<p>The checker will extract each numerical claim from the article, find the matching figures in NVIDIA's 10-Q/10-K filings, recalculate them, and have an auditor review every result.</p>
					<ul className="plain small muted">
						<li>Model responses: {replayOption?.label}. {replayOption?.detail}</li>
						<li>SEC lookups, calculations, rule checks and revision control run for real.</li>
						<li>No API key or account is needed.</li>
					</ul>
					<button className="btn btn-primary" onClick={runExample} disabled={running}>
						<IconPlay size={14} /> Run included example
					</button>
				</div>
			)}
		</section>
	)

	const inspector = selected && run && (
		<Inspector
			run={run}
			claim={selected}
			onClose={() => {
				setSelectedId(undefined)
				if (layout === "mobile") setTab("results")
			}}
			onSelect={(id) => select(id)}
			onLocate={locate}
			historyOpen={historyOpen}
			onHistoryToggle={setHistoryOpen}
			headingRef={inspectorHeading}
			liveConfigured={meta.live.configured}
			liveHint={meta.live.hint}
			onChallenge={challenge}
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
					<span className="pill pill-dark">
						{meta.company.name} · {meta.company.ticker}
					</span>
					<span className="pill pill-dark">SEC data as of {fmtDate(meta.snapshotFetchedAt)}</span>
				</div>
			</header>

			<div className="runbar">
				<div className="runbar-actions">
					<button className="btn btn-primary" onClick={runExample} disabled={running} aria-describedby="example-label">
						{running ? <IconSpinner size={14} /> : <IconPlay size={14} />} {running ? "Running…" : "Run included example"}
					</button>
					<button className="btn btn-secondary" onClick={() => setCustomOpen(true)} disabled={running}>
						Check your own article
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
					<span className="label-chip" id="example-label" title={replayOption?.detail}>
						Synthetic example · {replayOption?.short} · Real calculations
					</span>
				</div>
				<div className="runbar-status">
					<span className="status-text" aria-live="polite">
						{run ? progressText(run) : runError ? <span className="text-bad">{runError}</span> : "Ready · nothing has been run yet"}
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
				<Modal labelledBy="inspector-title" variant="drawer" onClose={() => setSelectedId(undefined)} initialFocus={inspectorHeading}>
					{inspector}
				</Modal>
			)}

			{customOpen && (
				<CustomArticleDialog
					meta={meta}
					initial={typeof customOpen === "object" ? customOpen : undefined}
					onClose={() => setCustomOpen(false)}
					onStart={async (b) => {
						await start(b)
						setTab("results")
					}}
				/>
			)}

			<footer className="footer">
				<IconAlert size={13} /> {meta.product.disclaimer} · Mozaik @mozaik-ai/core {meta.mozaikVersion}
			</footer>
		</div>
	)
}
