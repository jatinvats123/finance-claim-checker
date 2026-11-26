type P = { size?: number; className?: string }
const svg = (d: React.ReactNode, { size = 16, className }: P, viewBox = "0 0 24 24") => (
	<svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
		{d}
	</svg>
)

export const IconCheck = (p: P) => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, p)
export const IconX = (p: P) => svg(<path d="M7 7l10 10M17 7L7 17" />, p)
export const IconAlert = (p: P) =>
	svg(
		<>
			<path d="M12 4l9 16H3z" />
			<path d="M12 10v4M12 17.5v.01" />
		</>,
		p,
	)
export const IconHelp = (p: P) =>
	svg(
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17v.01" />
		</>,
		p,
	)
export const IconClock = (p: P) =>
	svg(
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>,
		p,
	)
export const IconExternal = (p: P) =>
	svg(
		<>
			<path d="M14 4h6v6M20 4l-9 9" />
			<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
		</>,
		p,
	)
export const IconClose = (p: P) => svg(<path d="M6 6l12 12M18 6L6 18" />, p)
export const IconPlay = (p: P) => svg(<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />, p)
export const IconDoc = (p: P) =>
	svg(
		<>
			<path d="M7 3h7l4 4v14H7z" />
			<path d="M14 3v4h4M10 12h5M10 16h5" />
		</>,
		p,
	)
export const IconDownload = (p: P) => svg(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />, p)
export const IconLocate = (p: P) =>
	svg(
		<>
			<circle cx="12" cy="12" r="7" />
			<path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
		</>,
		p,
	)
export const IconChevron = (p: P & { dir?: "left" | "right" | "down" }) => svg(<path d={p.dir === "left" ? "M15 6l-6 6 6 6" : p.dir === "down" ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} />, p)
export const IconCorrection = (p: P) =>
	svg(
		<>
			<path d="M4 12a8 8 0 0 1 14-5.3L20 9" />
			<path d="M20 4v5h-5" />
			<path d="M20 12a8 8 0 0 1-14 5.3L4 15" />
			<path d="M4 20v-5h5" />
		</>,
		p,
	)
export const IconSpinner = (p: P) => svg(<path d="M12 3a9 9 0 1 0 9 9" className="spin-path" />, { ...p, className: `spin ${p.className ?? ""}` })
