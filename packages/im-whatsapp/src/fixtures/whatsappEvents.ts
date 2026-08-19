/**
 * WhatsApp webhook fixture(record-replay)
 */

/** 文本消息 webhook */
export const textWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'wa_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505551111', phone_number_id: 'pn_1' },
            contacts: [{ profile: { name: 'Alice' }, wa_id: '8613800000000' }],
            messages: [
              {
                from: '8613800000000',
                id: 'wamid.1',
                timestamp: '1720000000',
                type: 'text',
                text: { body: '你好,在吗' },
              },
            ],
          },
        },
      ],
    },
  ],
}

/** 图片消息 webhook */
export const imageWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'wa_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: '8613800000000' }],
            messages: [{ from: '8613800000000', id: 'wamid.2', timestamp: '1720000001', type: 'image', image: { id: 'media_2', mime_type: 'image/png' } }],
          },
        },
      ],
    },
  ],
}

/** 按钮回复 webhook(approval) */
export const buttonReplyWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'wa_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: '8613800000000' }],
            messages: [
              {
                from: '8613800000000',
                id: 'wamid.3',
                timestamp: '1720000002',
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: '{"a":"ap_1","act":"allow"}', title: '允许' } },
              },
            ],
          },
        },
      ],
    },
  ],
}

/** 多消息 webhook(一条 webhook 两条消息) */
export const multiMessageWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'wa_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: '8613800000000' }],
            messages: [
              { from: '8613800000000', id: 'wamid.4', timestamp: '1720000003', type: 'text', text: { body: '第一条' } },
              { from: '8613800000000', id: 'wamid.5', timestamp: '1720000004', type: 'text', text: { body: '第二条' } },
            ],
          },
        },
      ],
    },
  ],
}

/** 非消息变更(状态回执/消息送达) */
export const statusWebhook = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'wa_1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
}

/** 非法 webhook */
export const wrongObjectWebhook = { object: 'instagram_business_account', entry: [] }
export const emptyWebhook = { object: 'whatsapp_business_account', entry: [] }
