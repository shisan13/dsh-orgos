/**
 * 企业微信回调明文 XML → NormalizedMessage 规范化(技术设计 §9.2)
 *
 * | 明文 XML                       | NormalizedMessage                       |
 * |--------------------------------|-----------------------------------------|
 * | MsgType=text(私聊)             | kind: text, peer{kind: direct}          |
 * | MsgType=text(群 @bot)          | kind: mention, peer{kind: group}        |
 * | MsgType=image/voice/file       | kind: attachment, attachment{ref}       |
 * | MsgType=event(卡片/菜单回调)   | kind: approval_reply, approval{...}     |
 *
 * 纯函数:输入解密后的明文 XML(parseXmlTags 后的表),输出规范化消息或错误。
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'
import { parseXmlTags } from './xml.ts'

export type WecomEventResult = { ok: true; msg: NormalizedMessage } | { ok: false; reason: string }

/** 入站密文回调 → 规范化消息(内部完成 XML 解析) */
export function wecomXmlToMessage(xml: string, botName?: string): WecomEventResult {
  const fields = parseXmlTags(xml)
  const msgType = fields.get('MsgType')
  const msgId = fields.get('MsgId') ?? fields.get('CreateTime')
  const fromUser = fields.get('FromUserName')
  if (msgType === undefined || msgId === undefined || fromUser === undefined) {
    return { ok: false, reason: '缺少 MsgType/MsgId/FromUserName' }
  }
  const toUser = fields.get('ToUserName') ?? ''

  // 事件类:卡片按钮回调(template_card_event / click)
  if (msgType === 'event') {
    const event = fields.get('Event')
    if (event !== 'template_card_event' && event !== 'click') {
      return { ok: false, reason: `忽略非按钮事件:${String(event)}` }
    }
    const eventKey = fields.get('EventKey')
    const parsed = eventKey !== undefined ? parseEventKey(eventKey) : undefined
    if (parsed === undefined) {
      return { ok: false, reason: 'EventKey 无法解析(缺少 approvalId/action)' }
    }
    const msg: NormalizedMessage = {
      channel: 'wecom',
      peer: { kind: 'direct', id: toUser },
      sender: { id: fromUser },
      kind: 'approval_reply',
      approval: parsed,
      messageId: msgId,
      ts: typeof fields.get('CreateTime') === 'string' ? new Date(Number(fields.get('CreateTime')) * 1000).toISOString() : undefined,
    }
    return { ok: true, msg }
  }

  // 文本/附件
  const content = fields.get('Content')
  const isGroupMention = botName !== undefined && content !== undefined && (content.trim().startsWith(`@${botName}`) || content.trim().startsWith('@'))
  let attachment: NormalizedMessage['attachment'] | undefined
  if (msgType === 'image' || msgType === 'voice' || msgType === 'file') {
    const mediaId = fields.get('MediaId')
    attachment = { ref: mediaId ?? msgId, name: fields.get('FileName') }
  } else if (msgType !== 'text') {
    return { ok: false, reason: `不支持的 MsgType:${msgType}` }
  }
  const msg: NormalizedMessage = {
    channel: 'wecom',
    // 群 @ 判定:以 @bot 开头的文本视为群内提及;否则私聊
    peer: { kind: isGroupMention ? 'group' : 'direct', id: fromUser },
    sender: { id: fromUser },
    kind: attachment !== undefined ? 'attachment' : isGroupMention ? 'mention' : 'text',
    content,
    messageId: msgId,
    ts: typeof fields.get('CreateTime') === 'string' ? new Date(Number(fields.get('CreateTime')) * 1000).toISOString() : undefined,
  }
  if (attachment !== undefined) msg.attachment = attachment
  return { ok: true, msg }
}

/** EventKey 解析:兼容完整 JSON 与紧凑 JSON(卡片按钮 value 由渲染侧决定) */
export function parseEventKey(eventKey: string): { approvalId: string; action: 'allow' | 'deny' } | undefined {
  try {
    const parsed = JSON.parse(eventKey) as Record<string, unknown>
    const approvalId = typeof parsed.approvalId === 'string' ? parsed.approvalId : typeof parsed.a === 'string' ? parsed.a : undefined
    const act = parsed.action === 'allow' || parsed.act === 'allow' ? 'allow' : parsed.action === 'deny' || parsed.act === 'deny' ? 'deny' : undefined
    if (approvalId === undefined || act === undefined) return undefined
    return { approvalId, action: act }
  } catch {
    return undefined
  }
}
