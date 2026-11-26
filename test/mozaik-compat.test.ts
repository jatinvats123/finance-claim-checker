/**
 * Compatibility gate for the pinned Mozaik version (see package.json: @mozaik-ai/core 6.0.0).
 *
 * Verifies the three runtime behaviours the claim checker depends on, without any API key:
 *  1. two agents' loops run concurrently (neither waits for the other),
 *  2. a tool call mutates the shared RuntimeState that another participant reads,
 *  3. a custom SemanticEvent triggers a reaction in a third participant.
 */
import { describe, expect, it } from "vitest"
import {
	createAgent,
	createHuman,
	defineRuntime,
	FunctionCallItem,
	ModelContext,
	ModelMessageItem,
	DeveloperMessageItem,
	RuntimeState,
	SemanticEvent,
	SituationSpecification,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type SituationContext,
	type Tool,
} from "@mozaik-ai/core"
import { readFileSync } from "node:fs"

class SharedState extends RuntimeState {
	notes: string[] = []
}

/** Scripted runner: first turn calls the tool, second turn answers. Agent "slow" takes 60ms per turn. */
class ScriptedRunner implements InferenceRunner {
	async run(input: InferenceInput): Promise<InferenceOutput> {
		const items = input.context.getItems()
		const dev = items[0] as DeveloperMessageItem
		const who = dev.content.text
		await new Promise((r) => setTimeout(r, who === "slow" ? 60 : 10))
		const alreadyCalled = items.some((i) => i.type === "function_call_output")
		if (!alreadyCalled) {
			return {
				items: [FunctionCallItem.rehydrate({ callId: `call-${who}`, name: "add_note", args: JSON.stringify({ note: who }) })],
				tokenUsage: undefined,
				rowResponse: null,
			}
		}
		return { items: [ModelMessageItem.rehydrate({ text: `done ${who}` })], tokenUsage: undefined, rowResponse: null }
	}
	// eslint-disable-next-line require-yield
	async *stream(): AsyncGenerator<SemanticEvent> {
		throw new Error("not used")
	}
}

class OfType extends SituationSpecification {
	constructor(private readonly type: string) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === this.type
	}
}

describe("Mozaik compatibility (pinned version)", () => {
	it("is the pinned version", () => {
		const pkg = JSON.parse(readFileSync("node_modules/@mozaik-ai/core/package.json", "utf8"))
		const ours = JSON.parse(readFileSync("package.json", "utf8"))
		expect(ours.dependencies["@mozaik-ai/core"]).toBe(pkg.version)
		expect(pkg.version).toBe("6.0.0")
	})

	it("runs two agents concurrently, shares state, and reacts to a custom event", async () => {
		const rt = defineRuntime<SharedState>()
		rt.initializeRuntime({ state: new SharedState(), inferenceRunnerConfig: { runner: new ScriptedRunner() } })

		const timeline: string[] = []
		const reactions: string[] = []

		const makeTool = (ownerId: () => string): Tool => ({
			type: "function",
			name: "add_note",
			description: "add a note to shared state",
			parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
			strict: true,
			invoke: async ({ note }: { note: string }) => {
				rt.resolveRuntime().state.notes.push(note)
				rt.sendEvent(SemanticEvent.create("note.added", ownerId(), { note }), ownerId())
				return "ok"
			},
		})

		let slowId = ""
		let fastId = ""
		const slow = createAgent({ name: "slow", capabilities: [], instruction: "slow", tools: [makeTool(() => slowId)], handlers: [] })
		const fast = createAgent({ name: "fast", capabilities: [], instruction: "fast", tools: [makeTool(() => fastId)], handlers: [] })
		slowId = slow.getId()
		fastId = fast.getId()

		const observer = createHuman({
			name: "observer",
			capabilities: [],
			handlers: [
				{
					specification: new OfType("note.added"),
					processor: {
						apply: ({ event }) => {
							const { note } = event.payload as { note: string }
							reactions.push(`${note} saw ${rt.resolveRuntime().state.notes.length} notes`)
						},
					},
				},
				{
					specification: new OfType("inference.started").or(new OfType("model.answer")),
					processor: {
						apply: ({ event }) => {
							const name = event.producerId === slowId ? "slow" : "fast"
							timeline.push(`${name}:${event.type}`)
						},
					},
				},
			],
		})

		rt.join(observer)
		rt.join(slow)
		rt.join(fast)

		const done = new Promise<void>((resolve) => {
			let answers = 0
			observer.setHandlers([
				...observer.getHandlers(),
				{
					specification: new OfType("model.answer"),
					processor: { apply: () => void (++answers === 2 && resolve()) },
				},
			])
		})

		const fresh = (instruction: string) => ModelContext.create().addContextItem(DeveloperMessageItem.create(instruction))
		rt.runLoop(slow.getId(), "go", { model: "scripted", context: fresh("slow"), tools: slow.getTools() })
		rt.runLoop(fast.getId(), "go", { model: "scripted", context: fresh("fast"), tools: fast.getTools() })
		await done

		// Concurrency: the fast agent finished while the slow agent's loop was still running.
		expect(timeline.indexOf("fast:model.answer")).toBeLessThan(timeline.indexOf("slow:model.answer"))
		expect(timeline.indexOf("slow:inference.started")).toBeLessThan(timeline.indexOf("fast:model.answer"))
		// Shared state written by both agents' tools.
		expect(rt.resolveRuntime().state.notes.sort()).toEqual(["fast", "slow"])
		// Event reaction in a third participant, reading shared state at reaction time.
		expect(reactions).toEqual(["fast saw 1 notes", "slow saw 2 notes"])
	})
})
