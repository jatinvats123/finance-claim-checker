import { fmtDate, fmtNumber, type RunView } from "../api"
import { IconExternal } from "./icons"

/** What this run was checked against: SEC statements, or an official report verified page by page. */
export function ReferenceSummary({ run, open = false }: { run: RunView; open?: boolean }) {
	const ref = run.reference
	const r = ref.report
	const pages = r ? [...new Set(r.verified.map((v) => v.page))].sort((a, b) => a - b) : []
	return (
		<details className="reference-summary" open={open}>
			<summary>
				<span className="ref-kicker">Reference</span>{" "}
				{ref.kind === "sec" ? (
					<>
						SEC financial statements of <strong>{ref.entityName}</strong>
						{ref.ticker ? ` (${ref.ticker})` : ""} · fetched {fmtDate(ref.fetchedAt)}
						{ref.reportingCurrency ? ` · reported in ${ref.reportingCurrency}` : ""}
					</>
				) : (
					<>
						Official report of <strong>{ref.entityName}</strong> ·{" "}
						{r?.status === "reading" ? "being read…" : r?.status === "failed" ? "unavailable" : `${r?.verified.length ?? 0} figures verified on page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`}
						{r && r.rejected.length > 0 ? ` · ${r.rejected.length} proposals rejected` : ""}
					</>
				)}
			</summary>
			<div className="ref-body">
				<p className="small">{ref.label}.</p>
				<ul className="plain small">
					{ref.sources.map((s) => (
						<li key={s.label}>
							{s.url ? (
								<a href={s.url} target="_blank" rel="noreferrer noopener" className="ext-link">
									{s.label} <IconExternal size={12} />
								</a>
							) : (
								s.label
							)}
						</li>
					))}
				</ul>
				{ref.note && <p className="small muted">{ref.note}</p>}
				{r && (
					<>
						<p className="small muted">
							Statement pages selected by code: {r.statementPages.join(", ") || "none"} of {r.pageCount}. The Reader agent proposed where each figure is printed; code checked the row, the value on that row, the column date, the unit note and the consolidated/standalone heading before accepting it.
						</p>
						{r.verified.length > 0 && (
							<div className="table-wrap">
								<table className="evidence-table">
									<thead>
										<tr>
											<th scope="col">Figure</th>
											<th scope="col">Page · row · column</th>
											<th scope="col" className="right">
												Printed → value
											</th>
										</tr>
									</thead>
									<tbody>
										{r.verified.map((v, i) => (
											<tr key={i}>
												<th scope="row">
													{v.metric}
													<div className="cell-sub">
														{v.period} · {v.consolidation}
													</div>
												</th>
												<td>
													p.{v.page} · “{v.row}”<div className="cell-sub">{v.column}</div>
												</td>
												<td className="num right">
													{v.printed} <span className="muted">({v.unitNote})</span>
													<div className="cell-sub">
														{fmtNumber(v.value)} {v.unit}
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						{r.rejected.length > 0 && (
							<details className="rejected">
								<summary className="small">Proposals rejected by code ({r.rejected.length})</summary>
								<ul className="plain small">
									{r.rejected.map((x, i) => (
										<li key={i}>
											<span className="mono">{JSON.stringify(x.proposed)}</span> — {x.reason}
										</li>
									))}
								</ul>
							</details>
						)}
					</>
				)}
			</div>
		</details>
	)
}
