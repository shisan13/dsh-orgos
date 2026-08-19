/**
 * Telegram 事件 fixture(record-replay,不真连 Bot API)
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export const BOT_USERNAME = 'my_orgos_bot'

/** 私聊文本 */
export const privateTextUpdate = {
  update_id: 100,
  message: {
    message_id: 1,
    from: { id: 111, first_name: 'Alice' },
    chat: { id: 111, type: 'private' },
    date: 1720000000,
    text: '在吗',
  },
}

/** 群消息 @bot(entities mention) */
export const groupMentionUpdate = {
  update_id: 101,
  message: {
    message_id: 2,
    from: { id: 111, first_name: 'Alice' },
    chat: { id: -100123, type: 'group', title: '研发群' },
    date: 1720000001,
    text: '@my_orgos_bot 帮我修 bug',
    entities: [{ type: 'mention', offset: 0, length: 13 }],
  },
}

/** 群消息未 @bot */
export const groupPlainUpdate = {
  update_id: 102,
  message: {
    message_id: 3,
    from: { id: 111 },
    chat: { id: -100123, type: 'supergroup' },
    date: 1720000002,
    text: '今天天气不错',
  },
}

/** 回复消息(reply_to_message) */
export const replyUpdate = {
  update_id: 103,
  message: {
    message_id: 4,
    from: { id: 111 },
    chat: { id: 111, type: 'private' },
    date: 1720000003,
    text: '修好了',
    reply_to_message: { message_id: 2 },
  },
}

/** 图片附件 */
export const photoUpdate = {
  update_id: 104,
  message: {
    message_id: 5,
    from: { id: 111 },
    chat: { id: 111, type: 'private' },
    date: 1720000004,
    photo: [
      { file_id: 'small_1', width: 90 },
      { file_id: 'big_1', width: 1280 },
    ],
  },
}

/** 按钮回调(审批) */
export const callbackApprovalUpdate = {
  update_id: 105,
  callback_query: {
    id: 'cq_1',
    from: { id: 111 },
    message: { message_id: 9, chat: { id: 111, type: 'private' } },
    data: '{"a":"ap_1","act":"allow"}',
  },
}

/** 非法/忽略的 update */
export const unknownUpdate = { update_id: 106, edited_message: { message_id: 1 } }
export const malformedUpdate = { update_id: 107 }

/** 规范化后的期望(群 @bot) */
export const expectedGroupMention: NormalizedMessage = {
  channel: 'telegram',
  peer: { kind: 'group', id: '-100123' },
  sender: { id: '111', name: 'Alice' },
  kind: 'mention',
  content: '@my_orgos_bot 帮我修 bug',
  messageId: '2',
  ts: '2024-07-03T16:26:40.000Z',
}
