/**
 * TeamStore / 文件工具 绑定层测试:Given-When-Then(AGENTS.md §4 闸门)
 * 覆盖 JSONL 头行、快照往返、team.yml 原子替换(备份/校验/回滚)与清理。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileTeamStore, atomicWriteTeamYml, readTeamYml, listBackups, pruneStateDir } from './store.js'

describe('createFileTeamStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 空状态目录 WHEN append THEN 自动写头行且业务行带 at', () => {
    const store = createFileTeamStore(dir)
    store.append('runs', { op: 'inbound' })
    const text = readFileSync(join(dir, 'runs.jsonl'), 'utf8')
    expect(text).toContain('"version":1')
    const rec = store.readAll('runs')
    expect(rec.length).toBe(1)
    expect(rec[0]?.op).toBe('inbound')
    expect(typeof rec[0]?.at).toBe('string')
  })

  it('GIVEN 已有流 WHEN append THEN 追加不重复头行', () => {
    const store = createFileTeamStore(dir)
    store.append('mailbox', { op: 'send' })
    store.append('mailbox', { op: 'send' })
    const lines = readFileSync(join(dir, 'mailbox.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(3) // 头行 + 2 业务行
    expect(store.readAll('mailbox').length).toBe(2)
  })

  it('GIVEN 快照保存 WHEN loadSnapshot THEN 往返一致', () => {
    const store = createFileTeamStore(dir)
    store.saveSnapshot('taskboard', { items: [{ id: 't1' }] })
    const loaded = store.loadSnapshot('taskboard')
    expect((loaded?.state as { items: Array<{ id: string }> }).items[0]?.id).toBe('t1')
  })

  it('GIVEN 无快照 WHEN loadSnapshot THEN undefined', () => {
    const store = createFileTeamStore(dir)
    expect(store.loadSnapshot('taskboard')).toBeUndefined()
  })
})

describe('atomicWriteTeamYml', () => {
  let dir: string
  const validate = (text: string): string[] => (text.includes('bad') ? ['含非法内容'] : [])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-yml-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 首次写入 WHEN 校验通过 THEN 落盘', () => {
    const r = atomicWriteTeamYml(dir, 'org: acme\n', validate)
    expect(r.ok).toBe(true)
    expect(readTeamYml(dir)).toBe('org: acme\n')
  })

  it('GIVEN 校验失败 WHEN 写入 THEN 拒绝且不落盘', () => {
    const r = atomicWriteTeamYml(dir, 'bad content\n', validate)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual(['含非法内容'])
    expect(readTeamYml(dir)).toBeUndefined()
  })

  it('GIVEN 已有 team.yml WHEN 再次写入 THEN 旧文件进备份且新文件生效', () => {
    atomicWriteTeamYml(dir, 'org: old\n', validate)
    const r = atomicWriteTeamYml(dir, 'org: new\n', validate)
    expect(r.ok).toBe(true)
    expect(readTeamYml(dir)).toBe('org: new\n')
    const backups = listBackups(dir)
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, 'backups', backups[0] as string), 'utf8')).toBe('org: old\n')
  })

  it('GIVEN 无 team.yml WHEN readTeamYml THEN undefined', () => {
    expect(readTeamYml(dir)).toBeUndefined()
  })
})

describe('pruneStateDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-prune-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 备份超限 WHEN prune THEN 仅保留最近 N 份且不动 team.yml', () => {
    const teamDir = join(dir, 'team')
    const backupDir = join(dir, 'backups')
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(join(teamDir, 'team.yml'), 'org: keep\n')
    mkdirSync(backupDir, { recursive: true })
    for (let i = 0; i < 25; i += 1) {
      writeFileSync(join(backupDir, `team-${String(i).padStart(3, '0')}.yml`), `v${i}`)
    }
    pruneStateDir(dir, 20)
    const backups = listBackups(dir).sort()
    expect(backups.length).toBe(20)
    expect(backups[0]).toBe('team-005.yml')
    expect(backups[19]).toBe('team-024.yml')
    expect(backups).not.toContain('team-004.yml')
    // team.yml 不动
    expect(readTeamYml(dir)).toBe('org: keep\n')
  })
})
