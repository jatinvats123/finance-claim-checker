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

export const METRIC_CONCEPTS = {
	revenue: ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:SalesRevenueNet"],
	net_income: ["us-gaap:NetIncomeLoss"],
	gross_profit: ["us-gaap:GrossProfit"],
	operating_income: ["us-gaap:OperatingIncomeLoss"],
	eps_diluted: ["us-gaap:EarningsPerShareDiluted"],
	eps_basic: ["us-gaap:EarningsPerShareBasic"],
} as const

export type VerifiableMetric = keyof typeof METRIC_CONCEPTS
export const ALL_CONCEPTS: string[] = Object.values(METRIC_CONCEPTS).flat()
