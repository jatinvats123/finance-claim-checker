import type { Scale } from "./types.js"

/** Article units, expressed in the base units used by SEC XBRL and verified PDF facts. */
export const SCALE: Record<Scale, number> = { units: 1, thousand: 1e3, lakh: 1e5, million: 1e6, crore: 1e7, billion: 1e9, trillion: 1e12, lakh_crore: 1e12 }
