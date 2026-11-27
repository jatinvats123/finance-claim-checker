import { useEffect, useState } from "react"
import "./newsroom.css"

const base = "/case-files/"
const correction = "https://www.latimes.com/business/la-fi-markets-20160727-snap-story.html"
const archive = "https://archive.sltrib.com/article.php?id=10071604&itype=storyID"
const benchmark = "https://github.com/jatinvats123/finance-claim-checker/blob/c59889b/eval/editor-stress.md"

interface CaseReport {
	run: { model: string; modelCalls: { provenance: string }[]; trace: { peakActive: number } }
	claims: {
		id: string
		interpretation: { quote: string }
		numericalResult: { actual: number; actualDisplay: string; verdict: string; inputs: { url: string; accn: string; end: string }[] }
	}[]
	history: { at: number; claimId?: string; kind: string; detail: string }[]
}

async function receipt(name: string): Promise<CaseReport> {
	const response = await fetch(base + name)
	if (!response.ok) throw new Error("Could not open the saved run.")
	return response.json()
}

const cases = ["apple-2016-error.json", "apple-2016-control.json", "apple-2026-auditor.json"]
const titles = ["Published error", "Rounded correction"]
const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n)

export function NewsroomCase() {
	const [reports, setReports] = useState<CaseReport[]>()
	const [error, setError] = useState("")
	const [version, setVersion] = useState(0)
	const [step, setStep] = useState(0)
	useEffect(() => {
		let current = true
		Promise.all(cases.map(receipt)).then(value => { if (current) setReports(value) })
			.catch(() => { if (current) setError("Could not load the saved receipts. Reload this page to try again.") })
		return () => { current = false }
	}, [])
	const claim = reports?.[version].claims[0]
	const item = claim?.numericalResult
	const fact = item?.inputs[0]
	const multi = reports?.[2]
	const moments = [
		{ claim: "c3", kind: "audit.investigating", text: "The Auditor blocked an apparent mismatch. The draft said “a year earlier,” but Evidence used FY2026." },
		{ claim: "c7", kind: "audit.approved", text: "While the prior-year claim was under review, the Auditor approved a separate gross-profit correction from $223.6B to $233.602B." },
		{ claim: "c3", kind: "claim.revised", text: "The Extractor revised the claim to FY2025. Its old evidence, calculation and review were invalidated." },
		{ claim: "c3", kind: "calculation", marker: "r2.e3 MATCH", text: "Evidence rebound to the FY2025 filing. Filed revenue of $416.161B matches the draft’s rounded $416.2B." },
	]
	const events = moments.map(m => multi?.history.find(e => e.claimId === m.claim && e.kind === m.kind && (!m.marker || e.detail.includes(m.marker))))
	const now = events[step]
	return <div className="newsroom">
		<header><a href="/">Finance Claim Checker</a><a href="/">Open the checker ↗</a></header>
		<main>
			<section className="case-hero">
				<p className="case-kicker">Earnings desk / Apple</p>
				<h1>A $10.5 billion profit claim. What did Apple file?</h1>
				<p>A July 2016 market story overstated Apple’s quarterly profit. We reconstructed the claim and checked it against the original 10-Q.</p>
				<nav><a href="#claim">Inspect the claim ↓</a><a href="#watch">Watch the 60-second walkthrough</a></nav>
			</section>
			{error && <p role="alert">{error}</p>}
			<section id="claim" className="case-section"><p className="case-kicker">01 / Verify the number</p><h2>Check both versions</h2>
				<div className="case-switch">{titles.map((label, i) => <button key={label} type="button" aria-pressed={version === i} onClick={() => setVersion(i)}>{label}</button>)}</div>
				{claim && item && fact ? <div className="case-receipt" aria-live="polite"><div>
					<span className="case-label">Reconstructed draft</span><blockquote>{claim.interpretation.quote}</blockquote>
					<strong className={item.verdict === "MISMATCH" ? "case-warn" : "case-ok"}>{item.verdict === "MISMATCH" ? "Editor correction available" : "Matches the filing"}</strong>
					<p>{version === 0 ? "Replace $10.5 billion with $7.8 billion at the draft’s precision." : "The rounded $7.8 billion figure stands. There is no proposed edit."}</p>
				</div><div><span className="case-label">Apple Form 10-Q / USD in millions</span><table><thead><tr><th>Statement row</th><th>June 25, 2016</th></tr></thead><tbody><tr><td>Income before provision for income taxes</td><td>10,469</td></tr><tr><th>Net income</th><th>{fmt(item.actual / 1000000)}</th></tr></tbody></table>
				<p>{item.actualDisplay} in full precision. Quarter ended {fact.end}.</p><a href={fact.url} target="_blank" rel="noreferrer">Open Apple’s original filing ↗</a></div></div> : !error && <p>Loading the recorded live runs…</p>}
				<div className="case-links"><span>Saved live check{reports && " · " + reports[version].run.model}</span><a href={correction}>Published correction</a><a href={archive}>Original syndicated figure</a><a href={base + cases[version]}>Raw live receipt</a></div>
			</section>
			<section id="auditor" className="case-section"><p className="case-kicker">02 / Follow a real disagreement</p><h2>One claim was challenged. Another finished.</h2>
				<p>A separate Apple FY2026 synthetic draft, checked against public filings. This is a saved live Gemini run. The Auditor’s period rule raised the objection, model agents revised the claim and evidence, and the model Auditor approved the result.</p>
				<div className="case-switch">{["Objection", "Other edit ready", "Period revised", "New verdict"].map((label,i) => <button type="button" key={label} aria-pressed={i === step} onClick={() => setStep(i)}>{label}</button>)}</div>
				<div className="case-step" aria-live="polite">{now && <><span className="case-label">{(now.at/1000).toFixed(2)} s / claim {now.claimId}</span><p>{moments[step].text}</p><details><summary>Inspect the original event</summary><code>{now.kind} · {now.detail}</code></details></>}</div>
				<div className="case-links"><a href={base + cases[2]}>Full run and event history</a><span>{multi && multi.run.modelCalls.filter(c => c.provenance === "live").length + " live model responses"}</span></div>
			</section>
			<section className="case-section" id="timing"><p className="case-kicker">03 / Measure the editor’s wait</p><h2>Time to the first usable correction</h2>
				<div className="case-times"><div><b>31.0 s</b><span>Concurrent median</span></div><div><b>46.0 s</b><span>Serial median</span></div></div>
				<p>In all ten paired synthetic drafts that produced a correct edit, concurrent review produced it first. Two other drafts produced none in either mode. This exploratory engine-only comparison excludes retrieval and browser time. At the predeclared 120-second cutoff both modes delivered 16 of 18 expected edits.</p>
				<div className="case-links"><a href={base + "first-correction-comparison.json"}>All twelve pairs</a><a href={benchmark}>Experiment and limits</a></div>
			</section>
			<section className="case-section" id="watch"><p className="case-kicker">Walkthrough / 60 seconds</p><h2>The judge’s walkthrough</h2><video controls playsInline preload="metadata" aria-label="Finance Claim Checker walkthrough with on-screen text" src="/newsroom-demo.mp4"/></section>
			<footer><a href="/">Check your own public draft ↗</a></footer>
		</main></div>
}
