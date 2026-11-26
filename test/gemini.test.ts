/** The Gemini mapper must send each function call's thought signature back on later turns. */
import { describe, expect, it } from "vitest"
import { DeveloperMessageItem, FunctionCallOutputItem, ModelContext, UserMessageItem, type FunctionCallItem } from "@mozaik-ai/core"
import { SignaturePreservingGeminiMapper } from "../src/llm/gemini.js"

describe("SignaturePreservingGeminiMapper", () => {
	it("round-trips thought signatures and Gemini call ids", () => {
		const mapper = new SignaturePreservingGeminiMapper()
		const out = mapper.toResponse({
			candidates: [{ content: { parts: [{ thought: true, text: "hidden" }, { functionCall: { name: "search_facts", args: { metric: "revenue" } }, thoughtSignature: "SIG-1" }] } }],
			usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 150, thoughtsTokenCount: 30 },
		})
		expect(out.items).toHaveLength(1) // thought text is not surfaced
		const call = out.items[0] as FunctionCallItem
		expect(call.name).toBe("search_facts")
		expect(out.tokenUsage?.outputTokenDetails.reasoning_tokens).toBe(30)

		const context = ModelContext.create()
			.addContextItem(DeveloperMessageItem.create("instructions"))
			.addContextItem(UserMessageItem.create("task"))
			.addContextItem(call)
			.addContextItem(FunctionCallOutputItem.create(call.callId, JSON.stringify({ facts: [] })))
		const req = mapper.toRequest({ model: "gemini-3.5-flash", context, tools: [{ type: "function", name: "search_facts", description: "d", parameters: { type: "object" }, strict: false, invoke: async () => "" }] })

		expect(req.config.systemInstruction).toBe("instructions")
		expect(req.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"])
		expect(req.contents[1].parts[0]).toEqual({ functionCall: { name: "search_facts", args: { metric: "revenue" } }, thoughtSignature: "SIG-1" })
		expect(req.contents[2].parts[0]).toEqual({ functionResponse: { name: "search_facts", response: { facts: [] } } })
		expect(req.config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({ type: "object" })
	})

	it("echoes Gemini-provided call ids and wraps non-object tool output", () => {
		const mapper = new SignaturePreservingGeminiMapper()
		const out = mapper.toResponse({ candidates: [{ content: { parts: [{ functionCall: { id: "g-7", name: "approve", args: {} }, thoughtSignature: "S" }] } }] })
		const call = out.items[0] as FunctionCallItem
		expect(call.callId).toBe("g-7")
		const context = ModelContext.create().addContextItem(UserMessageItem.create("t")).addContextItem(call).addContextItem(FunctionCallOutputItem.create("g-7", "approved"))
		const req = mapper.toRequest({ model: "gemini-3.5-flash", context })
		expect(req.contents[1].parts[0].functionCall.id).toBe("g-7")
		expect(req.contents[2].parts[0]).toEqual({ functionResponse: { id: "g-7", name: "approve", response: { output: "approved" } } })
	})
})
