import { useEffect, useRef, useState } from "react"
import { ApiError, fmtDate, resolveArticle, type Candidate, type MetaView, type ResolveView, type StartBody } from "../api"
import { IconAlert, IconCheck, IconPlay, IconSpinner } from "./icons"

export type Draft = {
	title: string
	text: string
	/** what the user typed in the company field (ticker or name) */
	company: string
	/** an SEC filer the user picked from candidates */
	cik?: string
	reportUrl: string
	reportFile?: { name: string; base64: string; size: number }
	companyName: string
	mode: "live" | "replay"
}

export const emptyDraft = (meta: MetaView): Draft => ({ title: "", text: "", company: "", reportUrl: "", companyName: "", mode: meta.live.configured ? "live" : "replay" })

const MAX_PDF = 25 * 1024 * 1024

function CandidateList({ candidates, chosen, onChoose }: { candidates: Candidate[]; chosen?: string; onChoose: (c: Candidate) => void }) {
	return (
		<fieldset className="candidates">
			<legend>Which company is the article about?</legend>
			{candidates.map((c) => (
				<label key={c.cik} className={`candidate${chosen === c.cik ? " is-chosen" : ""}`}>
					<input type="radio" name="candidate" checked={chosen === c.cik} onChange={() => onChoose(c)} />
					<span>
						<strong>{c.name}</strong> <span className="muted">{c.tickers[0] ?? "no ticker"} · CIK {Number(c.cik)}</span>
						<span className="hint">{c.why.join("; ")}</span>
					</span>
				</label>
			))}
		</fieldset>
	)
}

