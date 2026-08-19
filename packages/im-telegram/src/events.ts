/**
 * Telegram Update → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * | Telegram 事件                | NormalizedMessage                       |
 * |------------------------------|-----------------------------------------|
 * | 私聊 text                    | kind: text, peer{kind: direct}          |
 * | 群消息 @botusername(entities) | kind: mention, peer{kind: group}        |
 * | 群消息未 @bot                | kind: text(路由层按 requireMention 静默) |
 * | reply_to_message             | kind: reply, peer.threadId               |
 * | photo/document               | kind: attachment, attachment{ref}       |
 * | callback_query(按钮)         | kind: approval_reply, approval{...}     |
 *
 * 纯函数:输入 Telegram update 对象,输出规范化消息或错误(不抛异常)。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type TelegramEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

interface TgChat {
  id: number | string
  type?: string
}
interface TgEntity {
  type?: string
  offset?: number
  length?: number
}
interface TgMessage {
  message_id?: number
  from?: { id?: number | string; first_name?: string }
  chat?: TgChat
  date?: number
  text?: string
  entities?: TgEntity[]
  reply_to_message?: { message_id?: number }
  photo?: { file_id?: string }[]
  document?: { file_id?: string; file_name?: string }
}

/** 单个 update → 规范化消息(callback_query 优先于 message) */
export function telegramUpdateToMessage(raw: unknown, botUsername?: string): TelegramEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'update 不是对象' }
  }
  const update = raw as Record<string, unknown>
  if (update.callback_query !== undefined) {
    return callbackToMessage(update.callback_query)
  }
  const message = update.message as TgMessage | undefined
  if (typeof message !== 'object' || message === null) {
    return { ok: false, reason: 'update 缺少 message/callback_query' }
  }
  if (typeof message.message_id !== 'number') {
    return { ok: false, reason: '缺少 message_id' }
  }
  const chat = message.chat
  if (typeof chat !== 'object' || chat === null) {
    return { ok: false, reason: '缺少 chat' }
  }
  const chatType = chat.type ?? 'private'
  const isGroup = chatType === 'group' || chatType === 'supergroup'
  const senderId = message.from?.id
  if (senderId === undefined) {
    return { ok: false, reason: '缺少 from.id' }
  }

  const text = typeof message.text === 'string' ? message.text : undefined
  const mentionedBot = isGroup && botUsername !== undefined && textIncludesMention(text, botUsername, message.entities)

  // 附件优先(photo/document)
  const photo = Array.isArray(message.photo) ? message.photo : undefined
  const document = message.document
  let attachment: NormalizedMessage['attachment'] | undefined
  if (document !== undefined && typeof document.file_id === 'string') {
    attachment = { ref: document.file_id, name: document.file_name }
  } else if (photo !== undefined && photo.length > 0) {
    const largest = photo[photo.length - 1]
    attachment = { ref: largest?.file_id ?? String(message.message_id) }
  }

  const msg: NormalizedMessage = {
    channel: 'telegram',
    peer: { kind: isGroup ? 'group' : 'direct', id: String(chat.id) },
    sender: { id: String(senderId), name: message.from?.first_name },
    kind: attachment !== undefined ? 'attachment' : isGroup && mentionedBot ? 'mention' : 'text',
    content: text,
    messageId: String(message.message_id),
    ts: typeof message.date === 'number' ? new Date(message.date * 1000).toISOString() : undefined,
  }
  const threadId = message.reply_to_message?.message_id
  if (typeof threadId === 'number') msg.peer.threadId = String(threadId)
  if (attachment !== undefined) msg.attachment = attachment
  // 回复消息:群/私聊内回复都标 reply(带 threadId)
  if (msg.kind === 'text' && msg.peer.threadId !== undefined) {
    msg.kind = 'reply'
  }
  return { ok: true, msg }
}

/** 按钮回调:data 为紧凑 JSON {a: approvalId, act: allow|deny}(Telegram callback_data ≤64 字节) */
function callbackToMessage(raw: unknown): TelegramEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'callback_query 不是对象' }
  }
  const cb = raw as Record<string, unknown>
  const from = cb.from as Record<string, unknown> | undefined
  const message = cb.message as Record<string, unknown> | undefined
  const chat = message?.chat as TgChat | undefined
  if (typeof from?.id === 'undefined' || typeof chat?.id === 'undefined' || typeof cb.id !== 'string') {
    return { ok: false, reason: 'callback_query 缺少 from/chat/id' }
  }
  const data = typeof cb.data === 'string' ? parseData(cb.data) : undefined
  if (data === undefined) {
    return { ok: false, reason: 'callback_query data 无法解析' }
  }
  const msg: NormalizedMessage = {
    channel: 'telegram',
    peer: { kind: chat.type === 'group' || chat.type === 'supergroup' ? 'group' : 'direct', id: String(chat.id) },
    sender: { id: String(from.id) },
    kind: 'approval_reply',
    approval: { approvalId: data.approvalId, action: data.action },
    messageId: cb.id,
  }
  return { ok: true, msg }
}

/** 解析紧凑 data JSON(与 parseValue/parseCustomId/parseButtonId 同构:返回 {approvalId, action}) */
export function parseData(data: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const approvalId = typeof parsed.a === 'string' ? parsed.a : typeof parsed.approvalId === 'string' ? parsed.approvalId : undefined
    const action = parsed.act === 'allow' || parsed.action === 'allow' ? 'allow' : parsed.act === 'deny' || parsed.action === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || action === undefined) return undefined
    return { approvalId, action }
  } catch {
    return undefined
  }
}

/** @bot 提及判定:entities 命中 mention 且片段等于 @botUsername;无 entities 时按文本开头匹配 */
export function textIncludesMention(text: string | undefined, botUsername: string, entities?: TgEntity[]): boolean {
  if (text === undefined) return false
  if (entities !== undefined && entities.length > 0) {
    for (const entity of entities) {
      if (entity.type !== 'mention' || typeof entity.offset !== 'number' || typeof entity.length !== 'number') continue
      const mention = text.slice(entity.offset, entity.offset + entity.length)
      if (mention === `@${botUsername}`) return true
    }
    return false
  }
  return text.startsWith(`@${botUsername}`) || text.includes(` @${botUsername} `) || text.endsWith(` @${botUsername}`)
}
