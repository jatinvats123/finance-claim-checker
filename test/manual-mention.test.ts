import { describe, expect, it, vi } from "vitest"
import type { AddressInfo } from "node:net"
import { readFileSync } from "node:fs"
import * as edgar from "../src/sec/edgar.js"
import { createApp } from "../src/web/server.js"
import { CheckerRunner } from "../src/llm/runner.js"
import type { RunView } from "../src/web/types.js"
import { loadSnapshot } from "../src/sec/edgar.js"
import { EvidenceRegistry } from "../src/sec/evidence.js"
import { unmatchedFinancialMentions } from "../src/web/mentions.js"
import { compareMention } from "../src/web/manual-check.js"

const registry = new EvidenceRegistry(loadSnapshot("INFY"))
const typo = "The same paragraph gives FY2024 operating profit as US$3.843 billion."
function lookup(text: string) {
	const [mention] = unmatchedFinancialMentions({ article: { title: "Test", text }, claims: [] })
	return compareMention(text, mention, registry)
}

describe("editor-selected filing lookup", () => {
	it("opens a keyless filing receipt for a new draft while preserving the replay cache miss", async () => {
		const app = createApp({ env: {}, liveSec: false })
		await new Promise<void>(ready => app.server.listen(0, "127.0.0.1", ready))
		const base = "http://127.0.0.1:" + (app.server.address() as AddressInfo).port
		const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) })
		try {
			const meta = await (await fetch(base + "/api/meta")).json()
			const sample = meta.samples.find((s: { id: string }) => s.id === "infosys-manual")
			const frozen = JSON.parse(readFileSync("eval/editor-stress-cases.json", "utf8")).cases.find((s: { id: string }) => s.id === "infy-usd-with-local-sidebar")
			expect(sample).toMatchObject({ text: frozen.article.text, title: frozen.article.title, preferredMode: "replay" })
			const start = await post("/api/runs", { source: "custom", mode: sample.preferredMode, company: { query: sample.company }, title: sample.title, text: sample.text })
			expect(start.status).toBe(202)
			const { id } = await start.json()
			const path = "/api/runs/" + id
			await (await fetch(base + path + "/events")).text()
			const body = { start: sample.text.indexOf("US$3.843") }
			const selected = await post(path + "/mentions", body)
			expect(selected.status).toBe(200)
			const { run } = await selected.json() as { run: RunView }
			expect(run.status).toBe("cache_miss")
			expect(run.claims).toHaveLength(0)
			expect(run.manualChecks?.[body.start]).toMatchObject({ status: "compared", matches: false, filed: "$3.834B" })
			expect((await (await fetch(base + path)).json()).manualChecks).toEqual(run.manualChecks)
		} finally {
			app.server.close()
		}
	})
	it("sends one selected live number through the normal audit and persists an idempotent result", async () => {
		const fixture = vi.spyOn(edgar, "cachedLiveSnapshot").mockResolvedValue(loadSnapshot("INFY"))
		const app = createApp({ liveSec: false, env: { ANTHROPIC_API_KEY: "test-only" }, timeoutMs: 8_000,
			liveInner: tasks => new CheckerRunner({ mode: "author", tasks, script: { description: "Model intentionally misses one number", tasks: {
				"extractor:article": [{ say: "Done" }],
				"context:c1@r1": [{ say: "No additional context issues" }],
				"auditor:c1@r1.e1": [{ call: { name: "approve", args: { claimId: "c1", claimRevision: 1, evidenceRevision: 1, note: "Checked the source and period." } } }, { say: "Done" }],
			} } }),
		})
		await new Promise<void>(ready => app.server.listen(0, "127.0.0.1", ready))
		const base = "http://127.0.0.1:" + (app.server.address() as AddressInfo).port
		const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) })
		try {
			const start = await post("/api/runs", { source: "custom", mode: "live", company: { query: "INFY" }, title: "Infosys", text: typo })
			expect(start.status).toBe(202)
			const { id } = await start.json()
			const path = "/api/runs/" + id
			await (await fetch(base + path + "/events")).text()
			expect((await (await fetch(base + path)).json()).claims).toHaveLength(0)
			expect((await post(path + "/mentions", { start: 0 })).status).toBe(409)
			const body = { start: typo.indexOf("US$") }
			expect((await post(path + "/mentions", body)).status).toBe(202)
			await (await fetch(base + path + "/events")).text()
			const final: RunView = await (await fetch(base + path)).json()
			expect(final.claims).toHaveLength(1)
			expect(final.claims[0]).toMatchObject({ verdict: "MISMATCH", review: { status: "complete" },
				calc: { actualDisplay: "$3.834B", inputs: [expect.objectContaining({ form: "20-F" })] } })
			expect(final.claims[0].history.some(entry => entry.kind === "claim.editor_selected")).toBe(true)
			expect((await post(path + "/mentions", body)).status).toBe(200)
			expect((await (await fetch(base + path)).json()).claims).toHaveLength(1)
		} finally {
			app.server.close()
			fixture.mockRestore()
		}
	}, 20_000)
	it("recovers the omitted Infosys figure from the original wording and pinned filing", () => {
		expect(lookup(typo)).toMatchObject({
			interpretation: { quote: typo, statedNumber: "3.843", metric: "operating_income", fiscalYear: 2024, fiscalPeriod: "FY", currency: "USD" },
			receipt: { status: "compared", matches: false, source: { form: "20-F", value: 3_834_000_000, url: expect.stringContaining("sec.gov/") } },
		})
		expect(lookup(typo.replace("3.843", "3.834")).receipt).toMatchObject({ status: "compared", matches: true })
	})
	it.each([
		"Analysts forecast FY2024 operating profit of US$3.843 billion.",
		"FY2024 operating profit was US$3.843 billion according to the forecast.",
		"The subsidiary reported FY2024 operating profit of US$3.843 billion.",
		"The company reported adjusted FY2024 operating profit of US$3.843 billion.",
		"FY2024 operating profit was US$3.843 billion less than budget.",
		"FY2024 operating profit was not US$3.843 billion.",
		"Operating profit was US$3.843 billion.",
		"FY2024 operating profit was ₹3.843 billion.",
		"FY2024 operating profit was NZ$3.843 billion.",
		"FY2024 operating profit was X$3.843 billion.",
		"FY2024 operating profit was $3.843 billion.",
		"FY2024 operating profit was ca$3.843 billion.",
		"FY2024 operating profit was US$3.843 billion while revenue was US$6 billion.",
	])("withholds a comparison when attribution or basis is unsafe: %s", text => {
		const result = lookup(text)
		expect(result.receipt.status).toBe("needs_review")
		expect(result.interpretation).toBeUndefined()
	})
})
