import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import type { ClaimView } from "../api"
import { VerdictBadge, verdictTone, type Tone } from "./status"

export type ArticleHandle = { locate: (claimId: string) => void }

type Props = {
	title: string
	text: string
	claims: ClaimView[]
	selectedId?: string
	onSelect: (id: string) => void
	note?: React.ReactNode
}

type Seg = { start: number; end: number; ids: string[] }

/** Paragraph ranges over the exact article string (offsets preserved; text is never rewritten). */
function paragraphs(text: string): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = []
	const re = /\n[ \t]*\n\s*/g
	let last = 0
	for (let m = re.exec(text); m; m = re.exec(text)) {
		out.push({ start: last, end: m.index })
		last = m.index + m[0].length
	}
	out.push({ start: last, end: text.length })
	return out.filter((p) => p.end > p.start)
}

function segment(range: { start: number; end: number }, spans: { id: string; start: number; end: number }[]): Seg[] {
	const cuts = new Set([range.start, range.end])
	for (const s of spans) {
		if (s.end <= range.start || s.start >= range.end) continue
		cuts.add(Math.max(s.start, range.start))
		cuts.add(Math.min(s.end, range.end))
	}
	const pts = [...cuts].sort((a, b) => a - b)
	const segs: Seg[] = []
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i]
		const b = pts[i + 1]
		segs.push({ start: a, end: b, ids: spans.filter((s) => s.start <= a && s.end >= b).map((s) => s.id) })
	}
	return segs
}

const PRIORITY: Tone[] = ["bad", "warn", "neutral", "pending", "good"]
const toneOf = (ids: string[], byId: Map<string, ClaimView>): Tone => PRIORITY.find((t) => ids.some((id) => verdictTone(byId.get(id)!.verdict) === t)) ?? "pending"

export const ArticlePanel = forwardRef<ArticleHandle, Props>(function ArticlePanel({ title, text, claims, selectedId, onSelect, note }, ref) {
	const scroller = useRef<HTMLDivElement>(null)
	const [menu, setMenu] = useState<{ ids: string[]; top: number; left: number; from: HTMLElement }>()
	const byId = useMemo(() => new Map(claims.map((c) => [c.id, c])), [claims])
	const spans = useMemo(() => claims.flatMap((c) => c.location.spans.map((s) => ({ id: c.id, ...s }))), [claims])
	const paras = useMemo(() => paragraphs(text), [text])

	useImperativeHandle(ref, () => ({
		locate(id: string) {
			const el = scroller.current?.querySelector<HTMLElement>(`[data-claims~="${id}"]`)
			if (!el) return
			const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
			el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" })
			for (const m of scroller.current!.querySelectorAll<HTMLElement>(`[data-claims~="${id}"]`)) {
				m.classList.remove("flash")
				void m.offsetWidth
				m.classList.add("flash")
			}
			el.focus({ preventScroll: true })
		},
	}))

	useEffect(() => {
		if (!menu) return
		const first = scroller.current?.querySelector<HTMLButtonElement>(".claim-menu button")
		first?.focus()
		const close = (e: MouseEvent) => {
			if (!(e.target as HTMLElement).closest(".claim-menu")) setMenu(undefined)
		}
		document.addEventListener("mousedown", close)
		return () => document.removeEventListener("mousedown", close)
	}, [menu])

	function activate(ids: string[], el: HTMLElement) {
		if (ids.length === 1) return onSelect(ids[0])
		const box = scroller.current!.getBoundingClientRect()
		const r = el.getBoundingClientRect()
		setMenu({ ids, top: r.bottom - box.top + scroller.current!.scrollTop + 6, left: Math.max(8, Math.min(r.left - box.left, box.width - 300)), from: el })
	}

	const closeMenu = () => {
		menu?.from.focus()
		setMenu(undefined)
	}

	return (
		<div className="panel-body article-scroll" ref={scroller}>
			<article className="article" aria-labelledby="article-title">
				<h2 id="article-title" className="article-title">
					{title}
				</h2>
				{note}
				{paras.map((p) => (
					<p key={p.start}>
						{segment(p, spans).map((s) => {
							const chunk = text.slice(s.start, s.end)
							if (!s.ids.length) return <span key={s.start}>{chunk}</span>
							const tone = toneOf(s.ids, byId)
							const selected = selectedId ? s.ids.includes(selectedId) : false
							const label = s.ids.map((id) => `${id}: ${byId.get(id)!.verdictLabel}`).join("; ")
							return (
								<mark
									key={s.start}
									className={`hl hl-${tone}${selected ? " is-selected" : ""}${s.ids.length > 1 ? " is-multi" : ""}`}
									data-claims={s.ids.join(" ")}
									tabIndex={0}
									role="button"
									aria-label={`${s.ids.length > 1 ? `Part of ${s.ids.length} claims` : "Claim"} — ${label}. Text: ${chunk}`}
									aria-pressed={selected}
									onClick={(e) => activate(s.ids, e.currentTarget)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											activate(s.ids, e.currentTarget)
										}
									}}
								>
									{chunk}
								</mark>
							)
						})}
					</p>
				))}
			</article>
			{menu && (
				<div
					className="claim-menu"
					role="menu"
					aria-label="Choose a claim"
					style={{ top: menu.top, left: menu.left }}
					onKeyDown={(e) => {
						const items = [...(e.currentTarget.querySelectorAll("button") as NodeListOf<HTMLButtonElement>)]
						const i = items.indexOf(document.activeElement as HTMLButtonElement)
						if (e.key === "Escape") closeMenu()
						if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus()
						if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus()
					}}
				>
					<div className="claim-menu-title">This text is part of {menu.ids.length} claims</div>
					{menu.ids.map((id) => {
						const c = byId.get(id)!
						return (
							<button
								key={id}
								role="menuitem"
								onClick={() => {
									setMenu(undefined)
									onSelect(id)
								}}
							>
								<span className="claim-id">{id}</span>
								<span className="claim-menu-text">
									{c.metricLabel} · {c.kindLabel}
									<VerdictBadge claim={c} />
								</span>
							</button>
						)
					})}
				</div>
			)}
		</div>
	)
})
