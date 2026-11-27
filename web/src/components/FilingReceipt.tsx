import { useState } from "react"
import type { ClaimView, RunView } from "../api"
import { correctionPreview, correctionText, exactValue, filingRow, receiptConversion } from "../correction"
import { IconExternal } from "./icons"
import "./FilingReceipt.css"

export function FilingReceipt({ claim }: { claim: ClaimView }) {
	const inputs = claim.calc?.inputs ?? []
	if (!inputs.length) return null
	return <section className="filing-receipt" aria-label="Filing receipt">
		<h3>Filing receipt</h3>
		{inputs.map(input => <div key={input.role + input.evidenceId} className="receipt-input">
			{input.derivation && <p><strong>Derived {input.period}</strong> · {input.derivation}</p>}
			{(input.derivation ? input.derivationInputs ?? [] : [input]).map((fact, index) => {
				const row = filingRow(fact)
				const role = input.derivation ? index === 0 ? "Full year" : "First nine months" : input.role === "base" ? "Comparison period" : "Current period"
				return <article className="receipt-fact" key={fact.evidenceId}>
					<div className="receipt-fact-head"><strong>{role}</strong>
						{fact.url ? <a className="ext-link" href={fact.url} target="_blank" rel="noreferrer noopener">{fact.location ? `Report p.${fact.location.page}` : fact.form} <IconExternal size={12} /></a> : <span>{fact.form}</span>}
					</div>
					{row && <p><strong>{row.row}</strong> · {row.printed} ({row.units})<br/>{row.tableUrl ? <a href={row.tableUrl} className="ext-link" target="_blank" rel="noreferrer noopener">{row.statement} <IconExternal size={12} /></a> : <span className="muted">{row.statement}</span>}</p>}
					<p className="receipt-raw">{fact.location ? "Verified value" : "SEC XBRL fact"} · <code>{fact.concept}</code><br/>
						<b className="num">{fact.unit} {exactValue(fact.value)}</b> · {fact.start} to {fact.end}</p>
					{!fact.location && <p className="muted small">{fact.accn} · filed {fact.filed}</p>}
				</article>
			})}
			{receiptConversion(claim, input) && <p className="small receipt-conversion">{receiptConversion(claim, input)}</p>}
		</div>)}
	</section>
}

export function EditorCorrection({ run, claim }: { run: RunView; claim: ClaimView }) {
	const [precision, setPrecision] = useState<"article" | "filing">("article")
	const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle")
	const preview = correctionPreview(run, claim)
	if (!preview) return null
	const text = correctionText(run, claim, precision)!
	const r = preview.replacement
	function choose(value: typeof precision) {
		setPrecision(value)
		setStatus("idle")
	}
	async function copy() {
		try {
			await navigator.clipboard.writeText(text)
			setStatus("copied")
		} catch {
			setStatus("manual")
		}
	}
	return <div className="receipt-edit">
		<h4>{r ? "Suggested edit" : "Standalone alternative"}</h4>
		{r ? <p className="receipt-preview">{r.before}<mark>{precision === "filing" ? r.exact : r.replacement}</mark>{r.after}</p>
			: <><p className="muted small">This claim needs a separately worded sentence. Check the wording before replacing the original.</p><p className="receipt-preview">{preview.suggestion}</p></>}
		{r && r.exact !== r.replacement && <fieldset className="receipt-precision">
			<legend>Precision for the edit</legend>
			<label><input type="radio" name={`precision-${claim.id}`} checked={precision === "article"} onChange={() => choose("article")} /> Article · {r.replacement}</label>
			<label><input type="radio" name={`precision-${claim.id}`} checked={precision === "filing"} onChange={() => choose("filing")} /> Filing · {r.exact}</label>
		</fieldset>}
		{preview.calculations.map(calculation => <p key={calculation} className="small">{calculation}</p>)}
		<button className="btn btn-secondary" onClick={copy}>Copy correction with source</button>
		{status === "copied" && <p role="status">Correction and source copied.</p>}
		{status === "manual" && <label>Copy the correction manually<textarea readOnly value={text} onFocus={event => event.target.select()} /></label>}
	</div>
}
