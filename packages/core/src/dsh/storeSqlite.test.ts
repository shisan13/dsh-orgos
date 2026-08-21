/**
 * SQLiteTeamStore(M3.1)测试:Given-When-Then(AGENTS.md §4 闸门)
 * 覆盖:与 JSONL 实现的记录同构、seq 有序、重启恢复、appendBatch 原子、
 * 快照往返、JSONL→SQLite 迁移(含幂等保护与解析失败回滚)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileTeamStore } from './store.js'
import { createSqliteTeamStore, migrateJsonlToSqlite } from './storeSqlite.js'
import type { StreamName } from './store.js'

const STREAMS: StreamName[] = ['mailbox', 'taskboard', 'delegations', 'runs', 'memory-team-main']

describe('SQLiteTeamStore(M3.1 存储 provider)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-sqlite-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 同一批记录写入两个实现 WHEN readAll THEN 记录形状逐条一致(格式即迁移契约)', () => {
    const jsonl = createFileTeamStore(dir)
    const sqlite = createSqliteTeamStore(join(dir, 'sqlite'))
    const records = [
      { op: 'create', delegationId: 'd1' },
      { op: 'settle', delegationId: 'd1', ok: true },
      { op: 'mail', kind: 'note' },
    ]
    for (const r of records) {
      jsonl.append('delegations', r)
      sqlite.append('delegations', r)
    }
    const a = jsonl.readAll('delegations')
    const b = sqlite.readAll('delegations')
    expect(b.length).toBe(3)
    // 逐条比对业务字段(时间戳 at 各自生成,允许不同)
    expect(b.map((r) => ({ ...r, at: undefined }))).toEqual(a.map((r) => ({ ...r, at: undefined })))
    expect(b.every((r) => typeof r.at === 'string')).toBe(true)
  })

  it('GIVEN 多流交错写入 WHEN 重新打开数据库 THEN seq 连续且按流隔离', () => {
    const sqlite = createSqliteTeamStore(dir)
    sqlite.append('mailbox', { kind: 'a' })
    sqlite.append('taskboard', { title: 't1' })
    sqlite.append('mailbox', { kind: 'b' })
    // 重启恢复:同路径新实例
    const reopened = createSqliteTeamStore(dir)
    expect(reopened.readAll('mailbox').map((r) => r.kind)).toEqual(['a', 'b'])
    expect(reopened.readAll('taskboard')).toHaveLength(1)
    // 继续追加不重号
    reopened.append('mailbox', { kind: 'c' })
    expect(reopened.readAll('mailbox')).toHaveLength(3)
  })

  it('GIVEN appendBatch WHEN 写入 THEN 全部落库且 readAll 有序返回', () => {
    const sqlite = createSqliteTeamStore(dir)
    sqlite.appendBatch?.('delegations', [{ op: 'a' }, { op: 'b' }, { op: 'c' }])
    expect(sqlite.readAll('delegations').map((r) => r.op)).toEqual(['a', 'b', 'c'])
  })

  it('GIVEN 空批次 WHEN appendBatch THEN no-op 不产生空记录', () => {
    const sqlite = createSqliteTeamStore(dir)
    sqlite.appendBatch?.('runs', [])
    expect(sqlite.readAll('runs')).toEqual([])
  })

  it('GIVEN saveSnapshot WHEN loadSnapshot THEN 往返一致且跨实例可见', () => {
    const sqlite = createSqliteTeamStore(dir)
    sqlite.saveSnapshot('taskboard', { tasks: 5, at: 'x' })
    const again = createSqliteTeamStore(dir)
    const loaded = again.loadSnapshot('taskboard')
    expect(loaded?.state).toEqual({ tasks: 5, at: 'x' })
    expect(loaded?.savedAt).toBeTypeOf('string')
    expect(again.loadSnapshot('runs')).toBeUndefined()
  })

  it('GIVEN JSONL 已有数据 WHEN migrateJsonlToSqlite THEN SQLite readAll 与 JSONL 一致且幂等保护生效', () => {
    const jsonl = createFileTeamStore(dir)
    for (const stream of STREAMS) jsonl.append(stream, { op: `seed-${stream}` })
    jsonl.append('mailbox', { op: 'second' })
    const report = migrateJsonlToSqlite(dir, STREAMS)
    expect(report.ok).toBe(true)
    expect(report.migrated['mailbox']).toBe(2)
    const sqlite = createSqliteTeamStore(dir)
    for (const stream of STREAMS) {
      expect(sqlite.readAll(stream).map((r) => r.op)).toEqual(jsonl.readAll(stream).map((r) => r.op))
    }
    // 幂等:重复迁移被拒
    const again = migrateJsonlToSqlite(dir, STREAMS)
    expect(again.ok).toBe(false)
    expect(again.reason).toContain('已迁移过')
  })

  it('GIVEN JSONL 行损坏 WHEN 迁移 THEN 整体回滚且 JSONL 原样保留', () => {
    const jsonl = createFileTeamStore(dir)
    jsonl.append('mailbox', { op: 'good' })
    // 手工追加一行坏 JSON
    const fs = require('node:fs') as typeof import('node:fs')
    fs.appendFileSync(join(dir, 'mailbox.jsonl'), '{bad json\n')
    const report = migrateJsonlToSqlite(dir, STREAMS)
    expect(report.ok).toBe(false)
    expect(report.issues.length).toBeGreaterThan(0)
    // SQLite 表无半批数据(事务回滚):重新打开后 mailbox 为空
    const sqlite = createSqliteTeamStore(dir)
    expect(sqlite.readAll('mailbox')).toEqual([])
    // JSONL 原样保留(文件未动:头行 + 好行 + 坏行)
    const raw = fs.readFileSync(join(dir, 'mailbox.jsonl'), 'utf8')
    expect(raw).toContain('"op":"good"')
    expect(raw).toContain('{bad json')
  })

  it('GIVEN stateRoot WHEN 查询 THEN 返回注入路径且 SQLite 文件落在其中', () => {
    const sqlite = createSqliteTeamStore(dir)
    expect(sqlite.stateRoot()).toBe(dir)
    const fs = require('node:fs') as typeof import('node:fs')
    expect(fs.existsSync(join(dir, 'team.sqlite'))).toBe(true)
  })
})
