import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { loadCassette, type Cassette } from "./runner.js"

/** Recordings first (data/replay/recordings/*.json), then hand-written fixtures (data/replay/*.fixtures.json). */
export function defaultCassettePaths(): string[] {
	const dirs = [
		["data/replay/recordings", (f: string) => f.endsWith(".json")],
		["data/replay", (f: string) => f.endsWith(".fixtures.json")],
	] as const
	return dirs.flatMap(([d, ok]) => (existsSync(d) ? readdirSync(d).filter(ok).map((f) => join(d, f)) : []))
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
