/**
 * Slack Socket Mode 信封 fixture(record-replay)
 */
export const BOT_USER_ID = 'U0BOT'

/** 私聊消息(events_api) */
export const imMessageEnvelope = {
  type: 'events_api',
  envelope_id: 'evt_1',
  payload: {
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'D123',
      user: 'U123',
      text: '在吗',
      ts: '1720000000.000001',
      channel_type: 'im',
    },
  },
}

/** 群消息 @bot */
export const groupMentionEnvelope = {
  type: 'events_api',
  envelope_id: 'evt_2',
  payload: {
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      text: '<@U0BOT> 帮我修 bug',
      ts: '1720000001.000001',
      channel_type: 'channel',
    },
  },
}

/** 群消息未 @bot */
export const groupPlainEnvelope = {
  type: 'events_api',
  envelope_id: 'evt_3',
  payload: {
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      text: '今天天气不错',
      ts: '1720000002.000001',
      channel_type: 'channel',
    },
  },
}

/** 线程回复消息 */
export const threadReplyEnvelope = {
  type: 'events_api',
  envelope_id: 'evt_4',
  payload: {
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      text: '修好了',
      ts: '1720000003.000001',
      thread_ts: '1720000001.000001',
      channel_type: 'channel',
    },
  },
}

/** 文件消息 */
export const fileMessageEnvelope = {
  type: 'events_api',
  envelope_id: 'evt_5',
  payload: {
    type: 'event_callback',
    event: {
      type: 'message',
      channel: 'D123',
      user: 'U123',
      ts: '1720000004.000001',
      channel_type: 'im',
      files: [{ id: 'F123', name: 'report.pdf' }],
    },
  },
}

/** 按钮交互(block_actions) */
export const blockActionsEnvelope = {
  type: 'interactive',
  envelope_id: 'evt_6',
  payload: {
    type: 'block_actions',
    actions: [{ action_id: 'approval_allow', value: '{"a":"ap_1","act":"allow"}' }],
    user: { id: 'U123' },
    channel: { id: 'D123' },
    message: { ts: '1720000005.000001' },
  },
}

/** 忽略/非法信封 */
export const ignoredEnvelope = { type: 'hello', envelope_id: 'evt_7', payload: { type: 'hello' } }
export const badEnvelope = { type: 'events_api', envelope_id: 'evt_8', payload: { type: 'event_callback', event: { type: 'reaction_added' } } }
export const malformedEnvelope = { type: 'interactive', envelope_id: 'evt_9', payload: { type: 'block_actions', actions: [{ action_id: 'x' }] } }
