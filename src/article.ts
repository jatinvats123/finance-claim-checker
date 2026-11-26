import { readFileSync } from "node:fs"
import { basename } from "node:path"

/** Article file: the first "# " line is the title; an optional leading HTML comment is a note, not article text. */
export function readArticle(path: string): { title: string; text: string } {
	const raw = readFileSync(path, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "")
	const lines = raw.split(/\r?\n/)
	const titleIdx = lines.findIndex((l) => l.startsWith("# "))
	const title = titleIdx >= 0 ? lines[titleIdx].slice(2).trim() : basename(path)
	const text = lines
		.filter((_, i) => i !== titleIdx)
		.join("\n")
		.trim()
	return { title, text }
}
