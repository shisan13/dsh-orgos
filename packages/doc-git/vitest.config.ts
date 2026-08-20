import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 协议层(GitWikiProvider)与绑定层(dsh 行)都计入覆盖率,只排除测试与 fixtures
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/fixtures/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
