/** Minimal PDF writer for tests: positioned Helvetica text, one content stream per page. */
export type PdfText = { x: number; y: number; text: string; size?: number }

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")

export function makePdf(pages: PdfText[][]): Uint8Array {
	const objects: string[] = []
	const add = (body: string) => objects.push(body) // object number = index + 1
	add("<< /Type /Catalog /Pages 2 0 R >>")
	add("") // pages, filled below
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	const pageIds: number[] = []
	for (const items of pages) {
		const stream = items.map((t) => `BT /F1 ${t.size ?? 9} Tf 1 0 0 1 ${t.x} ${t.y} Tm (${esc(t.text)}) Tj ET`).join("\n")
		add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`)
		const contentId = objects.length
		add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`)
		pageIds.push(objects.length)
	}
	objects[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
	let out = "%PDF-1.4\n"
	const offsets: number[] = []
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"))
		out += `${i + 1} 0 obj\n${body}\nendobj\n`
	})
	const xref = Buffer.byteLength(out, "latin1")
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return new Uint8Array(Buffer.from(out, "latin1"))
}

/**
 * Ind AS interim statement laid out like TCS's real report: column headers stacked over four lines
 * ("Three months" / "ended" / "September 30," / "2026"), a Note column, no annual column, and profit
 * attributable to shareholders as an indented row under its heading.
 */
export function interimPage(): PdfText[] {
	const xs = [300, 370, 440, 510]
	const row = (y: number, label: string, vals: string[], note?: string) => [{ x: 40, y, text: label }, ...(note ? [{ x: 250, y, text: note }] : []), ...vals.map((t, i) => ({ x: xs[i], y, text: t }))]
	return [
		{ x: 40, y: 770, text: "TESTCO SERVICES LIMITED" },
		{ x: 40, y: 756, text: "Consolidated Interim Statement of Profit and Loss" },
		{ x: 520, y: 742, text: "(Rs. crore)" },
		{ x: 250, y: 728, text: "Note" },
		...["Three months", "Three months", "Six months", "Six months"].map((t, i) => ({ x: xs[i] - 4, y: 728, text: t })),
		...xs.map((x) => ({ x: x + 6, y: 716, text: "ended" })),
		...xs.map((x) => ({ x: x - 6, y: 704, text: "September 30," })),
		...["2026", "2025", "2026", "2025"].map((t, i) => ({ x: xs[i] + 8, y: 692, text: t })),
		...row(672, "Revenue from operations", ["73,188", "65,799", "1,45,463", "1,29,236"], "11"),
		...row(656, "Other income", ["1,337", "867", "2,905", "2,527"], "12"),
		...row(640, "TOTAL INCOME", ["74,525", "66,666", "1,48,368", "1,31,763"]),
		...row(620, "PROFIT FOR THE PERIOD", ["13,934", "12,131", "27,354", "24,950"]),
		{ x: 40, y: 604, text: "Profit for the period attributable to:" },
		...row(590, "Shareholders of the Company", ["13,884", "12,075", "27,233", "24,835"]),
		...row(576, "Non-controlling interests", ["50", "56", "121", "115"]),
		{ x: 40, y: 560, text: "Total comprehensive income for the period attributable to:" },
		...row(546, "Shareholders of the Company", ["13,695", "12,485", "27,304", "26,493"]),
		...row(526, "Earnings per equity share:- Basic and diluted (Rs.)", ["38.37", "33.37", "75.27", "68.64"], "17"),
	]
}

/** An Indian-style quarterly results statement: quarter, half-year and year columns, "(Rs. in crore)". */
export function resultsPage(kind: "Consolidated" | "Standalone", v: { rev: string[]; np: string[]; basic: string[]; diluted: string[] }): PdfText[] {
	const xs = [240, 300, 360, 420, 480, 540]
	const row = (y: number, label: string, vals: string[]) => [{ x: 40, y, text: label }, ...vals.map((t, i) => ({ x: xs[i], y, text: t }))]
	return [
		{ x: 40, y: 770, text: `TestCo Limited - Statement of Unaudited ${kind} Financial Results for the quarter and half year ended 30.09.2025`, size: 8 },
		{ x: 500, y: 752, text: "(Rs. in crore)" },
		{ x: 262, y: 736, text: "Quarter ended" },
		{ x: 430, y: 736, text: "Half year ended" },
		{ x: 536, y: 736, text: "Year ended" },
		...["30.09.2025", "30.06.2025", "30.09.2024", "30.09.2025", "30.09.2024", "31.03.2025"].map((t, i) => ({ x: xs[i], y: 722, text: t })),
		...row(700, "Revenue from operations", v.rev),
		{ x: 40, y: 684, text: "Other income" },
		...row(668, "Net profit for the period", v.np),
		{ x: 40, y: 652, text: "Earnings per equity share (of Rs. 1 each)" },
		...row(638, "(a) Basic", v.basic),
		...row(624, "(b) Diluted", v.diluted),
	]
}
