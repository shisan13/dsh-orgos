/**
 * 飞书事件 → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * 飞书 v2 长连接事件(im.message.receive_v1 / card.action.trigger)到统一消息形状:
 * | 飞书事件                 | NormalizedMessage                      |
 * |--------------------------|----------------------------------------|
 * | 群消息 @bot              | kind: mention, peer{kind: group}       |
 * | 私聊                     | kind: text, peer{kind: direct}         |
 * | 回复消息                 | kind: reply, peer.threadId             |
 * | 卡片按钮(审批/任务/提问) | kind: approval_reply, approval{...}    |
 * | 文件/图片                | kind: attachment, attachment{ref}      |
 *
 * 纯函数:输入 lark 事件对象,输出规范化消息或错误(不抛异常,便于适配器渲染错误)。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export type LarkEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

/** 提取事件字段(飞书 v2 事件结构,字段缺失即拒绝) */
export function larkEventToMessage(raw: unknown, botOpenId?: string): LarkEventResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '事件不是对象' }
  }
  const event = (raw as Record<string, unknown>).event as Record<string, unknown> | undefined
  if (typeof event !== 'object' || event === null) {
    return { ok: false, reason: '缺少 event 字段' }
  }
  const header = (raw as Record<string, unknown>).header as Record<string, unknown> | undefined
  const eventType = typeof header?.event_type === 'string' ? header.event_type : ''

  // 卡片按钮回调:card.action.trigger(T6 一次性:value 携带 approvalId/questionId/taskId)
  if (eventType === 'card.action.trigger') {
    return cardActionToMessage(raw)
  }

  // 消息事件:im.message.receive_v1
  if (eventType !== 'im.message.receive_v1' && eventType !== '') {
    return { ok: false, reason: `忽略非消息事件:${eventType}` }
  }
  const message = event.message as Record<string, unknown> | undefined
  const sender = event.sender as Record<string, unknown> | undefined
  if (typeof message !== 'object' || message === null || typeof sender !== 'object' || sender === null) {
    return { ok: false, reason: '缺少 message/sender 字段' }
  }
  const messageId = message.message_id
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return { ok: false, reason: '缺少 message_id(幂等必需)' }
  }
  const chatId = message.chat_id
  const chatType = message.chat_type
  if (typeof chatId !== 'string' || chatId.length === 0 || (chatType !== 'p2p' && chatType !== 'group')) {
    return { ok: false, reason: '缺少合法的 chat_id/chat_type' }
  }
  const openId = (sender.sender_id as Record<string, unknown> | undefined)?.open_id
  if (typeof openId !== 'string') {
    return { ok: false, reason: '缺少 sender open_id' }
  }

  const msgType = message.message_type
  const content = parseContent(message.content)

  // 群 @bot 判定:mentions 命中 bot open_id
  const mentions = Array.isArray(message.mentions) ? (message.mentions as Record<string, unknown>[]) : []
  const mentionedBot = botOpenId !== undefined && mentions.some((m) => (m.id as Record<string, unknown> | undefined)?.open_id === botOpenId)

  let attachment: NormalizedMessage['attachment'] | undefined
  let text: string | undefined
  if (msgType === 'text') {
    text = str(content?.text)
  } else if (msgType === 'post' || msgType === 'image' || msgType === 'file') {
    attachment = { ref: str(content?.file_key) ?? str(content?.image_key) ?? messageId, name: str(content?.file_name) }
    text = str(content?.text)
  } else {
    return { ok: false, reason: `不支持的 message_type:${String(msgType)}` }
  }

  const threadId = str(message.parent_id)
  const createTime = str(message.create_time)
  const msg: NormalizedMessage = {
    channel: 'feishu',
    peer: { kind: chatType === 'group' ? 'group' : 'direct', id: chatId, threadId },
    sender: { id: openId },
    kind: attachment !== undefined
      ? 'attachment'
      : chatType === 'group'
        ? (mentionedBot ? 'mention' : 'text')
        : 'text',
    content: text,
    attachment,
    messageId,
    ts: createTime,
  }
  // 回复消息(带 parent_id)kind=reply(群内回复同样触发,避免静默丢消息)
  if (msg.kind === 'text' && msg.peer.threadId !== undefined) {
    msg.kind = 'reply'
  }
  return { ok: true, msg }
}

/** 卡片按钮回调(approval_reply / question / task 动作统一走 value 负载) */
function cardActionToMessage(raw: unknown): LarkEventResult {
  const event = (raw as Record<string, unknown>).event as Record<string, unknown> | undefined
  const operator = event?.operator as Record<string, unknown> | undefined
  const action = event?.action as Record<string, unknown> | undefined
  const context = event?.context as Record<string, unknown> | undefined
  const openId = operator?.open_id
  let value = action?.value
  if (typeof openId !== 'string' || value === undefined || value === null) {
    return { ok: false, reason: '卡片回调缺少 operator.open_id / action.value' }
  }
  // 飞书契约:按钮 value 是字符串,且平台会额外做字符串编码(实测双重引号);
  // 循环解包最多 3 层(字符串 → JSON 字符串 → 对象)。
  let depth = 0
  while (typeof value === 'string' && depth < 3) {
    try {
      value = JSON.parse(value) as unknown
      depth += 1
    } catch {
      break
    }
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: '卡片 value 解析后不是对象' }
  }
  const v = value as Record<string, unknown>
  const approvalId = v.approvalId
  const actionName = v.action
  // 兼容各版本字段名:open_chat_id/chat_id;open_message_id/message_id
  const chatId = context?.open_chat_id ?? context?.chat_id
  const messageId = context?.open_message_id ?? context?.message_id
  if (typeof chatId !== 'string' || typeof messageId !== 'string') {
    return { ok: false, reason: `卡片回调缺少 context 聊天/消息 id(现有键:${context ? Object.keys(context).join(',') : '无 context'})` }
  }
  const msg: NormalizedMessage = {
    channel: 'feishu',
    peer: { kind: 'direct', id: chatId },
    sender: { id: openId },
    kind: 'approval_reply',
    content: typeof v.reason === 'string' ? v.reason : undefined,
    approval:
      typeof approvalId === 'string' && (actionName === 'allow' || actionName === 'deny')
        ? { approvalId, action: actionName }
        : undefined,
    messageId,
  }
  if (msg.approval === undefined) {
    return { ok: false, reason: `未知卡片动作:${String(actionName)}` }
  }
  return { ok: true, msg }
}

/** 飞书 content 字段是 JSON 字符串(文本消息 {"text":"..."}) */
function parseContent(content: unknown): Record<string, unknown> | undefined {
  if (typeof content !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** unknown → string 窄化(Record<string, unknown> 索引访问的合法收口) */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
