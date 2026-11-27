/** Tab-local refresh recovery. Unavailable or full browser storage must not interrupt a check. */
export function readSession<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(`claim-checker:v1:${key}`) ?? "null")
		return valid(value) ? value : undefined
	} catch {
		return undefined
	}
}

export function saveSession(key: string, value: unknown): void {
	try {
		const name = `claim-checker:v1:${key}`
		if (value === undefined) sessionStorage.removeItem(name)
		else sessionStorage.setItem(name, JSON.stringify(value))
	} catch {
		// Checking still works when browser storage is disabled or its quota is reached.
	}
}
