import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // 顺序敏感:子路径前缀必须排在裸包名之前(裸名会吞掉 /dsh/* 子路径)
      'dsh-orgos-core/dsh/': fileURLToPath(new URL('../core/src/dsh/', import.meta.url)),
      'dsh-orgos-core': fileURLToPath(new URL('../core/src/domain/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
