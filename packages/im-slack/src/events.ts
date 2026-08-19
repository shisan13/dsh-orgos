/**
 * Slack Socket Mode 信封 → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * | 信封/事件                        | NormalizedMessage                       |
 * |----------------------------------|-----------------------------------------|
 * | events_api + message(im)         | kind: text, peer{kind: direct}          |
 * | events_api + message(群 <@bot>)  | kind: mention, peer{kind: group}        |
 * | events_api + message(thread_ts)  | kind: reply, peer.threadId               |
 * | events_api + message(files)      | kind: attachment, attachment{ref}       |
 * | interactive(block_actions)       | kind: approval_reply, approval{...}     |
 *
 * 纯函数:输入信封对象,输出规范化消息或错误。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type SlackEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

interface SlackEnvelope {
  type?: string
  payload?: Record<string, unknown>
}

/** 信封 → 规范化消息(events_api / interactive 分派) */
export function slackEnvelopeToMessage(raw: unknown, botUserId?: string): SlackEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '信封不是对象' }
  }
  const envelope = raw as SlackEnvelope
  const payload = envelope.payload
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: '缺少 payload' }
  }
  const type = payload.type
  if (envelope.type === 'events_api') {
    if (type !== 'event_callback') {
      return { ok: false, reason: `忽略非 event_callback:${String(type)}` }
    }
    return eventCallbackToMessage(payload, botUserId)
  }
  if (envelope.type === 'interactive') {
    if (type !== 'block_actions' && type !== 'interactive_message') {
      return { ok: false, reason: `忽略非按钮交互:${String(type)}` }
    }
    return interactiveToMessage(payload)
  }
  return { ok: false, reason: `忽略信封类型:${String(envelope.type)}` }
}

/** event_callback:event.type=message(忽略 subtype 与 bot 消息) */
function eventCallbackToMessage(payload: Record<string, unknown>, botUserId?: string): SlackEventResult {
  const event = payload.event as Record<string, unknown> | undefined
  if (typeof event !== 'object' || event === null || event.type !== 'message') {
    return { ok: false, reason: '忽略非 message 事件' }
  }
  if (event.subtype !== undefined) {
    return { ok: false, reason: `忽略消息 subtype:${String(event.subtype)}` }
  }
  const channel = event.channel
  const user = event.user
  const ts = event.ts
  if (typeof channel !== 'string' || typeof user !== 'string' || typeof ts !== 'string') {
    return { ok: false, reason: '缺少 channel/user/ts' }
  }
  const channelType = event.channel_type
  const isGroup = channelType === 'channel' || channelType === 'group'
  const text = typeof event.text === 'string' ? event.text : undefined
  const mentionedBot = botUserId !== undefined && text !== undefined && text.includes(`<@${botUserId}>`)
  const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : undefined
  const files = Array.isArray(event.files) ? event.files : undefined
  const attachment = files !== undefined && files.length > 0
    ? { ref: typeof files[0]?.id === 'string' ? (files[0] as Record<string, unknown>).id as string : ts, name: typeof files[0]?.name === 'string' ? (files[0] as Record<string, unknown>).name as string : undefined }
    : undefined

  const msg: NormalizedMessage = {
    channel: 'slack',
    peer: { kind: isGroup ? 'group' : 'direct', id: channel, threadId: threadTs },
    sender: { id: user },
    kind: attachment !== undefined ? 'attachment' : isGroup && mentionedBot ? 'mention' : 'text',
    content: text,
    messageId: ts,
    ts: slackTsToIso(ts),
  }
  if (attachment !== undefined) msg.attachment = attachment
  if (msg.kind === 'text' && threadTs !== undefined) {
    msg.kind = 'reply'
  }
  return { ok: true, msg }
}

/** 按钮交互:actions[0].value 携带紧凑 JSON */
function interactiveToMessage(payload: Record<string, unknown>): SlackEventResult {
  const actions = Array.isArray(payload.actions) ? payload.actions : undefined
  const user = payload.user as Record<string, unknown> | undefined
  const channel = payload.channel as Record<string, unknown> | undefined
  const message = payload.message as Record<string, unknown> | undefined
  const firstAction = actions?.[0] as Record<string, unknown> | undefined
  const value = typeof firstAction?.value === 'string' ? firstAction.value : undefined
  const userId = typeof user?.id === 'string' ? user.id : undefined
  const channelId = typeof channel?.id === 'string' ? channel.id : undefined
  const messageTs = typeof message?.ts === 'string' ? message.ts : undefined
  if (userId === undefined || channelId === undefined || value === undefined) {
    return { ok: false, reason: '按钮交互缺少 user/channel/value' }
  }
  const parsed = parseValue(value)
  if (parsed === undefined) {
    return { ok: false, reason: '按钮 value 无法解析' }
  }
  const msg: NormalizedMessage = {
    channel: 'slack',
    peer: { kind: 'direct', id: channelId },
    sender: { id: userId },
    kind: 'approval_reply',
    approval: parsed,
    messageId: messageTs ?? `${Date.now()}`,
  }
  return { ok: true, msg }
}

/** value JSON 解析(紧凑/完整兼容) */
export function parseValue(value: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const approvalId = typeof parsed.a === 'string' ? parsed.a : typeof parsed.approvalId === 'string' ? parsed.approvalId : undefined
    const action = parsed.act === 'allow' || parsed.action === 'allow' ? 'allow' : parsed.act === 'deny' || parsed.action === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || action === undefined) return undefined
    return { approvalId, action }
  } catch {
    return undefined
  }
}

/** Slack ts 浮点秒 → ISO */
export function slackTsToIso(ts: string): string | undefined {
  const seconds = Number.parseFloat(ts)
  if (!Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString()
}
