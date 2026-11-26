/** Refresh the committed SEC snapshot: npm run snapshot:sec -- NVDA [MSFT ...] */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fetchSnapshot, SNAPSHOT_DIR } from "../src/sec/edgar.js"

const tickers = process.argv.slice(2)
if (tickers.length === 0) {
	console.error("usage: npm run snapshot:sec -- TICKER [TICKER...]")
	process.exit(1)
}
mkdirSync(SNAPSHOT_DIR, { recursive: true })
for (const t of tickers) {
	const snap = await fetchSnapshot(t)
	const path = join(SNAPSHOT_DIR, `${snap.ticker}.json`)
	writeFileSync(path, JSON.stringify(snap, null, 1))
	const rows = Object.values(snap.facts).flatMap((u) => Object.values(u)).reduce((n, r) => n + r.length, 0)
	console.log(`${snap.ticker} (${snap.entityName}): ${rows} fact rows, ${snap.filings.length} filings -> ${path}`)
}
