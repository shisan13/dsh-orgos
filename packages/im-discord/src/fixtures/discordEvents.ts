/**
 * Discord Gateway 帧 fixture(record-replay)
 */
export const BOT_USER_ID = '222000111'

/** 群消息 @bot(MESSAGE_CREATE) */
export const groupMentionFrame = {
  op: 0,
  t: 'MESSAGE_CREATE',
  d: {
    id: 'msg_1',
    channel_id: 'ch_1',
    guild_id: 'guild_1',
    author: { id: '111', username: 'alice', bot: false },
    content: '<@222000111> 帮我修 bug',
    mentions: [{ id: '222000111' }],
    attachments: [],
  },
}

/** 私聊文本(DM,无 guild_id) */
export const dmTextFrame = {
  op: 0,
  t: 'MESSAGE_CREATE',
  d: {
    id: 'msg_2',
    channel_id: 'dm_1',
    author: { id: '111', username: 'alice' },
    content: '在吗',
    mentions: [],
    attachments: [],
  },
}

/** 群未 @bot */
export const groupPlainFrame = {
  op: 0,
  t: 'MESSAGE_CREATE',
  d: {
    id: 'msg_3',
    channel_id: 'ch_1',
    guild_id: 'guild_1',
    author: { id: '111' },
    content: '今天天气不错',
    mentions: [],
  },
}

/** 回复消息(message_reference) */
export const replyFrame = {
  op: 0,
  t: 'MESSAGE_CREATE',
  d: {
    id: 'msg_4',
    channel_id: 'ch_1',
    guild_id: 'guild_1',
    author: { id: '111' },
    content: '修好了',
    mentions: [],
    message_reference: { message_id: 'msg_1' },
  },
}

/** 附件消息 */
export const attachmentFrame = {
  op: 0,
  t: 'MESSAGE_CREATE',
  d: {
    id: 'msg_5',
    channel_id: 'dm_1',
    author: { id: '111' },
    content: '',
    mentions: [],
    attachments: [{ id: 'at_1', filename: 'report.pdf' }],
  },
}

/** 按钮交互(INTERACTION_CREATE) */
export const interactionFrame = {
  op: 0,
  t: 'INTERACTION_CREATE',
  d: {
    id: 'int_1',
    type: 3,
    user: { id: '111' },
    channel_id: 'dm_1',
    message: { id: 'msg_9' },
    data: { custom_id: '{"a":"ap_1","act":"allow"}' },
  },
}

/** 忽略/非法帧 */
export const heartbeatFrame = { op: 1 }
export const readyFrame = { op: 0, t: 'READY', d: { user: { id: '222000111' } } }
export const badFrame = { op: 0, t: 'MESSAGE_CREATE', d: { id: 'x' } }
