/**
 * MemoryStore —— 三层记忆引擎(技术设计 §4.6.3;FR-M1/M2)
 *
 * 分层纪律:纯领域内核,零 DSH/Node import;持久化由 dsh 绑定层负责。
 *
 * 三层:
 * - private:成员自然记忆 = 其 session 历史(DSH 持久化)+ workspace MEMORY.md,
 *   本引擎不落库、不复制(团队/集团记忆是显式提炼层,防全量广播污染上下文);
 * - team:`memory-<teamId>` 流,成员贡献、lead 提炼,本 team + 上层可读;
 * - org:`memory-org` 流,各层 orchestrator 按 authority 提炼推送,BG 间默认隔离,
 *   org 汇总只读(投影由 ScopeProjection.projectMemory 强制,见 §4.6.2 实现约束)。
 */
export type MemoryLevel = 'team' | 'org'

export type MemoryKind = 'contribution' | 'handover' | 'decision' | 'insight'

export interface MemoryEntry {
  id: string
  level: MemoryLevel
  /** team 层必填:归属团队节点 id */
  teamId?: string
  /** 写入岗位 id */
  author: string
  kind: MemoryKind
  content: string
  /** 提炼摘要(上层推送时可选压缩) */
  digest?: string
  createdAt: string
}

export type MemoryInsertResult = { ok: true; entry: MemoryEntry } | { ok: false; reason: string }

const KINDS: MemoryKind[] = ['contribution', 'handover', 'decision', 'insight']

/**
 * 记忆条目校验:
 * - content 非空;
 * - team 层必须携带 teamId;
 * - kind 必须在四类之内(contribution/handover/decision/insight)。
 */
export function validateMemoryEntry(entry: MemoryEntry): string | undefined {
  if (typeof entry.content !== 'string' || entry.content.trim().length === 0) return '记忆内容不能为空'
  if (entry.level === 'team' && (entry.teamId === undefined || entry.teamId.length === 0)) return 'team 层记忆必须指定 teamId'
  if (!KINDS.includes(entry.kind)) return `非法记忆类型:${String(entry.kind)}`
  if (typeof entry.author !== 'string' || entry.author.length === 0) return '记忆作者不能为空'
  return undefined
}

/** 三层记忆引擎:append-only 列表 + 写入校验(权威投影在 scope 层) */
export class MemoryStore {
  private entries: MemoryEntry[] = []

  insert(entry: MemoryEntry): MemoryInsertResult {
    const error = validateMemoryEntry(entry)
    if (error !== undefined) return { ok: false, reason: error }
    this.entries.push(entry)
    return { ok: true, entry }
  }

  /** 冷启动重放(绑定层从 JSONL 恢复;重复 id 幂等跳过) */
  replay(entry: MemoryEntry): void {
    if (this.entries.some((e) => e.id === entry.id)) return
    const r = this.insert(entry)
    void r
  }

  list(): MemoryEntry[] {
    return [...this.entries]
  }

  count(): number {
    return this.entries.length
  }
}
