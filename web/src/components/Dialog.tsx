import { useEffect, useRef } from "react"

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/**
 * Modal surface with focus trap, Escape to close and focus restore.
 * variant "drawer" slides in from the right (evidence inspector on mid-size screens).
 */
export function Modal({ labelledBy, onClose, variant = "dialog", children, initialFocus }: { labelledBy: string; onClose: () => void; variant?: "dialog" | "drawer"; children: React.ReactNode; initialFocus?: React.RefObject<HTMLElement> }) {
	const box = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null
		const target = initialFocus?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE)
		target?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation()
				onClose()
			}
			if (e.key !== "Tab" || !box.current) return
			const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
			if (!items.length) return
			const first = items[0]
			const last = items[items.length - 1]
			const active = document.activeElement as HTMLElement | null
			const inside = !!active && box.current.contains(active)
			// Focus may sit on a non-tabbable element inside (e.g. the heading focused on open).
			if (e.shiftKey && (active === first || !inside || !items.includes(active!))) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && (active === last || !inside)) {
				e.preventDefault()
				first.focus()
			}
		}
		document.addEventListener("keydown", onKey)
		document.body.classList.add("modal-open")
		return () => {
			document.removeEventListener("keydown", onKey)
			document.body.classList.remove("modal-open")
			previous?.focus?.()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	return (
		<div className={`overlay overlay-${variant}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className={`modal modal-${variant}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={box}>
				{children}
			</div>
		</div>
	)
}
