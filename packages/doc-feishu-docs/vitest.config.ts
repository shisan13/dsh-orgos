import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // 只排除测试与夹具;index.ts(协议层)与 dsh/index.ts(绑定层)必须真实计入覆盖率,
      // 不做「排除被测文件」的虚高处理。
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
