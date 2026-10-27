import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/live/*.live.ts'], environment: 'node', testTimeout: 65_000, fileParallelism: false } })
