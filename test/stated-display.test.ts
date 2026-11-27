import { describe, expect, it } from "vitest"
import { asWritten } from "../src/web/viewmodel.js"

describe("stated figure as the article wrote it", () => {
	const wipro = { quote: "Wipro Limited reported consolidated operating income of ₹15,172.1 crore for the year ended March 31, 2025", statedNumber: "15172.1" }

	it("keeps Western and Indian digit grouping from the quote", () => {
		expect(asWritten("₹15172.1 crore", wipro)).toBe("₹15,172.1 crore")
		expect(asWritten("₹151271 crore", { quote: "Operating profit was ₹1,51,271 crore for the year.", statedNumber: "151271" })).toBe("₹1,51,271 crore")
	})

	it("leaves ungrouped, already grouped or unmatched numbers alone", () => {
		expect(asWritten("$96.2 billion", { quote: "revenue of $96.2 billion", statedNumber: "96.2" })).toBe("$96.2 billion")
		expect(asWritten("₹1,53,000 crore", { quote: "₹1,53,000 crore", statedNumber: "1,53,000" })).toBe("₹1,53,000 crore")
		expect(asWritten("₹15172.1 crore", { quote: "₹15,127.1 crore, not 15172.1", statedNumber: "15172.1" })).toBe("₹15172.1 crore")
	})
})