export function CheckForm({ meta, draft, setDraft, busy, onStart, onRunExample }: { meta: MetaView; draft: Draft; setDraft: (d: Draft) => void; busy: boolean; onStart: (b: StartBody) => Promise<void>; onRunExample: () => void }) {
	const [resolved, setResolved] = useState<ResolveView>()
	const [resolving, setResolving] = useState(false)
	const [error, setError] = useState<{ message: string; code?: string; candidates?: Candidate[] }>()
	const [submitting, setSubmitting] = useState(false)
	const seq = useRef(0)
	const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })

	// identify the company as the article is pasted (debounced; no run and no model call)
	useEffect(() => {
		const enough = draft.text.trim().length >= 20 || draft.company.trim() || draft.cik
		if (!enough) {
			setResolved(undefined)
			return
		}
		const id = ++seq.current
		const ctl = new AbortController()
		const t = setTimeout(() => {
			setResolving(true)
			resolveArticle({ title: draft.title, text: draft.text, company: draft.cik ? { cik: draft.cik } : draft.company.trim() ? { query: draft.company.trim() } : undefined, mode: draft.mode }, ctl.signal)
				.then((r) => id === seq.current && setResolved(r))
				.catch(() => id === seq.current && setResolved(undefined))
				.finally(() => id === seq.current && setResolving(false))
		}, 550)
		return () => {
			clearTimeout(t)
			ctl.abort()
		}
	}, [draft.text, draft.title, draft.company, draft.cik, draft.mode])

	const res = resolved?.resolution
	const ref = resolved?.reference
	const hasReport = !!(draft.reportUrl.trim() || draft.reportFile)
	const needsReport = res?.status === "not_found" || (ref?.kind === "unavailable" && ref.needsReport) || error?.code === "COMPANY_NOT_FOUND" || error?.code === "SEC_DATA_UNAVAILABLE"
	const secCompany = res?.status === "resolved" ? res.company : undefined
	const [reportOpen, setReportOpen] = useState(false)
	/** a sample's instructions for getting its report (e.g. a site that only serves the PDF to browsers) */
	const [sampleReportNote, setSampleReportNote] = useState<string>()
	useEffect(() => {
		if (needsReport || hasReport) setReportOpen(true)
	}, [needsReport, hasReport])

	async function pickFile(f?: File) {
		if (!f) return set({ reportFile: undefined })
		if (f.size > MAX_PDF) return setError({ message: `${f.name} is ${(f.size / 1e6).toFixed(1)} MB; the limit is 25 MB.` })
		const buf = new Uint8Array(await f.arrayBuffer())
		let bin = ""
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
		set({ reportFile: { name: f.name, base64: btoa(bin), size: f.size }, reportUrl: "" })
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		if (busy || submitting) return
		setError(undefined)
		const name = draft.companyName.trim() || draft.company.trim() || undefined
		const body: StartBody = {
			source: "custom",
			mode: draft.mode,
			title: draft.title,
			text: draft.text,
			company: draft.cik ? { cik: draft.cik } : draft.company.trim() ? { query: draft.company.trim(), name } : name ? { name } : undefined,
			report: draft.reportUrl.trim() ? { url: draft.reportUrl.trim() } : draft.reportFile ? { file: { name: draft.reportFile.name, base64: draft.reportFile.base64 } } : undefined,
		}
		setSubmitting(true)
		try {
			await onStart(body)
		} catch (err) {
			const b = err instanceof ApiError ? err.body : {}
			setError({ message: (err as Error).message, code: typeof b.code === "string" ? b.code : undefined, candidates: Array.isArray(b.candidates) ? (b.candidates as Candidate[]) : undefined })
		} finally {
			setSubmitting(false)
		}
	}

	const candidates = error?.candidates ?? (res?.status === "ambiguous" ? res.candidates : undefined)

	return (
		<form className="check-form" onSubmit={submit} aria-labelledby="check-title">
			<div className="check-head">
				<h2 id="check-title">Check a finance article</h2>
				<p className="muted">
					Paste an article about any company. The checker identifies the company, fetches its official statements (SEC filings, or the company's own report as a PDF), and checks every revenue, profit and EPS figure, with a receipt for each.
				</p>
			</div>

			{meta.samples.length > 0 && (
				<div className="samples" role="group" aria-label="Sample articles">
					<span className="muted small">Try a fresh article:</span>
					{meta.samples.map((s) => (
						<button
							key={s.id}
							type="button"
							className="sample-chip"
							title={s.note}
							onClick={() => {
								setError(undefined)
								setSampleReportNote(/\bPDF\b/.test(s.note) && /upload|download/i.test(s.note) ? s.note : undefined)
								setDraft({ ...draft, title: s.title, text: s.text, company: s.company ?? "", cik: undefined, reportUrl: s.reportUrl ?? "", reportFile: undefined, companyName: s.reportUrl ? (s.company ?? "") : "", mode: s.preferredMode ?? draft.mode })
							}}
						>
							{s.label}
						</button>
					))}
				</div>
			)}

			{meta.samples.filter(s => s.preferredMode === draft.mode && s.text === draft.text).map(s => <p className="hint" key={s.id}>{s.note}</p>)}
			<div className="field">
				<label htmlFor="article-title">Title</label>
				<input id="article-title" className="input" value={draft.title} onChange={(e) => set({ title: e.target.value })} maxLength={300} placeholder="Optional" />
			</div>
			<div className="field">
				<label htmlFor="article-text">Article text</label>
				<textarea id="article-text" className="input textarea" value={draft.text} onChange={(e) => set({ text: e.target.value })} rows={9} required placeholder="Paste the article. It is shown as plain text and never interpreted as HTML." />
			</div>

			<div className="field">
				<label htmlFor="article-company">Company</label>
				<input
					id="article-company"
					className="input"
					value={draft.company}
					onChange={(e) => set({ company: e.target.value, cik: undefined })}
					placeholder="Detected from the article — or type a name or ticker"
					autoComplete="off"
					maxLength={120}
				/>
				<div className="company-status" aria-live="polite">
					{resolving ? (
						<span className="muted small">
							<IconSpinner size={12} /> Identifying the company…
						</span>
					) : res?.status === "resolved" ? (
						<div className="resolved">
							<p>
								<IconCheck size={14} /> <strong>{res.company.name}</strong> <span className="muted">{res.company.tickers[0] ?? ""} · CIK {Number(res.company.cik)}</span>
								<span className="hint">{res.reason}</span>
							</p>
							{ref?.kind === "sec" ? (
								<p className="small">
									Reference: SEC financial statements ({ref.forms.join(", ")}) · latest {ref.latest ?? "–"} · reported in {ref.reportingCurrency ?? "?"} · {ref.source === "committed" ? "committed snapshot" : "fetched live"} {fmtDate(ref.fetchedAt)}
								</p>
							) : ref?.kind === "unavailable" ? (
								<p className="small text-warn">
									<IconAlert size={12} /> {ref.reason}
								</p>
							) : null}
						</div>
					) : res?.status === "not_found" ? (
						<p className="small text-warn">
							<IconAlert size={12} /> {res.reason}
						</p>
					) : null}
				</div>
				{candidates && candidates.length > 0 && (
					<CandidateList
						candidates={candidates}
						chosen={draft.cik}
						onChoose={(c) => {
							setError(undefined)
							set({ cik: c.cik, company: c.name })
						}}
					/>
				)}
				<p className="hint">
					Resolved against SEC's list of {meta.companyIndex ? meta.companyIndex.count.toLocaleString("en-US") : "all"} filers; no fixed company list. When the text could mean several companies, you choose.
				</p>
			</div>

			<details className="report-box" open={reportOpen} onToggle={(e) => setReportOpen((e.target as HTMLDetailsElement).open)}>
				<summary>Official report (PDF){needsReport ? " — needed for this company" : " — optional"}</summary>
				<p className="hint">For a company without usable SEC data, supply its results PDF. The selected company must match the issuer shown on the financial statement pages. The checker verifies accepted figures against those pages.</p>
				{sampleReportNote && <p className="hint hint-warn">{sampleReportNote}</p>}
				<div className="field">
					<label htmlFor="report-url">PDF URL</label>
					<input id="report-url" className="input" type="url" value={draft.reportUrl} onChange={(e) => set({ reportUrl: e.target.value, reportFile: undefined })} placeholder="https://… /results.pdf" />
				</div>
				<div className="field">
					<label htmlFor="report-file">or upload the PDF</label>
					<input id="report-file" className="input" type="file" accept="application/pdf,.pdf" onChange={(e) => pickFile(e.target.files?.[0])} />
					{draft.reportFile && (
						<span className="hint">
							{draft.reportFile.name} · {(draft.reportFile.size / 1e6).toFixed(2)} MB
						</span>
					)}
				</div>
				{hasReport && !secCompany && (
					<div className="field">
						<label htmlFor="report-company">Company name (for the report)</label>
						<input id="report-company" className="input" value={draft.companyName} onChange={(e) => set({ companyName: e.target.value })} placeholder="e.g. Tata Consultancy Services" maxLength={120} />
					</div>
				)}
			</details>

			<fieldset className="field modes">
				<legend>Model responses</legend>
				<label className={`mode${!meta.live.configured ? " is-disabled" : ""}`}>
					<input type="radio" name="mode" value="live" checked={draft.mode === "live"} disabled={!meta.live.configured} onChange={() => set({ mode: "live" })} />
					<span>
						<strong>Live model</strong>
						{meta.live.configured ? <span className="hint">Calls {meta.live.model} from the server. Keys stay on the server.</span> : <span className="hint hint-warn">{meta.live.hint}</span>}
					</span>
				</label>
				<label className="mode">
					<input type="radio" name="mode" value="replay" checked={draft.mode === "replay"} onChange={() => set({ mode: "replay" })} />
					<span>
						<strong>Replay only (no model calls)</strong>
						<span className="hint">Uses recorded responses: the sample articles were recorded with a real model. New text without a recording stops with an explicit cache miss; nothing is substituted.</span>
					</span>
				</label>
			</fieldset>

			{error && (
				<p className="form-error" role="alert">
					{error.message}
				</p>
			)}
			<div className="check-actions">
				<button type="submit" className="btn btn-primary" disabled={busy || submitting || !draft.text.trim()}>
					{submitting ? <IconSpinner size={14} /> : <IconPlay size={14} />} {submitting ? (hasReport ? "Fetching and reading the report…" : "Fetching the company's statements…") : "Check article"}
				</button>
				<button type="button" className="link-btn" onClick={onRunExample} disabled={busy}>
					or run the included NVIDIA example
				</button>
			</div>
		</form>
	)
}
