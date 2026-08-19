/**
 * Discord Gateway 事件 → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * Gateway 协议(op 0=DISPATCH/1=HEARTBEAT/2=IDENTIFY/7=RECONNECT/10=HELLO/11=ACK)
 * 由生产 transport 实现;本层处理 DISPATCH 的业务事件:
 * | 事件                         | NormalizedMessage                       |
 * |------------------------------|-----------------------------------------|
 * | MESSAGE_CREATE(DM)           | kind: text, peer{kind: direct}          |
 * | MESSAGE_CREATE(群 @bot)      | kind: mention, peer{kind: group}        |
 * | MESSAGE_CREATE(reference)    | kind: reply, peer.threadId               |
 * | MESSAGE_CREATE(attachments)  | kind: attachment, attachment{ref}       |
 * | INTERACTION_CREATE(按钮)     | kind: approval_reply, approval{...}     |
 *
 * 纯函数:输入 gateway 帧对象,输出规范化消息或错误。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type DiscordEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

interface GatewayFrame {
  op?: number
  t?: string
  d?: unknown
}

/** gateway 帧 → 规范化消息(仅处理 op=0 DISPATCH 的业务事件) */
export function discordFrameToMessage(raw: unknown, botUserId?: string): DiscordEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '帧不是对象' }
  }
  const frame = raw as GatewayFrame
  if (frame.op !== 0) {
    return { ok: false, reason: `忽略非 DISPATCH 帧(op=${String(frame.op)})` }
  }
  if (frame.t === 'INTERACTION_CREATE') {
    return interactionToMessage(frame.d)
  }
  if (frame.t !== 'MESSAGE_CREATE') {
    return { ok: false, reason: `忽略事件类型:${String(frame.t)}` }
  }
  return messageCreateToMessage(frame.d, botUserId)
}

/** MESSAGE_CREATE 规范化 */
function messageCreateToMessage(data: unknown, botUserId?: string): DiscordEventResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: '缺少事件数据' }
  }
  const d = data as Record<string, unknown>
  const id = d.id
  const channelId = d.channel_id
  const author = d.author as Record<string, unknown> | undefined
  if (typeof id !== 'string' || typeof channelId !== 'string' || typeof author?.id !== 'string') {
    return { ok: false, reason: '缺少 id/channel_id/author.id' }
  }
  const isGroup = typeof d.guild_id === 'string'
  const content = typeof d.content === 'string' ? d.content : undefined
  const mentions = Array.isArray(d.mentions) ? d.mentions : undefined
  const mentionedBot = botUserId !== undefined && mentions !== undefined && mentions.some((m) => (m as Record<string, unknown>).id === botUserId)
  const reference = d.message_reference as Record<string, unknown> | undefined
  const threadId = typeof reference?.message_id === 'string' ? reference.message_id : undefined
  const attachments = Array.isArray(d.attachments) ? d.attachments : undefined
  const attachment = attachments !== undefined && attachments.length > 0
    ? { ref: typeof (attachments[0] as Record<string, unknown>).id === 'string' ? (attachments[0] as Record<string, unknown>).id as string : id, name: typeof (attachments[0] as Record<string, unknown>).filename === 'string' ? (attachments[0] as Record<string, unknown>).filename as string : undefined }
    : undefined

  const msg: NormalizedMessage = {
    channel: 'discord',
    peer: { kind: isGroup ? 'group' : 'direct', id: channelId, threadId },
    sender: { id: String(author.id), name: typeof author.username === 'string' ? author.username : undefined },
    kind: attachment !== undefined ? 'attachment' : isGroup && mentionedBot ? 'mention' : 'text',
    content,
    messageId: id,
  }
  if (attachment !== undefined) msg.attachment = attachment
  if (msg.kind === 'text' && threadId !== undefined) {
    msg.kind = 'reply'
  }
  return { ok: true, msg }
}

/** 按钮交互(INTERACTION_CREATE,type=3 COMPONENT):custom_id 携带紧凑 JSON */
function interactionToMessage(data: unknown): DiscordEventResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: '缺少交互数据' }
  }
  const d = data as Record<string, unknown>
  const user = d.user as Record<string, unknown> | undefined
  const interactionData = d.data as Record<string, unknown> | undefined
  const channelId = d.channel_id
  const message = d.message as Record<string, unknown> | undefined
  const userId = typeof user?.id === 'string' ? user.id : undefined
  const customId = typeof interactionData?.custom_id === 'string' ? interactionData.custom_id : undefined
  const messageId = typeof message?.id === 'string' ? message.id : undefined
  if (userId === undefined || typeof channelId !== 'string' || customId === undefined) {
    return { ok: false, reason: '交互缺少 user/channel_id/custom_id' }
  }
  const parsed = parseCustomId(customId)
  if (parsed === undefined) {
    return { ok: false, reason: 'custom_id 无法解析' }
  }
  const msg: NormalizedMessage = {
    channel: 'discord',
    peer: { kind: typeof d.guild_id === 'string' ? 'group' : 'direct', id: channelId },
    sender: { id: userId },
    kind: 'approval_reply',
    approval: parsed,
    messageId: messageId ?? `${Date.now()}`,
  }
  return { ok: true, msg }
}

/** custom_id JSON 解析(紧凑/完整兼容;Discord custom_id ≤100 字符) */
export function parseCustomId(customId: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const parsed = JSON.parse(customId) as Record<string, unknown>
    const approvalId = typeof parsed.a === 'string' ? parsed.a : typeof parsed.approvalId === 'string' ? parsed.approvalId : undefined
    const action = parsed.act === 'allow' || parsed.action === 'allow' ? 'allow' : parsed.act === 'deny' || parsed.action === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || action === undefined) return undefined
    return { approvalId, action }
  } catch {
    return undefined
  }
}
