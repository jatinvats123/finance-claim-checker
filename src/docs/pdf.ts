/**
 * Official financial reports as PDF: fetch (public http/https URLs only, size-capped, no private
 * network addresses), then extract text with positions so code can verify where a value sits — page,
 * row, and the column it is printed under. Scanned PDFs without a text layer are reported, not guessed.
 */
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export type PdfItem = { str: string; x0: number; x1: number; y: number; h: number }
export type PdfLine = { y: number; items: PdfItem[]; text: string }
export type PdfPage = { n: number; lines: PdfLine[]; text: string }
export type ReportDoc = {
	/** Where the bytes came from: the fetched URL, or an uploaded file name (with the source URL the user stated, unfetched). */
	url?: string
	fileName?: string
	statedSourceUrl?: string
	sha256: string
	bytes: number
	pageCount: number
	pages: PdfPage[]
	fetchedAt: string
}

export type ReportFailure = "REPORT_FETCH_FAILED" | "REPORT_NOT_PDF" | "REPORT_TOO_LARGE" | "REPORT_UNREADABLE" | "REPORT_NO_TEXT" | "REPORT_URL_REJECTED"
export class ReportUnavailable extends Error {
	constructor(
		readonly code: ReportFailure,
		message: string,
	) {
		super(message)
	}
}

export const MAX_REPORT_BYTES = 25 * 1024 * 1024
const MAX_PAGES = 120

function privateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split(".").map(Number)
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
	}
	const v6 = ip.toLowerCase()
	if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7))
	return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff")
}

/** Public http(s) URLs only: a public server must not be usable to reach private networks. */
export async function assertPublicUrl(raw: string): Promise<URL> {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new ReportUnavailable("REPORT_URL_REJECTED", `"${raw}" is not a valid URL.`)
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new ReportUnavailable("REPORT_URL_REJECTED", "Only http(s) URLs can be fetched.")
	if (url.username || url.password) throw new ReportUnavailable("REPORT_URL_REJECTED", "URLs with credentials are not fetched.")
	const host = url.hostname.replace(/^\[|\]$/g, "")
	if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new ReportUnavailable("REPORT_URL_REJECTED", "Local and internal hosts are not fetched.")
	const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
	if (!addrs.length) throw new ReportUnavailable("REPORT_FETCH_FAILED", `Could not resolve ${host}.`)
	if (addrs.some((a) => privateAddress(a.address))) throw new ReportUnavailable("REPORT_URL_REJECTED", `${host} resolves to a private network address; only public URLs are fetched.`)
	return url
}

/** Fetch a public PDF (follows up to 4 redirects, each re-checked), capped at 25 MB. */
export async function fetchReport(rawUrl: string, timeoutMs = 45_000): Promise<{ bytes: Uint8Array; finalUrl: string }> {
	let url = await assertPublicUrl(rawUrl)
	const signal = AbortSignal.timeout(timeoutMs)
	for (let hop = 0; hop < 5; hop++) {
		let res: Response
		try {
			res = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; finance-claim-checker/0.1; +https://github.com/)", Accept: "application/pdf,*/*;q=0.8" } })
		} catch (e) {
			throw new ReportUnavailable("REPORT_FETCH_FAILED", `Could not fetch ${url.host}: ${(e as Error).message}`)
		}
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			url = await assertPublicUrl(new URL(res.headers.get("location")!, url).href)
			continue
		}
		if (!res.ok) throw new ReportUnavailable("REPORT_FETCH_FAILED", `${url.host} answered ${res.status} ${res.statusText} for the report URL.`)
		const declared = Number(res.headers.get("content-length") ?? 0)
		if (declared > MAX_REPORT_BYTES) throw new ReportUnavailable("REPORT_TOO_LARGE", `The report is ${(declared / 1e6).toFixed(1)} MB; the limit is 25 MB.`)
		const reader = res.body?.getReader()
		if (!reader) throw new ReportUnavailable("REPORT_FETCH_FAILED", "Empty response.")
		const chunks: Uint8Array[] = []
		let size = 0
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			size += value.length
			if (size > MAX_REPORT_BYTES) {
				await reader.cancel()
				throw new ReportUnavailable("REPORT_TOO_LARGE", "The report is larger than 25 MB.")
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(size)
		let o = 0
		for (const c of chunks) {
			bytes.set(c, o)
			o += c.length
		}
		assertPdf(bytes, res.headers.get("content-type") ?? "")
		return { bytes, finalUrl: url.href }
	}
	throw new ReportUnavailable("REPORT_FETCH_FAILED", "Too many redirects.")
}

