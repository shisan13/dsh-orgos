/**
 * im-gateway BackoffPolicy 测试(§9.1 指数退避;公共设施,各 IM 适配器共用)
 */
import { describe, expect, it } from 'vitest'
import { BackoffPolicy } from './backoff.ts'

describe('Given 指数退避策略', () => {
  it('Then 退避序列 = base * 2^(n-1),封顶 max', () => {
    const p = new BackoffPolicy({ baseMs: 1000, maxMs: 8000, maxAttempts: 5 })
    expect(p.delayFor(1)).toBe(1000)
    expect(p.delayFor(2)).toBe(2000)
    expect(p.delayFor(3)).toBe(4000)
    expect(p.delayFor(4)).toBe(8000)
    expect(p.delayFor(5)).toBe(8000)
  })

  it('Then exhausted 判定:超过 maxAttempts 才放弃', () => {
    const p = new BackoffPolicy({ maxAttempts: 3 })
    expect(p.exhausted(1)).toBe(false)
    expect(p.exhausted(3)).toBe(false)
    expect(p.exhausted(4)).toBe(true)
  })

  it('Then 默认参数 base 1s / max 60s / 5 次;attempt<1 返回 0', () => {
    const p = new BackoffPolicy()
    expect(p.baseMs).toBe(1000)
    expect(p.maxMs).toBe(60_000)
    expect(p.maxAttempts).toBe(5)
    expect(p.delayFor(0)).toBe(0)
  })
})
