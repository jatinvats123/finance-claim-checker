import type { FiscalPeriod } from "../sec/evidence.js"

export type Metric = "revenue" | "net_income" | "gross_profit" | "operating_income" | "eps_diluted" | "eps_basic" | "other"
export type Accounting = "gaap" | "non_gaap" | "unspecified"
export type Scale = "units" | "thousand" | "million" | "billion" | "trillion"
export type StatedUnit = "usd" | "usd_per_share" | "percent" | "multiple"
export type Qualifier = "exact" | "about" | "more_than" | "less_than" | "at_least"

/** What the extractor says a sentence claims. Everything the calculator needs, nothing it computes. */
export type ClaimInterpretation = {
	/** Exact words from the article. */
	quote: string
	metric: Metric
	accounting: Accounting
	kind: "level" | "change"
	fiscalYear: number
	fiscalPeriod: FiscalPeriod
	/** For change claims: what the article compares against. */
	comparison?: "yoy" | "qoq" | "unspecified"
	direction?: "increase" | "decrease"
	/** The number exactly as written, as a string so precision is preserved ("96.2", "106", "2"). */
	statedNumber: string
	statedUnit: StatedUnit
	scale: Scale
	qualifier: Qualifier
}

export type Claim = {
	id: string
	revision: number
	interpretation: ClaimInterpretation
	/** Why this revision exists ("extracted", "auditor correction: ..."). */
	reason: string
	correctionsUsed: number
}

export type EvidenceBinding = {
	claimId: string
	claimRevision: number
	evidenceRevision: number
	currentFactId?: string
	baseFactId?: string
	/** For comparison-basis "unspecified": the base we did NOT use, shown as context only. */
	alternateBaseFactId?: string
	/** Set when no 10-Q/10-K covers the period, or the claim cannot be checked against statements. */
	noReference?: { status: "REFERENCE_NOT_YET_FILED" | "NOT_IN_STATEMENTS"; detail: string; earningsReleases?: { accn: string; filed: string; url: string }[] }
	boundBy: string
}

export type NumericVerdict = "MATCH" | "MISMATCH" | "NOT_COMPUTABLE" | "NOT_VERIFIABLE" | "REFERENCE_NOT_YET_FILED"

export type CalcInput = {
	evidenceId: string
	role: "current" | "base"
	concept: string
	value: number
	unit: string
	period: string
	start: string
	end: string
	form: string
	accn: string
	filed: string
	url: string
	derivation?: string
}

export type Calculation = {
	claimId: string
	claimRevision: number
	evidenceRevision: number
	verdict: NumericVerdict
	formula: string
	substituted: string
	actual?: number
	actualDisplay?: string
	statedDisplay: string
	toleranceRule?: string
	difference?: string
	inputs: CalcInput[]
	notes: string[]
}

export type ContextWarning = {
	claimId: string
	claimRevision: number
	evidenceRevision?: number
	source: "rule" | "context-agent"
	code: string
	message: string
}

export type AuditState =
	| { status: "pending" }
	| { status: "investigating"; target: "claim" | "evidence"; reason: string; by: string }
	| { status: "approved"; note: string; by: string }
	| { status: "unresolved"; reason: string }
	| { status: "failed"; reason: string }

export type Audit = { claimId: string; claimRevision: number; evidenceRevision: number; state: AuditState }
