import { useState } from "react"
import type { MetaView, StartBody } from "../api"
import { Modal } from "./Dialog"
import { IconClose } from "./icons"

export function CustomArticleDialog({ meta, initial, onClose, onStart }: { meta: MetaView; initial?: { title: string; text: string }; onClose: () => void; onStart: (b: StartBody) => Promise<void> }) {
	const [title, setTitle] = useState(initial?.title ?? "")
	const [text, setText] = useState(initial?.text ?? "")
	const [mode, setMode] = useState<"live" | "replay">(meta.live.configured ? "live" : "replay")
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		if (busy) return
		setBusy(true)
		setError(undefined)
		try {
			await onStart({ source: "custom", mode, title, text })
			onClose()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Modal labelledBy="custom-title" onClose={onClose}>
			<form onSubmit={submit} className="dialog-form">
				<div className="dialog-head">
					<h2 id="custom-title">Check your own article</h2>
					<button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
						<IconClose />
					</button>
				</div>

				<div className="field">
					<label htmlFor="company">Company</label>
					<select id="company" className="input" value={meta.company.ticker} disabled={meta.companies.length < 2} onChange={() => undefined}>
						{meta.companies.map((c) => (
							<option key={c.ticker} value={c.ticker}>
								{c.name} ({c.ticker})
							</option>
						))}
					</select>
					<p className="hint">Only companies with SEC data in this deployment are listed. The article should be about this company's reported results.</p>
				</div>

				<div className="field">
					<label htmlFor="custom-article-title">Title</label>
					<input id="custom-article-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Optional" />
				</div>
				<div className="field">
					<div className="field-row">
						<label htmlFor="custom-article-text">Article text</label>
						<button
							type="button"
							className="link-btn"
							onClick={() => {
								setTitle(meta.example.title)
								setText(meta.example.text)
							}}
						>
							Start from the included example
						</button>
					</div>
					<textarea id="custom-article-text" className="input textarea" value={text} onChange={(e) => setText(e.target.value)} rows={10} required placeholder="Paste the article text. It is shown as plain text and never interpreted as HTML." />
				</div>

				<fieldset className="field modes">
					<legend>Model responses</legend>
					<label className={`mode${!meta.live.configured ? " is-disabled" : ""}`}>
						<input type="radio" name="mode" value="live" checked={mode === "live"} disabled={!meta.live.configured} onChange={() => setMode("live")} />
						<span>
							<strong>Live provider</strong>
							{meta.live.configured ? <span className="hint">Calls {meta.live.model} from the server. Keys stay on the server.</span> : <span className="hint hint-warn">{meta.live.hint}</span>}
						</span>
					</label>
					<label className="mode">
						<input type="radio" name="mode" value="replay" checked={mode === "replay"} onChange={() => setMode("replay")} />
						<span>
							<strong>Replay only (no model calls)</strong>
							<span className="hint">Uses recorded or fixture responses. Text without matching replay data produces an explicit cache miss; nothing is substituted.</span>
						</span>
					</label>
				</fieldset>

				{error && (
					<p className="form-error" role="alert">
						{error}
					</p>
				)}
				<div className="dialog-actions">
					<button type="button" className="btn btn-secondary" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
						{busy ? "Starting…" : "Run check"}
					</button>
				</div>
			</form>
		</Modal>
	)
}
