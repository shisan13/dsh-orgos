/**
 * 入站消息规范化与校验(技术设计 §9.2)
 * - normalize:把适配器原始事件转成 NormalizedMessage 的通用收口(字段校验 + 去重键);
 * - 去重键:(channel, peer.id, messageId) —— 幂等集(§9.1 防重放/重推,T6);
 * - 适配器实现的约定:非法消息(缺 messageId 等)在 gateway 层拒绝并标记 rejected。
 */
import type { NormalizedMessage } from './types.ts'

export type NormalizeIssue = { field: string; message: string }

export type NormalizeResult = { ok: true; msg: NormalizedMessage } | { ok: false; issues: NormalizeIssue[] }

const KINDS = new Set(['text', 'mention', 'reply', 'approval_reply', 'attachment'])

/** 校验 + 收口(纯函数):非法输入返回字段级问题(不抛异常,适配器可渲染错误) */
export function normalizeMessage(raw: unknown): NormalizeResult {
  const issues: NormalizeIssue[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, issues: [{ field: '$', message: '消息必须是对象' }] }
  }
  const r = raw as Record<string, unknown>
  const channel = r.channel
  if (typeof channel !== 'string' || channel.length === 0) {
    issues.push({ field: 'channel', message: '缺少 channel' })
  }
  const peer = r.peer
  if (typeof peer !== 'object' || peer === null) {
    issues.push({ field: 'peer', message: '缺少 peer' })
  } else {
    const p = peer as Record<string, unknown>
    if (p.kind !== 'group' && p.kind !== 'direct') {
      issues.push({ field: 'peer.kind', message: 'peer.kind 必须是 group/direct' })
    }
    if (typeof p.id !== 'string' || p.id.length === 0) {
      issues.push({ field: 'peer.id', message: '缺少 peer.id' })
    }
  }
  const sender = r.sender
  if (typeof sender !== 'object' || sender === null) {
    issues.push({ field: 'sender', message: '缺少 sender' })
  } else if (typeof (sender as Record<string, unknown>).id !== 'string' || ((sender as Record<string, unknown>).id as string).length === 0) {
    issues.push({ field: 'sender.id', message: '缺少 sender.id' })
  }
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) {
    issues.push({ field: 'kind', message: `kind 必须是 ${[...KINDS].join('/')}` })
  }
  if (typeof r.messageId !== 'string' || r.messageId.length === 0) {
    issues.push({ field: 'messageId', message: '缺少 messageId(幂等/防重放必需)' })
  }
  if (issues.length > 0) return { ok: false, issues }
  const msg: NormalizedMessage = {
    channel: channel as string,
    peer: {
      kind: (peer as Record<string, unknown>).kind as 'group' | 'direct',
      id: (peer as Record<string, unknown>).id as string,
      threadId: typeof (peer as Record<string, unknown>).threadId === 'string' ? (peer as Record<string, unknown>).threadId as string : undefined,
    },
    sender: {
      id: (sender as Record<string, unknown>).id as string,
      name: typeof (sender as Record<string, unknown>).name === 'string' ? (sender as Record<string, unknown>).name as string : undefined,
    },
    kind: r.kind as NormalizedMessage['kind'],
    content: typeof r.content === 'string' ? r.content : undefined,
    approval: typeof r.approval === 'object' && r.approval !== null ? r.approval as NormalizedMessage['approval'] : undefined,
    attachment: typeof r.attachment === 'object' && r.attachment !== null ? r.attachment as NormalizedMessage['attachment'] : undefined,
    messageId: r.messageId as string,
    ts: typeof r.ts === 'string' ? r.ts : undefined,
  }
  return { ok: true, msg }
}

/** 去重键:(channel, peer.id, messageId),T6 防重放 */
export function dedupKey(msg: Pick<NormalizedMessage, 'channel' | 'peer' | 'messageId'>): string {
  return `${msg.channel}:${msg.peer.id}:${msg.messageId}`
}

/**
 * 幂等集(§9.1 防重推):固定容量 LRU 式去重。
 * 线程安全非本层职责(单线程事件循环);容量上限防无限增长。
 */
export class IdempotencySet {
  private readonly keys = new Set<string>()
  private readonly queue: string[] = []
  private readonly capacity: number

  constructor(capacity = 10_000) {
    this.capacity = capacity
  }

  /** 返回 true = 已见过(重复);false = 首次 */
  seen(key: string): boolean {
    if (this.keys.has(key)) return true
    this.keys.add(key)
    this.queue.push(key)
    if (this.queue.length > this.capacity) {
      const oldest = this.queue.shift()
      if (oldest !== undefined) this.keys.delete(oldest)
    }
    return false
  }

  size(): number {
    return this.keys.size
  }
}
