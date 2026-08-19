/**
 * 钉钉 Stream 信封 fixture(record-replay,不真连 Stream WS)
 */

/** 群 @bot 文本(ChatbotMessage,isInAtList) */
export const groupMentionEnvelope = {
  headers: {
    topic: '/v1.0/im/bot/messages/get',
    eventId: 'evt_1',
    eventType: 'ChatbotMessage',
    eventBornTime: 1720000000000,
  },
  data: JSON.stringify({
    msgtype: 'text',
    text: { content: '@orgos-bot 帮我查一下' },
    conversationType: '2',
    senderStaffId: 'staff_1',
    senderNick: '张三',
    chatbotUserId: 'bt_1',
    msgId: 'msg_1',
    conversationId: 'cid_group_1',
    isInAtList: true,
    createAt: 1720000000000,
  }),
}

/** 私聊文本(未 @) */
export const privateTextEnvelope = {
  headers: { topic: '/v1.0/im/bot/messages/get', eventId: 'evt_2', eventType: 'ChatbotMessage' },
  data: JSON.stringify({
    msgtype: 'text',
    text: { content: '在吗' },
    conversationType: '1',
    senderStaffId: 'staff_1',
    senderNick: '张三',
    chatbotUserId: 'bt_1',
    msgId: 'msg_2',
    conversationId: 'cid_p2p_1',
    isInAtList: false,
    createAt: 1720000000001,
  }),
}

/** 群文本但未 @(isInAtList=false 且不以 @ 开头) */
export const groupPlainEnvelope = {
  headers: { topic: '/v1.0/im/bot/messages/get', eventId: 'evt_3', eventType: 'ChatbotMessage' },
  data: JSON.stringify({
    msgtype: 'text',
    text: { content: '今天天气不错' },
    conversationType: '2',
    senderStaffId: 'staff_2',
    msgId: 'msg_3',
    conversationId: 'cid_group_1',
    isInAtList: false,
  }),
}

/** 图片消息 */
export const pictureEnvelope = {
  headers: { topic: '/v1.0/im/bot/messages/get', eventId: 'evt_4', eventType: 'ChatbotMessage' },
  data: JSON.stringify({
    msgtype: 'picture',
    conversationType: '1',
    senderStaffId: 'staff_1',
    msgId: 'msg_4',
    conversationId: 'cid_p2p_1',
    downloadCode: 'dl_abc',
  }),
}

/** 卡片按钮回调(EventType CardCallback) */
export const cardCallbackEnvelope = {
  headers: { topic: '/v1.0/im/bot/cards', eventId: 'evt_5', eventType: 'CardCallback' },
  data: JSON.stringify({
    userId: 'staff_1',
    msgId: 'msg_5',
    conversationId: 'cid_p2p_1',
    content: JSON.stringify({
      cardPrivateData: {
        params: JSON.stringify({ a: 'ap_1', act: 'allow' }),
      },
    }),
  }),
}

/** 忽略/非法信封 */
export const ignoredEnvelope = { headers: { eventType: 'UserEnterOrg' }, data: '{}' }
export const malformedEnvelope = { headers: { eventType: 'ChatbotMessage' }, data: 'not-json' }
export const badMessageEnvelope = {
  headers: { eventType: 'ChatbotMessage' },
  data: JSON.stringify({ msgtype: 'text', text: { content: 'x' } }),
}
