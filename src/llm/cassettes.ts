import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { loadCassette, type Cassette } from "./runner.js"

/** Which replay data to use. "recorded" = genuine model responses only (no fixture fallback). */
export type ReplaySource = "fixtures" | "recorded" | "all"

export const RECORDINGS_DIR = "data/replay/recordings"

/** Recordings (data/replay/recordings/*.json) and/or hand-written fixtures (data/replay/*.fixtures.json). */
export function defaultCassettePaths(source: ReplaySource = "all"): string[] {
	const recorded = existsSync(RECORDINGS_DIR) ? readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json")).map((f) => join(RECORDINGS_DIR, f)) : []
	const fixtures = existsSync("data/replay") ? readdirSync("data/replay").filter((f) => f.endsWith(".fixtures.json")).map((f) => join("data/replay", f)) : []
	return source === "recorded" ? recorded : source === "fixtures" ? fixtures : [...recorded, ...fixtures]
}

export function parseReplaySource(v: string | undefined): ReplaySource {
	if (v === undefined) return "fixtures"
	if (v === "fixtures" || v === "recorded" || v === "all") return v
	throw new Error(`replay source must be fixtures, recorded or all (got "${v}")`)
}

/** Load cassettes; recorded responses take priority over hand-written fixtures. */
export function loadCassettes(paths: string[]): { path: string; data: Cassette }[] {
	const out = paths.flatMap((p) => {
		const data = loadCassette(p)
		return data ? [{ path: p, data }] : []
	})
	return out.sort((a, b) => Number(b.data.provenance === "recorded") - Number(a.data.provenance === "recorded"))
}

export function providerConfigured(env = process.env): boolean {
	return !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY)
}

export function defaultModel(env = process.env): string {
	if (env.CHECKER_MODEL) return env.CHECKER_MODEL
	if (env.ANTHROPIC_API_KEY) return "claude-sonnet-5-5"
	if (env.OPENAI_API_KEY) return "gpt-5.5"
	if (env.GEMINI_API_KEY) return "gemini-3.5-flash"
	return "claude-sonnet-5-5"
}
