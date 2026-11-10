import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/executor/**/*.test.ts'],
    environment: 'node',
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
