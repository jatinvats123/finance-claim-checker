/** Replay cache policy: the key covers everything model-visible, including tool definitions. */
import { describe, expect, it } from "vitest"
import { DeveloperMessageItem, ModelContext, UserMessageItem, type InferenceInput, type ModelMessageItem, type Tool } from "@mozaik-ai/core"
import { CheckerRunner, IncompatibleCassette, REPLAY_KEY_VERSION, requestKey, type Cassette } from "../src/llm/runner.js"
import { TaskTracker } from "../src/runtime/tasks.js"

const tool = (o: Partial<Tool> = {}): Tool => ({
	type: "function",
	name: "search_facts",
	description: "List facts",
	parameters: { type: "object", properties: { metric: { type: "string" } }, required: ["metric"] },
	strict: false,
	invoke: async () => "",
	...o,
})

function input(tools: Tool[], contextId?: (id: string) => void): InferenceInput {
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create("instructions")).addContextItem(UserMessageItem.create("task"))
	contextId?.(context.id)
	return { model: "m", context, tools }
}

describe("replay key", () => {
	it("changes when a tool's description, schema or strict flag changes", () => {
		const k = requestKey(input([tool()]))
		expect(requestKey(input([tool()]))).toBe(k) // deterministic
		expect(requestKey(input([tool({ description: "List facts (10-Q/10-K only)" })]))).not.toBe(k)
		expect(requestKey(input([tool({ parameters: { type: "object", properties: { metric: { type: "string", enum: ["revenue"] } }, required: ["metric"] } })]))).not.toBe(k)
		expect(requestKey(input([tool({ strict: true })]))).not.toBe(k)
	})

	it("ignores tool order and object key order", () => {
		const a = tool({ name: "a" })
		const b = tool({ name: "b", parameters: { required: ["metric"], properties: { metric: { type: "string" } }, type: "object" } })
		const b2 = tool({ name: "b", parameters: { type: "object", properties: { metric: { type: "string" } }, required: ["metric"] } })
		expect(requestKey(input([a, b]))).toBe(requestKey(input([b2, a])))
	})

	it("a response recorded under an old tool schema is a cache miss under the new one", async () => {
		const old = input([tool()])
		const cassette: Cassette = { provenance: "recorded", description: "t", createdAt: "", keyVersion: REPLAY_KEY_VERSION, entries: { [requestKey(old)]: { task: "x", turn: 0, items: [{ type: "message", text: "old answer" }] } } }
		const tasks = new TaskTracker()
		const runner = new CheckerRunner({ mode: "replay", tasks, cassettes: [cassette] })
		const same = await runner.run(input([tool()], (id) => tasks.register({ key: "x", role: "context", contextId: id })))
		expect((same.items[0] as ModelMessageItem).content.text).toBe("old answer")
		const changed = await runner.run(input([tool({ description: "changed" })], (id) => tasks.register({ key: "y", role: "context", contextId: id })))
		expect((changed.items[0] as ModelMessageItem).content.text).toMatch(/CACHE_MISS/)
	})

	it("refuses a cassette made with another key version", () => {
		const legacy: Cassette = { provenance: "fixture", description: "", createdAt: "", entries: {} }
		expect(() => new CheckerRunner({ mode: "replay", tasks: new TaskTracker(), cassettes: [legacy] })).toThrow(IncompatibleCassette)
	})
})