export function assertPdf(bytes: Uint8Array, contentType = "") {
	const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1")
	if (head.includes("%PDF-")) return
	const kind = /<html|<!doctype html/i.test(head) || contentType.includes("html") ? "an HTML page" : contentType ? `"${contentType}"` : "not a PDF"
	throw new ReportUnavailable("REPORT_NOT_PDF", `The report URL returned ${kind}, not a PDF. Only PDF reports are supported; link the PDF file itself.`)
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

/** Text with positions, grouped into lines (top to bottom); cells further apart than a few spaces are joined with " | ". */
export async function parsePdf(bytes: Uint8Array): Promise<PdfPage[]> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
	let doc: any
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
	try {
		doc = await task.promise
	} catch (e) {
		throw new ReportUnavailable("REPORT_UNREADABLE", `The PDF could not be read: ${(e as Error).message}`)
	}
	const pages: PdfPage[] = []
	const n = Math.min(doc.numPages, MAX_PAGES)
	for (let i = 1; i <= n; i++) {
		const page = await doc.getPage(i)
		const content = await page.getTextContent()
		const items: PdfItem[] = []
		for (const it of content.items as any[]) {
			const str = typeof it.str === "string" ? it.str : ""
			if (!str.trim()) continue
			const x0 = it.transform[4]
			items.push({ str, x0, x1: x0 + (it.width ?? 0), y: it.transform[5], h: it.height ?? Math.abs(it.transform[3]) })
		}
		pages.push({ n: i, ...toLines(items) })
		page.cleanup?.()
	}
	await task.destroy()
	const textChars = pages.reduce((s, p) => s + p.text.length, 0)
	if (textChars < 200) throw new ReportUnavailable("REPORT_NO_TEXT", "The PDF has no text layer (it looks scanned). OCR is not supported; provide a text-based PDF.")
	return pages
}

export function toLines(items: PdfItem[]): { lines: PdfLine[]; text: string } {
	const sorted = [...items].sort((a, b) => b.y - a.y || a.x0 - b.x0)
	const lines: PdfLine[] = []
	for (const it of sorted) {
		const tol = Math.max(2, Math.min(it.h || 8, 12) * 0.45)
		const line = lines.find((l) => Math.abs(l.y - it.y) <= tol)
		if (line) line.items.push(it)
		else lines.push({ y: it.y, items: [it], text: "" })
	}
	for (const l of lines) {
		l.items.sort((a, b) => a.x0 - b.x0)
		let text = ""
		let prev: PdfItem | undefined
		for (const it of l.items) {
			if (prev) {
				const gap = it.x0 - prev.x1
				const space = Math.max(2, (prev.h || 8) * 0.25)
				text += gap > space * 3 ? " | " : gap > space * 0.3 || !/\s$/.test(prev.str) ? " " : ""
			}
			text += norm(it.str)
			prev = it
		}
		l.text = norm(text)
	}
	lines.sort((a, b) => b.y - a.y)
	return { lines, text: lines.map((l) => l.text).join("\n") }
}

export async function loadReport(input: { url?: string; file?: { name: string; base64: string }; statedSourceUrl?: string }): Promise<ReportDoc> {
	let bytes: Uint8Array
	let url: string | undefined
	if (input.file) {
		bytes = new Uint8Array(Buffer.from(input.file.base64, "base64"))
		if (bytes.length > MAX_REPORT_BYTES) throw new ReportUnavailable("REPORT_TOO_LARGE", "The uploaded report is larger than 25 MB.")
		assertPdf(bytes)
	} else if (input.url) {
		const r = await fetchReport(input.url)
		bytes = r.bytes
		url = r.finalUrl
	} else throw new ReportUnavailable("REPORT_FETCH_FAILED", "No report URL or file given.")
	const pages = await parsePdf(bytes)
	return {
		url,
		fileName: input.file?.name,
		statedSourceUrl: input.file ? input.statedSourceUrl : undefined,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		pageCount: pages.length,
		pages,
		fetchedAt: new Date().toISOString(),
	}
}
