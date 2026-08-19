/**
 * WhatsApp Business API webhook → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * | webhook 内容                    | NormalizedMessage                       |
 * |---------------------------------|-----------------------------------------|
 * | messages[].type=text            | kind: text, peer{kind: direct}          |
 * | messages[].type=image/document  | kind: attachment, attachment{ref}       |
 * | messages[].type=interactive     | kind: approval_reply, approval{...}     |
 *
 * WhatsApp 消息为 phone 级(Business API 无群会话消息),peer 恒为 direct。
 * 纯函数:输入 webhook body 对象,输出规范化消息列表(一条 webhook 可含多条消息)。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type WhatsappEventResult = { ok: true; messages: NormalizedMessage[] } | { ok: false; reason: string }

/** webhook body → 规范化消息列表(逐条 messages[].type 分派) */
export function whatsappWebhookToMessages(raw: unknown): WhatsappEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'webhook 不是对象' }
  }
  const body = raw as Record<string, unknown>
  if (body.object !== 'whatsapp_business_account') {
    return { ok: false, reason: `忽略非消息对象:${String(body.object)}` }
  }
  const entries = Array.isArray(body.entry) ? body.entry : undefined
  if (entries === undefined || entries.length === 0) {
    return { ok: false, reason: '缺少 entry' }
  }
  const messages: NormalizedMessage[] = []
  for (const entry of entries) {
    const entryObj = entry as Record<string, unknown>
    const changes = Array.isArray(entryObj.changes) ? (entryObj.changes as unknown[]) : []
    for (const change of changes) {
      const value = (change as Record<string, unknown>).value as Record<string, unknown> | undefined
      if (typeof value !== 'object' || value === null) continue
      const rawMessages = Array.isArray(value.messages) ? value.messages : []
      for (const rawMessage of rawMessages) {
        const converted = messageToNormalized(rawMessage)
        if (converted !== undefined) messages.push(converted)
      }
    }
  }
  if (messages.length === 0) {
    return { ok: false, reason: '无可处理消息' }
  }
  return { ok: true, messages }
}

/** 单条 messages[] 条目 → 规范化消息(不可处理返回 undefined) */
function messageToNormalized(raw: unknown): NormalizedMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  const id = m.id
  const from = m.from
  const type = m.type
  if (typeof id !== 'string' || typeof from !== 'string' || typeof type !== 'string') {
    return undefined
  }
  const base: NormalizedMessage = {
    channel: 'whatsapp',
    peer: { kind: 'direct', id: from },
    sender: { id: from },
    kind: 'text',
    messageId: id,
    ts: typeof m.timestamp === 'string' ? new Date(Number(m.timestamp) * 1000).toISOString() : undefined,
  }
  if (type === 'text') {
    const text = m.text as Record<string, unknown> | undefined
    base.kind = 'text'
    base.content = typeof text?.body === 'string' ? text.body : undefined
    return base
  }
  if (type === 'image' || type === 'document' || type === 'audio' || type === 'video') {
    base.kind = 'attachment'
    base.attachment = {
      ref: typeof m.id === 'string' ? m.id : '',
      name: typeof (m as Record<string, unknown>).filename === 'string' ? (m as Record<string, unknown>).filename as string : undefined,
    }
    const media = m[type] as Record<string, unknown> | undefined
    if (typeof media?.id === 'string') base.attachment.ref = media.id
    return base
  }
  if (type === 'interactive') {
    const interactive = m.interactive as Record<string, unknown> | undefined
    const reply = interactive?.button_reply as Record<string, unknown> | undefined
    const idValue = typeof reply?.id === 'string' ? reply.id : undefined
    const parsed = idValue !== undefined ? parseButtonId(idValue) : undefined
    if (parsed === undefined) return undefined
    base.kind = 'approval_reply'
    base.approval = parsed
    return base
  }
  return undefined
}

/** 按钮 id JSON 解析(紧凑/完整兼容;按钮 id ≤256 字符) */
export function parseButtonId(buttonId: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const parsed = JSON.parse(buttonId) as Record<string, unknown>
    const approvalId = typeof parsed.a === 'string' ? parsed.a : typeof parsed.approvalId === 'string' ? parsed.approvalId : undefined
    const action = parsed.act === 'allow' || parsed.action === 'allow' ? 'allow' : parsed.act === 'deny' || parsed.action === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || action === undefined) return undefined
    return { approvalId, action }
  } catch {
    return undefined
  }
}
