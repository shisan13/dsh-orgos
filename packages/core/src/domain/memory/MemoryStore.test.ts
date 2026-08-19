/**
 * MemoryStore 三层记忆引擎测试:Given-When-Then(AGENTS.md §4 闸门)
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore, validateMemoryEntry } from './MemoryStore.ts'
import type { MemoryEntry } from './MemoryStore.ts'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'mem-1',
  level: 'team',
  teamId: 'team-main',
  author: 'coder-1',
  kind: 'contribution',
  content: '修复了构建脚本',
  createdAt: '2026-08-19T00:00:00.000Z',
  ...over,
})

describe('validateMemoryEntry', () => {
  it('GIVEN 合法 team 条目 THEN 通过', () => {
    expect(validateMemoryEntry(entry())).toBeUndefined()
  })

  it('GIVEN 空内容 THEN 拒绝', () => {
    expect(validateMemoryEntry(entry({ content: '  ' }))).toContain('不能为空')
  })

  it('GIVEN team 层缺 teamId THEN 拒绝', () => {
    expect(validateMemoryEntry(entry({ teamId: undefined }))).toContain('teamId')
  })

  it('GIVEN 非法 kind THEN 拒绝', () => {
    expect(validateMemoryEntry(entry({ kind: 'gossip' as never }))).toContain('非法记忆类型')
  })

  it('GIVEN org 层无 teamId THEN 通过', () => {
    expect(validateMemoryEntry(entry({ level: 'org', teamId: undefined }))).toBeUndefined()
  })
})

describe('MemoryStore', () => {
  it('GIVEN 插入合法条目 WHEN insert THEN 成功且可列出', () => {
    const store = new MemoryStore()
    const r = store.insert(entry())
    expect(r.ok).toBe(true)
    expect(store.count()).toBe(1)
    expect(store.list()[0]?.author).toBe('coder-1')
  })

  it('GIVEN 非法条目 WHEN insert THEN 拒绝且不入库', () => {
    const store = new MemoryStore()
    const r = store.insert(entry({ content: '' }))
    expect(r.ok).toBe(false)
    expect(store.count()).toBe(0)
  })

  it('GIVEN 重复 id 重放 WHEN replay THEN 幂等跳过', () => {
    const store = new MemoryStore()
    store.replay(entry())
    store.replay(entry())
    expect(store.count()).toBe(1)
  })
})
