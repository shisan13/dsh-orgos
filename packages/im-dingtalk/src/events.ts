/**
 * 钉钉 Stream Mode 信封 → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * Stream 信封:headers{topic, eventType, eventId} + data(事件体 JSON 字符串)
 * | 事件                            | NormalizedMessage                       |
 * |---------------------------------|-----------------------------------------|
 * | ChatbotMessage 私聊             | kind: text, peer{kind: direct}          |
 * | ChatbotMessage 群 isInAtList    | kind: mention, peer{kind: group}        |
 * | ChatbotMessage 图片/文件        | kind: attachment, attachment{ref}       |
 * | 卡片按钮回调(CardCallback)      | kind: approval_reply, approval{...}     |
 *
 * 纯函数:输入信封对象,输出规范化消息或错误。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type DingtalkEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

interface DingtalkEnvelope {
  headers?: { topic?: string; eventType?: string; eventId?: string }
  data?: string
}

/** 信封 → 规范化消息(eventType 分派) */
export function dingtalkEnvelopeToMessage(raw: unknown, botName?: string): DingtalkEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '信封不是对象' }
  }
  const envelope = raw as DingtalkEnvelope
  const eventType = envelope.headers?.eventType
  if (eventType === 'ChatbotMessage') {
    const data = parseData(envelope.data)
    if (data === undefined) return { ok: false, reason: 'data 无法解析' }
    return chatMessageToMessage(data, botName)
  }
  if (eventType === 'CardCallback' || eventType === 'RobotCardCallback' || envelope.headers?.topic?.includes('card')) {
    const data = parseData(envelope.data)
    if (data === undefined) return { ok: false, reason: '卡片回调 data 无法解析' }
    return cardCallbackToMessage(data)
  }
  return { ok: false, reason: `忽略事件类型:${String(eventType)}` }
}

/** ChatbotMessage 规范化 */
function chatMessageToMessage(data: Record<string, unknown>, botName?: string): DingtalkEventResult {
  const msgId = data.msgId
  const conversationId = data.conversationId
  const senderStaffId = data.senderStaffId
  if (typeof msgId !== 'string' || typeof conversationId !== 'string' || typeof senderStaffId !== 'string') {
    return { ok: false, reason: '缺少 msgId/conversationId/senderStaffId' }
  }
  const conversationType = data.conversationType
  const isGroup = conversationType === '2'
  const content = typeof data.text === 'object' && data.text !== null ? (data.text as Record<string, unknown>).content : undefined
  const text = typeof content === 'string' ? content : undefined
  const inAtList = data.isInAtList === true
  const mentionByText = isGroup && botName !== undefined && text !== undefined && (text.trim().startsWith(`@${botName}`) || text.trim().startsWith('@'))

  const msgType = data.msgtype
  let attachment: NormalizedMessage['attachment'] | undefined
  if (msgType === 'picture' || msgType === 'file') {
    const downloadCode = typeof data.downloadCode === 'string' ? data.downloadCode : undefined
    attachment = { ref: downloadCode ?? msgId, name: typeof data.fileName === 'string' ? data.fileName : undefined }
  }

  const msg: NormalizedMessage = {
    channel: 'dingtalk',
    peer: { kind: isGroup ? 'group' : 'direct', id: conversationId },
    sender: { id: senderStaffId, name: typeof data.senderNick === 'string' ? data.senderNick : undefined },
    kind: attachment !== undefined ? 'attachment' : isGroup && (inAtList || mentionByText) ? 'mention' : 'text',
    content: text,
    messageId: msgId,
    ts: typeof data.createAt === 'number' ? new Date(data.createAt).toISOString() : undefined,
  }
  if (attachment !== undefined) msg.attachment = attachment
  return { ok: true, msg }
}

/**
 * 卡片按钮回调规范化(content 为 JSON 字符串,内含 cardPrivateData.params(JSON 字符串)):
 * { "content": "{\"cardPrivateData\":{\"params\":\"{\\\"a\\\":\\\"ap_1\\\",\\\"act\\\":\\\"allow\\\"}\"}}" }
 */
function cardCallbackToMessage(data: Record<string, unknown>): DingtalkEventResult {
  const userId = data.userId
  const msgId = data.msgId
  const conversationId = data.conversationId
  if (typeof userId !== 'string' || typeof msgId !== 'string' || typeof conversationId !== 'string') {
    return { ok: false, reason: '卡片回调缺少 userId/msgId/conversationId' }
  }
  const content = typeof data.content === 'string' ? data.content : ''
  const parsed = parseCardContent(content)
  if (parsed === undefined) {
    return { ok: false, reason: '卡片回调参数无法解析' }
  }
  const msg: NormalizedMessage = {
    channel: 'dingtalk',
    peer: { kind: 'direct', id: conversationId },
    sender: { id: userId },
    kind: 'approval_reply',
    approval: parsed,
    messageId: msgId,
  }
  return { ok: true, msg }
}

/** 解析卡片 content JSON → approval 参数(兼容多层转义) */
export function parseCardContent(content: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const outer = JSON.parse(content) as Record<string, unknown>
    const cardPrivate = outer.cardPrivateData as Record<string, unknown> | undefined
    const params = typeof cardPrivate?.params === 'string' ? JSON.parse(cardPrivate.params) : cardPrivate?.params
    const p = params as Record<string, unknown> | undefined
    const approvalId = typeof p?.a === 'string' ? p.a : typeof p?.approvalId === 'string' ? p.approvalId : undefined
    const action = p?.act === 'allow' || p?.action === 'allow' ? 'allow' : p?.act === 'deny' || p?.action === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || action === undefined) return undefined
    return { approvalId, action }
  } catch {
    return undefined
  }
}

/** data 字段是 JSON 字符串(部分事件是对象,兼容两者) */
function parseData(data: string | undefined): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
