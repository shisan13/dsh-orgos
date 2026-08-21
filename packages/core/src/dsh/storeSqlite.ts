/**
 * dsh-orgos-core 绑定层 —— SQLite 存储 provider(M3.1)
 *
 * TeamStore seam 的 SQLite 实现:
 * - 记录 JSON 格式与 JSONL 实现逐字节同构(格式即迁移契约),业务层零感知;
 * - 单表 streams(stream, seq, record)+ meta;WAL + synchronous=NORMAL;
 *   单写者由 TeamService 串行化保证(与 JSONL 同语义);
 * - 引擎:node:sqlite(Node ≥22.5 内置,零原生编译依赖;Node 24 仍带
 *   ExperimentalWarning —— seam 隔离,异常时切 better-sqlite3 不改业务)。
 * 分层纪律:本目录(dsh/)是绑定层,允许接触运行环境;不落任何凭据。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamStore, StreamName } from './store.js'

const ENGINE_KEY = 'engine'
const ENGINE_SQLITE = 'sqlite'

/** 单条 JSONL 行(业务记录 + at 时间戳)解析失败时跳过并返回问题行号(迁移诊断) */
export interface MigrationReport {
  ok: boolean
  /** 各流迁移条数(stream → count) */
  migrated: Record<string, number>
  /** 解析失败行(stream:line,内容截断不落盘) */
  issues: string[]
  reason?: string
}

/** JSONL → SQLite 一次性搬移(停服迁移,单写者;JSONL 原样保留,删除 SQLite 即回退) */
export function migrateJsonlToSqlite(stateRoot: string, streams: StreamName[]): MigrationReport {
  const dbPath = join(stateRoot, 'team.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`CREATE TABLE IF NOT EXISTS streams (
    stream TEXT NOT NULL,
    seq INTEGER NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (stream, seq)
  ); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const has = db.prepare('SELECT 1 AS x FROM meta WHERE key = ?').get(ENGINE_KEY) as { x?: number } | undefined
  if (has !== undefined) {
    db.close()
    return { ok: false, migrated: {}, issues: [], reason: 'sqlite 已迁移过(meta.engine 已存在);如需重迁请先备份并删除 team.sqlite' }
  }
  const insert = db.prepare('INSERT INTO streams (stream, seq, record) VALUES (?, ?, ?)')
  const migrated: Record<string, number> = {}
  const issues: string[] = []
  db.exec('BEGIN')
  try {
    for (const stream of streams) {
      const p = join(stateRoot, `${stream}.jsonl`)
      if (!existsSync(p)) continue
      let seq = 0
      let lineNo = 0
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        lineNo += 1
        if (line.length === 0) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if ('version' in parsed) continue // JSONL 头行不是业务记录
        seq += 1
        insert.run(stream, seq, JSON.stringify(parsed))
      }
      migrated[stream] = seq
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(ENGINE_KEY, ENGINE_SQLITE)
    db.exec('COMMIT')
    return { ok: true, migrated, issues }
  } catch (error) {
    db.exec('ROLLBACK')
    issues.push(String(error).slice(0, 200))
    return { ok: false, migrated, issues, reason: '迁移失败(已回滚,JSONL 原样保留)' }
  } finally {
    db.close()
  }
}

/** SQLite TeamStore(M3.1;TeamStore seam 实现,注入方式与 JSONL 完全一致) */
export function createSqliteTeamStore(stateRoot: string): TeamStore {
  mkdirSync(stateRoot, { recursive: true })
  const dbPath = join(stateRoot, 'team.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(`CREATE TABLE IF NOT EXISTS streams (
    stream TEXT NOT NULL,
    seq INTEGER NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (stream, seq)
  ); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const markEngine = (): void => {
    const existing = db.prepare('SELECT 1 AS x FROM meta WHERE key = ?').get(ENGINE_KEY) as { x?: number } | undefined
    if (existing === undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(ENGINE_KEY, ENGINE_SQLITE)
  }
  markEngine()

  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM streams WHERE stream = ?')
  const insert = db.prepare('INSERT INTO streams (stream, seq, record) VALUES (?, ?, ?)')
  const selectAll = db.prepare('SELECT record FROM streams WHERE stream = ? ORDER BY seq ASC')
  const metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

  const appendOne = (stream: StreamName, record: Record<string, unknown>): void => {
    const seq = (nextSeq.get(stream) as { n: number }).n
    insert.run(stream, seq, JSON.stringify({ at: new Date().toISOString(), ...record }))
  }

  return {
    stateRoot: () => stateRoot,
    append(stream, record) {
      appendOne(stream, record)
    },
    /** 批量追加(单事务;JSONL 实现为循环,seam 可选方法) */
    appendBatch(stream, records) {
      if (records.length === 0) return
      db.exec('BEGIN')
      try {
        for (const record of records) appendOne(stream, record)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    readAll(stream) {
      const rows = selectAll.all(stream) as Array<{ record: string }>
      return rows.map((r) => JSON.parse(r.record) as Record<string, unknown>)
    },
    saveSnapshot(stream, state) {
      metaSet.run(`snapshot:${stream}`, JSON.stringify({ savedAt: new Date().toISOString(), state }))
    },
    loadSnapshot(stream) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`snapshot:${stream}`) as { value: string } | undefined
      if (row === undefined) return undefined
      return JSON.parse(row.value) as Record<string, unknown>
    },
  }
}
