/**
 * 飞书 v2 长连接事件 fixture(record-replay:测试不真连 IM,技术设计 §13)
 */
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'

export const BOT_OPEN_ID = 'ou_bot_123'

/** 群消息 @bot(mention) */
export const groupMentionEvent = {
  schema: '2.0',
  header: { event_id: 'evt_1', event_type: 'im.message.receive_v1', tenant_key: 't_1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_group_1',
      message_type: 'text',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 帮我修个 bug' }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID } }],
      create_time: '1720000000000',
    },
  },
}

/** 群消息非 @bot(静默候选) */
export const groupPlainEvent = {
  schema: '2.0',
  header: { event_id: 'evt_2', event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_group_2',
      message_type: 'text',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      content: JSON.stringify({ text: '今天天气不错' }),
      create_time: '1720000000001',
    },
  },
}

/** 私聊消息(text) */
export const p2pEvent = {
  schema: '2.0',
  header: { event_id: 'evt_3', event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_p2p_1',
      message_type: 'text',
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '在吗' }),
      create_time: '1720000000002',
    },
  },
}

/** 回复消息(reply,带 parent_id) */
export const replyEvent = {
  schema: '2.0',
  header: { event_id: 'evt_4', event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_reply_1',
      message_type: 'text',
      chat_id: 'oc_group_1',
      chat_type: 'group',
      parent_id: 'om_group_1',
      content: JSON.stringify({ text: '修好了' }),
      create_time: '1720000000003',
    },
  },
}

/** 文件消息(attachment) */
export const fileEvent = {
  schema: '2.0',
  header: { event_id: 'evt_5', event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_file_1',
      message_type: 'file',
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      content: JSON.stringify({ file_key: 'file_abc', file_name: 'report.pdf' }),
      create_time: '1720000000004',
    },
  },
}

/** 卡片按钮回调(approval) */
export const cardActionEvent = {
  schema: '2.0',
  header: { event_id: 'evt_6', event_type: 'card.action.trigger' },
  event: {
    operator: { open_id: 'ou_owner' },
    action: { value: { approvalId: 'ap_1', action: 'allow' } },
    context: { open_chat_id: 'oc_p2p_1', open_message_id: 'om_card_1' },
  },
}

/** 非法/无关事件(缺 message_id / 未知 event_type) */
export const badEvent = {
  schema: '2.0',
  header: { event_id: 'evt_7', event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_user_1' } },
    message: { message_type: 'text', chat_id: 'oc_g', chat_type: 'group' },
  },
}

/** 规范化后的期望(群 @bot) */
export const expectedGroupMention: NormalizedMessage = {
  channel: 'feishu',
  peer: { kind: 'group', id: 'oc_group_1' },
  sender: { id: 'ou_user_1' },
  kind: 'mention',
  content: '@_user_1 帮我修个 bug',
  messageId: 'om_group_1',
  ts: '1720000000000',
}
