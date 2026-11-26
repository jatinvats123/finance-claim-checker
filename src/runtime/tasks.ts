/**
 * Each agent turn on a claim runs in its own Mozaik loop with a fresh ModelContext. The tracker maps
 * that context (and the loop id Mozaik assigns) back to the task, so the runner can label provenance
 * and failures, and so loop completion can be detected from `model.answer`.
 */
export type AgentRole = "extractor" | "extractor-fix" | "evidence" | "context" | "auditor"

export type Task = {
	key: string
	role: AgentRole
	claimId?: string
	claimRevision?: number
	evidenceRevision?: number
	contextId: string
	loopId?: string
	failure?: { kind: "CACHE_MISS" | "PROVIDER_ERROR" | "LIMIT_REACHED"; message: string }
	done: boolean
}

export class TaskTracker {
	private readonly byContext = new Map<string, Task>()
	private readonly byLoop = new Map<string, Task>()

	register(task: Omit<Task, "done">): Task {
		const t: Task = { ...task, done: false }
		this.byContext.set(t.contextId, t)
		return t
	}

	forContext(contextId: string): Task | undefined {
		return this.byContext.get(contextId)
	}

	bindLoop(contextId: string, loopId: string): Task | undefined {
		const t = this.byContext.get(contextId)
		if (t) {
			t.loopId = loopId
			this.byLoop.set(loopId, t)
		}
		return t
	}

	forLoop(loopId: string): Task | undefined {
		return this.byLoop.get(loopId)
	}

	all(): Task[] {
		return [...this.byContext.values()]
	}

	open(): Task[] {
		return this.all().filter((t) => !t.done)
	}
}
