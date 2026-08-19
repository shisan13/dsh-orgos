/**
 * seeder 播种器测试:Given-When-Then(AGENTS.md §4 闸门)
 * 源目录用仓库内 packages/core/presets(构建产物同布局);目标目录为临时 userRoot。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedPresets } from './seeder.js'

const ALL_ROLES = ['orgos-orchestrator', 'orgos-coder', 'orgos-reviewer', 'orgos-analyst', 'orgos-assistant']

describe('seedPresets', () => {
  let userRoot: string
  const logs: string[] = []

  beforeEach(() => {
    userRoot = mkdtempSync(join(tmpdir(), 'orgos-presets-'))
    logs.length = 0
  })
  afterEach(() => {
    rmSync(userRoot, { recursive: true, force: true })
  })

  it('GIVEN 空 userRoot WHEN seed THEN 五个角色全部播种且逐个记录日志', () => {
    const r = seedPresets(userRoot, (m) => logs.push(m))
    expect(r.seeded.sort()).toEqual([...ALL_ROLES].sort())
    expect(r.skipped).toEqual([])
    expect(r.errors).toEqual([])
    for (const role of ALL_ROLES) expect(existsSync(join(userRoot, role))).toBe(true)
    expect(logs.length).toBe(ALL_ROLES.length)
  })

  it('GIVEN 已存在同名目录 WHEN seed THEN 绝不覆盖而是跳过', () => {
    const keep = join(userRoot, 'orgos-coder')
    mkdirSync(keep, { recursive: true })
    const r = seedPresets(userRoot, () => {})
    expect(r.skipped).toEqual(['orgos-coder'])
    expect(r.seeded).not.toContain('orgos-coder')
    expect(r.seeded.length).toBe(ALL_ROLES.length - 1)
  })

  it('GIVEN 全量已播种 WHEN 再次 seed THEN 全部跳过且无重复日志', () => {
    seedPresets(userRoot, () => {})
    const r = seedPresets(userRoot, () => {})
    expect(r.skipped.sort()).toEqual([...ALL_ROLES].sort())
    expect(r.seeded).toEqual([])
    expect(r.errors).toEqual([])
  })
})
