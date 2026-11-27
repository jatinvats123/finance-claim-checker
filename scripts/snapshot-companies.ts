/** Refresh the committed copy of SEC's company list (used when SEC is unreachable, and by the tests). */
import { COMPANY_INDEX_PATH, fetchCompanyIndex, saveCompanyIndex } from "../src/company/companies.js"

const index = await fetchCompanyIndex(30_000)
saveCompanyIndex(index)
console.log(`${index.companies.length} companies → ${COMPANY_INDEX_PATH} (fetched ${index.fetchedAt})`)
