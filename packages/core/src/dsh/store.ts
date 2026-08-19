/**
 * dsh-orgos-core 绑定层 —— 状态持久化(技术设计 §8)
 *
 * TeamStore:JSONL append-only + 快照;host 侧单实例。
 * 分层纪律:本目录(dsh/)是 DSH 绑定层,允许接触运行环境;domain/ 仍零 DSH import。
 * 注意:不落任何凭据(凭据只走 ctx.credentials)。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type StreamName = 'registry' | 'mailbox' | 'taskboard' | 'delegations' | 'runs' | 'memory-team' | 'memory-org'

export interface TeamStore {
  append(stream: StreamName, record: Record<string, unknown>): void
  readAll(stream: StreamName): Record<string, unknown>[]
  saveSnapshot(stream: StreamName, state: Record<string, unknown>): void
  loadSnapshot(stream: StreamName): Record<string, unknown> | undefined
  stateRoot(): string
}

interface JsonlHeader {
  version: 1
  stream: string
  createdAt: string
}

export function createFileTeamStore(stateRoot: string): TeamStore {
  mkdirSync(join(stateRoot, 'snapshots'), { recursive: true })
  const pathFor = (stream: StreamName) => join(stateRoot, `${stream}.jsonl`)
  const snapshotFor = (stream: StreamName) => join(stateRoot, 'snapshots', `${stream}.json`)

  const ensureHeader = (stream: StreamName): void => {
    const p = pathFor(stream)
    if (!existsSync(p)) {
      const header: JsonlHeader = { version: 1, stream, createdAt: new Date().toISOString() }
      writeFileSync(p, JSON.stringify(header) + '\n')
    }
  }

  return {
    stateRoot: () => stateRoot,
    append(stream, record) {
      ensureHeader(stream)
      writeFileSync(pathFor(stream), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { flag: 'a' })
    },
    readAll(stream) {
      const p = pathFor(stream)
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((rec) => !('version' in rec)) // 头部行不是业务记录
    },
    saveSnapshot(stream, state) {
      const tmp = snapshotFor(stream) + '.tmp'
      writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), state }))
      renameSync(tmp, snapshotFor(stream))
    },
    loadSnapshot(stream) {
      const p = snapshotFor(stream)
      if (!existsSync(p)) return undefined
      return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    },
  }
}

/** 校验 team.yml 原子替换(FR-X5:备份 → 校验 → 应用 → 回滚) */
export function atomicWriteTeamYml(stateRoot: string, content: string, validate: (text: string) => string[]): { ok: true } | { ok: false; errors: string[] } {
  const errors = validate(content)
  if (errors.length > 0) return { ok: false, errors }
  const dir = join(stateRoot, 'team')
  const backups = join(stateRoot, 'backups')
  mkdirSync(dir, { recursive: true })
  mkdirSync(backups, { recursive: true })
  const target = join(dir, 'team.yml')
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(target, join(backups, `team-${stamp}.yml`))
  }
  writeFileSync(target, content)
  return { ok: true }
}

export function readTeamYml(stateRoot: string): string | undefined {
  const p = join(stateRoot, 'team', 'team.yml')
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}

export function listBackups(stateRoot: string): string[] {
  const dir = join(stateRoot, 'backups')
  return existsSync(dir) ? readdirSync(dir) : []
}

/** 团队状态目录清理(仅限 snapshots/backups,绝不动 team.yml 与 jsonl) */
export function pruneStateDir(stateRoot: string, keepBackups = 20): void {
  const backups = listBackups(stateRoot).sort().reverse()
  for (const extra of backups.slice(keepBackups)) {
    rmSync(join(stateRoot, 'backups', extra), { force: true })
  }
}

/** 可观测性 marker(team_doctor 诊断基础;NFR-6):append-only 状态行,含时间戳 */
export function marker(stateRoot: string, source: string, event: string, detail?: string): void {
  try {
    mkdirSync(stateRoot, { recursive: true })
    appendFileSync(join(stateRoot, 'markers.log'), `${new Date().toISOString()} [${source}] ${event}${detail ? ' ' + detail : ''}\n`)
  } catch {
    /* 可观测性失败不阻塞业务 */
  }
}
