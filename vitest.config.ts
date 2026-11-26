import { defineConfig } from "vitest/config"

// Tests live in test/ at the repo root (vite.config.ts sets root to web/ for the frontend build).
export default defineConfig({ test: { root: ".", include: ["test/**/*.test.ts"] } })
