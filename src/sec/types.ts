/** Raw shapes from SEC EDGAR (trimmed to what the checker uses). */

export type FactRow = {
	start?: string
	end: string
	val: number
	accn: string
	fy: number | null
	fp: string | null
	form: string
	filed: string
	frame?: string
}

export type FilingRow = {
	accessionNumber: string
	form: string
	filingDate: string
	reportDate: string
	primaryDocument: string
	items: string
}

/** A trimmed, provenance-stamped copy of EDGAR data for one company. */
export type SecSnapshot = {
	ticker: string
	cik: string
	entityName: string
	source: {
		companyFactsUrl: string
		submissionsUrl: string
		fetchedAt: string
		note: string
	}
	/** concept (e.g. "us-gaap:Revenues") -> unit (e.g. "USD") -> rows */
	facts: Record<string, Record<string, FactRow[]>>
	filings: FilingRow[]
}

/**
 * Financial-statement forms the checker verifies against: 10-Q (quarterly, unaudited), 10-K (annual,
 * audited) and, for foreign private issuers, 20-F / 40-F annual reports. Earnings releases (8-K, 6-K)
 * are never references: checking a release against itself would be circular.
 */
export const STATEMENT_FORM = /^(10-Q|10-K|20-F|40-F)(\/A)?$/
export const ANNUAL_FORM = /^(10-K|20-F|40-F)/
export const isStatementForm = (form: string) => STATEMENT_FORM.test(form)

/**
 * XBRL concepts per metric, in priority order (US GAAP and IFRS). When a filing tags several concepts
 * for the same period, the first one present is the metric's primary line item: e.g. NetIncomeLoss
 * (attributable to the company) before ProfitLoss (which includes non-controlling interests).
 */
export const METRIC_CONCEPTS = {
	revenue: [
		"us-gaap:Revenues",
		"us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
		"us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
		"us-gaap:SalesRevenueNet",
		"us-gaap:RevenuesNetOfInterestExpense",
		"ifrs-full:Revenue",
		"ifrs-full:RevenueFromContractsWithCustomers",
		"report:Revenue",
	],
	net_income: ["us-gaap:NetIncomeLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent", "us-gaap:ProfitLoss", "ifrs-full:ProfitLoss", "report:NetIncome"],
	gross_profit: ["us-gaap:GrossProfit", "ifrs-full:GrossProfit", "report:GrossProfit"],
	operating_income: ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities", "report:OperatingIncome"],
	eps_diluted: ["us-gaap:EarningsPerShareDiluted", "ifrs-full:DilutedEarningsLossPerShare", "report:EPSDiluted"],
	eps_basic: ["us-gaap:EarningsPerShareBasic", "ifrs-full:BasicEarningsLossPerShare", "report:EPSBasic"],
} as const

export type VerifiableMetric = keyof typeof METRIC_CONCEPTS
/** Concepts fetched from SEC XBRL (report:* concepts name line items read from official reports). */
export const ALL_CONCEPTS: string[] = Object.values(METRIC_CONCEPTS)
	.flat()
	.filter((c) => !c.startsWith("report:"))
export const reportConcept = (m: VerifiableMetric): string => (METRIC_CONCEPTS[m] as readonly string[]).find((c) => c.startsWith("report:"))!
export const VERIFIABLE_METRICS = Object.keys(METRIC_CONCEPTS) as VerifiableMetric[]
export const isVerifiableMetric = (m: string): m is VerifiableMetric => m in METRIC_CONCEPTS
export const isPerShareMetric = (m: string) => m === "eps_diluted" || m === "eps_basic"
export const metricOfConcept = (concept: string): VerifiableMetric | undefined => VERIFIABLE_METRICS.find((m) => (METRIC_CONCEPTS[m] as readonly string[]).includes(concept))
export const taxonomyOf = (concept: string) => (concept.startsWith("ifrs-full:") ? "IFRS" : concept.startsWith("us-gaap:") ? "US GAAP" : "as reported")
