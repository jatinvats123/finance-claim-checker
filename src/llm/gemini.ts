/**
 * Gemini request/response mapper that preserves thought signatures.
 *
 * Gemini 3 models attach a `thoughtSignature` to function-call parts and reject the next request
 * (400 INVALID_ARGUMENT, "Function call is missing a thought_signature") unless that signature is
 * sent back unchanged. Mozaik 6.0.0's built-in Gemini mapper drops it, because FunctionCallItem has
 * no field for it. This mapper is the same mapping (Mozaik is MIT-licensed) plus a side table from
 * call id to signature, and it plugs into Mozaik's public GeminiGenerateContent endpoint.
 */
import { randomUUID } from "node:crypto"
import {
	FunctionCallItem,
	GeminiGenerateContent,
	InputTokenDetails,
	ModelMessageItem,
	OutputTokenDetails,
	TokenUsage,
	type ContextItem,
	type InferenceInput,
	type InferenceOutput,
} from "@mozaik-ai/core"

type Part = Record<string, unknown>
type Content = { role: "user" | "model"; parts: Part[] }

/** Matches Mozaik's InferenceEndpointMapper (not exported by name in 6.0.0). */
type EndpointMapper = ConstructorParameters<typeof GeminiGenerateContent>[0]

export class SignaturePreservingGeminiMapper implements NonNullable<EndpointMapper> {
	/** our call id -> what Gemini sent with that call */
	private readonly calls = new Map<string, { signature?: string; geminiId?: string }>()

	toRequest(input: InferenceInput): any {
		const contents: Content[] = []
		const system: string[] = []
		const names = new Map<string, string>()
		const add = (role: Content["role"], part: Part) => {
			const last = contents[contents.length - 1]
			if (last?.role === role) last.parts.push(part)
			else contents.push({ role, parts: [part] })
		}
		for (const item of input.context.getItems() as (ContextItem & Record<string, any>)[]) {
			if (item.type === "message" && (item.role === "developer" || item.role === "system")) system.push(item.content.text)
			else if (item.type === "message" && item.role === "user") add("user", { text: item.content.text })
			else if (item.type === "message" && item.role === "assistant") add("model", { text: item.content.text })
			else if (item.type === "function_call") {
				names.set(item.callId, item.name)
				const known = this.calls.get(item.callId)
				let args: unknown = {}
				try {
					args = JSON.parse(item.args)
				} catch {
					/* keep {} */
				}
				const functionCall: Part = { name: item.name, args }
				if (known?.geminiId) functionCall.id = known.geminiId
				add("model", known?.signature ? { functionCall, thoughtSignature: known.signature } : { functionCall })
			} else if (item.type === "function_call_output") {
				const known = this.calls.get(item.callId)
				const functionResponse: Part = { name: names.get(item.callId) ?? "", response: parseResponse(item.output.text) }
				if (known?.geminiId) functionResponse.id = known.geminiId
				add("user", { functionResponse })
			}
			// reasoning items are not sent back: thought text is not requested (no includeThoughts)
		}
		const config: Record<string, unknown> = {}
		if (system.length) config.systemInstruction = system.join("\n\n")
		if (input.tools?.length) config.tools = [{ functionDeclarations: input.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
		if (input.structuredOutput) {
			config.responseMimeType = "application/json"
			config.responseSchema = input.structuredOutput.schema
		}
		// maxOutputTokens is deliberately not forwarded (same as Mozaik's mapper): on Gemini it also caps thinking tokens.
		if (input.reasoningEffort) config.thinkingConfig = { thinkingLevel: input.reasoningEffort }
		return { model: input.model, contents, config }
	}

	toResponse(response: any): InferenceOutput {
		const items: InferenceOutput["items"] = []
		for (const part of response?.candidates?.[0]?.content?.parts ?? []) {
			if (part.thought) continue
			if (part.functionCall) {
				const callId = part.functionCall.id || `gemini-${randomUUID()}`
				this.calls.set(callId, { signature: part.thoughtSignature, geminiId: part.functionCall.id || undefined })
				items.push(FunctionCallItem.rehydrate({ callId, name: part.functionCall.name, args: JSON.stringify(part.functionCall.args ?? {}) }))
			} else if (typeof part.text === "string" && part.text) {
				items.push(ModelMessageItem.rehydrate({ text: part.text }))
			}
		}
		const u = response?.usageMetadata
		const tokenUsage = u
			? new TokenUsage(u.promptTokenCount ?? 0, u.candidatesTokenCount ?? 0, u.totalTokenCount ?? 0, new InputTokenDetails(u.cachedContentTokenCount ?? 0), new OutputTokenDetails(u.thoughtsTokenCount ?? 0))
			: undefined
		return { items, tokenUsage, rowResponse: response }
	}
}

function parseResponse(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text)
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: text }
	} catch {
		return { output: text }
	}
}

/** Mozaik's Gemini endpoint with the signature-preserving mapper. */
export const geminiEndpoint = () => new GeminiGenerateContent(new SignaturePreservingGeminiMapper())
